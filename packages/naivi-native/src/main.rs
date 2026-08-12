//! naivi-native — generic native host (U5).
//!
//! A winit entry that runs ANY naivi (Vue Vapor) demo through the rquickjs
//! guest into blitz-dom (stylo + taffy + parley), rendered by the VelloHybrid
//! renderer in a native window. The demo is selected by the CLI, which passes
//! the Vite-built page bundle; there are no per-demo host crates.
//!
//! Usage: `naivi-native <page-bundle.js> [styles.css]` — the bundle is the
//! single-file IIFE produced by `naivi desktop` (the CLI aliases
//! `@naivi/runtime/vue-vapor` to the desktop entry, which mounts Vue through
//! the naive renderer against `globalThis.naive`). `styles.css` is the U6
//! author CSS, injected as `globalThis.__NAIVE_CSS`.
//!
//! The guest is evaled BEFORE the window is created: ops issued during the
//! async mount hit blitz's default no-op shell provider, then the real
//! provider is installed when the window comes up. Every subsequent
//! [`Document::poll`] pumps guest microtasks and drains queued events.

use std::cell::RefCell;
use std::rc::Rc;
use std::task::Context as TaskContext;

use anyrender_vello_hybrid::VelloHybridWindowRenderer;
use blitz_dom::{BaseDocument, DocGuard, DocGuardMut, Document, DocumentConfig};
use blitz_shell::{BlitzApplication, BlitzShellProxy, WindowConfig, create_default_event_loop};
use blitz_traits::events::UiEvent;
use naivi_dom::ffi::{self, QueuedEvent};
use naivi_dom::{EventSink, NaiviDocument, NaiviEvent};
use naivi_guest_quickjs::QuickJsGuest;

/// The native event sink: forwards drained naivi events into the QuickJS FFI
/// queue, which the guest tick delivers to the JS callback as
/// `(nodeId, kind, x, y)`.
struct QuickJsEventSink;

impl EventSink for QuickJsEventSink {
    fn on_event(&mut self, event: NaiviEvent) {
        ffi::queue_event(QueuedEvent {
            node: event.node.as_u64(),
            kind: event.kind.to_u8(),
            x: event.client_x as f64,
            y: event.client_y as f64,
            key: event.key,
            code: event.code,
            value: event.value,
        });
    }
}

/// Forwards the blitz [`Document`] surface to the shared naivi document and
/// pumps the QuickJS guest every poll: advance microtasks (mount
/// continuations, Vue re-renders), drain blitz-side events into the FFI
/// queue, then deliver them to JS callbacks (which may re-enter Rust via ops).
struct DocHandle {
    /// The naivi document (owns bindings + event queue + sink).
    doc: Rc<RefCell<NaiviDocument>>,
    /// Clone of `doc.inner`, kept so `inner()`/`inner_mut()` can return
    /// borrows from a source that outlives the call.
    inner: Rc<RefCell<BaseDocument>>,
    /// The QuickJS guest (bundle eval + microtask pump + event drain).
    guest: Rc<RefCell<QuickJsGuest>>,
}

impl DocHandle {
    fn new(doc: Rc<RefCell<NaiviDocument>>, guest: Rc<RefCell<QuickJsGuest>>) -> Self {
        let inner = Rc::clone(&doc.borrow().inner);
        Self { doc, inner, guest }
    }
}

impl Document for DocHandle {
    fn inner(&self) -> DocGuard<'_> {
        DocGuard::RefCell(self.inner.borrow())
    }

    fn inner_mut(&mut self) -> DocGuardMut<'_> {
        DocGuardMut::RefCell(self.inner.borrow_mut())
    }

    fn handle_ui_event(&mut self, event: UiEvent) {
        self.doc.borrow_mut().handle_ui_event(event);
    }

    fn poll(&mut self, _task_context: Option<TaskContext>) -> bool {
        // Advance the guest (mount continuation, Vue re-render microtasks).
        // Runs outside `ctx.with` (runtime-level pump).
        if let Ok(guest) = self.guest.try_borrow_mut() {
            guest.pump_jobs();
        }
        // Drain blitz-side events into the FFI queue.
        let changed = self.doc.borrow().drain_events();
        // Deliver queued events to JS callbacks inside `ctx.with` (may
        // re-enter Rust synchronously via ops — the NaiviDocument borrow from
        // `drain_events` above is already released).
        if let Ok(guest) = self.guest.try_borrow_mut() {
            if let Err(error) = guest.drain_events() {
                tracing::error!("DocHandle.poll: event drain failed: {error:?}");
            }
        }
        changed
    }
}

fn main() {
    tracing_subscriber::fmt::init();

    let args: Vec<String> = std::env::args().collect();
    let bundle_path = match args.get(1) {
        Some(path) => path.clone(),
        None => {
            eprintln!("usage: naivi-native <page-bundle.js> [styles.css]");
            std::process::exit(1);
        }
    };
    let bundle = match std::fs::read_to_string(&bundle_path) {
        Ok(source) => source,
        Err(error) => {
            eprintln!("failed to read bundle `{bundle_path}`: {error}");
            std::process::exit(1);
        }
    };

    // U6: the CLI compiles the author CSS to `node_modules/.naive/styles.css`
    // and passes it as argv[2]. Inject it as `globalThis.__NAIVE_CSS` before
    // evaling the bundle so `loadCSSClassStyles()` can add_stylesheet it.
    let styles_css = args
        .get(2)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .unwrap_or_default();
    let author_css = styles_css.trim();
    if !author_css.is_empty() {
        tracing::info!(
            "naivi native: injecting author stylesheet ({} chars)",
            author_css.len()
        );
    }

    // The document uses system fonts (native): blitz's default font ctx
    // registers system fonts on non-wasm targets (blitz-dom "system-fonts").
    let mut doc = NaiviDocument::with_config(DocumentConfig::default());
    doc.set_event_sink(Box::new(QuickJsEventSink));
    let doc = Rc::new(RefCell::new(doc));

    // Install the document for the FFI ops BEFORE evaling the bundle.
    ffi::install_document(Rc::clone(&doc));

    let mut guest = match QuickJsGuest::new() {
        Ok(guest) => guest,
        Err(error) => {
            eprintln!("failed to create QuickJS guest: {error:?}");
            std::process::exit(1);
        }
    };
    if let Err(error) = guest.init(&bundle) {
        eprintln!("guest bundle eval failed: {error}");
        std::process::exit(1);
    }
    // Inject the author CSS (U6) — the guest reads `globalThis.__NAIVE_CSS`.
    if !author_css.is_empty() {
        let source = format!(
            "globalThis.__NAIVE_CSS = {};",
            serde_json::to_string(author_css).expect("css json")
        );
        guest
            .eval_script(&source)
            .expect("inject __NAIVE_CSS failed");
    }
    // Kick off the async mount (the page bundle's `mount(App)` starts on
    // eval; the first microtask pump advances it before the first frame).
    guest.pump_jobs();
    let guest = Rc::new(RefCell::new(guest));

    let event_loop = create_default_event_loop();
    let (proxy, rx) = BlitzShellProxy::new(event_loop.create_proxy());
    let renderer = VelloHybridWindowRenderer::new();
    let handle = DocHandle::new(doc, guest);
    let window = WindowConfig::new(Box::new(handle), renderer);

    let mut app = BlitzApplication::<VelloHybridWindowRenderer>::new(proxy, rx);
    app.add_window(window);
    event_loop.run_app(app).unwrap();

    // The FFI module keeps the document in a thread-local. If it outlives
    // main(), the winit window (held via the shell provider) is dropped during
    // TLS teardown, which panics on macOS: objc2's autorelease-pool thread-local
    // is already destroyed, so `winit_appkit::Window::drop` → `Pool::new`
    // aborts. Drop the reference here so the window goes away while the TLS is
    // still alive (the remaining Rc drops when main's locals unwind).
    ffi::clear_document();
}

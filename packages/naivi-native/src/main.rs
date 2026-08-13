//! naivi-native — generic native host (U5).
//!
//! A winit entry that runs ANY naivi (Vue Vapor) demo through the rquickjs
//! guest into blitz-dom (stylo + taffy + parley), rendered by the VelloHybrid
//! renderer in a native window. The demo is selected by the CLI; there are no
//! per-demo host crates.
//!
//! Usage (main/page split, primary — `naivi desktop`):
//! `naivi-native <main-bundle.js> <page-bundle.js> [styles.css] [project-dir]`
//!
//! The main bundle is the Vite-built desktop MAIN entry (the CLI aliases
//! `@naivi/runtime` to the desktop-main API): it drives startup via
//! `app.whenReady()` + `NaiveWindow.loadFile('index.html')`. The host builds
//! `globalThis.__naiveMain` (whenReady/createWindow/loadFile), evals the main
//! bundle, resolves readiness once the window exists, and `loadFile` evals the
//! prebuilt page bundle (the Vite-built PAGE entry, aliased so its `mount(App)`
//! routes through the desktop entry) as window content.
//!
//! Backward-compat (page-direct, manual runs):
//! `naivi-native <page-bundle.js> [styles.css]` evals the page bundle directly
//! without a main entry (pre-split U5 behavior).
//!
//! The guest is evaled BEFORE the window's real shell provider is installed:
//! ops issued during the async mount hit blitz's default no-op shell provider,
//! then the real provider is installed when the window comes up. Every
//! subsequent [`Document::poll`] pumps guest microtasks and drains queued
//! events.

use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;
use std::task::Context as TaskContext;

use anyrender_vello_hybrid::VelloHybridWindowRenderer;
use blitz_dom::{BaseDocument, DocGuard, DocGuardMut, Document, DocumentConfig};
use blitz_shell::{BlitzApplication, BlitzShellProxy, WindowConfig, create_default_event_loop};
use blitz_traits::events::UiEvent;
use naivi_dom::ffi::{self, QueuedEvent};
use naivi_dom::{EventSink, NaiviDocument, NaiviEvent};
use naivi_guest_quickjs::QuickJsGuest;
use naivi_guest_quickjs::main_ffi::{self, MainState};

/// The native event sink: forwards drained naivi events into the QuickJS FFI
/// queue, which the guest tick delivers to the JS callback as
/// `(nodeId, kind, x, y, key, code, value, button, buttons, deltaX, deltaY,
/// imeData, chain)` (KTD2/KTD3).
struct QuickJsEventSink;

impl EventSink for QuickJsEventSink {
    fn on_event(&mut self, event: NaiviEvent) {
        ffi::queue_event(QueuedEvent {
            node: event.node,
            kind: event.kind.to_u8(),
            x: event.client_x as f64,
            y: event.client_y as f64,
            key: event.key,
            code: event.code,
            value: event.value,
            chain: event.chain,
            button: event.button,
            buttons: event.buttons,
            delta_x: event.delta_x,
            delta_y: event.delta_y,
            ime_data: event.ime_data,
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
        // KTD5 frame order: advance the guest (mount continuation, Vue
        // re-render microtasks) — runs outside `ctx.with` (runtime-level pump).
        if let Ok(guest) = self.guest.try_borrow_mut() {
            guest.pump_jobs();
        }
        // Run the guest's frame tick: the injected `globalThis.__tick` flushes
        // the writer as one flush_frame (whole-frame transaction) and delivers
        // any frame_rejected to the self-heal callback.
        if let Ok(guest) = self.guest.try_borrow_mut() {
            if let Err(error) = guest.tick() {
                tracing::error!("DocHandle.poll: guest tick failed: {error:?}");
            }
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

/// Exit non-zero with a message (KD5 parity: fatal host errors surface to the
/// terminal — no rfd dependency in this crate).
fn fatal(message: &str) -> ! {
    eprintln!("{message}");
    std::process::exit(1);
}

fn main() {
    tracing_subscriber::fmt::init();

    let args: Vec<String> = std::env::args().collect();
    // Main/page split when a page-bundle arg is present (>= 3 positional
    // args); otherwise backward-compat page-direct mode (1–2 args).
    let split_mode = args.len() >= 3;
    let (main_bundle_path, page_bundle_path, styles_path, project_dir) = if split_mode {
        (
            args.get(1).cloned(),
            args.get(2).cloned(),
            args.get(3).cloned(),
            args.get(4).map(PathBuf::from),
        )
    } else {
        (None, args.get(1).cloned(), args.get(2).cloned(), None)
    };
    let Some(page_bundle_path) = page_bundle_path else {
        fatal(
            "usage: naivi-native <main-bundle.js> <page-bundle.js> [styles.css] [project-dir]\n       naivi-native <page-bundle.js> [styles.css]",
        );
    };

    let read_source = |path: &str, what: &str| -> String {
        match std::fs::read_to_string(path) {
            Ok(source) => source,
            Err(error) => fatal(&format!("failed to read {what} `{path}`: {error}")),
        }
    };
    let page_bundle = read_source(&page_bundle_path, "page bundle");
    let main_bundle = main_bundle_path
        .as_deref()
        .map(|path| read_source(path, "main bundle"));

    // U6: the CLI compiles the author CSS to `node_modules/.naive/styles.css`
    // and passes it as an optional arg. Inject it as `globalThis.__NAIVE_CSS`
    // before the page bundle runs so `loadCSSClassStyles()` can add_stylesheet
    // it.
    let author_css = styles_path
        .as_deref()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .map(|css| css.trim().to_string())
        .unwrap_or_default();
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

    // Install the document for the FFI ops BEFORE evaling any bundle.
    ffi::install_document(Rc::clone(&doc));

    let mut guest = match QuickJsGuest::new() {
        Ok(guest) => guest,
        Err(error) => fatal(&format!("failed to create QuickJS guest: {error:?}")),
    };

    // Main/page split: publish the page bundle + project dir (the loadFile
    // FFI reads them), then eval the main bundle (which registers
    // `app.whenReady().then(createWindow)` — nothing runs until readiness).
    if let Some(main_bundle) = &main_bundle {
        main_ffi::set_main_state(MainState {
            page_bundle: Some(page_bundle),
            project_dir,
            page_loaded: false,
        });
        if let Err(error) = guest.init_main(main_bundle) {
            fatal(&format!("guest main bundle eval failed: {error}"));
        }
    } else {
        // Page-direct mode: eval the page bundle directly (pre-split U5).
        if let Err(error) = guest.init(&page_bundle) {
            fatal(&format!("guest page bundle eval failed: {error}"));
        }
    }

    if !author_css.is_empty() {
        let source = format!(
            "globalThis.__NAIVE_CSS = {};",
            serde_json::to_string(&author_css).expect("css json")
        );
        guest
            .eval_script(&source)
            .expect("inject __NAIVE_CSS failed");
    }

    let guest = Rc::new(RefCell::new(guest));

    let event_loop = create_default_event_loop();
    let (proxy, rx) = BlitzShellProxy::new(event_loop.create_proxy());
    let renderer = VelloHybridWindowRenderer::new();
    let handle = DocHandle::new(doc, Rc::clone(&guest));
    let window = WindowConfig::new(Box::new(handle), renderer);

    let mut app = BlitzApplication::<VelloHybridWindowRenderer>::new(proxy, rx);
    app.add_window(window);

    // Main/page split: resolve `app.whenReady()` now — the main's
    // `createWindow()` (a size confirmation) then `loadFile('index.html')`
    // run, evaling the page bundle. The window is registered above but its
    // real shell provider installs when the event loop starts; the async
    // mount progresses through the no-op provider first, exactly as
    // page-direct mode did (the provider swaps over on the first frame).
    if main_bundle.is_some() {
        if let Err(error) = guest.borrow().resolve_ready() {
            fatal(&format!("guest resolve_ready failed: {error}"));
        }
    }

    event_loop.run_app(app).unwrap();

    // KD5 hardening: a main that never loads a page is a silent failure
    // (blank window, exit 0). Surface it as a non-zero exit.
    if main_bundle.is_some() && !main_ffi::page_was_loaded() {
        fatal("naive desktop: main never loaded a page (app.whenReady()/loadFile not called)");
    }

    // The FFI module keeps the document in a thread-local. If it outlives
    // main(), the winit window (held via the shell provider) is dropped during
    // TLS teardown, which panics on macOS: objc2's autorelease-pool thread-local
    // is already destroyed, so `winit_appkit::Window::drop` → `Pool::new`
    // aborts. Drop the reference here so the window goes away while the TLS is
    // still alive (the remaining Rc drops when main's locals unwind).
    ffi::clear_document();
}

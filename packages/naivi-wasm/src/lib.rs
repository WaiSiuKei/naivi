//! naivi-wasm — generic U4 wasm channel for the naivi (Vue Vapor) frontend.
//!
//! A `cdylib` exposing the KTD1 mutation-mirror protocol as wasm-bindgen
//! exports, each a thin adapter over the U3 [`OpsCore`]. A single
//! [`NaiviDocument`] is created by [`start`] and driven by
//! [`BlitzApplication`] (winit + VelloHybrid renderer on the `#blitz-target`
//! canvas); the guest JS binds these exports, builds/mutates the tree through
//! them, and receives dispatched DOM events through [`set_event_callback`].
//!
//! This is the SHARED wasm host: `naivi wasm --release` (in any
//! `examples/naivi/<demo>`) drops the demo's guest bundle into this crate's
//! `assets/guest/`, and `trunk serve` (here) runs it. There are no per-demo
//! host crates.
//!
//! ## Protocol notes (shared with `js/naivi-runtime/src/wasm-types.ts`)
//!
//! - Node ids are the blitz-allocated [`NodeId`] as `u64` / JS `bigint`.
//! - Event kinds are encoded as `u8`, matching [`NaiviEventKind::ALL`] order
//!   (click=0 … dblclick=8); the JS side mirrors that order in `EVENT_KINDS`.
//! - `bind_event` returns the node id as the handler id; `unbind_event`
//!   receives that handler id and clears every binding on the node (the JS
//!   side keeps its own handler → (node, kind) registry for bookkeeping, so
//!   the id-only shape is sufficient for the mirror protocol).
//! - `set_event_callback` receives `(nodeId, kind, x, y)` per drained event.

#![cfg(target_arch = "wasm32")]

use std::cell::RefCell;
use std::rc::Rc;

use anyrender_vello_hybrid::VelloHybridWindowRenderer;
use blitz_dom::{BaseDocument, DocGuard, DocGuardMut, Document, DocumentConfig, build_single_font_ctx};
use blitz_shell::{BlitzApplication, BlitzShellProxy, WindowConfig};
use blitz_traits::events::UiEvent;
use blitz_traits::node_id::NodeId;
use naivi_dom::{EventSink, NaiviDocument, NaiviEvent, NaiviEventKind, OpsCore};
use std::task::Context as TaskContext;
use tracing::info;
use wasm_bindgen::prelude::*;
use winit::event_loop::EventLoop;
use winit::platform::web::WindowAttributesWeb;
use winit::window::WindowAttributes;

/// DejaVu Sans, bundled so the document has a real font on wasm32 (browsers
/// don't expose system fonts to wasm). License: Bitstream Vera / DejaVu
/// (permissive).
const DEJAVU_SANS: &[u8] = include_bytes!("../assets/DejaVuSans.woff2");

thread_local! {
    /// The single naivi document, installed by [`start`] before `run_app`.
    static DOC: RefCell<Option<Rc<RefCell<NaiviDocument>>>> = const { RefCell::new(None) };
    /// The JS callback registered via [`set_event_callback`].
    static EVENT_CALLBACK: RefCell<Option<js_sys::Function>> = const { RefCell::new(None) };
}

/// Run `f` against the installed document's ops core.
fn with_core<R>(f: impl FnOnce(&mut OpsCore) -> R) -> R {
    DOC.with(|slot| {
        let slot = slot.borrow();
        let doc = slot
            .as_ref()
            .expect("naivi document not initialized — call start() first");
        let mut core = doc.borrow().ops_core();
        f(&mut core)
    })
}

// ── event kind <-> u8 (order shared with js/naivi-runtime EVENT_KINDS) ──

fn kind_to_u8(kind: NaiviEventKind) -> u8 {
    match kind {
        NaiviEventKind::Click => 0,
        NaiviEventKind::PointerDown => 1,
        NaiviEventKind::PointerUp => 2,
        NaiviEventKind::PointerMove => 3,
        NaiviEventKind::Wheel => 4,
        NaiviEventKind::ContextMenu => 5,
        NaiviEventKind::MouseEnter => 6,
        NaiviEventKind::MouseLeave => 7,
        NaiviEventKind::DblClick => 8,
    }
}

fn u8_to_kind(kind: u8) -> Option<NaiviEventKind> {
    Some(match kind {
        0 => NaiviEventKind::Click,
        1 => NaiviEventKind::PointerDown,
        2 => NaiviEventKind::PointerUp,
        3 => NaiviEventKind::PointerMove,
        4 => NaiviEventKind::Wheel,
        5 => NaiviEventKind::ContextMenu,
        6 => NaiviEventKind::MouseEnter,
        7 => NaiviEventKind::MouseLeave,
        8 => NaiviEventKind::DblClick,
        _ => return None,
    })
}

/// Sink that forwards drained events to the JS callback as
/// `(nodeId, kind, x, y)` — the `set_event_callback` wire shape.
struct WasmEventSink;

impl EventSink for WasmEventSink {
    fn on_event(&mut self, event: NaiviEvent) {
        EVENT_CALLBACK.with(|slot| {
            let slot = slot.borrow();
            let Some(cb) = slot.as_ref() else {
                return;
            };
            let args = js_sys::Array::new();
            args.push(&JsValue::from_f64(event.node.as_u64() as f64));
            args.push(&JsValue::from(kind_to_u8(event.kind)));
            args.push(&JsValue::from_f64(event.client_x as f64));
            args.push(&JsValue::from_f64(event.client_y as f64));
            let _ = cb.apply(&JsValue::NULL, &args);
        });
    }
}

/// Forwards the blitz [`Document`] surface to the shared naivi document so the
/// SAME instance (and its shared event bindings/queue) serves both the window
/// and the wasm exports' ops core.
///
/// Holds a clone of `NaiviDocument::inner` so [`Document::inner`]/[`inner_mut`]
/// borrow from a long-lived [`Rc<RefCell<BaseDocument>>`] (the same pattern
/// blitz uses for `Rc<RefCell<BaseDocument>>: Document`).
///
/// `poll` uses an immutable borrow: `NaiviDocument::drain_events` is `&self`
/// and the JS sink may re-enter Rust (Vue handler → wasm export) synchronously
/// while it runs. A mutable borrow held across that call would trip the
/// `RefCell` re-entrancy guard.
struct DocHandle {
    /// The naivi document (owns bindings + event queue + sink).
    doc: Rc<RefCell<NaiviDocument>>,
    /// Clone of `doc.inner`, kept so `inner()`/`inner_mut()` can return
    /// borrows from a source that outlives the call.
    inner: Rc<RefCell<BaseDocument>>,
}

impl DocHandle {
    fn new(doc: Rc<RefCell<NaiviDocument>>) -> Self {
        let inner = Rc::clone(&doc.borrow().inner);
        Self { doc, inner }
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
        // The naivi event handler only records into the queue — no JS re-entry.
        self.doc.borrow_mut().handle_ui_event(event);
    }

    fn poll(&mut self, _task_context: Option<TaskContext>) -> bool {
        // `&self`: the sink may re-enter Rust synchronously via the JS callback.
        self.doc.borrow().drain_events()
    }
}

// ── KTD1 protocol exports (thin adapters over OpsCore) ──────────────

/// Create an element; returns its blitz-allocated node id.
#[wasm_bindgen]
pub fn create_element(tag: &str) -> u64 {
    with_core(|core| core.create_element(tag).as_u64())
}

/// Create a text node; returns its blitz-allocated node id.
#[wasm_bindgen]
pub fn create_text_node(text: &str) -> u64 {
    with_core(|core| core.create_text_node(text).as_u64())
}

/// Attach a node as a child of the document root (the facade `body`).
#[wasm_bindgen]
pub fn attach_document_root(node_id: u64) {
    with_core(|core| core.attach_document_root(NodeId::from_u64(node_id)));
}

/// Set the text content of a text node.
#[wasm_bindgen]
pub fn set_text(node_id: u64, text: &str) {
    with_core(|core| core.set_text(NodeId::from_u64(node_id), text));
}

/// Set an attribute (e.g. `class`, `id`, `data-*`).
#[wasm_bindgen]
pub fn set_attr(node_id: u64, name: &str, value: &str) {
    with_core(|core| core.set_attr(NodeId::from_u64(node_id), name, value));
}

/// Set an inline style property.
#[wasm_bindgen]
pub fn set_style(node_id: u64, key: &str, value: &str) {
    with_core(|core| core.set_style(NodeId::from_u64(node_id), key, value));
}

/// Inject an author stylesheet (U6: SFC `<style>` / AOT CSS text) into stylo.
#[wasm_bindgen]
pub fn add_stylesheet(css: &str) {
    with_core(|core| core.add_stylesheet(css));
}

/// Append `child` as the last child of `parent`.
#[wasm_bindgen]
pub fn append_child(parent: u64, child: u64) {
    with_core(|core| core.append_child(NodeId::from_u64(parent), NodeId::from_u64(child)));
}

/// Insert `child` immediately before `anchor`.
#[wasm_bindgen]
pub fn insert_before(anchor: u64, child: u64) {
    with_core(|core| core.insert_before(NodeId::from_u64(anchor), NodeId::from_u64(child)));
}

/// Insert `child` immediately after `anchor`.
#[wasm_bindgen]
pub fn insert_after(anchor: u64, child: u64) {
    with_core(|core| core.insert_after(NodeId::from_u64(anchor), NodeId::from_u64(child)));
}

/// Replace `old` with `new` in place.
#[wasm_bindgen]
pub fn replace_node(old: u64, new: u64) {
    with_core(|core| core.replace_node(NodeId::from_u64(old), NodeId::from_u64(new)));
}

/// Remove (and drop) a node and its subtree.
#[wasm_bindgen]
pub fn remove_node(node_id: u64) {
    with_core(|core| core.remove_node(NodeId::from_u64(node_id)));
}

/// Bind `kind` (u8) on `node_id`; returns the node id as the handler id.
#[wasm_bindgen]
pub fn bind_event(node_id: u64, kind: u8) -> u64 {
    let Some(kind) = u8_to_kind(kind) else {
        return 0;
    };
    let node = NodeId::from_u64(node_id);
    with_core(|core| {
        core.bind_event(node, kind);
        node.as_u64()
    })
}

/// Clear every event binding on the node identified by `handler_id`.
#[wasm_bindgen]
pub fn unbind_event(handler_id: u64) {
    let node = NodeId::from_u64(handler_id);
    with_core(|core| {
        for kind in NaiviEventKind::ALL {
            core.unbind_event(node, kind);
        }
    });
}

/// Register the Rust→JS event callback: `(nodeId: number, kind: number, x: number, y: number) => void`.
#[wasm_bindgen]
pub fn set_event_callback(cb: js_sys::Function) {
    EVENT_CALLBACK.with(|slot| *slot.borrow_mut() = Some(cb));
}

/// Force-drain queued events through the sink (the app loop already does this
/// per frame; kept as a guest-invokable pump).
#[wasm_bindgen]
pub fn tick() {
    DOC.with(|slot| {
        if let Some(doc) = slot.borrow().as_ref() {
            doc.borrow().drain_events();
        }
    });
}

// ── host startup ────────────────────────────────────────────────────

#[wasm_bindgen(start)]
pub fn start() -> Result<(), JsValue> {
    console_error_panic_hook::set_once();
    tracing_wasm::set_as_global_default();
    info!("naivi wasm starting");

    let window = web_sys::window().expect("no global window");
    let document = window.document().expect("no document on window");
    let canvas = document
        .get_element_by_id("blitz-target")
        .expect("no #blitz-target canvas in the host page");
    let canvas = canvas
        .dyn_into::<web_sys::HtmlCanvasElement>()
        .expect("#blitz-target is not a canvas");

    // Make sure the canvas can be given focus and isn't outlined when focused.
    canvas.set_tab_index(0);
    canvas.style().set_property("outline", "none")?;

    let event_loop = EventLoop::new().map_err(|e| JsValue::from_str(&format!("{e}")))?;
    let (proxy, rx) = BlitzShellProxy::new(event_loop.create_proxy());

    let renderer = VelloHybridWindowRenderer::new();
    let mut doc = NaiviDocument::with_config(DocumentConfig {
        font_ctx: Some(build_single_font_ctx(DEJAVU_SANS)),
        ..Default::default()
    });
    doc.set_event_sink(Box::new(WasmEventSink));
    let doc = Rc::new(RefCell::new(doc));

    // Install the document in global state BEFORE run_app so any guest op
    // issued after the first frame resolves against it.
    DOC.with(|slot| *slot.borrow_mut() = Some(Rc::clone(&doc)));

    // Intentionally no `.with_surface_size(...)` on wasm: letting winit-web set
    // the canvas size writes fixed inline CSS that overrides host stylesheet
    // rules. Host CSS sizes the canvas.
    let attrs = WindowAttributes::default().with_platform_attributes(Box::new(
        WindowAttributesWeb::default().with_canvas(Some(canvas)),
    ));
    let window_config = WindowConfig::with_attributes(Box::new(DocHandle::new(doc)), renderer, attrs);

    let mut app = BlitzApplication::<VelloHybridWindowRenderer>::new(proxy, rx);
    app.add_window(window_config);

    event_loop
        .run_app(app)
        .map_err(|e| JsValue::from_str(&format!("{e}")))?;
    Ok(())
}

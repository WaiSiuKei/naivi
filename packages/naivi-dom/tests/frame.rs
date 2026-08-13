//! U6 frame-core tests: decode/apply as one whole-frame transaction, virtual
//! id mapping, reset, and event reverse-lookup (KTD2/KTD3/KD8, AE5/AE7).
//!
//! Frames are hand-encoded in the `@naivi/protocol` wire format (U4):
//! `[seq u32 LE][count u16 LE][op…]`, ops with virtual u32 node ids, u16
//! string prefixes (u32 for `AddStylesheet`).

use blitz_dom::{Document, DocumentConfig};
use blitz_traits::events::{
    BlitzPointerEvent, BlitzPointerId, MouseEventButton, MouseEventButtons, Point,
    PointerCoords, PointerDetails, UiEvent,
};
use blitz_traits::shell::{ColorScheme, DummyShellProvider, Viewport};
use keyboard_types::Modifiers;
use naivi_dom::generated::op;
use naivi_dom::{EventSink, NaiviDocument, NaiviEvent, NaiviEventKind};
use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

// ── frame byte helpers (mirror the TS FrameWriter) ──────────────────

fn str16(s: &str) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&(s.len() as u16).to_le_bytes());
    out.extend_from_slice(s.as_bytes());
    out
}

fn u32(v: u32) -> Vec<u8> {
    v.to_le_bytes().to_vec()
}

fn op(code: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = vec![code];
    out.extend_from_slice(payload);
    out
}

fn frame(seq: u32, ops: &[Vec<u8>]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&seq.to_le_bytes());
    out.extend_from_slice(&(ops.len() as u16).to_le_bytes());
    for op in ops {
        out.extend_from_slice(op);
    }
    out
}

fn create_element(id: u32, tag: &str) -> Vec<u8> {
    op(op::CREATE_ELEMENT, &[u32(id), str16(tag)].concat())
}

fn create_text(id: u32, text: &str) -> Vec<u8> {
    op(op::CREATE_TEXT, &[u32(id), str16(text)].concat())
}

fn append(parent: u32, child: u32) -> Vec<u8> {
    op(op::APPEND_CHILD, &[u32(parent), u32(child)].concat())
}

fn set_attr(node: u32, name: &str, value: &str) -> Vec<u8> {
    op(op::SET_ATTR, &[u32(node), str16(name), str16(value)].concat())
}

fn set_style(node: u32, key: &str, value: &str) -> Vec<u8> {
    op(op::SET_STYLE, &[u32(node), str16(key), str16(value)].concat())
}

fn bind_event(node: u32, kind: u8) -> Vec<u8> {
    op(op::BIND_EVENT, &[u32(node), vec![kind]].concat())
}

fn remove_node(node: u32) -> Vec<u8> {
    op(op::REMOVE_NODE, &u32(node))
}

fn reset() -> Vec<u8> {
    op(op::RESET, &[])
}

fn add_stylesheet(css: &str) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&(css.len() as u32).to_le_bytes());
    payload.extend_from_slice(css.as_bytes());
    op(op::ADD_STYLESHEET, &payload)
}

// ── doc fixture ─────────────────────────────────────────────────────

fn make_doc() -> NaiviDocument {
    let config = DocumentConfig {
        viewport: Some(Viewport::new(800, 600, 1.0, ColorScheme::Light)),
        shell_provider: Some(Arc::new(DummyShellProvider)),
        ..Default::default()
    };
    NaiviDocument::with_config(config)
}

fn main_button_pointer_event(x: f32, y: f32) -> BlitzPointerEvent {
    BlitzPointerEvent {
        id: BlitzPointerId::Mouse,
        is_primary: true,
        coords: PointerCoords {
            page_x: x,
            page_y: y,
            screen_x: x,
            screen_y: y,
            client_x: x,
            client_y: y,
        },
        button: MouseEventButton::Main,
        buttons: MouseEventButtons::Primary,
        mods: Modifiers::default(),
        details: PointerDetails::default(),
        element: Point::default(),
        active_pointers: Default::default(),
    }
}

/// A sink that records drained events for assertions.
#[derive(Default)]
struct RecordingSink(Rc<RefCell<Vec<NaiviEvent>>>);

impl EventSink for RecordingSink {
    fn on_event(&mut self, event: NaiviEvent) {
        self.0.borrow_mut().push(event);
    }
}

// ── tests ───────────────────────────────────────────────────────────

#[test]
fn decodes_and_applies_a_legal_frame() {
    let mut doc = make_doc();
    // Establish the facade body under the document root (add_stylesheet
    // attaches to the root element, and hit-testing needs a laid-out body).
    doc.flush_frame(&frame(0, &[create_element(100, "body"), op(op::ATTACH_ROOT, &u32(100))]));
    doc.flush_frame(&frame(
        7,
        &[
            create_element(1, "div"),
            create_text(2, "hi"),
            append(1, 2),
            append(100, 1),
            set_attr(1, "class", "greeting"),
            set_style(1, "width", "100px"),
            bind_event(1, NaiviEventKind::Click.to_u8()),
            add_stylesheet(".greeting { color: red; }"),
        ],
    ));
    assert!(doc.take_frame_rejected().is_empty(), "frame must be accepted");

    let doc_ref = doc.inner();
    let div = doc.ops_core().resolve_virtual(1).expect("virtual 1 mapped");
    let node = doc_ref.get_node(div).unwrap();
    assert_eq!(node.attr("class".into()), Some("greeting"));
    assert_eq!(node.children.len(), 1);
    assert_eq!(
        node.attr("data-naivi-id".into()),
        Some("1"),
        "bind writes the VIRTUAL id"
    );
}

#[test]
fn invalid_id_rejects_the_whole_frame_transactionally() {
    let mut doc = make_doc();
    // create div (id 1) + append under UNKNOWN parent 99 + a set_attr that
    // would mutate if applied. The whole frame must be dropped: no partial DOM.
    doc.flush_frame(&frame(
        3,
        &[
            create_element(1, "div"),
            append(99, 1),
            set_attr(1, "class", "zombie"),
        ],
    ));
    assert_eq!(doc.take_frame_rejected(), vec![(3, 0x01)]);

    let doc_ref = doc.inner();
    // The div must NOT exist (the frame was discarded as one transaction).
    assert!(doc.ops_core().resolve_virtual(1).is_none());
    let root = doc_ref.root_node();
    assert!(
        root.children.is_empty(),
        "nothing was applied from the rejected frame"
    );
}

#[test]
fn duplicate_create_id_rejects_the_frame() {
    let mut doc = make_doc();
    doc.flush_frame(&frame(1, &[create_element(1, "a")]));
    assert!(doc.take_frame_rejected().is_empty());

    // Re-creating id 1 while it is still live is JS/guest drift → reject.
    doc.flush_frame(&frame(2, &[create_element(1, "b")]));
    assert_eq!(doc.take_frame_rejected(), vec![(2, 0x01)]);
    assert!(doc.ops_core().resolve_virtual(1).is_some(), "original node survives");
}

#[test]
fn remove_invalidates_the_virtual_id() {
    let mut doc = make_doc();
    doc.flush_frame(&frame(1, &[create_element(1, "div")]));
    assert!(doc.ops_core().resolve_virtual(1).is_some());

    doc.flush_frame(&frame(2, &[remove_node(1)]));
    assert!(doc.take_frame_rejected().is_empty());
    assert!(doc.ops_core().resolve_virtual(1).is_none());

    // Reusing the removed id is now unknown → reject (no panic).
    doc.flush_frame(&frame(3, &[set_attr(1, "class", "zombie")]));
    assert_eq!(doc.take_frame_rejected(), vec![(3, 0x01)]);
}

#[test]
fn reset_drops_the_tree_map_and_bindings() {
    let mut doc = make_doc();
    doc.flush_frame(&frame(
        1,
        &[create_element(1, "div"), bind_event(1, NaiviEventKind::Click.to_u8())],
    ));
    let core = doc.ops_core();
    assert!(core.resolve_virtual(1).is_some());
    assert!(!core.bound_kinds(core.resolve_virtual(1).unwrap()).is_empty());
    drop(core);

    // A reset frame wipes everything (self-heal start, R15).
    doc.flush_frame(&frame(2, &[reset()]));
    assert!(doc.take_frame_rejected().is_empty());
    assert!(doc.ops_core().resolve_virtual(1).is_none());

    // The id is reusable on a clean slate.
    doc.flush_frame(&frame(3, &[create_element(1, "div")]));
    assert!(doc.take_frame_rejected().is_empty());
    assert!(doc.ops_core().resolve_virtual(1).is_some());
}

#[test]
fn malformed_frame_is_rejected_without_panicking() {
    let mut doc = make_doc();
    // Truncated: header says 1 op but no op bytes follow.
    let mut bytes = 1u32.to_le_bytes().to_vec();
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.push(op::CREATE_ELEMENT); // no payload
    doc.flush_frame(&bytes);
    assert_eq!(doc.take_frame_rejected(), vec![(0, 0x01)]);
}

#[test]
fn bound_node_events_carry_the_virtual_id() {
    let mut doc = make_doc();
    // Establish the facade body, then a 100x100 clickable box at the origin
    // under it, virtual id 1.
    doc.flush_frame(&frame(0, &[create_element(100, "body"), op(op::ATTACH_ROOT, &u32(100))]));
    doc.flush_frame(&frame(
        1,
        &[
            create_element(1, "div"),
            append(100, 1),
            set_style(1, "position", "absolute"),
            set_style(1, "left", "0px"),
            set_style(1, "top", "0px"),
            set_style(1, "width", "100px"),
            set_style(1, "height", "100px"),
            bind_event(1, NaiviEventKind::Click.to_u8()),
        ],
    ));
    assert!(doc.take_frame_rejected().is_empty());
    doc.inner_mut().resolve(0.0);

    let recorded = Rc::new(RefCell::new(Vec::new()));
    doc.set_event_sink(Box::new(RecordingSink(Rc::clone(&recorded))));

    let click = main_button_pointer_event(50.0, 50.0);
    doc.handle_ui_event(UiEvent::PointerDown(click.clone()));
    doc.handle_ui_event(UiEvent::PointerUp(click));

    assert!(doc.poll(None), "poll should drain the click");
    let drained = recorded.borrow();
    assert_eq!(drained.len(), 1);
    assert_eq!(drained[0].node, 1, "event node is the virtual id (KTD2)");
    assert_eq!(drained[0].kind, NaiviEventKind::Click);
    assert_eq!(drained[0].client_x, 50.0);
    assert_eq!(drained[0].client_y, 50.0);
}

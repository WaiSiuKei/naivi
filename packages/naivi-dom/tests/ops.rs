//! Integration tests for the naivi-dom ops core and `Document` implementation.
//!
//! These exercise the engine-neutral ops core (`OpsCore` / `NaiviOp`) against a
//! real `BaseDocument`, plus the event binding / queue / drain path through a
//! `NaiviDocument`.

use blitz_dom::{BaseDocument, Document, DocumentConfig, LocalName, NodeId, local_name};
use blitz_traits::events::{
    BlitzPointerEvent, BlitzPointerId, MouseEventButton, MouseEventButtons, Point, PointerCoords,
    PointerDetails, UiEvent,
};
use blitz_traits::shell::{ColorScheme, DummyShellProvider, Viewport};
use keyboard_types::Modifiers;
use naivi_dom::{EventSink, NaiviDocument, NaiviEvent, NaiviEventKind, NaiviOp, OpsCore};
use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

/// A [`BaseDocument`] with a dummy shell provider so that mutator-drop redraw
/// calls don't panic.
fn make_base_document() -> Rc<RefCell<BaseDocument>> {
    let config = DocumentConfig {
        viewport: Some(Viewport::new(800, 600, 1.0, ColorScheme::Light)),
        shell_provider: Some(Arc::new(DummyShellProvider)),
        ..Default::default()
    };
    Rc::new(RefCell::new(BaseDocument::new(config)))
}

/// Build an `html > body` skeleton and return the ops core plus the body id.
fn make_doc_with_skeleton() -> (OpsCore, NodeId) {
    let doc = make_base_document();
    let mut ops = OpsCore::new(Rc::clone(&doc));
    let root = doc.borrow().root_node().id;
    let html = ops.create_element("html");
    ops.append_child(root, html);
    let body = ops.create_element("body");
    ops.append_child(html, body);
    (ops, body)
}

/// A main-button mouse pointer event at page/client coordinates `(x, y)`.
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

/// The `data-naivi-id` attribute local name (not a registered HTML atom).
fn data_naivi_id() -> LocalName {
    LocalName::from("data-naivi-id")
}

/// A sink that records drained events for assertions.
#[derive(Default)]
struct RecordingSink(Rc<RefCell<Vec<NaiviEvent>>>);

impl EventSink for RecordingSink {
    fn on_event(&mut self, event: NaiviEvent) {
        self.0.borrow_mut().push(event);
    }
}

// ---------------------------------------------------------------------------
// tree
// ---------------------------------------------------------------------------

#[test]
fn create_element_and_append_child() {
    let (mut ops, body) = make_doc_with_skeleton();

    let div = ops.create_element("div");
    ops.append_child(body, div);
    let span = ops.create_element("span");
    ops.append_child(body, span);

    let doc = ops.doc.borrow();
    let body_node = doc.get_node(body).unwrap();
    assert_eq!(body_node.children.len(), 2);
    assert_eq!(body_node.children[0], div);
    assert_eq!(body_node.children[1], span);
    assert_eq!(doc.get_node(div).unwrap().parent, Some(body));
    assert_eq!(doc.get_node(span).unwrap().parent, Some(body));
    assert!(doc.get_node(div).unwrap().element_data().is_some());
}

#[test]
fn create_text_node_and_set_text() {
    let (mut ops, body) = make_doc_with_skeleton();

    let text = ops.create_text_node("hello");
    ops.append_child(body, text);
    {
        let doc = ops.doc.borrow();
        assert_eq!(doc.get_node(text).unwrap().text_content(), "hello");
        assert!(doc.get_node(text).unwrap().is_text_node());
    }

    ops.set_text(text, "world");
    let doc = ops.doc.borrow();
    assert_eq!(doc.get_node(text).unwrap().text_content(), "world");
}

// ---------------------------------------------------------------------------
// attributes
// ---------------------------------------------------------------------------

#[test]
fn attribute_round_trip() {
    let (mut ops, body) = make_doc_with_skeleton();
    let div = ops.create_element("div");
    ops.append_child(body, div);

    ops.set_attr(div, "class", "foo bar");
    ops.set_attr(div, "id", "main");
    {
        let doc = ops.doc.borrow();
        let node = doc.get_node(div).unwrap();
        assert_eq!(node.attr(local_name!("class")), Some("foo bar"));
        assert_eq!(node.attr(local_name!("id")), Some("main"));
    }

    ops.clear_attr(div, "class");
    let doc = ops.doc.borrow();
    let node = doc.get_node(div).unwrap();
    assert_eq!(node.attr(local_name!("class")), None);
    assert_eq!(node.attr(local_name!("id")), Some("main"));
}

// ---------------------------------------------------------------------------
// style
// ---------------------------------------------------------------------------

#[test]
fn style_properties_apply_and_remove() {
    let (mut ops, body) = make_doc_with_skeleton();
    let div = ops.create_element("div");
    ops.append_child(body, div);

    ops.set_style(div, "width", "120px");
    ops.set_style(div, "height", "60px");
    {
        let mut doc = ops.doc.borrow_mut();
        doc.resolve(0.0);
        let rect = doc.get_client_bounding_rect(div).expect("div should be laid out");
        assert_eq!(rect.width, 120.0);
        assert_eq!(rect.height, 60.0);
    }

    ops.remove_style(div, "height");
    {
        let mut doc = ops.doc.borrow_mut();
        doc.resolve(0.0);
        let rect = doc.get_client_bounding_rect(div).expect("div should be laid out");
        assert!(
            rect.height < 60.0,
            "removed height should collapse: {}",
            rect.height
        );
    }
}

// ---------------------------------------------------------------------------
// sibling insertion / replacement
// ---------------------------------------------------------------------------

#[test]
fn sibling_insertion_and_replacement() {
    let (mut ops, body) = make_doc_with_skeleton();

    let a = ops.create_element("a");
    ops.append_child(body, a);
    let b = ops.create_element("b");
    ops.append_child(body, b);
    let c = ops.create_element("c");
    ops.append_child(body, c);
    // body: [a, b, c]

    let x = ops.create_element("x");
    ops.insert_before(b, x);
    // body: [a, x, b, c]

    let y = ops.create_element("y");
    ops.insert_after(x, y);
    // body: [a, x, y, b, c]

    let z = ops.create_element("z");
    ops.replace_node(b, z);
    // body: [a, x, y, z, c]

    let doc = ops.doc.borrow();
    let body_node = doc.get_node(body).unwrap();
    let kids: Vec<NodeId> = body_node.children.iter().copied().collect();
    assert_eq!(kids, vec![a, x, y, z, c]);

    // `b` was detached by the replacement (mutator `replace_node_with` detaches
    // but does not drop), and `z` took its place.
    assert_eq!(doc.get_node(b).unwrap().parent, None);
    assert_eq!(doc.get_node(z).unwrap().parent, Some(body));
    for kid in [a, x, y, z, c] {
        assert_eq!(doc.get_node(kid).unwrap().parent, Some(body));
    }
}

// ---------------------------------------------------------------------------
// event bindings
// ---------------------------------------------------------------------------

#[test]
fn bind_and_unbind_event() {
    let (mut ops, body) = make_doc_with_skeleton();
    let div = ops.create_element("div");
    ops.append_child(body, div);

    ops.bind_event(div, NaiviEventKind::Click);
    ops.bind_event(div, NaiviEventKind::PointerDown);
    {
        let doc = ops.doc.borrow();
        let node = doc.get_node(div).unwrap();
        let expected = div.as_u64().to_string();
        assert_eq!(node.attr(data_naivi_id()), Some(expected.as_str()));
    }
    assert_eq!(
        ops.bound_kinds(div),
        vec![NaiviEventKind::Click, NaiviEventKind::PointerDown]
    );

    // Unbinding one kind keeps the attribute (the node is still bound).
    ops.unbind_event(div, NaiviEventKind::Click);
    assert_eq!(ops.bound_kinds(div), vec![NaiviEventKind::PointerDown]);
    {
        let doc = ops.doc.borrow();
        let node = doc.get_node(div).unwrap();
        let expected = div.as_u64().to_string();
        assert_eq!(node.attr(data_naivi_id()), Some(expected.as_str()));
    }

    // Unbinding the last kind clears the attribute and the registry entry.
    ops.unbind_event(div, NaiviEventKind::PointerDown);
    assert!(ops.bound_kinds(div).is_empty());
    let doc = ops.doc.borrow();
    assert_eq!(doc.get_node(div).unwrap().attr(data_naivi_id()), None);
}

// ---------------------------------------------------------------------------
// batch ops
// ---------------------------------------------------------------------------

#[test]
fn apply_ops_batch_returns_created_ids() {
    let (mut ops, body) = make_doc_with_skeleton();

    // First batch: create nodes; ids are returned in op order.
    let created = ops.apply_ops(&[
        NaiviOp::CreateElement {
            tag: "div".to_string(),
        },
        NaiviOp::CreateElement {
            tag: "span".to_string(),
        },
    ]);
    assert_eq!(created.len(), 2);
    assert_eq!(created[0].0, 0);
    assert_eq!(created[1].0, 1);
    let div = created[0].1;
    let span = created[1].1;

    // Second batch: reference the returned ids.
    let created_again = ops.apply_ops(&[
        NaiviOp::AppendChild {
            parent: body,
            child: div,
        },
        NaiviOp::SetStyle {
            node: div,
            name: "width".to_string(),
            value: "10px".to_string(),
        },
        NaiviOp::AppendChild {
            parent: div,
            child: span,
        },
        NaiviOp::BindEvent {
            node: div,
            kind: NaiviEventKind::Click,
        },
    ]);
    assert!(created_again.is_empty(), "no create ops in this batch");

    let doc = ops.doc.borrow();
    let body_node = doc.get_node(body).unwrap();
    assert_eq!(body_node.children.len(), 1);
    assert_eq!(body_node.children[0], div);

    let div_node = doc.get_node(div).unwrap();
    assert_eq!(div_node.children.len(), 1);
    assert_eq!(div_node.children[0], span);
    assert!(div_node.element_data().unwrap().style_attribute.is_some());
    assert_eq!(
        div_node.attr(data_naivi_id()),
        Some(div.as_u64().to_string().as_str())
    );
}

// ---------------------------------------------------------------------------
// event dispatch through the Document
// ---------------------------------------------------------------------------

#[test]
fn handle_ui_event_queues_bound_click_only() {
    let mut doc = NaiviDocument::new(make_base_document());
    // The ops core shares the document's registry, so bindings made through it
    // are visible to the document's event handler.
    let mut ops = doc.ops_core();

    let root = doc.inner.borrow().root_node().id;
    let html = ops.create_element("html");
    ops.append_child(root, html);
    let body = ops.create_element("body");
    ops.append_child(html, body);

    // A 100x100 box at the origin, bound to `click`.
    let bound = ops.create_element("div");
    ops.append_child(body, bound);
    ops.set_style(bound, "position", "absolute");
    ops.set_style(bound, "left", "0px");
    ops.set_style(bound, "top", "0px");
    ops.set_style(bound, "width", "100px");
    ops.set_style(bound, "height", "100px");
    ops.bind_event(bound, NaiviEventKind::Click);

    // A second 100x100 box at x=200, NOT bound.
    let unbound = ops.create_element("div");
    ops.append_child(body, unbound);
    ops.set_style(unbound, "position", "absolute");
    ops.set_style(unbound, "left", "200px");
    ops.set_style(unbound, "top", "0px");
    ops.set_style(unbound, "width", "100px");
    ops.set_style(unbound, "height", "100px");

    // Lay out so the pointer hit-test can resolve boxes.
    doc.inner_mut().resolve(0.0);

    // Install a recording sink.
    let recorded = Rc::new(RefCell::new(Vec::new()));
    doc.set_event_sink(Box::new(RecordingSink(Rc::clone(&recorded))));

    // Click inside the bound box: the bound node's (node, kind) must be queued.
    let click = main_button_pointer_event(50.0, 50.0);
    doc.handle_ui_event(UiEvent::PointerDown(click.clone()));
    doc.handle_ui_event(UiEvent::PointerUp(click));

    assert!(doc.poll(None), "poll should drain the queued click");
    {
        let drained = recorded.borrow();
        assert_eq!(drained.len(), 1);
        assert_eq!(drained[0].node, bound);
        assert_eq!(drained[0].kind, NaiviEventKind::Click);
        assert_eq!(drained[0].client_x, 50.0);
        assert_eq!(drained[0].client_y, 50.0);
    }

    // Click inside the UNBOUND box: nothing is queued, poll drains nothing.
    let click = main_button_pointer_event(250.0, 50.0);
    doc.handle_ui_event(UiEvent::PointerDown(click.clone()));
    doc.handle_ui_event(UiEvent::PointerUp(click));

    assert!(!doc.poll(None), "no bound events should be queued");
    assert_eq!(recorded.borrow().len(), 1);
}

// ---------------------------------------------------------------------------
// resolve
// ---------------------------------------------------------------------------

#[test]
fn resolve_after_ops_does_not_panic() {
    let (mut ops, body) = make_doc_with_skeleton();

    let div = ops.create_element("div");
    ops.append_child(body, div);
    let text = ops.create_text_node("hello naivi");
    ops.append_child(div, text);
    ops.set_attr(div, "class", "greeting");
    ops.set_style(div, "width", "200px");

    let mut doc = ops.doc.borrow_mut();
    doc.resolve(0.0);
}

// ---------------------------------------------------------------------------
// removed node ids are invalidated
// ---------------------------------------------------------------------------

#[test]
#[should_panic(expected = "invalid SlotMap key")]
fn removed_node_id_is_invalid() {
    let (mut ops, body) = make_doc_with_skeleton();
    let div = ops.create_element("div");
    ops.append_child(body, div);

    // Removing a node drops it; its id must no longer resolve.
    ops.remove_node(div);
    assert!(ops.doc.borrow().get_node(div).is_none());

    // Reusing the dropped id is a guest bug — this must panic.
    ops.set_attr(div, "class", "zombie");
}

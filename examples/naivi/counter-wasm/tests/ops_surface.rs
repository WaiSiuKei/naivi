//! Host-side coverage of the wasm export surface (U4, KTD1 protocol).
//!
//! The wasm exports in `src/lib.rs` are thin adapters over
//! [`OpsCore`](naivi_dom::OpsCore). This test drives the *same* ops the
//! exports call — create_element / create_text_node / set_text / set_attr /
//! set_style / append_child / insert_before / insert_after / replace_node /
//! remove_node / bind_event / unbind_event / drain_events — against a real
//! [`NaiviDocument`], proving the surface maps onto working engine ops.
//! (It cannot run on wasm32, so it runs on the host; the wasm32 build itself
//! is the compile-time proof that every export resolves to an `OpsCore` op.)

use blitz_dom::{BaseDocument, Document, DocumentConfig, local_name};
use blitz_traits::shell::{ColorScheme, DummyShellProvider, Viewport};
use naivi_dom::{EventSink, NaiviDocument, NaiviEvent, NaiviEventKind, NaiviOp, NoopEventSink};
use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

/// A [`BaseDocument`] with a dummy shell provider so mutator-drop redraw
/// calls don't panic (same setup as the U3 ops tests).
fn make_base_document() -> Rc<RefCell<BaseDocument>> {
    let config = DocumentConfig {
        viewport: Some(Viewport::new(800, 600, 1.0, ColorScheme::Light)),
        shell_provider: Some(Arc::new(DummyShellProvider)),
        ..Default::default()
    };
    Rc::new(RefCell::new(BaseDocument::new(config)))
}

/// A sink that records drained events.
#[derive(Default)]
struct RecordingSink(Rc<RefCell<Vec<NaiviEvent>>>);

impl EventSink for RecordingSink {
    fn on_event(&mut self, event: NaiviEvent) {
        self.0.borrow_mut().push(event);
    }
}

/// Every op the U4 wasm exports call, driven against a real document.
#[test]
fn export_surface_ops_work() {
    let inner = make_base_document();
    let mut doc = NaiviDocument::new(inner);
    let events = Rc::new(RefCell::new(Vec::new()));
    doc.set_event_sink(Box::new(RecordingSink(Rc::clone(&events))));
    let mut core = doc.ops_core();

    // create_element / create_text_node / append_child
    let root = core.create_element("html");
    let p = core.create_element("p");
    let text = core.create_text_node("hello");
    core.append_child(root, p);
    core.append_child(p, text);

    // set_text / set_attr / set_style
    core.set_text(text, "world");
    core.set_attr(p, "class", "lede");
    core.set_attr(p, "id", "intro");
    core.set_style(p, "color", "red");

    // insert_before / insert_after / replace_node
    let spacer = core.create_element("br");
    core.insert_before(p, spacer);
    let after = core.create_element("hr");
    core.insert_after(p, after);
    let replacement = core.create_element("span");
    core.replace_node(spacer, replacement);

    // bind_event / unbind_event (all kinds — what the wasm unbind_event does)
    core.bind_event(p, NaiviEventKind::Click);
    core.bind_event(p, NaiviEventKind::PointerMove);
    for kind in NaiviEventKind::ALL {
        core.unbind_event(p, kind);
    }
    assert!(core.bound_kinds(p).is_empty());

    // remove_node
    core.remove_node(after);
    core.remove_node(replacement);

    // Drain path (app-loop poll) works without panicking.
    assert!(!doc.drain_events());
    assert!(events.borrow().is_empty());

    // Text content / attributes landed on the document.
    let doc_ref = doc.inner();
    assert_eq!(doc_ref.get_node(text).unwrap().text_content(), "world");
    assert_eq!(doc_ref.get_node(p).unwrap().attr(local_name!("class")), Some("lede"));
    assert_eq!(doc_ref.get_node(p).unwrap().attr(local_name!("id")), Some("intro"));
    // Removed nodes are gone.
    assert!(doc_ref.get_node(after).is_none());
    assert!(doc_ref.get_node(replacement).is_none());
}

/// The `attach_document_root` export wires the facade body to the document
/// root — without it, resolve / hit-test report "No DOM" and nothing renders.
#[test]
fn attach_document_root_wires_facade_body() {
    let inner = make_base_document();
    let mut doc = NaiviDocument::new(inner);
    doc.set_event_sink(Box::new(NoopEventSink));
    let mut core = doc.ops_core();

    {
        let d = doc.inner();
        let root_id = d.root_node().id;
        assert!(d.get_node(root_id).unwrap().children.is_empty());
    }

    let body = core.create_element("body");
    core.attach_document_root(body);

    let d = doc.inner();
    let root_id = d.root_node().id;
    assert_eq!(d.get_node(root_id).unwrap().children.first(), Some(&body));
    assert_eq!(d.get_node(body).unwrap().parent, Some(root_id));
}

/// The same surface driven as an `apply_ops` batch (the shared-core batch path
/// used by other channels) still lands.
#[test]
fn export_surface_ops_via_batch() {
    let inner = make_base_document();
    let mut doc = NaiviDocument::new(inner);
    doc.set_event_sink(Box::new(NoopEventSink));
    let mut core = doc.ops_core();

    let root = core.create_element("div");
    let created = core.apply_ops(&[
        NaiviOp::CreateElement { tag: "p".into() },
        NaiviOp::CreateTextNode { text: "hi".into() },
    ]);
    let (_, p) = created[0];
    let (_, text) = created[1];
    core.apply_ops(&[
        NaiviOp::AppendChild { parent: root, child: p },
        NaiviOp::AppendChild { parent: p, child: text },
        NaiviOp::SetText { node: text, text: "hi".into() },
    ]);
    assert_eq!(created.len(), 2);
    let doc_ref = doc.inner();
    assert_eq!(doc_ref.get_node(text).unwrap().text_content(), "hi");
}

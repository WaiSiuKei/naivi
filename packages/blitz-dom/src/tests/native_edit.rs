//! Unit tests for the engine-owned native-edit session (U2): session
//! lifecycle on focus/blur, bidirectional value sync, key/composition
//! forwarding, Tab traversal, stale-event guard, fail-close, and coverage.

use crate::{Attribute, BaseDocument, Document, DocumentConfig, NodeId, qual_name};
use blitz_traits::native_input::{
    NativeEditAttrs, NativeEditEvent, NativeEditGeometry, NativeEditStyle,
};
use blitz_traits::shell::{ColorScheme, ShellProvider, Viewport};
use std::sync::{Arc, Mutex};

/// A shell provider that records native-edit calls and reports a configurable
/// capability/begin result.
struct MockNativeShell {
    capable: bool,
    begin_ok: bool,
    calls: Mutex<Vec<String>>,
    set_values: Mutex<Vec<String>>,
}

impl MockNativeShell {
    fn capable(begin_ok: bool) -> Arc<Self> {
        Arc::new(Self {
            capable: true,
            begin_ok,
            calls: Mutex::new(Vec::new()),
            set_values: Mutex::new(Vec::new()),
        })
    }
}

impl ShellProvider for MockNativeShell {
    fn native_edit_capable(&self) -> bool {
        self.capable
    }
    fn begin_native_edit_session(
        &self,
        _node_id: NodeId,
        _geometry: &NativeEditGeometry,
        _style: &NativeEditStyle,
        _attrs: &NativeEditAttrs,
    ) -> bool {
        self.calls.lock().unwrap().push("begin".to_string());
        self.begin_ok
    }
    fn native_edit_set_value(&self, value: &str) {
        self.set_values.lock().unwrap().push(value.to_string());
    }
    fn update_native_edit_geometry(&self, _geometry: &NativeEditGeometry) {
        self.calls.lock().unwrap().push("update_geometry".to_string());
    }
    fn update_native_edit_style(&self, _style: &NativeEditStyle) {
        self.calls.lock().unwrap().push("update_style".to_string());
    }
    fn end_native_edit_session(&self) {
        self.calls.lock().unwrap().push("end".to_string());
    }
    fn set_ime_enabled(&self, _enabled: bool) {
        self.calls.lock().unwrap().push("ime_enabled".to_string());
    }
    fn set_ime_cursor_area(&self, _x: f32, _y: f32, _width: f32, _height: f32) {
        self.calls.lock().unwrap().push("ime_area".to_string());
    }
}

/// Build a document containing `<input type="{input_type}">`, a sibling
/// `<div>` (not covered) and a second text `<input>`, with a mock native
/// shell installed. Layout is resolved so the inputs have `TextInput` special
/// data (coverage) and geometry. Returns `(doc, shell, input, input2, div)`.
fn make_doc(
    input_type: &str,
) -> (BaseDocument, Arc<MockNativeShell>, NodeId, NodeId, NodeId) {
    let shell = MockNativeShell::capable(true);
    let mut doc = BaseDocument::new(DocumentConfig {
        viewport: Some(Viewport::new(400, 300, 1.0, ColorScheme::Light)),
        ..Default::default()
    });
    doc.set_shell_provider(shell.clone());

    let root_id = doc.root_node().id;
    let mut m = doc.mutate();
    let html = m.create_element(qual_name!("html"), vec![]);
    let body = m.create_element(qual_name!("body"), vec![]);
    let div = m.create_element(qual_name!("div"), vec![]);
    let input = m.create_element(
        qual_name!("input"),
        vec![Attribute {
            name: qual_name!("type", html),
            value: input_type.to_string(),
        }],
    );
    let input2 = m.create_element(
        qual_name!("input"),
        vec![Attribute {
            name: qual_name!("type", html),
            value: "text".to_string(),
        }],
    );
    m.append_children(body, &[div, input, input2]);
    m.append_children(html, &[body]);
    m.append_children(root_id, &[html]);
    drop(m);
    doc.resolve(0.0);
    (doc, shell, input, input2, div)
}

#[test]
fn focus_on_covered_input_starts_session_and_calls_begin() {
    let (mut doc, shell, input, _input2, _div) = make_doc("text");
    assert!(doc.set_focus_to(input));

    let session = doc.native_edit_session.clone().expect("session started");
    assert_eq!(session.node_id, input);
    assert!(shell.calls.lock().unwrap().contains(&"begin".to_string()));
    // Geometry is non-default: the input has a real box.
    assert!(session.geometry.border_box.2 > 0.0);
}

#[test]
fn session_only_starts_for_covered_inputs() {
    let (mut doc, shell, _input, _input2, div) = make_doc("text");
    // A non-input element must not start a session even with a capable shell.
    assert!(doc.set_focus_to(div));
    assert!(doc.native_edit_session.is_none());
    assert!(shell.calls.lock().unwrap().is_empty());
}

#[test]
fn value_changed_mirrors_into_dom_and_dispatches_input() {
    let (mut doc, shell, input, _input2, _div) = make_doc("text");
    doc.set_focus_to(input);

    doc.handle_native_edit_event(NativeEditEvent::ValueChanged {
        node_id: input,
        value: "hi".to_string(),
    });

    let session = doc.native_edit_session.clone().unwrap();
    assert_eq!(session.last_value, "hi");
    let attr_value = doc
        .get_node(input)
        .and_then(|n| n.element_data())
        .and_then(|e| e.attr(markup5ever::local_name!("value")))
        .unwrap()
        .to_string();
    assert_eq!(attr_value, "hi");
    // Mirrored: the engine must NOT push the mirrored value back into the
    // control (no loop). The only push is the initial empty seed at session
    // start.
    assert!(!shell.set_values.lock().unwrap().contains(&"hi".to_string()));
    // Input dispatched to the guest queue.
    let pending = doc.drain_native_edit_events();
    assert_eq!(pending.len(), 1);
    assert!(matches!(
        pending[0].data,
        blitz_traits::events::DomEventData::Input(ref e) if e.value == "hi"
    ));
}

#[test]
fn guest_value_set_pushes_to_control_without_input_event() {
    let (mut doc, shell, input, _input2, _div) = make_doc("text");
    doc.set_focus_to(input);

    // Guest/programmatic set (the value-attribute frame path). The session
    // start seeds an empty value first.
    let mut m = doc.mutate();
    m.set_attribute(input, qual_name!("value", html), "yo");
    drop(m);

    assert_eq!(
        *shell.set_values.lock().unwrap(),
        vec!["".to_string(), "yo".to_string()]
    );
    assert!(doc.native_edit_pending_events.is_empty());
}

/// While the session owns the node, keystroke mirrors must NOT paint the
/// value into the canvas input (the HTML overlay is the visible editor — no
/// duplicate/overlapping text, and no tofu before the script's slices load);
/// the final blur-commit must paint the settled value.
#[test]
fn keystroke_mirrors_suppress_canvas_paint_until_commit() {
    let (mut doc, _shell, input, _input2, _div) = make_doc("text");
    doc.set_focus_to(input);
    let editor_text = |doc: &BaseDocument| {
        doc.get_node(input)
            .and_then(|n| n.element_data())
            .and_then(|e| e.text_input_data())
            .map(|d| d.editor.text().to_string())
            .unwrap()
    };
    // Session start clears the canvas input's text (nothing stale underneath).
    assert_eq!(editor_text(&doc), "");

    // Keystroke mirror (ValueChanged): value attribute updates, canvas text
    // stays empty.
    doc.handle_native_edit_event(NativeEditEvent::ValueChanged {
        node_id: input,
        value: "中文".to_string(),
    });
    let attr = doc
        .get_node(input)
        .and_then(|n| n.element_data())
        .and_then(|e| e.attr(markup5ever::local_name!("value")))
        .unwrap()
        .to_string();
    assert_eq!(attr, "中文");
    assert_eq!(
        editor_text(&doc),
        "",
        "keystroke mirror must not paint into the canvas input"
    );
    assert!(doc.native_edit_paint_suppressed);

    // Final blur-commit: paints the settled value and ends the session.
    doc.handle_native_edit_event(NativeEditEvent::Committed {
        node_id: input,
        value: "中文测试".to_string(),
    });
    assert_eq!(editor_text(&doc), "中文测试");
    assert!(doc.native_edit_session.is_none(), "commit ends the session");
    assert!(!doc.native_edit_paint_suppressed);
}

#[test]
fn tab_traversal_ends_old_session_and_starts_next() {
    let (mut doc, shell, input, _input2, _div) = make_doc("text");
    doc.set_focus_to(input);
    assert!(doc.native_edit_session.is_some());

    doc.handle_native_edit_event(NativeEditEvent::Tab {
        node_id: input,
        shift: false,
    });

    // First session ended, a new one started on the second covered input.
    let session = doc.native_edit_session.clone().expect("new session started");
    assert_ne!(session.node_id, input);
    let calls = shell.calls.lock().unwrap();
    assert_eq!(calls.iter().filter(|c| *c == "end").count(), 1);
    assert_eq!(calls.iter().filter(|c| *c == "begin").count(), 2);
}

#[test]
fn key_events_reach_guest_queue_handler_only() {
    let (mut doc, _shell, input, _input2, _div) = make_doc("text");
    doc.set_focus_to(input);

    doc.handle_native_edit_event(NativeEditEvent::KeyUp {
        node_id: input,
        key: keyboard_types::Key::Enter,
        code: keyboard_types::Code::Enter,
    });

    let pending = doc.drain_native_edit_events();
    assert!(matches!(
        pending[0].data,
        blitz_traits::events::DomEventData::KeyUp(_)
    ));
}

#[test]
fn keydown_reaches_guest_queue_handler_only() {
    let (mut doc, _shell, input, _input2, _div) = make_doc("text");
    doc.set_focus_to(input);

    doc.handle_native_edit_event(NativeEditEvent::KeyDown {
        node_id: input,
        key: keyboard_types::Key::Character("a".into()),
        code: keyboard_types::Code::KeyA,
    });

    let pending = doc.drain_native_edit_events();
    assert!(matches!(
        pending[0].data,
        blitz_traits::events::DomEventData::KeyDown(_)
    ));
    // The parley editor is untouched (guest-only dispatch, KTD8).
    let editor_text = doc
        .get_node(input)
        .and_then(|n| n.element_data())
        .and_then(|e| e.text_input_data())
        .map(|d| d.editor.raw_text().to_string());
    assert_eq!(editor_text.as_deref(), Some(""));
}

#[test]
fn driver_suppresses_winit_keys_for_session_element() {
    // R2/KTD8: while a native-edit session is active, winit key events for the
    // session element must not reach the parley editor (they arrive via
    // `NativeEditEvent` instead) — the authoritative double-input guard.
    let key_event = blitz_traits::events::BlitzKeyEvent {
        key: keyboard_types::Key::Character("x".into()),
        code: keyboard_types::Code::KeyX,
        modifiers: Default::default(),
        location: Default::default(),
        is_auto_repeating: false,
        is_composing: false,
        state: blitz_traits::events::KeyState::Pressed,
        text: Some("x".into()),
    };
    let (mut doc, _shell, input, _input2, _div) = make_doc("text");
    doc.set_focus_to(input);
    assert!(doc.native_edit_session.is_some());

    doc.handle_ui_event(blitz_traits::events::UiEvent::KeyDown(key_event.clone()));
    let editor_text = doc
        .get_node(input)
        .and_then(|n| n.element_data())
        .and_then(|e| e.text_input_data())
        .map(|d| d.editor.raw_text().to_string());
    assert_eq!(
        editor_text.as_deref(),
        Some(""),
        "winit keys must not feed the parley editor during a session"
    );

    // Without a session the same key would edit the parley text.
    doc.end_native_edit_session();
    Document::handle_ui_event(&mut doc, blitz_traits::events::UiEvent::KeyDown(key_event));
    let editor_text = doc
        .get_node(input)
        .and_then(|n| n.element_data())
        .and_then(|e| e.text_input_data())
        .map(|d| d.editor.raw_text().to_string());
    assert_eq!(editor_text.as_deref(), Some("x"));
}

#[test]
fn composition_commit_reaches_guest_without_parley_edit() {
    let (mut doc, _shell, input, _input2, _div) = make_doc("text");
    doc.set_focus_to(input);

    doc.handle_native_edit_event(NativeEditEvent::CompositionCommit {
        node_id: input,
        text: "中".to_string(),
    });

    let pending = doc.drain_native_edit_events();
    // Browser order: Ime Commit first, then the mirrored Input.
    assert!(matches!(
        pending[0].data,
        blitz_traits::events::DomEventData::Ime(blitz_traits::events::BlitzImeEvent::Commit(ref t))
            if t == "中"
    ));
    assert!(matches!(
        pending[1].data,
        blitz_traits::events::DomEventData::Input(ref e) if e.value == "中"
    ));
    // The committed text is mirrored into the value attribute (R4/R8). The
    // parley editor is NOT synced mid-session: the HTML overlay is the
    // visible editor, so the canvas input must not paint (duplicate text /
    // tofu before the script's slices load). The final blur-commit paints
    // the settled value.
    let attr_value = doc
        .get_node(input)
        .and_then(|n| n.element_data())
        .and_then(|e| e.attr(markup5ever::local_name!("value")))
        .unwrap()
        .to_string();
    assert_eq!(attr_value, "中");
    // Parley editor stays empty mid-session (paint suppressed).
    let editor_text = doc
        .get_node(input)
        .and_then(|n| n.element_data())
        .and_then(|e| e.text_input_data())
        .map(|d| d.editor.raw_text().to_string());
    assert_eq!(editor_text.as_deref(), Some(""));
}

#[test]
fn committed_mirrors_value_then_ends_session() {
    let (mut doc, shell, input, _input2, _div) = make_doc("text");
    doc.set_focus_to(input);

    doc.handle_native_edit_event(NativeEditEvent::Committed {
        node_id: input,
        value: "final".to_string(),
    });

    assert!(doc.native_edit_session.is_none());
    assert!(shell.calls.lock().unwrap().contains(&"end".to_string()));
    let attr_value = doc
        .get_node(input)
        .and_then(|n| n.element_data())
        .and_then(|e| e.attr(markup5ever::local_name!("value")))
        .unwrap()
        .to_string();
    assert_eq!(attr_value, "final");
}

#[test]
fn stale_events_are_dropped_after_session_end() {
    let (mut doc, _shell, input, _input2, _div) = make_doc("text");
    doc.set_focus_to(input);
    doc.end_native_edit_session();
    assert!(doc.native_edit_session.is_none());

    // A queued backend event arriving after the session ended is dropped.
    doc.handle_native_edit_event(NativeEditEvent::Committed {
        node_id: input,
        value: "late".to_string(),
    });
    assert!(doc.native_edit_pending_events.is_empty());
    // Idempotent end is safe.
    doc.end_native_edit_session();
}

#[test]
fn stale_event_from_previous_session_node_is_dropped() {
    // F1: a backend `Committed` from a PREVIOUS session's control (delivered
    // asynchronously after the next session started, e.g. the old overlay's
    // teardown blur) must not be applied to the new session's element. This is
    // the source-blind stale-guard regression: the event carries the previous
    // node's id and is rejected even though a session is active.
    let (mut doc, shell, input, input2, _div) = make_doc("text");
    doc.set_focus_to(input);
    // Move focus to the second covered input: session A ends, session B starts.
    doc.set_focus_to(input2);
    let session_b = doc.native_edit_session.clone().unwrap();
    assert_eq!(session_b.node_id, input2);

    // A late teardown event from input (node A) arrives now.
    doc.handle_native_edit_event(NativeEditEvent::Committed {
        node_id: input,
        value: String::new(),
    });

    // Session B is untouched: still active, value attribute unmodified.
    assert!(doc.native_edit_session.is_some());
    assert_eq!(doc.native_edit_session.as_ref().unwrap().node_id, input2);
    let attr_value = doc
        .get_node(input2)
        .and_then(|n| n.element_data())
        .and_then(|e| e.attr(markup5ever::local_name!("value")))
        .map(|v| v.to_string());
    assert_eq!(attr_value, None, "B's value attribute must be untouched");
    // No spurious input dispatched for B.
    assert!(doc.native_edit_pending_events.is_empty());
    // Session B still ends on a genuine commit for its own node.
    doc.handle_native_edit_event(NativeEditEvent::Committed {
        node_id: input2,
        value: "done".to_string(),
    });
    assert!(doc.native_edit_session.is_none());
    assert!(shell.calls.lock().unwrap().contains(&"end".to_string()));
}

#[test]
fn fail_close_keeps_parley_path_when_begin_returns_false() {
    let (mut doc, _shell, input, _input2, _div) = make_doc("text");
    // Replace the shell with one whose begin fails.
    let failing = MockNativeShell::capable(false);
    doc.set_shell_provider(failing.clone());

    doc.set_focus_to(input);
    // Session must not be marked active; the parley path remains.
    assert!(doc.native_edit_session.is_none());
    // Fail-close IME symmetry: since the parley path is retained, the winit
    // IME that `focus(..)` skipped must be re-enabled.
    let calls = failing.calls.lock().unwrap();
    assert!(
        calls.contains(&"ime_enabled".to_string()),
        "parley path must get winit IME after a failed session start, got {calls:?}"
    );
}

#[test]
fn blur_ends_session() {
    let (mut doc, shell, input, _input2, _div) = make_doc("text");
    doc.set_focus_to(input);
    assert!(doc.native_edit_session.is_some());

    doc.clear_focus();
    assert!(doc.native_edit_session.is_none());
    assert!(shell.calls.lock().unwrap().contains(&"end".to_string()));
}

#[test]
fn geometry_repush_only_when_box_changed() {
    let (mut doc, shell, input, _input2, _div) = make_doc("text");
    doc.set_focus_to(input);

    // Unchanged geometry → no re-push.
    let before = shell.calls.lock().unwrap().len();
    doc.update_native_edit_session_geometry();
    assert_eq!(shell.calls.lock().unwrap().len(), before);

    // Force a geometry change and re-push → update fired, style re-pushed
    // alongside (R12, U2.8).
    {
        let mut session = doc.native_edit_session.as_mut().unwrap();
        session.geometry.border_box.2 += 10.0;
    }
    doc.update_native_edit_session_geometry();
    let calls = shell.calls.lock().unwrap();
    assert!(calls.contains(&"update_geometry".to_string()));
    assert!(
        calls.contains(&"update_style".to_string()),
        "style re-push (R12) must follow a box change"
    );
}

#[test]
fn guest_value_set_syncs_last_value() {
    // F15: after the guest sets the value (R5 push), a later blur-commit of
    // the SAME value must be recognized as a no-op — no spurious `input` for
    // the guest's own text.
    let (mut doc, shell, input, _input2, _div) = make_doc("text");
    doc.set_focus_to(input);

    let mut m = doc.mutate();
    m.set_attribute(input, qual_name!("value", html), "ab");
    drop(m);
    assert!(shell.set_values.lock().unwrap().contains(&"ab".to_string()));

    doc.handle_native_edit_event(NativeEditEvent::Committed {
        node_id: input,
        value: "ab".to_string(),
    });
    // Session ended; no input event dispatched for the guest's own value.
    assert!(doc.native_edit_session.is_none());
    assert!(doc.native_edit_pending_events.is_empty());
}

#[test]
fn submit_runs_implicit_form_submission_and_ends_session() {
    let (mut doc, shell, input, _input2, _div) = make_doc("text");
    doc.set_focus_to(input);

    // No form owner in this doc: implicit submission is a safe no-op and the
    // session still ends.
    doc.handle_native_edit_event(NativeEditEvent::Submit { node_id: input });
    assert!(doc.native_edit_session.is_none());
    assert!(shell.calls.lock().unwrap().contains(&"end".to_string()));
}

#[test]
fn focus_skip_ime_for_session_element() {
    // The covered input must not receive winit IME enable/area calls when the
    // session owns editing (KTD5/R2): the native control owns IME. Pins that
    // `focus()` was called with `enable_ime=false` and no IME calls leaked.
    let (mut doc, shell, input, _input2, _div) = make_doc("text");
    assert!(doc.set_focus_to(input));
    assert!(doc.native_edit_session.is_some());
    let calls = shell.calls.lock().unwrap();
    assert!(
        !calls.iter().any(|c| c == "ime_enabled" || c == "ime_area"),
        "IME must be owned by the native control, got {calls:?}"
    );
}

#[test]
fn refocusing_an_ended_session_restarts_it() {
    // A session can end without a focus move (backend `Committed` on blur
    // while the element keeps blitz focus). Re-clicking the still-focused
    // covered input must reopen the control — `set_focus_to` returns false
    // (focus unchanged) but still restarts the session.
    let (mut doc, shell, input, _input2, _div) = make_doc("text");
    doc.set_focus_to(input);
    assert!(doc.native_edit_session.is_some());

    doc.end_native_edit_session();
    assert!(doc.native_edit_session.is_none());

    assert!(!doc.set_focus_to(input));
    assert!(doc.native_edit_session.is_some());
    assert!(shell.calls.lock().unwrap().contains(&"begin".to_string()));

    // An active session is not restarted on re-click.
    doc.end_native_edit_session();
    doc.set_focus_to(input);
    let begins = shell
        .calls
        .lock()
        .unwrap()
        .iter()
        .filter(|c| c.as_str() == "begin")
        .count();
    assert!(!doc.set_focus_to(input));
    assert!(doc.native_edit_session.is_some());
    let begins2 = shell
        .calls
        .lock()
        .unwrap()
        .iter()
        .filter(|c| c.as_str() == "begin")
        .count();
    assert_eq!(begins2, begins, "active session must not be re-created");
}

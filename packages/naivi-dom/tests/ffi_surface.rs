//! U8 native-channel FFI surface tests (feature `quickjs`).
//!
//! Drives `globalThis.naive` (`build_naive_namespace`) from a real rquickjs
//! runtime: `flush_frame` applies a frame and delivers `frame_rejected` to the
//! JS callback (R10: same shape as the wasm channel).

#![cfg(feature = "quickjs")]

use blitz_dom::{BaseDocument, Document, DocumentConfig};
use blitz_traits::events::{
    BlitzPointerEvent, BlitzPointerId, MouseEventButton, MouseEventButtons, Point,
    PointerCoords, PointerDetails, UiEvent,
};
use blitz_traits::shell::{ColorScheme, DummyShellProvider, Viewport};
use keyboard_types::Modifiers;
use naivi_dom::ffi::{self, QueuedEvent};
use naivi_dom::generated::op;
use naivi_dom::{EventSink, NaiviDocument, NaiviEvent, NaiviEventKind};
use rquickjs::{Context, Function, Object, Runtime, TypedArray};
use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

/// A sink mirroring the native channel: `NaiviEvent` → `QueuedEvent` → the
/// FFI queue (delivered to the JS callback by `drain_events`).
struct FfiSink;

impl EventSink for FfiSink {
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

fn make_doc() -> NaiviDocument {
    let config = DocumentConfig {
        viewport: Some(Viewport::new(800, 600, 1.0, ColorScheme::Light)),
        shell_provider: Some(Arc::new(DummyShellProvider)),
        ..Default::default()
    };
    NaiviDocument::with_config(config)
}

/// Encode a frame in the U4 wire format (mirrors the TS FrameWriter).
fn frame(seq: u32, ops: &[&[u8]]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&seq.to_le_bytes());
    out.extend_from_slice(&(ops.len() as u16).to_le_bytes());
    for op in ops {
        out.extend_from_slice(op);
    }
    out
}

fn op(code: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = vec![code];
    out.extend_from_slice(payload);
    out
}

fn u32(v: u32) -> Vec<u8> {
    v.to_le_bytes().to_vec()
}

fn str16(s: &str) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&(s.len() as u16).to_le_bytes());
    out.extend_from_slice(s.as_bytes());
    out
}

#[test]
fn ffi_flush_frame_applies_and_reports_rejections() {
    let runtime = Runtime::new().unwrap();
    let context = Context::full(&runtime).unwrap();
    context.with(|ctx| {
        let doc = Rc::new(RefCell::new(make_doc()));
        ffi::install_document(Rc::clone(&doc));

        let naive = ffi::build_naive_namespace(ctx.clone()).unwrap();
        ctx.globals().set("naive", naive).unwrap();

        // Register a rejection recorder in JS.
        let _: () = ctx
            .eval(
                "globalThis.__rejected = []; \
                 naive.set_frame_rejected_callback((seq, reason) => \
                   globalThis.__rejected.push([seq, reason]));",
            )
            .unwrap();

        // Establish the facade body, then a <p class="lede">hello</p>.
        let f0 = frame(0, &[
            &op(op::CREATE_ELEMENT, &[u32(100), str16("body")].concat()),
            &op(op::ATTACH_ROOT, &u32(100)),
        ]);
        let f1 = frame(1, &[
            &op(op::CREATE_ELEMENT, &[u32(1), str16("p")].concat()),
            &op(op::CREATE_TEXT, &[u32(2), str16("hello")].concat()),
            &op(op::APPEND_CHILD, &[u32(100), u32(1)].concat()),
            &op(op::APPEND_CHILD, &[u32(1), u32(2)].concat()),
            &op(op::SET_ATTR, &[u32(1), str16("class"), str16("lede")].concat()),
        ]);

        let flush: Function = {
            let naive: Object = ctx.globals().get("naive").unwrap();
            naive.get("flush_frame").unwrap()
        };
        flush.call::<_, ()>((TypedArray::new(ctx.clone(), f0).unwrap(),))
            .unwrap();
        flush.call::<_, ()>((TypedArray::new(ctx.clone(), f1).unwrap(),))
            .unwrap();

        // The document has the p with its attribute.
        let p = doc.borrow().ops_core().resolve_virtual(1).expect("virtual 1 mapped");
        assert_eq!(
            doc.borrow().inner.borrow().get_node(p).unwrap().attr("class".into()),
            Some("lede")
        );

        // A bad frame (unknown parent) → frame_rejected(9, 1) delivered to JS.
        let bad = frame(9, &[
            &op(op::CREATE_ELEMENT, &[u32(3), str16("div")].concat()),
            &op(op::APPEND_CHILD, &[u32(99), u32(3)].concat()),
        ]);
        flush.call::<_, ()>((TypedArray::new(ctx.clone(), bad).unwrap(),))
            .unwrap();

        let rejected: String = ctx
            .eval("globalThis.__rejected.map(x => x.join(',')).join(';')")
            .unwrap();
        assert_eq!(rejected, "9,1");
        // The whole bad frame was dropped (no stray div).
        assert!(doc.borrow().ops_core().resolve_virtual(3).is_none());

        ffi::clear_document();
        ffi::clear_all();
    });
}

/// U4 event callback: `drain_events` spreads the full payload + ordered bound
/// chain to the JS callback (KTD2/KTD3, OQ3 `Rest<Vec<Value>>`).
#[test]
fn ffi_event_callback_carries_payload_and_chain() {
    let runtime = Runtime::new().unwrap();
    let context = Context::full(&runtime).unwrap();
    context.with(|ctx| {
        let doc = Rc::new(RefCell::new(make_doc()));
        ffi::install_document(Rc::clone(&doc));

        let naive = ffi::build_naive_namespace(ctx.clone()).unwrap();
        ctx.globals().set("naive", naive).unwrap();

        // Record the spread callback args.
        let _: () = ctx
            .eval(
                "globalThis.__events = []; \
                 naive.set_event_callback((...args) => globalThis.__events.push(args));",
            )
            .unwrap();

        // Nested DOM: body > outer(v1) > inner(v2), both bound to `click`.
        {
            let mut doc = doc.borrow_mut();
            let mut ops = doc.ops_core();
            let root = doc.inner.borrow().root_node().id;
            let html = ops.create_element("html");
            ops.append_child(root, html);
            let body = ops.create_element("body");
            ops.append_child(html, body);
            let outer = ops.create_element_v(1, "div").unwrap();
            ops.append_child(body, outer);
            ops.set_style(outer, "position", "absolute");
            ops.set_style(outer, "left", "0px");
            ops.set_style(outer, "top", "0px");
            ops.set_style(outer, "width", "300px");
            ops.set_style(outer, "height", "300px");
            ops.bind_event_v(1, NaiviEventKind::Click).unwrap();
            let inner = ops.create_element_v(2, "div").unwrap();
            ops.append_child(outer, inner);
            ops.set_style(inner, "position", "absolute");
            ops.set_style(inner, "left", "50px");
            ops.set_style(inner, "top", "50px");
            ops.set_style(inner, "width", "100px");
            ops.set_style(inner, "height", "100px");
            ops.bind_event_v(2, NaiviEventKind::Click).unwrap();
            doc.inner_mut().resolve(0.0);
            doc.set_event_sink(Box::new(FfiSink));
        }

        // Click inside the inner box (75, 75).
        let click = main_button_pointer_event(75.0, 75.0);
        doc.borrow_mut().handle_ui_event(UiEvent::PointerDown(click.clone()));
        doc.borrow_mut().handle_ui_event(UiEvent::PointerUp(click));
        assert!(doc.borrow_mut().poll(None), "poll should drain the queued click");

        // Deliver the queued event to the JS callback.
        ffi::drain_events(&ctx).unwrap();

        // Args: (node, kind, x, y, key, code, value, button, buttons, deltaX,
        // deltaY, imeData, chain). Main button = 0, primary buttons = 1.
        let captured: String = ctx
            .eval("JSON.stringify(globalThis.__events[0])")
            .unwrap();
        assert_eq!(captured, "[2,0,75,75,\"\",\"\",\"\",0,1,0,0,\"\",[2,1]]");

        ffi::clear_document();
        ffi::clear_all();
    });
}

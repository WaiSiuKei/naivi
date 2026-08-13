//! U8 native-channel FFI surface tests (feature `quickjs`).
//!
//! Drives `globalThis.naive` (`build_naive_namespace`) from a real rquickjs
//! runtime: `flush_frame` applies a frame and delivers `frame_rejected` to the
//! JS callback (R10: same shape as the wasm channel).

#![cfg(feature = "quickjs")]

use blitz_dom::{BaseDocument, DocumentConfig};
use blitz_traits::shell::{ColorScheme, DummyShellProvider, Viewport};
use naivi_dom::ffi;
use naivi_dom::generated::op;
use naivi_dom::NaiviDocument;
use rquickjs::{Context, Function, Object, Runtime, TypedArray};
use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

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

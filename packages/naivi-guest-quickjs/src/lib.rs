//! naivi-guest-quickjs — the U5 native guest engine.
//!
//! Embeds QuickJS (rquickjs) to run naivi guest JS bundles in a native window.
//! The host publishes a `globalThis.naive` FFI namespace (built by
//! [`naivi_dom::ffi`], the native twin of the U4 wasm exports), evals the
//! guest bundle, and pumps the microtask queue each frame. Events flow from
//! blitz's dispatch through [`naivi_dom::EventSink`] → the FFI queue →
//! [`QuickJsGuest::drain_events`], which restores the persisted callback and
//! calls it inside `ctx.with`.
//!
//! Single-threaded, single-context. Mirrors naive's `naive-guest-quickjs`
//! lifecycle (KTD5: pump jobs outside `ctx.with`; KTD7: teardown order).

pub mod guest;

pub use guest::QuickJsGuest;

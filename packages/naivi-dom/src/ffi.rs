//! rquickjs (QuickJS-NG) FFI surface for the native channel (U8).
//!
//! Builds `globalThis.naive` — the native twin of the wasm channel (R10) —
//! with the binary-frame surface: [`flush_frame`] is the only DOM-mutation
//! entry (whole-frame transaction, KTD3), events return per-callback via
//! [`set_event_callback`] + [`drain_events`] (KD2), and rejections arrive via
//! [`set_frame_rejected_callback`] (self-heal, R15). Every JS-callable
//! function takes the current [`Ctx`] as its first argument and never calls
//! `Context::with` internally (re-entering the runtime lock from a callback
//! self-deadlocks; mirrors naive-guest-quickjs KTD5).
//!
//! ## Event path
//!
//! Mirrors the wasm channel: [`set_event_callback`] stores the guest callback
//! as a `Persistent<Function>`; the guest tick calls [`drain_events`] inside
//! `ctx.with`, restoring the callback and invoking it with
//! `(nodeId, kind, x, y, key, code, value)` where `nodeId` is the JS-assigned
//! **virtual id** (KTD2). The channel's [`EventSink`](crate::EventSink)
//! implementation feeds [`queue_event`].

use crate::NaiviDocument;
use rquickjs::{Ctx, Function, Object, Persistent, Result, TypedArray, Value};
use std::cell::RefCell;
use std::rc::Rc;

/// A single event queued for the guest callback.
#[derive(Clone, Debug)]
pub struct QueuedEvent {
    /// The bound node's **virtual id** (JS-assigned u32; crosses to JS as a
    /// `f64` number). Replaces the old u64 blitz `NodeId` (U6/KTD2).
    pub node: u32,
    /// The protocol `u8` event kind.
    pub kind: u8,
    /// Client (viewport-relative) coordinates, when present.
    pub x: f64,
    pub y: f64,
    /// Keyboard key (e.g. `"Enter"`) for key events; empty otherwise.
    pub key: String,
    /// Physical keyboard code for key events; empty otherwise.
    pub code: String,
    /// Full input value for `input` events; empty otherwise.
    pub value: String,
}

thread_local! {
    /// The single native naivi document, installed by the host before the
    /// guest bundle is evaled (one window per thread).
    static DOC: RefCell<Option<Rc<RefCell<NaiviDocument>>>> = const { RefCell::new(None) };
    /// The JS callback registered via `set_event_callback`.
    static EVENT_CALLBACK: RefCell<Option<Persistent<Function<'static>>>> = const { RefCell::new(None) };
    /// The JS callback registered via `set_frame_rejected_callback`.
    static REJECTED_CALLBACK: RefCell<Option<Persistent<Function<'static>>>> = const { RefCell::new(None) };
    /// Events queued by the native [`EventSink`](crate::EventSink), drained by
    /// the guest tick.
    static PENDING: RefCell<Vec<QueuedEvent>> = const { RefCell::new(Vec::new()) };
}

/// Install the document the FFI ops operate on. Call once, before evaling the
/// guest bundle.
pub fn install_document(doc: Rc<RefCell<NaiviDocument>>) {
    DOC.with(|slot| *slot.borrow_mut() = Some(doc));
}

/// Drop the installed document reference. The host must call this once the
/// event loop has exited: if the document outlives `main()`, the winit window
/// it holds (via the shell provider) is dropped during TLS teardown, which
/// panics on macOS — `objc2`'s autorelease-pool thread-local is already
/// destroyed by then, so `winit_appkit::Window::drop` → `Pool::new` aborts.
pub fn clear_document() {
    DOC.with(|slot| *slot.borrow_mut() = None);
}

// ── event plumbing (shared with the channel's EventSink) ────────────

/// Queue an event for the guest callback. Called by the native
/// [`EventSink`](crate::EventSink) implementation when
/// [`NaiviDocument::drain_events`](crate::NaiviDocument::drain_events) drains
/// the blitz-side queue.
pub fn queue_event(event: QueuedEvent) {
    PENDING.with(|pending| pending.borrow_mut().push(event));
}

fn take_pending() -> Vec<QueuedEvent> {
    PENDING.with(|pending| std::mem::take(&mut *pending.borrow_mut()))
}

/// Deliver every queued event to the JS callback. Must run inside `ctx.with`
/// (the caller holds the runtime lock); a throwing callback is logged and
/// skipped, never fatal.
pub fn drain_events(ctx: &Ctx<'_>) -> rquickjs::Result<()> {
    let pending = take_pending();
    if pending.is_empty() {
        return Ok(());
    }
    let Some(cb) = EVENT_CALLBACK.with(|slot| slot.borrow().clone()) else {
        return Ok(());
    };
    let func = match cb.restore(ctx) {
        Ok(func) => func,
        Err(error) => {
            tracing::error!("ffi.drain_events: restore callback failed: {error:?}");
            return Ok(());
        }
    };
    for event in pending {
        let args = (
            event.node as f64,
            event.kind,
            event.x,
            event.y,
            event.key,
            event.code,
            event.value,
        );
        if let Err(error) = func.call::<_, Value>(args) {
            tracing::error!("ffi.drain_events: callback threw: {error:?}");
        }
    }
    Ok(())
}

/// Drop every stored callback and queued event. Must run before the rquickjs
/// Runtime is dropped (Persistent values are use-after-free once their runtime
/// dies).
pub fn clear_all() {
    EVENT_CALLBACK.with(|slot| *slot.borrow_mut() = None);
    REJECTED_CALLBACK.with(|slot| *slot.borrow_mut() = None);
    PENDING.with(|pending| pending.borrow_mut().clear());
}

// ── guest logging bridge ────────────────────────────────────────────

/// Register `globalThis.__naiveLog(level, message)` used by the injected
/// console shim (QuickJS-NG ships no console).
pub fn register_logging<'js>(ctx: Ctx<'js>) -> Result<()> {
    let log_fn = Function::new(ctx.clone(), |level: String, message: String| {
        match level.as_str() {
            "error" => tracing::error!("guest: {message}"),
            "warn" => tracing::warn!("guest: {message}"),
            "debug" => tracing::debug!("guest: {message}"),
            _ => tracing::info!("guest: {message}"),
        }
    })?;
    ctx.globals().set("__naiveLog", log_fn)?;
    Ok(())
}

// ── the `globalThis.naive` namespace (U8 frame surface) ─────────────

/// Build the `globalThis.naive` namespace object with the U8 frame surface,
/// all backed by the shared naivi document (R10: same shape as the wasm
/// channel — `flush_frame` is the only DOM-mutation entry).
///
/// [`WasmExports`]: https://github.com/dioxuslabs/blitz/blob/main/js/naivi-runtime/src/wasm-types.ts
pub fn build_naive_namespace<'js>(ctx: Ctx<'js>) -> Result<Object<'js>> {
    let naive = Object::new(ctx.clone())?;
    naive.set("flush_frame", Function::new(ctx.clone(), flush_frame)?)?;
    naive.set("set_event_callback", Function::new(ctx.clone(), set_event_callback)?)?;
    naive.set("set_frame_rejected_callback", Function::new(ctx.clone(), set_frame_rejected_callback)?)?;
    naive.set("tick", Function::new(ctx.clone(), tick)?)?;
    Ok(naive)
}

/// Flush one binary DOM-change frame (the ONLY DOM-mutation FFI entry; U8,
/// KTD1). Applied as a whole transaction; every rejection is delivered to the
/// callback installed via [`set_frame_rejected_callback`] (R15).
pub fn flush_frame<'js>(ctx: Ctx<'js>, bytes: TypedArray<'js, u8>) -> Result<()> {
    let data = bytes.as_bytes().unwrap_or(&[]).to_vec();
    DOC.with(|slot| {
        let slot = slot.borrow();
        let Some(doc) = slot.as_ref() else {
            return Ok(());
        };
        let mut doc_ref = doc.borrow_mut();
        doc_ref.flush_frame(&data);
        let rejected = doc_ref.take_frame_rejected();
        drop(doc_ref);
        for (seq, reason) in rejected {
            deliver_rejected(&ctx, seq, reason)?;
        }
        Ok(())
    })
}

/// Deliver a `frame_rejected(seq, reason)` to the JS callback (inside
/// `ctx.with`, since the caller holds the runtime lock).
fn deliver_rejected(ctx: &Ctx<'_>, seq: u32, reason: u8) -> Result<()> {
    let Some(cb) = REJECTED_CALLBACK.with(|slot| slot.borrow().clone()) else {
        return Ok(());
    };
    let func = match cb.restore(ctx) {
        Ok(func) => func,
        Err(error) => {
            tracing::error!("ffi.deliver_rejected: restore callback failed: {error:?}");
            return Ok(());
        }
    };
    let _: Value = func.call((seq as f64, reason as f64))?;
    Ok(())
}

fn set_event_callback<'js>(ctx: Ctx<'js>, callback: Function<'js>) -> Result<()> {
    let persistent = Persistent::save(&ctx, callback);
    EVENT_CALLBACK.with(|slot| *slot.borrow_mut() = Some(persistent));
    Ok(())
}

/// Register the Rust→JS frame-rejection callback `(seq, reason) => void`
/// (self-heal trigger, R15). Replaces any previously installed callback.
fn set_frame_rejected_callback<'js>(ctx: Ctx<'js>, callback: Function<'js>) -> Result<()> {
    let persistent = Persistent::save(&ctx, callback);
    REJECTED_CALLBACK.with(|slot| *slot.borrow_mut() = Some(persistent));
    Ok(())
}

/// Force-drain queued events (the app loop already does this per frame; kept
/// as a guest-invokable pump).
fn tick<'js>(ctx: Ctx<'js>) -> Result<()> {
    drain_events(&ctx)
}

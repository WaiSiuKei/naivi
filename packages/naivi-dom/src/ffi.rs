//! rquickjs (QuickJS-NG) FFI surface for the native channel (U5).
//!
//! Builds `globalThis.naive` — the native twin of the U4 wasm exports — over
//! the engine-neutral [`OpsCore`]. Every JS-callable function takes the
//! current [`Ctx`] as its first argument and never calls `Context::with`
//! internally (re-entering the runtime lock from a callback self-deadlocks;
//! mirrors naive-guest-quickjs KTD5). Node ids cross the boundary as JS
//! `BigInt`, matching the wasm bigint contract.
//!
//! ## Event path
//!
//! Mirrors the wasm channel: [`set_event_callback`] stores the guest callback
//! as a `Persistent<Function>`; the guest tick calls [`drain_events`] inside
//! `ctx.with`, restoring the callback and invoking it with
//! `(nodeId, kind, x, y)`. The channel's [`EventSink`](crate::EventSink)
//! implementation feeds [`queue_event`].

use crate::{NaiviDocument, NaiviEventKind, NodeId};
use rquickjs::{BigInt, Ctx, Function, Object, Persistent, Result, Value};
use std::cell::RefCell;
use std::rc::Rc;
use std::str::FromStr;

/// A single event queued for the guest callback.
#[derive(Clone, Copy, Debug)]
pub struct QueuedEvent {
    /// The bound node's id (as `u64`; crosses to JS as a `f64` number).
    pub node: u64,
    /// The protocol `u8` event kind.
    pub kind: u8,
    /// Client (viewport-relative) coordinates, when present.
    pub x: f64,
    pub y: f64,
}

thread_local! {
    /// The single native naivi document, installed by the host before the
    /// guest bundle is evaled (one window per thread).
    static DOC: RefCell<Option<Rc<RefCell<NaiviDocument>>>> = const { RefCell::new(None) };
    /// The JS callback registered via `set_event_callback`.
    static EVENT_CALLBACK: RefCell<Option<Persistent<Function<'static>>>> = const { RefCell::new(None) };
    /// Events queued by the native [`EventSink`](crate::EventSink), drained by
    /// the guest tick.
    static PENDING: RefCell<Vec<QueuedEvent>> = const { RefCell::new(Vec::new()) };
}

/// Install the document the FFI ops operate on. Call once, before evaling the
/// guest bundle.
pub fn install_document(doc: Rc<RefCell<NaiviDocument>>) {
    DOC.with(|slot| *slot.borrow_mut() = Some(doc));
}

/// Run `f` against the installed document's ops core.
fn with_core<R>(f: impl FnOnce(&mut crate::ops::OpsCore) -> R) -> R {
    DOC.with(|slot| {
        let slot = slot.borrow();
        let doc = slot
            .as_ref()
            .expect("naivi native document not installed — call install_document() first");
        let mut core = doc.borrow().ops_core();
        f(&mut core)
    })
}

/// Decode a JS `BigInt` node id.
fn to_node_id(value: BigInt<'_>) -> Option<NodeId> {
    let raw = value.to_i64().ok()? as u64;
    Some(NodeId::from_u64(raw))
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
        let args = (event.node as f64, event.kind, event.x, event.y);
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

// ── the `globalThis.naive` namespace ────────────────────────────────

/// Build the `globalThis.naive` namespace object with the full [`WasmExports`]
/// method surface, all backed by the shared ops core.
///
/// [`WasmExports`]: https://github.com/dioxuslabs/blitz/blob/main/js/naivi-runtime/src/wasm-types.ts
pub fn build_naive_namespace<'js>(ctx: Ctx<'js>) -> Result<Object<'js>> {
    let naive = Object::new(ctx.clone())?;
    naive.set("create_element", Function::new(ctx.clone(), create_element)?)?;
    naive.set("create_text_node", Function::new(ctx.clone(), create_text_node)?)?;
    naive.set("attach_document_root", Function::new(ctx.clone(), attach_document_root)?)?;
    naive.set("set_text", Function::new(ctx.clone(), set_text)?)?;
    naive.set("set_attr", Function::new(ctx.clone(), set_attr)?)?;
    naive.set("clear_attr", Function::new(ctx.clone(), clear_attr)?)?;
    naive.set("set_style", Function::new(ctx.clone(), set_style)?)?;
    naive.set("remove_style", Function::new(ctx.clone(), remove_style)?)?;
    naive.set("add_stylesheet", Function::new(ctx.clone(), add_stylesheet)?)?;
    naive.set("append_child", Function::new(ctx.clone(), append_child)?)?;
    naive.set("insert_before", Function::new(ctx.clone(), insert_before)?)?;
    naive.set("insert_after", Function::new(ctx.clone(), insert_after)?)?;
    naive.set("replace_node", Function::new(ctx.clone(), replace_node)?)?;
    naive.set("remove_node", Function::new(ctx.clone(), remove_node)?)?;
    naive.set("bind_event", Function::new(ctx.clone(), bind_event)?)?;
    naive.set("unbind_event", Function::new(ctx.clone(), unbind_event)?)?;
    naive.set("set_event_callback", Function::new(ctx.clone(), set_event_callback)?)?;
    naive.set("tick", Function::new(ctx.clone(), tick)?)?;
    // Legacy members kept for the shared `WasmExports` interface: the native
    // channel resolves fonts in Rust, so placeholder measures are no-ops.
    naive.set("set_placeholder_measures", Function::new(ctx.clone(), set_placeholder_measures)?)?;
    naive.set("clear_placeholder_measures", Function::new(ctx.clone(), clear_placeholder_measures)?)?;
    Ok(naive)
}

fn create_element<'js>(ctx: Ctx<'js>, tag: String) -> Result<BigInt<'js>> {
    let id = with_core(|core| core.create_element(&tag).as_u64());
    BigInt::from_u64(ctx, id)
}

fn create_text_node<'js>(ctx: Ctx<'js>, text: String) -> Result<BigInt<'js>> {
    let id = with_core(|core| core.create_text_node(&text).as_u64());
    BigInt::from_u64(ctx, id)
}

fn attach_document_root<'js>(_ctx: Ctx<'js>, node_id: BigInt<'js>) -> Result<()> {
    let Some(id) = to_node_id(node_id) else {
        return Ok(());
    };
    with_core(|core| core.attach_document_root(id));
    Ok(())
}

fn set_text<'js>(_ctx: Ctx<'js>, node_id: BigInt<'js>, text: String) -> Result<()> {
    let Some(id) = to_node_id(node_id) else {
        return Ok(());
    };
    with_core(|core| core.set_text(id, &text));
    Ok(())
}

fn set_attr<'js>(_ctx: Ctx<'js>, node_id: BigInt<'js>, name: String, value: String) -> Result<()> {
    let Some(id) = to_node_id(node_id) else {
        return Ok(());
    };
    with_core(|core| core.set_attr(id, &name, &value));
    Ok(())
}

fn clear_attr<'js>(_ctx: Ctx<'js>, node_id: BigInt<'js>, name: String) -> Result<()> {
    let Some(id) = to_node_id(node_id) else {
        return Ok(());
    };
    with_core(|core| core.clear_attr(id, &name));
    Ok(())
}

fn set_style<'js>(_ctx: Ctx<'js>, node_id: BigInt<'js>, key: String, value: String) -> Result<()> {
    let Some(id) = to_node_id(node_id) else {
        return Ok(());
    };
    with_core(|core| core.set_style(id, &key, &value));
    Ok(())
}

fn add_stylesheet<'js>(_ctx: Ctx<'js>, css: String) -> Result<()> {
    with_core(|core| core.add_stylesheet(&css));
    Ok(())
}

fn remove_style<'js>(_ctx: Ctx<'js>, node_id: BigInt<'js>, key: String) -> Result<()> {
    let Some(id) = to_node_id(node_id) else {
        return Ok(());
    };
    with_core(|core| core.remove_style(id, &key));
    Ok(())
}

fn append_child<'js>(_ctx: Ctx<'js>, parent: BigInt<'js>, child: BigInt<'js>) -> Result<()> {
    let (Some(parent), Some(child)) = (to_node_id(parent), to_node_id(child)) else {
        return Ok(());
    };
    with_core(|core| core.append_child(parent, child));
    Ok(())
}

fn insert_before<'js>(_ctx: Ctx<'js>, anchor: BigInt<'js>, child: BigInt<'js>) -> Result<()> {
    let (Some(anchor), Some(child)) = (to_node_id(anchor), to_node_id(child)) else {
        return Ok(());
    };
    with_core(|core| core.insert_before(anchor, child));
    Ok(())
}

fn insert_after<'js>(_ctx: Ctx<'js>, anchor: BigInt<'js>, child: BigInt<'js>) -> Result<()> {
    let (Some(anchor), Some(child)) = (to_node_id(anchor), to_node_id(child)) else {
        return Ok(());
    };
    with_core(|core| core.insert_after(anchor, child));
    Ok(())
}

fn replace_node<'js>(_ctx: Ctx<'js>, old: BigInt<'js>, replacement: BigInt<'js>) -> Result<()> {
    let (Some(old), Some(replacement)) = (to_node_id(old), to_node_id(replacement)) else {
        return Ok(());
    };
    with_core(|core| core.replace_node(old, replacement));
    Ok(())
}

fn remove_node<'js>(_ctx: Ctx<'js>, node_id: BigInt<'js>) -> Result<()> {
    let Some(id) = to_node_id(node_id) else {
        return Ok(());
    };
    with_core(|core| core.remove_node(id));
    Ok(())
}

fn bind_event<'js>(ctx: Ctx<'js>, node_id: BigInt<'js>, kind: String) -> Result<BigInt<'js>> {
    let Some(id) = to_node_id(node_id) else {
        return BigInt::from_u64(ctx, 0);
    };
    // The WasmExports contract passes the DOM event type as a string
    // (`"click"`, `"pointerdown"`, … — see js/naivi-runtime/wasm-types.ts).
    let Ok(kind) = NaiviEventKind::from_str(&kind) else {
        tracing::warn!("ffi.bind_event: unknown event type `{kind}`");
        return BigInt::from_u64(ctx, 0);
    };
    with_core(|core| core.bind_event(id, kind));
    // The node id is the handler id (protocol shape: id-only bookkeeping).
    BigInt::from_u64(ctx, id.as_u64())
}

fn unbind_event<'js>(_ctx: Ctx<'js>, handler_id: BigInt<'js>) -> Result<()> {
    let Some(id) = to_node_id(handler_id) else {
        return Ok(());
    };
    with_core(|core| {
        for kind in NaiviEventKind::ALL {
            core.unbind_event(id, kind);
        }
    });
    Ok(())
}

fn set_event_callback<'js>(ctx: Ctx<'js>, callback: Function<'js>) -> Result<()> {
    let persistent = Persistent::save(&ctx, callback);
    EVENT_CALLBACK.with(|slot| *slot.borrow_mut() = Some(persistent));
    Ok(())
}

/// Force-drain queued events (the app loop already does this per frame; kept
/// as a guest-invokable pump).
fn tick<'js>(ctx: Ctx<'js>) -> Result<()> {
    drain_events(&ctx)
}

fn set_placeholder_measures<'js>(_ctx: Ctx<'js>, _ops_json: String) -> Result<bool> {
    Ok(false)
}

fn clear_placeholder_measures<'js>(_ctx: Ctx<'js>) -> Result<bool> {
    Ok(true)
}

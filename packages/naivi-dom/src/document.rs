//! The naivi [`Document`] implementation.

use crate::events::{EventSink, NaiviEvent, NaiviEventHandler};
use crate::frame::{FrameApplier, FrameDecoder};
use crate::ops::{NaiviBindings, OpsCore};
use blitz_dom::{BaseDocument, DocGuard, DocGuardMut, Document, DocumentConfig, EventDriver};
use blitz_traits::events::{DomEvent, UiEvent};
use blitz_traits::node_id::NodeId;
use rustc_hash::FxHashMap;
use std::cell::RefCell;
use std::collections::VecDeque;
use std::rc::Rc;
use std::task::Context as TaskContext;

/// A blitz [`Document`] driven by the naivi mutation-mirror bridge.
///
/// Owns the shared event queue, binding registry and virtual-id map, and
/// forwards every [`UiEvent`] through an [`EventDriver`] whose
/// [`NaiviEventHandler`] only *records* matching events (it never mutates the
/// DOM or re-enters JS). [`Document::poll`] drains the queue through the
/// channel-specific [`EventSink`].
pub struct NaiviDocument {
    /// The underlying blitz document (shared with [`OpsCore`]).
    pub inner: Rc<RefCell<BaseDocument>>,
    /// Event-binding registry, shared with the ops core.
    pub(crate) bindings: Rc<RefCell<NaiviBindings>>,
    /// Virtual-id map (KTD7): JS-assigned virtual u32 id → blitz [`NodeId`],
    /// shared with the ops core so frame ops and the event handler's
    /// `data-naivi-id` reverse lookup agree on identity.
    pub(crate) virtual_ids: Rc<RefCell<FxHashMap<u32, NodeId>>>,
    /// Queue of events recorded by [`NaiviEventHandler`], drained in `poll`.
    /// Rc-shared so the handler can push during event dispatch.
    pub(crate) event_queue: Rc<RefCell<VecDeque<NaiviEvent>>>,
    /// Channel-specific sink (wasm / rquickjs) receiving drained events.
    pub(crate) event_sink: RefCell<Option<Box<dyn EventSink>>>,
    /// `frame_rejected(seq, reason)` queue (KTD3/KD8): filled by
    /// [`Self::flush_frame`] when a whole frame is rejected; drained by the
    /// channel host (`set_frame_rejected_callback`).
    pub(crate) frame_rejected: Rc<RefCell<VecDeque<(u32, u8)>>>,
}

impl NaiviDocument {
    /// Wrap a caller-supplied [`BaseDocument`].
    pub fn new(inner: Rc<RefCell<BaseDocument>>) -> Self {
        Self {
            inner,
            bindings: Rc::new(RefCell::new(FxHashMap::default())),
            virtual_ids: Rc::new(RefCell::new(FxHashMap::default())),
            event_queue: Rc::new(RefCell::new(VecDeque::new())),
            event_sink: RefCell::new(None),
            frame_rejected: Rc::new(RefCell::new(VecDeque::new())),
        }
    }

    /// Build a document from a [`DocumentConfig`].
    pub fn with_config(config: DocumentConfig) -> Self {
        Self::new(Rc::new(RefCell::new(BaseDocument::new(config))))
    }

    /// An [`OpsCore`] sharing this document's registries.
    ///
    /// Event bindings and virtual-id mappings made through the ops core are
    /// visible to this document's event handler (and vice versa).
    pub fn ops_core(&self) -> OpsCore {
        OpsCore::with_state(
            Rc::clone(&self.inner),
            Rc::clone(&self.bindings),
            Rc::clone(&self.virtual_ids),
        )
    }

    /// Install the channel-specific [`EventSink`] (wasm / rquickjs).
    pub fn set_event_sink(&mut self, sink: Box<dyn EventSink>) {
        *self.event_sink.borrow_mut() = Some(sink);
    }

    /// Drain queued events through the sink. Returns `true` if any were drained.
    pub fn drain_events(&self) -> bool {
        let events: Vec<NaiviEvent> = self.event_queue.borrow_mut().drain(..).collect();
        if events.is_empty() {
            return false;
        }
        if let Some(sink) = self.event_sink.borrow_mut().as_mut() {
            for event in events {
                sink.on_event(event);
            }
        }
        true
    }

    /// Drain and dispatch DOM events queued by a native-edit session (input /
    /// key / composition) to the guest, handler-only so default actions never
    /// reach the parley editor (KTD8/KTD9, R2).
    ///
    /// `&self`: the driver's [`NaiviEventHandler`] only *records* matching
    /// events into the shared queue (never mutates the DOM or re-enters JS),
    /// and this method holds no `RefCell` borrow of `Self`, so it is safe to
    /// call from host `DocHandle::poll` implementations that must keep an
    /// immutable borrow across the subsequent JS sink drain.
    pub fn poll_native_edit_events(&self) {
        let pending: Vec<DomEvent> = self.inner.borrow_mut().drain_native_edit_events();
        if pending.is_empty() {
            return;
        }
        let handler = NaiviEventHandler {
            bindings: Rc::clone(&self.bindings),
            queue: Rc::clone(&self.event_queue),
        };
        let mut inner = Rc::clone(&self.inner);
        let mut driver = EventDriver::new(&mut inner, handler);
        for event in pending {
            driver.handle_event_to_handler(event);
        }
    }

    /// Decode + apply one binary DOM-change frame as a whole transaction
    /// (U6/KTD3). On rejection the frame is discarded untouched and
    /// `frame_rejected(seq, reason)` is queued (drained by the host).
    pub fn flush_frame(&mut self, bytes: &[u8]) {
        match FrameDecoder::decode(bytes) {
            Ok(frame) => {
                let seq = frame.seq;
                let mut core = self.ops_core();
                let mut applier = FrameApplier::new(&mut core);
                if let Err(reason) = applier.apply_frame(frame) {
                    self.frame_rejected.borrow_mut().push_back((seq, reason.code()));
                }
            }
            Err(reason) => {
                // Undecodable: no seq to report; use 0.
                self.frame_rejected.borrow_mut().push_back((0, reason.code()));
            }
        }
    }

    /// Take every queued `(seq, reason)` rejection (self-heal trigger, R15).
    pub fn take_frame_rejected(&self) -> Vec<(u32, u8)> {
        self.frame_rejected.borrow_mut().drain(..).collect()
    }

    /// Drop the whole scene (self-heal start, R15): clears the tree, the
    /// virtual-id map and the event-binding registry.
    pub fn reset(&mut self) {
        self.ops_core().reset();
    }
}

impl Document for NaiviDocument {
    fn inner(&self) -> DocGuard<'_> {
        DocGuard::RefCell(self.inner.borrow())
    }

    fn inner_mut(&mut self) -> DocGuardMut<'_> {
        DocGuardMut::RefCell(self.inner.borrow_mut())
    }

    fn poll(&mut self, _task_context: Option<TaskContext>) -> bool {
        // Dispatch events generated by a native-edit session (input / key /
        // composition) to the guest, handler-only so default actions never
        // reach the parley editor (KTD8/KTD9, R2), then drain the recorded
        // queue through the channel sink.
        self.poll_native_edit_events();
        self.drain_events()
    }

    fn handle_ui_event(&mut self, event: UiEvent) {
        let handler = NaiviEventHandler {
            bindings: Rc::clone(&self.bindings),
            queue: Rc::clone(&self.event_queue),
        };
        let mut driver = EventDriver::new(&mut self.inner, handler);
        driver.handle_ui_event(event);
    }
}

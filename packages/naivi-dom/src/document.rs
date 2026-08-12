//! The naivi [`Document`] implementation.

use crate::events::{EventSink, NaiviEvent, NaiviEventHandler};
use crate::ops::{NaiviBindings, OpsCore};
use blitz_dom::{BaseDocument, DocGuard, DocGuardMut, Document, DocumentConfig, EventDriver};
use blitz_traits::events::UiEvent;
use rustc_hash::FxHashMap;
use std::cell::RefCell;
use std::collections::VecDeque;
use std::rc::Rc;
use std::task::Context as TaskContext;

/// A blitz [`Document`] driven by the naivi mutation-mirror bridge.
///
/// Owns the shared event queue and binding registry and forwards every
/// [`UiEvent`] through an [`EventDriver`] whose [`NaiviEventHandler`] only
/// *records* matching events (it never mutates the DOM or re-enters JS).
/// [`Document::poll`] drains the queue through the channel-specific
/// [`EventSink`].
pub struct NaiviDocument {
    /// The underlying blitz document (shared with [`OpsCore`]).
    pub inner: Rc<RefCell<BaseDocument>>,
    /// Event-binding registry, shared with the ops core.
    pub(crate) bindings: Rc<RefCell<NaiviBindings>>,
    /// Queue of events recorded by [`NaiviEventHandler`], drained in `poll`.
    /// Rc-shared so the handler can push during event dispatch.
    pub(crate) event_queue: Rc<RefCell<VecDeque<NaiviEvent>>>,
    /// Channel-specific sink (wasm / rquickjs) receiving drained events.
    pub(crate) event_sink: RefCell<Option<Box<dyn EventSink>>>,
}

impl NaiviDocument {
    /// Wrap a caller-supplied [`BaseDocument`].
    pub fn new(inner: Rc<RefCell<BaseDocument>>) -> Self {
        Self {
            inner,
            bindings: Rc::new(RefCell::new(FxHashMap::default())),
            event_queue: Rc::new(RefCell::new(VecDeque::new())),
            event_sink: RefCell::new(None),
        }
    }

    /// Build a document from a [`DocumentConfig`].
    pub fn with_config(config: DocumentConfig) -> Self {
        Self::new(Rc::new(RefCell::new(BaseDocument::new(config))))
    }

    /// An [`OpsCore`] sharing this document's node registry.
    ///
    /// Event bindings made through the ops core are visible to this document's
    /// event handler (and vice versa).
    pub fn ops_core(&self) -> OpsCore {
        OpsCore::with_bindings(Rc::clone(&self.inner), Rc::clone(&self.bindings))
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
}

impl Document for NaiviDocument {
    fn inner(&self) -> DocGuard<'_> {
        DocGuard::RefCell(self.inner.borrow())
    }

    fn inner_mut(&mut self) -> DocGuardMut<'_> {
        DocGuardMut::RefCell(self.inner.borrow_mut())
    }

    fn poll(&mut self, _task_context: Option<TaskContext>) -> bool {
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

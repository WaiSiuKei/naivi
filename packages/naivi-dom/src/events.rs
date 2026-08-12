//! Event binding, queueing and sink plumbing for naivi.

use crate::ops::NaiviBindings;
use blitz_dom::{Document, EventHandler};
use blitz_traits::events::{DomEvent, DomEventData, DomEventKind, EventState};
use blitz_traits::node_id::NodeId;
use std::cell::RefCell;
use std::collections::VecDeque;
use std::rc::Rc;

/// The bounded set of DOM event kinds that naivi can bind Vue `v-on` handlers to.
///
/// This is the naivi-side vocabulary of the bridge protocol. It maps onto a
/// subset of blitz's [`DomEventKind`]; event kinds outside this set are not
/// exposed to the guest.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum NaiviEventKind {
    Click,
    PointerDown,
    PointerUp,
    PointerMove,
    Wheel,
    ContextMenu,
    MouseEnter,
    MouseLeave,
    DblClick,
}

impl NaiviEventKind {
    /// All event kinds the guest can bind.
    pub const ALL: [NaiviEventKind; 9] = [
        Self::Click,
        Self::PointerDown,
        Self::PointerUp,
        Self::PointerMove,
        Self::Wheel,
        Self::ContextMenu,
        Self::MouseEnter,
        Self::MouseLeave,
        Self::DblClick,
    ];

    /// The DOM event name (e.g. `"click"`), as used by the bridge protocol.
    pub fn name(self) -> &'static str {
        match self {
            Self::Click => "click",
            Self::PointerDown => "pointerdown",
            Self::PointerUp => "pointerup",
            Self::PointerMove => "pointermove",
            Self::Wheel => "wheel",
            Self::ContextMenu => "contextmenu",
            Self::MouseEnter => "mouseenter",
            Self::MouseLeave => "mouseleave",
            Self::DblClick => "dblclick",
        }
    }

    /// Map a blitz [`DomEvent`] to the corresponding naivi kind.
    ///
    /// Returns `None` for event kinds naivi does not expose to the guest.
    pub fn from_dom_event(event: &DomEvent) -> Option<Self> {
        match &event.data {
            DomEventData::Click(_) => Some(Self::Click),
            DomEventData::PointerDown(_) => Some(Self::PointerDown),
            DomEventData::PointerUp(_) => Some(Self::PointerUp),
            DomEventData::PointerMove(_) => Some(Self::PointerMove),
            DomEventData::Wheel(_) => Some(Self::Wheel),
            DomEventData::ContextMenu(_) => Some(Self::ContextMenu),
            DomEventData::MouseEnter(_) => Some(Self::MouseEnter),
            DomEventData::MouseLeave(_) => Some(Self::MouseLeave),
            DomEventData::DoubleClick(_) => Some(Self::DblClick),
            _ => None,
        }
    }

    /// Map from a blitz [`DomEventKind`].
    pub fn from_dom_event_kind(kind: DomEventKind) -> Option<Self> {
        match kind {
            DomEventKind::Click => Some(Self::Click),
            DomEventKind::PointerDown => Some(Self::PointerDown),
            DomEventKind::PointerUp => Some(Self::PointerUp),
            DomEventKind::PointerMove => Some(Self::PointerMove),
            DomEventKind::Wheel => Some(Self::Wheel),
            DomEventKind::ContextMenu => Some(Self::ContextMenu),
            DomEventKind::MouseEnter => Some(Self::MouseEnter),
            DomEventKind::MouseLeave => Some(Self::MouseLeave),
            DomEventKind::DoubleClick => Some(Self::DblClick),
            _ => None,
        }
    }

    /// Map to a blitz [`DomEventKind`].
    pub fn to_dom_event_kind(self) -> DomEventKind {
        match self {
            Self::Click => DomEventKind::Click,
            Self::PointerDown => DomEventKind::PointerDown,
            Self::PointerUp => DomEventKind::PointerUp,
            Self::PointerMove => DomEventKind::PointerMove,
            Self::Wheel => DomEventKind::Wheel,
            Self::ContextMenu => DomEventKind::ContextMenu,
            Self::MouseEnter => DomEventKind::MouseEnter,
            Self::MouseLeave => DomEventKind::MouseLeave,
            Self::DblClick => DomEventKind::DoubleClick,
        }
    }
}

impl std::str::FromStr for NaiviEventKind {
    type Err = ();

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim_start_matches("on") {
            "click" => Ok(Self::Click),
            "pointerdown" => Ok(Self::PointerDown),
            "pointerup" => Ok(Self::PointerUp),
            "pointermove" => Ok(Self::PointerMove),
            "wheel" => Ok(Self::Wheel),
            "contextmenu" => Ok(Self::ContextMenu),
            "mouseenter" => Ok(Self::MouseEnter),
            "mouseleave" => Ok(Self::MouseLeave),
            "dblclick" => Ok(Self::DblClick),
            _ => Err(()),
        }
    }
}

/// A single event queued for the naivi guest.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NaiviEvent {
    /// The node that carried the matching binding.
    pub node: NodeId,
    /// The event kind.
    pub kind: NaiviEventKind,
    /// Client (viewport-relative) coordinates, when the underlying DOM event
    /// carried them (0.0 otherwise).
    pub client_x: f32,
    pub client_y: f32,
}

/// Receives events drained from [`NaiviDocument`](crate::document::NaiviDocument)'s queue.
///
/// U4 (wasm) and U5 (rquickjs) provide their own impls; the default is a no-op.
pub trait EventSink {
    fn on_event(&mut self, event: NaiviEvent);
}

/// A sink that discards every event (the default).
pub struct NoopEventSink;

impl EventSink for NoopEventSink {
    fn on_event(&mut self, _event: NaiviEvent) {}
}

/// A blitz [`EventHandler`] that only records matching events into the shared queue.
///
/// It never mutates the DOM or calls back into the guest: it consults the
/// binding registry for the first node in the event's chain that has the
/// event kind bound, and pushes the event onto the queue. The queue is
/// drained later by [`NaiviDocument::poll`](crate::document::NaiviDocument::poll),
/// which avoids re-entering blitz's event dispatch while `EventDriver` holds
/// `&mut dyn Document`.
pub struct NaiviEventHandler {
    pub(crate) bindings: Rc<RefCell<NaiviBindings>>,
    pub(crate) queue: Rc<RefCell<VecDeque<NaiviEvent>>>,
}

impl EventHandler for NaiviEventHandler {
    fn handle_event(
        &mut self,
        chain: &[NodeId],
        event: &mut DomEvent,
        _doc: &mut dyn Document,
        _event_state: &mut EventState,
    ) {
        let Some(kind) = NaiviEventKind::from_dom_event(event) else {
            return;
        };
        let (client_x, client_y) = client_coords(&event.data);
        let bindings = self.bindings.borrow();
        let Some(node) = chain
            .iter()
            .copied()
            .find(|id| bindings.get(id).is_some_and(|kinds| kinds.contains(&kind)))
        else {
            return;
        };
        drop(bindings);
        self.queue.borrow_mut().push_back(NaiviEvent {
            node,
            kind,
            client_x,
            client_y,
        });
    }
}

/// Cheaply capture client coordinates from a [`DomEventData`] without re-entering blitz.
fn client_coords(data: &DomEventData) -> (f32, f32) {
    use DomEventData::*;
    match data {
        PointerMove(e)
        | PointerDown(e)
        | PointerUp(e)
        | PointerCancel(e)
        | PointerEnter(e)
        | PointerLeave(e)
        | PointerOver(e)
        | PointerOut(e)
        | MouseMove(e)
        | MouseDown(e)
        | MouseUp(e)
        | MouseEnter(e)
        | MouseLeave(e)
        | MouseOver(e)
        | MouseOut(e)
        | TouchStart(e)
        | TouchMove(e)
        | TouchEnd(e)
        | TouchCancel(e)
        | Click(e)
        | ContextMenu(e)
        | DoubleClick(e) => (e.client_x(), e.client_y()),
        Wheel(e) => (e.client_x(), e.client_y()),
        _ => (0.0, 0.0),
    }
}

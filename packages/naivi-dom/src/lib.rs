//! naivi-dom — naivi (Vue Vapor AOT) frontend for blitz.
//!
//! This crate implements blitz's [`Document`] trait for the naivi frontend
//! ([`NaiviDocument`]) and provides an engine-neutral ops core ([`OpsCore`])
//! that maps mutation-mirror-tree operations from the naivi guest (JS) onto a
//! blitz [`BaseDocument`] via [`DocumentMutator`].
//!
//! The ops core is shared by both naivi channels:
//! - the wasm channel (wasm-bindgen exports, U4) and
//! - the native channel (rquickjs FFI, U5).
//!
//! Both are thin adapters over [`OpsCore::apply_ops`] / the per-op methods and
//! contain no engine-specific logic.
//!
//! ## Event model
//!
//! Vue `v-on` handlers are registered with [`OpsCore::bind_event`]. The binding
//! writes a `data-naivi-id` attribute and records `(node, kind)` in a shared
//! registry. When blitz's `EventDriver` dispatches a DOM event,
//! [`NaiviEventHandler`] finds the first node in the event's chain whose
//! registry contains the event kind and pushes it onto a per-document queue
//! (it never mutates the tree or re-enters JS). [`NaiviDocument::poll`] drains
//! that queue through a channel-specific [`EventSink`].

pub mod document;
pub mod events;
pub mod generated;
pub mod ops;

/// rquickjs (QuickJS-NG) FFI surface for the native channel (feature
/// `quickjs`; enabled by `naivi-guest-quickjs` and native examples).
#[cfg(feature = "quickjs")]
pub mod ffi;

pub use blitz_dom::DocumentConfig;
pub use blitz_traits::node_id::NodeId;
pub use document::NaiviDocument;
pub use events::{EventSink, NaiviEvent, NaiviEventKind, NaiviEventHandler, NoopEventSink};
pub use ops::{NaiviOp, OpsCore};

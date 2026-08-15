//! Platform-native text-input backends and the payloads the engine passes to
//! them during a native-edit session.
//!
//! A host (e.g. `naivi-wasm`, `naivi-native`) implements [`NativeTextInput`]
//! for its platform — a DOM `<input>`/`<textarea>` on wasm, an
//! NSTextField/NSTextView on macOS — and registers a factory with the shell.
//! The engine (`blitz-dom`) drives the session through the [`ShellProvider`]
//! `native_edit_*` methods; the backend reports user edits back through
//! [`NativeEditEvent`].

use crate::node_id::NodeId;
use keyboard_types::{Code, Key};

/// Viewport-coordinate geometry of the element being natively edited.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct NativeEditGeometry {
    /// Content box `(x, y, width, height)` in viewport (CSS px) coordinates.
    pub content_box: (f32, f32, f32, f32),
    /// Border box `(x, y, width, height)` in viewport coordinates. The overlay
    /// aligns to this box so border and padding sit over the styled box.
    pub border_box: (f32, f32, f32, f32),
}

/// Computed style payload for deep style matching (R12).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct NativeEditStyle {
    /// CSS font family string (may be a stack, e.g. `"Noto Sans", sans-serif`).
    pub font_family: String,
    /// Font size in CSS px.
    pub font_size: f32,
    /// Font weight (400 = normal).
    pub font_weight: u16,
    /// Text color as RGBA in 0..=1.
    pub color: (f32, f32, f32, f32),
    /// Background color as RGBA in 0..=1.
    pub background_color: (f32, f32, f32, f32),
    /// Border width in CSS px (0 when borderless).
    pub border_width: f32,
    /// Border color as RGBA in 0..=1.
    pub border_color: (f32, f32, f32, f32),
    /// Padding `(top, right, bottom, left)` in CSS px.
    pub padding: (f32, f32, f32, f32),
    /// Border radius in CSS px.
    pub border_radius: f32,
    /// Text alignment: `"left"`, `"center"`, `"right"`.
    pub text_align: String,
    /// True when the engine renders the focus indicator itself, so the native
    /// control must suppress its own platform focus ring (R12).
    pub engine_draws_focus_ring: bool,
}

/// Editing attributes reflected onto the native control (R11).
#[derive(Debug, Clone, Default)]
pub struct NativeEditAttrs {
    /// The `placeholder` attribute value (empty when absent).
    pub placeholder: String,
    /// The `maxlength` attribute value (None when absent).
    pub max_length: Option<u32>,
    /// The `readonly` attribute.
    pub read_only: bool,
    /// The `disabled` attribute.
    pub disabled: bool,
    /// The input `type` attribute (defaults to `"text"`); empty for textarea.
    pub input_type: String,
    /// True for `<textarea>`, false for `<input>`.
    pub multiline: bool,
}

/// Events the native control reports back to the engine during a session.
///
/// Every event carries the `node_id` the engine bound at [`NativeTextInput::create`]
/// so the engine's stale-event guard can reject events emitted by a previous
/// session's control (KTD2) — without it, a teardown `Committed` from control A
/// delivered after session B started would be applied to B.
#[derive(Debug, Clone)]
pub enum NativeEditEvent {
    /// The user edited the text; carries the full current value.
    ValueChanged { node_id: NodeId, value: String },
    /// The control lost focus (or committed); carries the final value.
    Committed { node_id: NodeId, value: String },
    /// Enter on a single-line control (form submission trigger).
    Submit { node_id: NodeId },
    /// Tab / Shift+Tab pressed inside the control.
    Tab { node_id: NodeId, shift: bool },
    /// A generic key press inside the control (forwarded to the guest; the
    /// engine keeps it out of the parley editor, KTD8).
    KeyDown {
        node_id: NodeId,
        key: Key,
        code: Code,
    },
    /// A generic key release inside the control (KTD8).
    KeyUp {
        node_id: NodeId,
        key: Key,
        code: Code,
    },
    /// IME composition preedit (marked text) from the native control.
    CompositionPreedit { node_id: NodeId, text: String },
    /// IME composition commit from the native control.
    CompositionCommit { node_id: NodeId, text: String },
}

impl NativeEditEvent {
    /// The node the emitting control was bound to at session start (KTD2).
    pub fn node_id(&self) -> NodeId {
        match self {
            NativeEditEvent::ValueChanged { node_id, .. }
            | NativeEditEvent::Committed { node_id, .. }
            | NativeEditEvent::Submit { node_id }
            | NativeEditEvent::Tab { node_id, .. }
            | NativeEditEvent::KeyDown { node_id, .. }
            | NativeEditEvent::KeyUp { node_id, .. }
            | NativeEditEvent::CompositionPreedit { node_id, .. }
            | NativeEditEvent::CompositionCommit { node_id, .. } => *node_id,
        }
    }
}

/// A platform-native text input control, owned by the shell and driven by the
/// engine's native-edit session.
///
/// Implementations use interior mutability (`&self`) because the shell holds
/// them behind an `Arc`; the engine never touches the control directly.
pub trait NativeTextInput: Send + Sync + 'static {
    /// Create (or show and position) the control over the given geometry,
    /// styled from `style` and reflecting `attrs`. Returns whether the control
    /// is now active — a `false` lets the engine fail-close to the parley path.
    /// `node_id` is bound to the control and echoed back in every
    /// [`NativeEditEvent`] so the engine can attribute events to this session.
    fn create(
        &self,
        node_id: NodeId,
        geometry: &NativeEditGeometry,
        style: &NativeEditStyle,
        attrs: &NativeEditAttrs,
    ) -> bool;

    /// Hide/destroy the control; the session has ended.
    fn destroy(&self);

    /// Programmatically set the control's text without firing an `input` event
    /// and without moving the caret (KTD6).
    fn set_value(&self, value: &str);

    /// Read the control's current text.
    fn get_value(&self) -> String;

    /// Reposition the control (scroll/resize re-push, R10).
    fn update_bounds(&self, geometry: &NativeEditGeometry);

    /// Restyle the control (R12).
    fn set_styles(&self, style: &NativeEditStyle);
}

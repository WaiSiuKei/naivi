//! Abstraction over windowing / operating system ("shell") functionality

use crate::native_input::{NativeEditAttrs, NativeEditGeometry, NativeEditStyle};
use crate::node_id::NodeId;
use cursor_icon::CursorIcon;

/// Type representing an error performing a clipboard operation
// TODO: fill out with meaningful errors
pub struct ClipboardError;

/// Abstraction over windowing / operating system ("shell") functionality that allows a Blitz document
/// to access that functionality without depending on a specific shell environment.
pub trait ShellProvider: Send + Sync + 'static {
    fn request_redraw(&self) {}
    fn set_cursor(&self, icon: Option<CursorIcon>) {
        let _ = icon;
    }
    fn set_window_title(&self, title: String) {
        let _ = title;
    }
    fn set_ime_enabled(&self, is_enabled: bool) {
        let _ = is_enabled;
    }
    fn set_ime_cursor_area(&self, x: f32, y: f32, width: f32, height: f32) {
        let _ = x;
        let _ = y;
        let _ = width;
        let _ = height;
    }

    // Native-edit session (engine-owned; hosts that implement a
    // [`NativeTextInput`](crate::native_input::NativeTextInput) backend return
    // `true` from `native_edit_capable`). Defaults are no-ops so hosts without
    // a backend keep the canvas (parley) editing path unchanged.

    /// Whether this shell hosts a native text-input backend.
    fn native_edit_capable(&self) -> bool {
        false
    }

    /// Begin a native-edit session for a focused element. `node_id` is bound
    /// to the control and echoed back in every [`NativeEditEvent`] so the
    /// engine can attribute events to this session (KTD2). Returns whether the
    /// control was created (fail-close: a `false` keeps the parley path).
    fn begin_native_edit_session(
        &self,
        _node_id: NodeId,
        _geometry: &NativeEditGeometry,
        _style: &NativeEditStyle,
        _attrs: &NativeEditAttrs,
    ) -> bool {
        false
    }

    /// Push a programmatic value into the active native control (R5).
    fn native_edit_set_value(&self, _value: &str) {}

    /// Reposition the active native control (R10).
    fn update_native_edit_geometry(&self, _geometry: &NativeEditGeometry) {}

    /// Restyle the active native control (R12).
    fn update_native_edit_style(&self, _style: &NativeEditStyle) {}

    /// End the native-edit session and hide/destroy the control (R3).
    fn end_native_edit_session(&self) {}

    fn get_clipboard_text(&self) -> Result<String, ClipboardError> {
        Err(ClipboardError)
    }
    fn set_clipboard_text(&self, text: String) -> Result<(), ClipboardError> {
        let _ = text;
        Err(ClipboardError)
    }
    fn open_file_dialog(
        &self,
        multiple: bool,
        filter: Option<FileDialogFilter>,
    ) -> Vec<std::path::PathBuf> {
        let _ = multiple;
        let _ = filter;
        vec![]
    }

    // Window chrome controls, for documents that draw their own titlebar
    // (e.g. a frameless window with an HTML titlebar).
    fn request_window_close(&self) {}
    fn set_window_minimized(&self, minimized: bool) {
        let _ = minimized;
    }
    fn set_window_maximized(&self, maximized: bool) {
        let _ = maximized;
    }
    fn is_window_maximized(&self) -> bool {
        false
    }
    fn set_window_decorations(&self, decorations: bool) {
        let _ = decorations;
    }
    /// Begin an interactive user-driven move of the window (call from a
    /// mousedown handler on a drag region)
    fn drag_window(&self) {}
}

pub struct DummyShellProvider;
impl ShellProvider for DummyShellProvider {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native_input::{NativeEditAttrs, NativeEditGeometry, NativeEditStyle};

    /// Hosts without a native text-input backend must be unaffected: the
    /// session capability is off and every `native_edit_*` call is a safe no-op
    /// (U1 default-no-op scenario).
    #[test]
    fn default_shell_provider_has_no_native_edit_capability() {
        let provider = DummyShellProvider;
        assert!(!provider.native_edit_capable());
        assert!(!provider.begin_native_edit_session(
            crate::node_id::NodeId::from_u64(1),
            &NativeEditGeometry::default(),
            &NativeEditStyle::default(),
            &NativeEditAttrs::default(),
        ));
        provider.native_edit_set_value("x");
        provider.update_native_edit_geometry(&NativeEditGeometry::default());
        provider.update_native_edit_style(&NativeEditStyle::default());
        provider.end_native_edit_session();
    }
}

/// The system color scheme (light and dark mode)
#[derive(Default, Debug, Clone, Copy, PartialEq)]
pub enum ColorScheme {
    #[default]
    Light,
    Dark,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Viewport {
    pub color_scheme: ColorScheme,
    pub window_size: (u32, u32),
    pub hidpi_scale: f32,
    pub zoom: f32,
}

impl Default for Viewport {
    fn default() -> Self {
        Self {
            window_size: (0, 0),
            hidpi_scale: 1.0,
            zoom: 1.0,
            color_scheme: ColorScheme::Light,
        }
    }
}

impl Viewport {
    pub fn new(
        physical_width: u32,
        physical_height: u32,
        scale_factor: f32,
        color_scheme: ColorScheme,
    ) -> Self {
        Self {
            window_size: (physical_width, physical_height),
            hidpi_scale: scale_factor,
            zoom: 1.0,
            color_scheme,
        }
    }

    /// Total scaling, computed as `hidpi_scale_factor * zoom`
    pub fn scale(&self) -> f32 {
        self.hidpi_scale * self.zoom
    }
    /// Same as [`scale`](Self::scale) but `f64` instead of `f32`
    pub fn scale_f64(&self) -> f64 {
        self.scale() as f64
    }

    /// Set hidpi scale factor
    pub fn set_hidpi_scale(&mut self, scale: f32) {
        self.hidpi_scale = scale;
    }

    /// Get document zoom level
    pub fn zoom(&self) -> f32 {
        self.zoom
    }

    /// Set document zoom level (`1.0` is unzoomed)
    pub fn set_zoom(&mut self, zoom: f32) {
        self.zoom = zoom;
    }

    pub fn zoom_by(&mut self, zoom: f32) {
        self.zoom += zoom;
    }

    pub fn zoom_mut(&mut self) -> &mut f32 {
        &mut self.zoom
    }
}

/// Filter provided by the dom for an file picker
pub struct FileDialogFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

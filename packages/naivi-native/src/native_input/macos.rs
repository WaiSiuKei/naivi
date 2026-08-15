//! macOS native text-input backend (U4): NSTextField (single-line) /
//! NSTextView in an NSScrollView (multi-line) as subviews of the winit
//! window's NSView, driven by the engine's native-edit session.
//!
//! The ObjC helper (`macos_helper.m`) is compiled by `build.rs` via `cc` with
//! `-fobjc-arc` and wraps all AppKit calls in `@try/@catch` (chartles pattern).
//! All interaction happens on the main thread; the raw handle is guarded by a
//! `Mutex` for the `Send + Sync` trait bound.

use blitz_shell::{BlitzShellEvent, BlitzShellProxy};
use blitz_traits::native_input::{
    NativeEditAttrs, NativeEditEvent, NativeEditGeometry, NativeEditStyle, NativeTextInput,
};
use std::ffi::{c_char, c_void, CStr, CString};
use std::sync::Mutex;

// ---------------------------------------------------------------------------
// FFI to the ObjC helper
// ---------------------------------------------------------------------------
type ValueChangedFn = unsafe extern "C" fn(*mut c_void, *const c_char);
type CommittedFn = unsafe extern "C" fn(*mut c_void, *const c_char);
type SubmitFn = unsafe extern "C" fn(*mut c_void);
type TabFn = unsafe extern "C" fn(*mut c_void, i32);

unsafe extern "C" {
    fn native_input_create(
        ns_view: *mut c_void,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        multiline: i32,
    ) -> *mut c_void;
    fn native_input_destroy(handle: *mut c_void);
    fn native_input_set_value(handle: *mut c_void, text: *const c_char);
    fn native_input_get_value(handle: *mut c_void) -> *const c_char;
    fn native_input_set_frame(handle: *mut c_void, x: f64, y: f64, w: f64, h: f64);
    fn native_input_focus(handle: *mut c_void);
    fn native_input_set_font(handle: *mut c_void, family: *const c_char, size: f64, weight: f64);
    fn native_input_set_text_color(handle: *mut c_void, r: f64, g: f64, b: f64, a: f64);
    fn native_input_set_background(handle: *mut c_void, r: f64, g: f64, b: f64, a: f64);
    fn native_input_set_placeholder(handle: *mut c_void, text: *const c_char);
    fn native_input_set_editable(handle: *mut c_void, editable: i32, enabled: i32);
    fn native_input_set_callbacks(
        handle: *mut c_void,
        ctx: *mut c_void,
        value_changed: ValueChangedFn,
        committed: CommittedFn,
        submit: SubmitFn,
        tab: TabFn,
    );
}

/// The shell proxy used to forward native events back to the engine (KTD2).
/// Set by the host factory; the ObjC callbacks are C function pointers, so
/// they reach the proxy through this global (all on the main thread).
static PROXY: Mutex<Option<BlitzShellProxy>> = Mutex::new(None);

pub fn set_proxy(proxy: BlitzShellProxy) {
    *PROXY.lock().unwrap() = Some(proxy);
}

fn send_event(doc_id: usize, event: NativeEditEvent) {
    if let Some(proxy) = PROXY.lock().unwrap().as_ref() {
        proxy.send_event(BlitzShellEvent::NativeEdit { doc_id, event });
    }
}

// ---------------------------------------------------------------------------
// Rust callbacks (registered into the ObjC helper)
// ---------------------------------------------------------------------------
unsafe extern "C" fn on_value_changed(ctx: *mut c_void, text: *const c_char) {
    let doc_id = ctx as usize;
    let value = if text.is_null() {
        String::new()
    } else {
        unsafe { CStr::from_ptr(text) }.to_string_lossy().into_owned()
    };
    send_event(doc_id, NativeEditEvent::ValueChanged(value));
}

unsafe extern "C" fn on_committed(ctx: *mut c_void, text: *const c_char) {
    let doc_id = ctx as usize;
    let value = if text.is_null() {
        String::new()
    } else {
        unsafe { CStr::from_ptr(text) }.to_string_lossy().into_owned()
    };
    send_event(doc_id, NativeEditEvent::Committed(value));
}

unsafe extern "C" fn on_submit(ctx: *mut c_void) {
    send_event(ctx as usize, NativeEditEvent::Submit);
}

unsafe extern "C" fn on_tab(ctx: *mut c_void, shift: i32) {
    send_event(ctx as usize, NativeEditEvent::Tab { shift: shift != 0 });
}

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------
pub struct MacOSNativeTextInput {
    /// The winit window's NSView (parent of the control).
    ns_view: *mut c_void,
    /// The ObjC control handle; null until `create`.
    handle: Mutex<*mut c_void>,
    /// The document id (routing key, KTD2) — also the callback ctx.
    doc_id: usize,
}

impl MacOSNativeTextInput {
    pub fn new(ns_view: *mut c_void, doc_id: usize) -> Self {
        Self {
            ns_view,
            handle: Mutex::new(std::ptr::null_mut()),
            doc_id,
        }
    }

    fn with_handle<R>(&self, f: impl FnOnce(*mut c_void) -> R) -> Option<R> {
        let handle = *self.handle.lock().unwrap();
        if handle.is_null() {
            return None;
        }
        Some(f(handle))
    }
}

impl NativeTextInput for MacOSNativeTextInput {
    fn create(
        &self,
        geometry: &NativeEditGeometry,
        style: &NativeEditStyle,
        attrs: &NativeEditAttrs,
    ) -> bool {
        if self.ns_view.is_null() {
            return false;
        }
        let (bx, by, bw, bh) = geometry.border_box;
        let handle = unsafe {
            native_input_create(
                self.ns_view,
                bx as f64,
                by as f64,
                bw as f64,
                bh as f64,
                attrs.multiline as i32,
            )
        };
        if handle.is_null() {
            return false;
        }
        unsafe {
            native_input_set_callbacks(
                handle,
                self.doc_id as *mut c_void,
                on_value_changed,
                on_committed,
                on_submit,
                on_tab,
            );
        }
        *self.handle.lock().unwrap() = handle;

        // Reflect editing attributes (R11).
        let placeholder = CString::new(attrs.placeholder.as_str()).unwrap_or_default();
        unsafe { native_input_set_placeholder(handle, placeholder.as_ptr()) };
        let editable = if attrs.read_only || attrs.disabled { 0 } else { 1 };
        let enabled = if attrs.disabled { 0 } else { 1 };
        unsafe { native_input_set_editable(handle, editable, enabled) };

        self.set_styles(style);
        unsafe { native_input_focus(handle) };
        true
    }

    fn destroy(&self) {
        let mut slot = self.handle.lock().unwrap();
        if slot.is_null() {
            return;
        }
        unsafe { native_input_destroy(*slot) };
        *slot = std::ptr::null_mut();
    }

    fn set_value(&self, value: &str) {
        self.with_handle(|handle| {
            let c = CString::new(value).unwrap_or_default();
            unsafe { native_input_set_value(handle, c.as_ptr()) };
        });
    }

    fn get_value(&self) -> String {
        self.with_handle(|handle| unsafe {
            let ptr = native_input_get_value(handle);
            if ptr.is_null() {
                return String::new();
            }
            CStr::from_ptr(ptr).to_string_lossy().into_owned()
        })
        .unwrap_or_default()
    }

    fn update_bounds(&self, geometry: &NativeEditGeometry) {
        self.with_handle(|handle| {
            let (bx, by, bw, bh) = geometry.border_box;
            unsafe {
                native_input_set_frame(handle, bx as f64, by as f64, bw as f64, bh as f64)
            };
        });
    }

    fn set_styles(&self, style: &NativeEditStyle) {
        self.with_handle(|handle| {
            let family = CString::new(style.font_family.as_str()).unwrap_or_default();
            unsafe {
                native_input_set_font(
                    handle,
                    family.as_ptr(),
                    style.font_size as f64,
                    style.font_weight as f64,
                );
                let (r, g, b, a) = style.color;
                native_input_set_text_color(handle, r as f64, g as f64, b as f64, a as f64);
                let (r, g, b, a) = style.background_color;
                native_input_set_background(handle, r as f64, g as f64, b as f64, a as f64);
            }
        });
    }
}

// SAFETY: all interaction with the NSTextField/NSTextView happens on the main
// thread via the ObjC helper; the raw pointers are never dereferenced from
// Rust, and the handle is guarded by a Mutex.
unsafe impl Send for MacOSNativeTextInput {}
unsafe impl Sync for MacOSNativeTextInput {}

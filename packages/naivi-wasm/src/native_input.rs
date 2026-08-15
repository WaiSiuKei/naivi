//! wasm native text-input backend: a DOM `<input>`/`<textarea>` overlay placed
//! over the `#blitz-target` canvas, owned by the engine's native-edit session.
//!
//! The overlay is a child of the canvas, absolutely positioned, and hidden
//! (`display:none`) until a session begins. It is excluded from the
//! accessibility tree (`aria-hidden` + `tabindex="-1"`); the canvas node stays
//! authoritative. All key/composition listeners call `stopPropagation` — the
//! overlay is a canvas child, so bubbled events would otherwise reach winit's
//! canvas listeners (R2, KTD5). Events are forwarded through the shell proxy
//! as `BlitzShellEvent::NativeEdit` (KTD2).
//!
//! All DOM state lives in a `thread_local` (wasm is single-threaded and the
//! DOM types are not `Send`); the backend itself is a `Send + Sync` handle
//! holding only the doc id and proxy.

use blitz_shell::BlitzShellProxy;
use blitz_traits::native_input::{
    NativeEditAttrs, NativeEditEvent, NativeEditGeometry, NativeEditStyle, NativeTextInput,
};
use keyboard_types::{Code, Key};
use std::cell::RefCell;
use std::rc::Rc;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use web_sys::{HtmlCanvasElement, HtmlInputElement, HtmlTextAreaElement};

/// The DOM state of the single reused overlay (chartles pattern): one hidden
/// `<input>` and one hidden `<textarea>` plus their listeners.
struct WasmNativeDom {
    canvas: HtmlCanvasElement,
    input: Option<HtmlInputElement>,
    textarea: Option<HtmlTextAreaElement>,
    /// True while IME composition is active; `input` events during composition
    /// are suppressed so the guest does not receive both the preedit stream
    /// and intermediate values.
    is_composing: bool,
    /// Currently visible control (`true` = textarea).
    active_multiline: bool,
    /// Kept alive for the page lifetime (listeners are installed once).
    #[allow(dead_code)]
    listeners: Vec<Rc<dyn std::any::Any>>,
}

thread_local! {
    static DOM: RefCell<Option<WasmNativeDom>> = const { RefCell::new(None) };
    /// The current backend handle, installed by the host factory so the DOM
    /// listeners can forward events to the shell proxy.
    static BACKEND: RefCell<Option<WasmNativeTextInput>> = const { RefCell::new(None) };
}

/// Set up the hidden overlay elements as children of `canvas`. Called once by
/// the host factory before the backend is used.
pub fn init_dom(canvas: HtmlCanvasElement) {
    DOM.with(|slot| {
        if slot.borrow().is_some() {
            return;
        }
        let document = web_sys::window()
            .and_then(|w| w.document())
            .expect("no document");

        let input = document
            .create_element("input")
            .expect("failed to create input")
            .dyn_into::<HtmlInputElement>()
            .expect("not an input element");
        setup_common(&input, &canvas);

        let textarea = document
            .create_element("textarea")
            .expect("failed to create textarea")
            .dyn_into::<HtmlTextAreaElement>()
            .expect("not a textarea element");
        setup_common(&textarea, &canvas);
        // The resize handle must not desync the overlay from the box (D8).
        let _ = textarea.style().set_property("resize", "none");

        let mut dom = WasmNativeDom {
            canvas,
            input: Some(input),
            textarea: Some(textarea),
            is_composing: false,
            active_multiline: false,
            listeners: Vec::new(),
        };
        install_listeners(&mut dom);
        *slot.borrow_mut() = Some(dom);
    });
}

/// Install the backend handle (called by the host factory right after the
/// backend is constructed).
pub fn set_backend(backend: WasmNativeTextInput) {
    BACKEND.with(|slot| *slot.borrow_mut() = Some(backend));
}

fn setup_common(element: &web_sys::HtmlElement, canvas: &HtmlCanvasElement) {
    let style = element.style();
    let _ = style.set_property("position", "absolute");
    let _ = style.set_property("z-index", "100");
    let _ = style.set_property("display", "none");
    let _ = style.set_property("box-sizing", "border-box");
    let _ = style.set_property("margin", "0");
    // Excluded from the accessibility tree; the canvas node stays authoritative.
    let _ = element.set_attribute("aria-hidden", "true");
    let _ = element.set_attribute("tabindex", "-1");
    let _ = element.set_attribute("autocomplete", "off");
    let _ = element.set_attribute("spellcheck", "false");
    let _ = canvas.append_child(element);
}

fn with_dom<R>(f: impl FnOnce(&mut WasmNativeDom) -> R) -> Option<R> {
    DOM.with(|slot| slot.borrow_mut().as_mut().map(f))
}

fn is_composing() -> bool {
    with_dom(|dom| dom.is_composing).unwrap_or(false)
}

fn current_value(multiline: bool) -> String {
    with_dom(|dom| {
        if multiline {
            dom.textarea.as_ref().map(|t| t.value()).unwrap_or_default()
        } else {
            dom.input.as_ref().map(|i| i.value()).unwrap_or_default()
        }
    })
    .unwrap_or_default()
}

/// The `Send + Sync` backend handle: only the doc id + shell proxy (the DOM
/// lives in the thread-local above).
pub struct WasmNativeTextInput {
    doc_id: usize,
    proxy: BlitzShellProxy,
}

impl WasmNativeTextInput {
    pub fn new(doc_id: usize, proxy: BlitzShellProxy) -> Self {
        Self { doc_id, proxy }
    }

    fn send(&self, event: NativeEditEvent) {
        self.proxy
            .send_event(blitz_shell::BlitzShellEvent::NativeEdit {
                doc_id: self.doc_id,
                event,
            });
    }
}

impl NativeTextInput for WasmNativeTextInput {
    fn create(
        &self,
        geometry: &NativeEditGeometry,
        style: &NativeEditStyle,
        attrs: &NativeEditAttrs,
    ) -> bool {
        with_dom(|dom| {
            dom.is_composing = false;
            dom.active_multiline = attrs.multiline;
            let element: web_sys::HtmlElement = if attrs.multiline {
                let t = dom.textarea.as_ref().expect("no textarea");
                let _ = t.set_value("");
                t.clone().unchecked_into()
            } else {
                let i = dom.input.as_ref().expect("no input");
                let _ = i.set_value("");
                let _ = i.set_type(&attrs.input_type);
                i.clone().unchecked_into()
            };

            // Reflect editing attributes (R11).
            if attrs.placeholder.is_empty() {
                let _ = element.remove_attribute("placeholder");
            } else {
                let _ = element.set_attribute("placeholder", &attrs.placeholder);
            }
            match attrs.max_length {
                Some(n) => {
                    let _ = element.set_attribute("maxlength", &n.to_string());
                }
                None => {
                    let _ = element.remove_attribute("maxlength");
                }
            }
            if attrs.read_only {
                let _ = element.set_attribute("readonly", "true");
            } else {
                let _ = element.remove_attribute("readonly");
            }
            if attrs.disabled {
                let _ = element.set_attribute("disabled", "true");
            } else {
                let _ = element.remove_attribute("disabled");
            }

            apply_style(&element, style);
            position_element(&element, geometry, &dom.canvas);

            // Show and focus.
            let _ = element.style().set_property("display", "block");
            let _ = element.focus();
            true
        })
        .unwrap_or(false)
    }

    fn destroy(&self) {
        with_dom(|dom| {
            let element: Option<web_sys::HtmlElement> = if dom.active_multiline {
                dom.textarea.clone().map(|t| t.unchecked_into())
            } else {
                dom.input.clone().map(|i| i.unchecked_into())
            };
            if let Some(element) = element {
                let _ = element.style().set_property("display", "none");
            }
            dom.is_composing = false;

            // Restore DOM focus to the canvas when the overlay held it, so
            // winit's canvas key listeners keep receiving events (A4).
            let document = web_sys::window().and_then(|w| w.document());
            if let Some(active) = document.and_then(|d| d.active_element()) {
                let overlay_active = dom
                    .input
                    .clone()
                    .map(|i| i.unchecked_into::<web_sys::Element>())
                    .or_else(|| dom.textarea.clone().map(|t| t.unchecked_into()))
                    .is_some_and(|el| el == active);
                if overlay_active {
                    let _ = dom.canvas.focus();
                }
            }
        });
    }

    fn set_value(&self, value: &str) {
        with_dom(|dom| {
            if dom.active_multiline {
                if let Some(t) = dom.textarea.as_ref() {
                    set_textarea_preserving_selection(t, value);
                }
            } else if let Some(i) = dom.input.as_ref() {
                set_input_preserving_selection(i, value);
            }
        });
    }

    fn get_value(&self) -> String {
        with_dom(|dom| {
            if dom.active_multiline {
                dom.textarea.as_ref().map(|t| t.value()).unwrap_or_default()
            } else {
                dom.input.as_ref().map(|i| i.value()).unwrap_or_default()
            }
        })
        .unwrap_or_default()
    }

    fn update_bounds(&self, geometry: &NativeEditGeometry) {
        with_dom(|dom| {
            let element: Option<web_sys::HtmlElement> = if dom.active_multiline {
                dom.textarea.clone().map(|t| t.unchecked_into())
            } else {
                dom.input.clone().map(|i| i.unchecked_into())
            };
            if let Some(element) = element {
                position_element(&element, geometry, &dom.canvas);
            }
        });
    }

    fn set_styles(&self, style: &NativeEditStyle) {
        with_dom(|dom| {
            let element: Option<web_sys::HtmlElement> = if dom.active_multiline {
                dom.textarea.clone().map(|t| t.unchecked_into())
            } else {
                dom.input.clone().map(|i| i.unchecked_into())
            };
            if let Some(element) = element {
                apply_style(&element, style);
            }
        });
    }
}

/// Position the overlay over the border box in viewport coordinates, adding
/// the canvas offset (the canvas may not sit at the viewport origin).
fn position_element(
    element: &web_sys::HtmlElement,
    geometry: &NativeEditGeometry,
    canvas: &HtmlCanvasElement,
) {
    let (bx, by, bw, bh) = geometry.border_box;
    let left = canvas.offset_left() as f64 + bx as f64;
    let top = canvas.offset_top() as f64 + by as f64;
    let style = element.style();
    let _ = style.set_property("left", &format!("{}px", left));
    let _ = style.set_property("top", &format!("{}px", top));
    let _ = style.set_property("width", &format!("{}px", bw));
    let _ = style.set_property("height", &format!("{}px", bh));
}

fn css_color(c: (f32, f32, f32, f32)) -> String {
    format!(
        "rgba({}, {}, {}, {})",
        (c.0 * 255.0).round() as i32,
        (c.1 * 255.0).round() as i32,
        (c.2 * 255.0).round() as i32,
        c.3
    )
}

fn apply_style(element: &web_sys::HtmlElement, style: &NativeEditStyle) {
    let css = element.style();
    if !style.font_family.is_empty() {
        let _ = css.set_property("font-family", &style.font_family);
    }
    if style.font_size > 0.0 {
        let _ = css.set_property("font-size", &format!("{}px", style.font_size));
    }
    let _ = css.set_property("font-weight", &style.font_weight.to_string());
    let _ = css.set_property("color", &css_color(style.color));
    let _ = css.set_property("background-color", &css_color(style.background_color));
    if style.border_width > 0.0 {
        let _ = css.set_property(
            "border",
            &format!(
                "{}px solid {}",
                style.border_width,
                css_color(style.border_color)
            ),
        );
    } else {
        let _ = css.set_property("border", "none");
    }
    let (pt, pr, pb, pl) = style.padding;
    let _ = css.set_property("padding", &format!("{}px {}px {}px {}px", pt, pr, pb, pl));
    if style.border_radius > 0.0 {
        let _ = css.set_property("border-radius", &format!("{}px", style.border_radius));
    }
    let _ = css.set_property("text-align", &style.text_align);
    // Suppress the platform focus ring when the engine renders the indicator.
    if style.engine_draws_focus_ring {
        let _ = css.set_property("outline", "none");
    } else {
        let _ = css.set_property("outline", "1px solid Highlight");
    }
}

fn set_input_preserving_selection(input: &HtmlInputElement, value: &str) {
    let start = input.selection_start().ok().flatten().unwrap_or(0);
    let end = input.selection_end().ok().flatten().unwrap_or(0);
    input.set_value(value);
    let _ = input.set_selection_range(start, end);
}

fn set_textarea_preserving_selection(textarea: &HtmlTextAreaElement, value: &str) {
    let start = textarea.selection_start().ok().flatten().unwrap_or(0);
    let end = textarea.selection_end().ok().flatten().unwrap_or(0);
    textarea.set_value(value);
    let _ = textarea.set_selection_range(start, end);
}

/// Send a native edit event to the shell. The engine drops stale events.
fn send_native(event: NativeEditEvent) {
    BACKEND.with(|slot| {
        if let Some(backend) = slot.borrow().as_ref() {
            backend.send(event);
        }
    });
}

fn install_listeners(dom: &mut WasmNativeDom) {
    let input = dom.input.clone().unwrap();
    let textarea = dom.textarea.clone().unwrap();

    for (element, multiline) in
        [(&input as &web_sys::EventTarget, false), (&textarea, true)]
    {
        let m = multiline;

        // input → ValueChanged (skipped during IME composition)
        let oninput = Closure::wrap(Box::new(move || {
            if !is_composing() {
                send_native(NativeEditEvent::ValueChanged(current_value(m)));
            }
        }) as Box<dyn FnMut()>);
        let _ = element.add_event_listener_with_callback("input", oninput.as_ref().unchecked_ref());
        dom.listeners.push(Rc::new(oninput));

        // composition
        let on_start = Closure::wrap(Box::new(move || {
            set_composing(true);
            send_native(NativeEditEvent::CompositionPreedit(String::new()));
        }) as Box<dyn FnMut()>);
        let _ = element.add_event_listener_with_callback("compositionstart", on_start.as_ref().unchecked_ref());
        dom.listeners.push(Rc::new(on_start));

        let on_update = Closure::wrap(Box::new(move |ev: web_sys::CompositionEvent| {
            send_native(NativeEditEvent::CompositionPreedit(
                ev.data().unwrap_or_default(),
            ));
        }) as Box<dyn FnMut(_)>);
        let _ = element.add_event_listener_with_callback("compositionupdate", on_update.as_ref().unchecked_ref());
        dom.listeners.push(Rc::new(on_update));

        let on_end = Closure::wrap(Box::new(move |ev: web_sys::CompositionEvent| {
            set_composing(false);
            send_native(NativeEditEvent::CompositionCommit(
                ev.data().unwrap_or_default(),
            ));
        }) as Box<dyn FnMut(_)>);
        let _ = element.add_event_listener_with_callback("compositionend", on_end.as_ref().unchecked_ref());
        dom.listeners.push(Rc::new(on_end));

        // keydown → Tab/Submit/KeyDown; always stopPropagation (R2, KTD5)
        let on_keydown = Closure::wrap(Box::new(move |ev: web_sys::KeyboardEvent| {
            let _ = ev.stop_propagation();
            let key = ev.key();
            let code = ev.code();
            if key == "Tab" {
                let _ = ev.prevent_default();
                send_native(NativeEditEvent::Tab { shift: ev.shift_key() });
                return;
            }
            if key == "Enter" && !m {
                let _ = ev.prevent_default();
                send_native(NativeEditEvent::Submit);
                return;
            }
            send_native(NativeEditEvent::KeyDown {
                key: key.parse().unwrap_or(Key::Unidentified),
                code: code.parse().unwrap_or(Code::Unidentified),
            });
        }) as Box<dyn FnMut(_)>);
        let _ = element.add_event_listener_with_callback("keydown", on_keydown.as_ref().unchecked_ref());
        dom.listeners.push(Rc::new(on_keydown));

        // keyup → KeyUp; stopPropagation
        let on_keyup = Closure::wrap(Box::new(move |ev: web_sys::KeyboardEvent| {
            let _ = ev.stop_propagation();
            send_native(NativeEditEvent::KeyUp {
                key: ev.key().parse().unwrap_or(Key::Unidentified),
                code: ev.code().parse().unwrap_or(Code::Unidentified),
            });
        }) as Box<dyn FnMut(_)>);
        let _ = element.add_event_listener_with_callback("keyup", on_keyup.as_ref().unchecked_ref());
        dom.listeners.push(Rc::new(on_keyup));

        // blur → Committed (R6)
        let on_blur = Closure::wrap(Box::new(move || {
            send_native(NativeEditEvent::Committed(current_value(m)));
        }) as Box<dyn FnMut()>);
        let _ = element.add_event_listener_with_callback("blur", on_blur.as_ref().unchecked_ref());
        dom.listeners.push(Rc::new(on_blur));
    }
}

fn set_composing(composing: bool) {
    with_dom(|dom| dom.is_composing = composing);
}

// SAFETY: wasm32 is single-threaded; all DOM access happens on the main thread.
unsafe impl Send for WasmNativeTextInput {}
unsafe impl Sync for WasmNativeTextInput {}

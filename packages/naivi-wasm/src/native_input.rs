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
use blitz_traits::node_id::NodeId;
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
    /// True while `destroy` runs: the overlay's synchronous blur (triggered by
    /// hiding it / restoring canvas focus) must not emit a `Committed` for a
    /// session the engine is already tearing down (the value is live-mirrored,
    /// R4).
    destroying: bool,
    /// True right after `create` until the engine's seed `set_value` — the
    /// seed places the caret at the end of the seeded text (plan U2.2).
    pending_seed: bool,
    /// The node this control is currently bound to (KTD2); echoed in events.
    node_id: Option<NodeId>,
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
            destroying: false,
            pending_seed: false,
            node_id: None,
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
    // `try_borrow_mut` (not `borrow_mut`): restoring canvas focus from
    // `destroy` fires the overlay's `blur` synchronously, and its listener
    // re-enters `with_dom` while the outer borrow is still live. A re-entrant
    // call returns `None` instead of panicking ("RefCell already borrowed");
    // the engine's stale-event guard drops anything it sends (KTD2).
    DOM.with(|slot| slot.try_borrow_mut().ok()?.as_mut().map(f))
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
#[derive(Clone)]
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
        node_id: NodeId,
        geometry: &NativeEditGeometry,
        style: &NativeEditStyle,
        attrs: &NativeEditAttrs,
    ) -> bool {
        with_dom(|dom| {
            dom.is_composing = false;
            dom.destroying = false;
            dom.pending_seed = true;
            dom.node_id = Some(node_id);
            dom.active_multiline = attrs.multiline;
            let element: web_sys::HtmlElement = if attrs.multiline {
                dom.textarea.as_ref().expect("no textarea").clone().unchecked_into()
            } else {
                let i = dom.input.as_ref().expect("no input");
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

            // Show and focus. `element.focus()` can fail (hidden page,
            // refused focus); fail-close to the parley path rather than
            // reporting an active session with no keyboard path.
            let _ = element.style().set_property("display", "block");
            element.focus().is_ok()
        })
        .unwrap_or(false)
    }

    fn destroy(&self) {
        with_dom(|dom| {
            // The overlay is about to lose focus (hide + canvas focus).
            // Suppress the resulting blur `Committed` — the session is already
            // ending and the value was live-mirrored (R4).
            dom.destroying = true;
            dom.pending_seed = false;
            dom.node_id = None;
            let element: Option<web_sys::HtmlElement> = if dom.active_multiline {
                dom.textarea.clone().map(|t| t.unchecked_into())
            } else {
                dom.input.clone().map(|i| i.unchecked_into())
            };
            // Capture whether the overlay holds focus BEFORE hiding it —
            // `display:none` synchronously blurs the focused element, so the
            // check must run first to restore canvas focus afterwards.
            let overlay_active = document_active_element_is_overlay(dom);
            if let Some(element) = element {
                let _ = element.style().set_property("display", "none");
            }
            dom.is_composing = false;

            // Restore DOM focus to the canvas when the overlay held it, so
            // winit's canvas key listeners keep receiving events (A4).
            if overlay_active {
                let _ = dom.canvas.focus();
            }
        });
    }

    fn set_value(&self, value: &str) {
        with_dom(|dom| {
            let element: Option<&dyn SelectionValue> = if dom.active_multiline {
                dom.textarea.as_ref().map(|t| t as &dyn SelectionValue)
            } else {
                dom.input.as_ref().map(|i| i as &dyn SelectionValue)
            };
            if let Some(element) = element {
                // The engine's seed after `create` places the caret at the
                // end of the seeded text (plan U2.2, "otherwise end-of-value")
                // instead of pinning it at 0; later programmatic pushes (R5)
                // preserve the user's selection.
                let seed = std::mem::take(&mut dom.pending_seed);
                set_preserving_selection(element, value, seed);
            }
        });
    }

    fn get_value(&self) -> String {
        with_dom(|dom| current_value(dom.active_multiline)).unwrap_or_default()
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

/// Common value/selection surface of `HtmlInputElement` and
/// `HtmlTextAreaElement` (the two overlay controls).
trait SelectionValue {
    fn selection_start(&self) -> Result<Option<u32>, wasm_bindgen::JsValue>;
    fn selection_end(&self) -> Result<Option<u32>, wasm_bindgen::JsValue>;
    fn set_value(&self, value: &str);
    fn set_selection_range(&self, start: u32, end: u32) -> Result<(), wasm_bindgen::JsValue>;
}

impl SelectionValue for HtmlInputElement {
    fn selection_start(&self) -> Result<Option<u32>, wasm_bindgen::JsValue> {
        HtmlInputElement::selection_start(self)
    }
    fn selection_end(&self) -> Result<Option<u32>, wasm_bindgen::JsValue> {
        HtmlInputElement::selection_end(self)
    }
    fn set_value(&self, value: &str) {
        HtmlInputElement::set_value(self, value);
    }
    fn set_selection_range(&self, start: u32, end: u32) -> Result<(), wasm_bindgen::JsValue> {
        HtmlInputElement::set_selection_range(self, start, end)
    }
}

impl SelectionValue for HtmlTextAreaElement {
    fn selection_start(&self) -> Result<Option<u32>, wasm_bindgen::JsValue> {
        HtmlTextAreaElement::selection_start(self)
    }
    fn selection_end(&self) -> Result<Option<u32>, wasm_bindgen::JsValue> {
        HtmlTextAreaElement::selection_end(self)
    }
    fn set_value(&self, value: &str) {
        HtmlTextAreaElement::set_value(self, value);
    }
    fn set_selection_range(&self, start: u32, end: u32) -> Result<(), wasm_bindgen::JsValue> {
        HtmlTextAreaElement::set_selection_range(self, start, end)
    }
}

/// Set a control's value while preserving the current caret/selection (R5).
/// When `seed` is true (the engine's value seed right after `create`), place
/// the caret at the end of the seeded text instead (plan U2.2).
fn set_preserving_selection(element: &dyn SelectionValue, value: &str, seed: bool) {
    if seed {
        element.set_value(value);
        let end = value.len() as u32;
        let _ = element.set_selection_range(end, end);
        return;
    }
    let start = element.selection_start().ok().flatten().unwrap_or(0);
    let end = element.selection_end().ok().flatten().unwrap_or(0);
    element.set_value(value);
    let _ = element.set_selection_range(start, end);
}

/// The node the overlay is currently bound to (KTD2); `None` outside a session.
fn current_node_id() -> Option<NodeId> {
    with_dom(|dom| dom.node_id).flatten()
}

/// Whether either overlay control currently holds DOM focus (checked before
/// the overlay is hidden in `destroy`).
fn document_active_element_is_overlay(dom: &WasmNativeDom) -> bool {
    let Some(active) = web_sys::window()
        .and_then(|w| w.document())
        .and_then(|d| d.active_element())
    else {
        return false;
    };
    dom.input
        .clone()
        .map(|i| i.unchecked_into::<web_sys::Element>())
        .or_else(|| dom.textarea.clone().map(|t| t.unchecked_into()))
        .is_some_and(|el| el == active)
}

/// Send a native edit event tagged with the session's node (KTD2). The engine
/// drops stale events, including ones from a previous session's control.
fn send_native<F: FnOnce(NodeId) -> NativeEditEvent>(build: F) {
    let Some(node_id) = current_node_id() else {
        return;
    };
    let event = build(node_id);
    BACKEND.with(|slot| {
        if let Some(backend) = slot.borrow().as_ref() {
            backend.send(event);
        }
    });
}

/// True while `destroy` is tearing the overlay down (the synchronous blur must
/// not emit a `Committed` for the ending session).
fn is_destroying() -> bool {
    with_dom(|dom| dom.destroying).unwrap_or(false)
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
                let value = current_value(m);
                send_native(move |node_id| NativeEditEvent::ValueChanged { node_id, value });
            }
        }) as Box<dyn FnMut()>);
        let _ = element.add_event_listener_with_callback("input", oninput.as_ref().unchecked_ref());
        dom.listeners.push(Rc::new(oninput));

        // composition
        let on_start = Closure::wrap(Box::new(move || {
            set_composing(true);
            send_native(|node_id| NativeEditEvent::CompositionPreedit {
                node_id,
                text: String::new(),
            });
        }) as Box<dyn FnMut()>);
        let _ = element.add_event_listener_with_callback("compositionstart", on_start.as_ref().unchecked_ref());
        dom.listeners.push(Rc::new(on_start));

        let on_update = Closure::wrap(Box::new(move |ev: web_sys::CompositionEvent| {
            let text = ev.data().unwrap_or_default();
            send_native(move |node_id| NativeEditEvent::CompositionPreedit { node_id, text });
        }) as Box<dyn FnMut(_)>);
        let _ = element.add_event_listener_with_callback("compositionupdate", on_update.as_ref().unchecked_ref());
        dom.listeners.push(Rc::new(on_update));

        let on_end = Closure::wrap(Box::new(move |ev: web_sys::CompositionEvent| {
            set_composing(false);
            let text = ev.data().unwrap_or_default();
            send_native(move |node_id| NativeEditEvent::CompositionCommit { node_id, text });
        }) as Box<dyn FnMut(_)>);
        let _ = element.add_event_listener_with_callback("compositionend", on_end.as_ref().unchecked_ref());
        dom.listeners.push(Rc::new(on_end));

        // keydown → Tab/Submit/KeyDown; always stopPropagation (R2, KTD5).
        // While the IME is composing, Enter/Tab confirm the candidate and must
        // not trigger submit/traversal — the IME owns the key.
        let on_keydown = Closure::wrap(Box::new(move |ev: web_sys::KeyboardEvent| {
            let _ = ev.stop_propagation();
            let composing = ev.is_composing();
            let key = ev.key();
            let code = ev.code();
            if composing {
                return;
            }
            if key == "Tab" {
                let _ = ev.prevent_default();
                let shift = ev.shift_key();
                send_native(move |node_id| NativeEditEvent::Tab { node_id, shift });
                return;
            }
            if key == "Enter" && !m {
                let _ = ev.prevent_default();
                // Forward the full key sequence before the engine's `Submit`
                // ends the session: the overlay is destroyed on submit, so a
                // real `keyup` would be a stale event and the guest's
                // `@keyup.enter` would never fire (KTD8).
                send_native(|node_id| NativeEditEvent::KeyDown {
                    node_id,
                    key: Key::Enter,
                    code: Code::Enter,
                });
                send_native(|node_id| NativeEditEvent::KeyUp {
                    node_id,
                    key: Key::Enter,
                    code: Code::Enter,
                });
                send_native(|node_id| NativeEditEvent::Submit { node_id });
                return;
            }
            let key = key.parse().unwrap_or(Key::Unidentified);
            let code = code.parse().unwrap_or(Code::Unidentified);
            send_native(move |node_id| NativeEditEvent::KeyDown { node_id, key, code });
        }) as Box<dyn FnMut(_)>);
        let _ = element.add_event_listener_with_callback("keydown", on_keydown.as_ref().unchecked_ref());
        dom.listeners.push(Rc::new(on_keydown));

        // keyup → KeyUp; stopPropagation
        let on_keyup = Closure::wrap(Box::new(move |ev: web_sys::KeyboardEvent| {
            let _ = ev.stop_propagation();
            let key = ev.key().parse().unwrap_or(Key::Unidentified);
            let code = ev.code().parse().unwrap_or(Code::Unidentified);
            send_native(move |node_id| NativeEditEvent::KeyUp { node_id, key, code });
        }) as Box<dyn FnMut(_)>);
        let _ = element.add_event_listener_with_callback("keyup", on_keyup.as_ref().unchecked_ref());
        dom.listeners.push(Rc::new(on_keyup));

        // blur → Committed (R6); suppressed while destroy tears the overlay
        // down (the engine already ended the session and live-mirrored R4).
        let on_blur = Closure::wrap(Box::new(move || {
            if is_destroying() {
                return;
            }
            let value = current_value(m);
            send_native(move |node_id| NativeEditEvent::Committed { node_id, value });
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

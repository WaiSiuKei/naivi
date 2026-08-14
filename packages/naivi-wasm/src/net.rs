//! `web_sys` fetch-backed [`NetProvider`] for the wasm host (U6 / R12).
//!
//! The engine's reqwest-based `blitz-net::Provider` depends on a tokio
//! runtime and cannot run on wasm32, so this provider uses `window.fetch`
//! directly (CORS mode) and routes results through the callback-style
//! `NetHandler` contract. Failures surface via `handler.error` so the
//! font-slice loader marks a slice failed instead of hanging in `loading`.

use blitz_traits::net::{Bytes, NetHandler, NetProvider, Request};
use js_sys::{JsString, Uint8Array};
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;
use web_sys::{Request as WebRequest, RequestInit, RequestMode, Response};

/// A `NetProvider` backed by the browser's `fetch` API.
#[derive(Clone, Copy, Default)]
pub struct WasmNetProvider;

impl NetProvider for WasmNetProvider {
    fn fetch(&self, _doc_id: usize, request: Request, handler: Box<dyn NetHandler>) {
        let url = request.url.to_string();
        let method = request.method.as_str().to_string();

        let opts = RequestInit::new();
        opts.set_method(&method);
        opts.set_mode(RequestMode::Cors);

        // Build the web Request; any failure fails the handler immediately.
        let web_req = match WebRequest::new_with_str_and_init(&url, &opts) {
            Ok(req) => req,
            Err(_) => {
                handler.error(url.clone());
                return;
            }
        };
        let window = match web_sys::window() {
            Some(window) => window,
            None => {
                handler.error(url);
                return;
            }
        };
        // `fetch_with_request` returns a `Promise` directly (validation
        // failures surface as a rejected promise).
        let promise = window.fetch_with_request(&web_req);

        wasm_bindgen_futures::spawn_local(async move {
            let response = match JsFuture::from(promise).await {
                Ok(response) => match response.dyn_into::<Response>() {
                    Ok(response) => response,
                    Err(_) => {
                        handler.error(url);
                        return;
                    }
                },
                Err(_) => {
                    handler.error(url);
                    return;
                }
            };

            if !response.ok() {
                handler.error(url);
                return;
            }

            let array_buffer = match response.array_buffer() {
                Ok(promise) => match JsFuture::from(promise).await {
                    Ok(buffer) => buffer,
                    Err(_) => {
                        handler.error(url);
                        return;
                    }
                },
                Err(_) => {
                    handler.error(url);
                    return;
                }
            };

            let bytes = Uint8Array::new(&array_buffer).to_vec();
            handler.bytes(url, Bytes::from(bytes));
        });
    }

    fn is_noop(&self) -> bool {
        false
    }
}

/// Fetch a URL as UTF-8 text (used for the Google Fonts CSS).
pub async fn fetch_text(url: &str) -> Result<String, JsValue> {
    let window = web_sys::window().ok_or_else(|| JsValue::from_str("no global window"))?;
    let promise = window.fetch_with_str(url);
    let response: Response = JsFuture::from(promise).await?.dyn_into()?;
    if !response.ok() {
        return Err(JsValue::from_str(&format!("HTTP {}", response.status())));
    }
    let text: JsString = JsFuture::from(response.text()?).await?.dyn_into()?;
    Ok(text.as_string().unwrap_or_default())
}

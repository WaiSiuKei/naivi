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

/// Fetch timeout for font slices and the CSS bootstrap. A fetch that never
/// settles would otherwise leave a slice `Loading` forever (and keep the
/// document pre-scan gate open); a bounded timeout moves it to the Failed
/// terminal state (R4 / AE5).
const FETCH_TIMEOUT_MS: u32 = 30_000;

/// A future that resolves (with `()`) after `ms` milliseconds via a JS
/// `setTimeout`, used to race long-lived fetches.
fn fetch_timeout(ms: u32) -> impl futures::Future<Output = ()> {
    let promise = js_sys::Promise::new(&mut |resolve: js_sys::Function, _reject: js_sys::Function| {
        if let Some(window) = web_sys::window() {
            let _ = window.set_timeout_with_callback_and_timeout_and_arguments(
                &resolve,
                ms as i32,
                &js_sys::Array::new(),
            );
        } else {
            // No timer available: resolve immediately so the fetch is not
            // aborted spuriously.
            let _ = resolve.call0(&JsValue::UNDEFINED);
        }
    });
    let future = JsFuture::from(promise);
    async move {
        let _ = future.await;
    }
}

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

        // Bounded lifetime: race the fetch against a timeout and abort on
        // expiry so the slice reaches the Failed terminal state instead of
        // hanging in Loading (R4 / AE5).
        let controller = web_sys::AbortController::new().ok();
        if let Some(signal) = controller.as_ref().map(|c| c.signal()) {
            opts.set_signal(Some(&signal));
        }

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
            // Fetch work produces the raw bytes without touching the handler;
            // the handler is invoked once below after the timeout race.
            let fetch_work = async {
                let response = match JsFuture::from(promise).await {
                    Ok(response) => match response.dyn_into::<Response>() {
                        Ok(response) => response,
                        Err(_) => return Err(()),
                    },
                    Err(_) => return Err(()),
                };

                if !response.ok() {
                    return Err(());
                }

                let array_buffer = match response.array_buffer() {
                    Ok(promise) => match JsFuture::from(promise).await {
                        Ok(buffer) => buffer,
                        Err(_) => return Err(()),
                    },
                    Err(_) => return Err(()),
                };

                Ok(Uint8Array::new(&array_buffer).to_vec())
            };

            match futures::future::select(
                Box::pin(fetch_work),
                Box::pin(fetch_timeout(FETCH_TIMEOUT_MS)),
            )
            .await
            {
                futures::future::Either::Left((Ok(bytes), _)) => {
                    handler.bytes(url, Bytes::from(bytes));
                }
                futures::future::Either::Left((Err(()), _)) => {
                    handler.error(url);
                }
                futures::future::Either::Right(_) => {
                    // Timeout: cancel the underlying fetch and fail the slice.
                    if let Some(controller) = controller {
                        controller.abort();
                    }
                    handler.error(url);
                }
            }
        });
    }

    fn is_noop(&self) -> bool {
        false
    }
}

/// Fetch a URL as UTF-8 text (used for the Google Fonts CSS), with the same
/// bounded timeout as slice fetches.
pub async fn fetch_text(url: &str) -> Result<String, JsValue> {
    let window = web_sys::window().ok_or_else(|| JsValue::from_str("no global window"))?;
    let promise = window.fetch_with_str(url);
    let work = async {
        let response: Response = JsFuture::from(promise).await?.dyn_into()?;
        if !response.ok() {
            return Err(JsValue::from_str(&format!("HTTP {}", response.status())));
        }
        let text: JsString = JsFuture::from(response.text()?).await?.dyn_into()?;
        Ok(text.as_string().unwrap_or_default())
    };
    match futures::future::select(Box::pin(work), Box::pin(fetch_timeout(FETCH_TIMEOUT_MS))).await {
        futures::future::Either::Left((result, _)) => result,
        futures::future::Either::Right(_) => Err(JsValue::from_str("fetch timeout")),
    }
}

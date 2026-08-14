//! QuickJS guest lifecycle (U5).
//!
//! Owns the rquickjs Runtime/Context, injects `globalThis.naive` (the ops FFI)
//! and a console shim, evals the guest bundle, and pumps the microtask queue
//! each frame. The guest is single-threaded and single-context; event delivery
//! runs inside `ctx.with` so the persisted callback can be restored and
//! called (mirrors naive-guest-quickjs KTD5 / KTD7).

use crate::main_ffi;
use naivi_dom::ffi;
use rquickjs::{Context, Ctx, Runtime, Value};

/// Minimal console polyfill routed to Rust logs (QuickJS-NG ships no console).
const CONSOLE_SHIM: &str = r#"
globalThis.console = {
  log: (...a) => globalThis.__naiveLog('info', a.map(String).join(' ')),
  info: (...a) => globalThis.__naiveLog('info', a.map(String).join(' ')),
  debug: (...a) => globalThis.__naiveLog('debug', a.map(String).join(' ')),
  warn: (...a) => globalThis.__naiveLog('warn', a.map(String).join(' ')),
  error: (...a) => globalThis.__naiveLog('error', a.map(String).join(' ')),
  trace: (...a) => globalThis.__naiveLog('debug', 'TRACE: ' + a.map(String).join(' ')),
  assert: (c, ...a) => { if (!c) globalThis.__naiveLog('error', 'Assertion failed: ' + a.map(String).join(' ')); },
  time: () => {},
  timeEnd: () => {},
  count: () => {},
  group: () => {},
  groupEnd: () => {},
};
"#;

/// Web `TextEncoder`/`TextDecoder` polyfills (QuickJS-NG ships neither, and the
/// naivi binary-frame writer encodes every DOM string with `TextEncoder`).
/// Pure JS, spec-conformant: astral pairs as 4-byte sequences, lone surrogates
/// as U+FFFD.
const TEXT_CODEC_SHIM: &str = r#"
globalThis.TextEncoder = globalThis.TextEncoder || class {
  constructor() { this.encoding = 'utf-8'; }
  encode(input = '') {
    const s = String(input);
    const n = s.length;
    const out = new Uint8Array(n * 4);
    let o = 0;
    for (let i = 0; i < n; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x80) {
        out[o++] = c;
      } else if (c < 0x800) {
        out[o++] = 0xc0 | (c >> 6);
        out[o++] = 0x80 | (c & 0x3f);
      } else if (c >= 0xd800 && c <= 0xdbff) {
        const lo = i + 1 < n ? s.charCodeAt(i + 1) : -1;
        if (lo >= 0xdc00 && lo <= 0xdfff) {
          const cp = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00);
          out[o++] = 0xf0 | (cp >> 18);
          out[o++] = 0x80 | ((cp >> 12) & 0x3f);
          out[o++] = 0x80 | ((cp >> 6) & 0x3f);
          out[o++] = 0x80 | (cp & 0x3f);
          i++;
          continue;
        }
        // High surrogate not followed by a low one: lone surrogate → U+FFFD.
        out[o++] = 0xef; out[o++] = 0xbf; out[o++] = 0xbd;
      } else if (c >= 0xdc00 && c <= 0xdfff) {
        // Lone low surrogate → U+FFFD.
        out[o++] = 0xef; out[o++] = 0xbf; out[o++] = 0xbd;
      } else {
        out[o++] = 0xe0 | (c >> 12);
        out[o++] = 0x80 | ((c >> 6) & 0x3f);
        out[o++] = 0x80 | (c & 0x3f);
      }
    }
    return out.subarray(0, o);
  }
};
globalThis.TextDecoder = globalThis.TextDecoder || class {
  constructor(label = 'utf-8', options) { this.encoding = 'utf-8'; }
  decode(input) {
    const b = input instanceof Uint8Array ? input
      : input instanceof ArrayBuffer ? new Uint8Array(input)
      : ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
      : new Uint8Array(0);
    let out = '';
    let i = 0;
    while (i < b.length) {
      const c0 = b[i];
      if (c0 < 0x80) { out += String.fromCharCode(c0); i += 1; }
      else if (c0 < 0xc2) { out += '\ufffd'; i += 1; }
      else if (c0 < 0xe0) {
        if (i + 1 >= b.length) { out += '\ufffd'; break; }
        out += String.fromCharCode(((c0 & 0x1f) << 6) | (b[i + 1] & 0x3f));
        i += 2;
      } else if (c0 < 0xf0) {
        if (i + 2 >= b.length) { out += '\ufffd'; break; }
        const cp = ((c0 & 0x0f) << 12) | ((b[i + 1] & 0x3f) << 6) | (b[i + 2] & 0x3f);
        out += (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff)) ? '\ufffd' : String.fromCharCode(cp);
        i += 3;
      } else if (c0 < 0xf5) {
        if (i + 3 >= b.length) { out += '\ufffd'; break; }
        const cp = ((c0 & 0x07) << 18) | ((b[i + 1] & 0x3f) << 12) | ((b[i + 2] & 0x3f) << 6) | (b[i + 3] & 0x3f);
        out += (cp < 0x10000 || cp > 0x10ffff) ? '\ufffd' : String.fromCodePoint(cp);
        i += 4;
      } else { out += '\ufffd'; i += 1; }
    }
    return out;
  }
};
"#;

/// A QuickJS guest session bound to one native window.
pub struct QuickJsGuest {
    // `context` must drop before `runtime` (struct fields drop in declaration
    // order): freeing the runtime while its context still references it trips
    // QuickJS's JS_FreeRuntime GC-list assert (KTD7 teardown order).
    context: Context,
    runtime: Runtime,
    initialized: bool,
}

impl QuickJsGuest {
    pub fn new() -> rquickjs::Result<Self> {
        let runtime = Runtime::new()?;
        let context = Context::full(&runtime)?;
        Ok(Self {
            runtime,
            context,
            initialized: false,
        })
    }

    /// Inject `globalThis.naive` (the ops FFI) + console shim and eval the
    /// guest bundle.
    ///
    /// The host must have installed the naivi document via
    /// [`ffi::install_document`] before this runs, so ops resolve against it.
    /// A failed eval returns the rquickjs error and leaves the guest
    /// uninitialized (callers decide how to surface it).
    pub fn init(&mut self, bundle: &str) -> rquickjs::Result<()> {
        self.context.with(|ctx| {
            Self::inject_runtime(&ctx, /* with_main_namespace */ false)?;
            Self::eval_bundle(&ctx, bundle, "init")
        })?;
        self.initialized = true;
        Ok(())
    }

    /// Initialize the guest with the desktop MAIN bundle (main/page split,
    /// plan 045 U2). Identical to [`init`](Self::init) plus the
    /// `globalThis.__naiveMain` namespace (whenReady/createWindow/loadFile),
    /// which the main bundle's `app.whenReady()` reads at eval time. The host
    /// must have published the page-bundle + project-dir state via
    /// [`main_ffi::set_main_state`] before this runs, so `loadFile` can eval
    /// the page bundle when the main calls it.
    pub fn init_main(&mut self, bundle: &str) -> rquickjs::Result<()> {
        self.context.with(|ctx| {
            Self::inject_runtime(&ctx, /* with_main_namespace */ true)?;
            Self::eval_bundle(&ctx, bundle, "init_main")
        })?;
        self.initialized = true;
        Ok(())
    }

    /// Inject the shared runtime surface: the ops FFI (`globalThis.naive`),
    /// the console shim, and (in main mode) the `__naiveMain` namespace.
    fn inject_runtime(ctx: &rquickjs::Ctx<'_>, with_main_namespace: bool) -> rquickjs::Result<()> {
        let naive = ffi::build_naive_namespace(ctx.clone())?;
        ctx.globals().set("naive", naive)?;
        ffi::register_logging(ctx.clone())?;
        let _: Value = ctx.eval(CONSOLE_SHIM)?;
        install_text_codecs(ctx)?;
        if with_main_namespace {
            main_ffi::build_main_namespace(ctx.clone())?;
        }
        Ok(())
    }

    /// Eval a bundle, surfacing the real JS exception (rquickjs's bare
    /// `Error::Exception` carries no message).
    fn eval_bundle(ctx: &rquickjs::Ctx<'_>, bundle: &str, what: &str) -> rquickjs::Result<()> {
        match ctx.eval::<Value, _>(bundle) {
            Ok(_) => Ok(()),
            Err(error) => {
                let caught = rquickjs::CaughtError::from_error(ctx, error);
                tracing::error!("guest.{what}: bundle eval failed: {caught}");
                Err(caught.throw(ctx))
            }
        }
    }

    /// Resolve `app.whenReady()` and pump the resulting microtasks (the main's
    /// `createWindow()` → `loadFile()` → page-bundle eval chain). Pumping runs
    /// outside `ctx.with` (KTD5).
    pub fn resolve_ready(&self) -> rquickjs::Result<()> {
        self.context.with(|ctx| main_ffi::resolve_ready(ctx))?;
        self.pump_jobs();
        Ok(())
    }

    pub fn is_initialized(&self) -> bool {
        self.initialized
    }

    /// Eval a snippet in the guest context (host-side injection, e.g. the U6
    /// `__NAIVE_CSS` global, tests, diagnostics).
    pub fn eval_script(&self, source: &str) -> rquickjs::Result<()> {
        self.context.with(|ctx| {
            let _: Value = ctx.eval(source)?;
            Ok(())
        })
    }

    /// Eval a snippet and return its value as a string (diagnostics).
    pub fn eval_string(&self, source: &str) -> rquickjs::Result<String> {
        self.context.with(|ctx| {
            let value: Value = ctx.eval(source)?;
            let out = match value.into_string() {
                Some(s) => s.to_string().unwrap_or_default(),
                None => String::new(),
            };
            Ok(out)
        })
    }

    /// Pump pending jobs (microtasks) for this frame.
    ///
    /// Must run outside `ctx.with` — the runtime lock is held inside `with`,
    /// and pumping re-enters the runtime (KTD5). A job that throws is logged
    /// and stops the pump for this frame; it never panics.
    pub fn pump_jobs(&self) {
        while self.runtime.is_job_pending() {
            if let Err(error) = self.runtime.execute_pending_job() {
                tracing::error!("guest.pump_jobs: job threw: {error:?}");
                break;
            }
        }
    }

    /// Deliver events queued by the native dispatch to the guest callback.
    ///
    /// Runs inside `ctx.with` so the persisted callback can be restored. A
    /// throwing callback is logged and skipped, never fatal (mirrors wasm's
    /// catch-and-continue).
    pub fn drain_events(&self) -> rquickjs::Result<()> {
        self.context.with(|ctx| ffi::drain_events(&ctx))
    }

    /// Run the guest's frame tick (KTD5): invokes `globalThis.__tick` if the
    /// guest mounted one (the desktop entry installs it as rAF-shim + writer
    /// flush → `naive.flush_frame`). The host calls this once per frame, after
    /// `pump_jobs` and before draining events. A missing `__tick` (pre-mount)
    /// is a no-op; a throwing tick is logged and never fatal.
    pub fn tick(&self) -> rquickjs::Result<()> {
        self.context.with(|ctx| {
            let _: Value = ctx.eval("globalThis.__tick && globalThis.__tick()")?;
            Ok(())
        })
    }

    /// Drop the stored callback, drain pending jobs, and run a final GC. Must
    /// run before the Context/Runtime are dropped (KTD7 — Persistents outlive
    /// their runtime otherwise, tripping JS_FreeRuntime's GC-list assert).
    pub fn shutdown(&mut self) {
        // Drain any remaining jobs so queued Promises don't hold objects.
        self.pump_jobs();
        // Drop the stored callback while the context is still alive.
        ffi::clear_all();
        // Force a GC so JS_FreeRuntime sees an empty object list.
        self.runtime.run_gc();
        self.initialized = false;
    }
}

impl Drop for QuickJsGuest {
    /// Safe teardown even when the caller forgets `shutdown` or drops during a
    /// panic unwind — otherwise JS_FreeRuntime trips on live objects (KTD7).
    fn drop(&mut self) {
        if self.initialized {
            self.shutdown();
        }
    }
}

/// Register `globalThis.TextEncoder`/`TextDecoder` (see [`TEXT_CODEC_SHIM`]).
/// QuickJS-NG ships neither; without this the guest's mount fails with
/// "TextEncoder is not defined" and the window stays blank.
fn install_text_codecs(ctx: &Ctx<'_>) -> rquickjs::Result<()> {
    let _: Value = ctx.eval(TEXT_CODEC_SHIM)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The binary-frame writer encodes every DOM string with `TextEncoder`;
    /// QuickJS ships none, so the shim must be a correct UTF-8 encoder.
    #[test]
    fn text_codec_shim_matches_utf8() {
        let guest = QuickJsGuest::new().unwrap();
        guest.eval_script(TEXT_CODEC_SHIM).unwrap();
        // ASCII stays single-byte (a broken encoder emits UTF-16 null pairs).
        let width = guest
            .eval_string("Array.from(new TextEncoder().encode('width')).join(',')")
            .unwrap();
        assert_eq!(width, "119,105,100,116,104");
        // Astral pair (😀 = U+1F600) round-trips through decode.
        let rt = guest
            .eval_string(
                "new TextDecoder().decode(new TextEncoder().encode('Hello 世界 😀'))",
            )
            .unwrap();
        assert_eq!(rt, "Hello 世界 😀");
        // Lone surrogate becomes U+FFFD (EF BF BD), not a dropped character.
        let lone = guest
            .eval_string("Array.from(new TextEncoder().encode('a\\uD800b')).join(',')")
            .unwrap();
        assert_eq!(lone, "97,239,191,189,98");
    }
}

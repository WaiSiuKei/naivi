//! QuickJS guest lifecycle (U5).
//!
//! Owns the rquickjs Runtime/Context, injects `globalThis.naive` (the ops FFI)
//! and a console shim, evals the guest bundle, and pumps the microtask queue
//! each frame. The guest is single-threaded and single-context; event delivery
//! runs inside `ctx.with` so the persisted callback can be restored and
//! called (mirrors naive-guest-quickjs KTD5 / KTD7).

use crate::main_ffi;
use naivi_dom::ffi;
use rquickjs::{Context, Runtime, Value};

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

//! `globalThis.__naiveMain` FFI surface for the desktop main/page split
//! (mirrors naive's `naive-guest-quickjs/src/main_ffi.rs`).
//!
//! Provides `createWindow` and `loadFile` as Rust-backed functions plus a
//! JS-assembled namespace exposing the Electron-style `whenReady()` promise.
//! The host resolves readiness by calling `globalThis.__naiveMain._resolveReady()`
//! after the main bundle initializes — this avoids persisting a rquickjs
//! `Persistent<Function>` across the ready handshake.
//!
//! Flow: the CLI bundles the project's `main` (aliasing `@naivi/runtime` to
//! the desktop-main API) into `main-bundle.js` and the page entry into
//! `page-bundle.js`. The host evals the main bundle first; it registers
//! `app.whenReady().then(createWindow)` (nothing runs until readiness). When
//! the host resolves readiness, the main's `createWindow()` runs (window size
//! is already baked in as `__NAIVE_WINDOW_SIZE__`), then `loadFile('index.html')`
//! evals the prebuilt page bundle as window content.
//!
//! JS-callable functions take the current [`Ctx`] and never call
//! `Context::with` internally (KTD5 — re-entering the runtime lock from a
//! callback self-deadlocks). Shared host state lives in a thread-local.

use std::cell::RefCell;
use std::path::{Path, PathBuf};

use rquickjs::{Ctx, Function, Result, Value};

thread_local! {
    static MAIN_STATE: RefCell<MainState> = RefCell::new(MainState::default());
}

/// Host-side state the `loadFile` handler needs (set before the main bundle runs).
#[derive(Default)]
pub struct MainState {
    /// The prebuilt page bundle (the main bundle's counterpart), evaled on
    /// `loadFile`.
    pub page_bundle: Option<String>,
    /// Project dir for dev-mode page resolution (`<dir>/<path>`).
    pub project_dir: Option<PathBuf>,
    /// Set once a page has been successfully loaded (guards re-entry).
    pub page_loaded: bool,
}

/// Publish the host state the main FFI handlers read.
pub fn set_main_state(state: MainState) {
    MAIN_STATE.with(|slot| *slot.borrow_mut() = state);
}

/// Whether a page was successfully loaded via `loadFile` (KD5 hardening: a
/// main that never loads a page is a silent blank-window failure).
pub fn page_was_loaded() -> bool {
    MAIN_STATE.with(|state| state.borrow().page_loaded)
}

/// Register the `__naiveCreateWindow` / `__naiveLoadFile` globals and assemble
/// `globalThis.__naiveMain` with a host-resolved `whenReady()` promise.
pub fn build_main_namespace<'js>(ctx: Ctx<'js>) -> Result<()> {
    ctx.globals().set(
        "__naiveCreateWindow",
        Function::new(ctx.clone(), create_window)?,
    )?;
    ctx.globals()
        .set("__naiveLoadFile", Function::new(ctx.clone(), load_file)?)?;
    let source = r#"
globalThis.__naiveMain = (() => {
  let _resolveReady;
  const _ready = new Promise((res) => { _resolveReady = res; });
  return {
    whenReady: () => _ready,
    createWindow: (w, h) => globalThis.__naiveCreateWindow(w, h),
    loadFile: (p) => globalThis.__naiveLoadFile(p),
    _resolveReady: () => _resolveReady(),
  };
})();
"#;
    let _: Value = ctx.eval(source)?;
    Ok(())
}

/// Resolve `app.whenReady()` (the main bundle's startup promise). The host
/// calls this after the main bundle initializes; the caller must pump the
/// guest's microtasks afterwards so the main's `createWindow()`/`loadFile()`
/// chain runs.
pub fn resolve_ready<'js>(ctx: Ctx<'js>) -> Result<()> {
    let _: Value = ctx.eval("globalThis.__naiveMain._resolveReady()")?;
    Ok(())
}

/// The main bundle's `createWindow(w, h)` — a size confirmation. The blitz
/// shell sizes the window at creation from the CLI's baked-in
/// `__NAIVE_WINDOW_SIZE__` (default 800x600 for fill-mode demos), so this is
/// a no-op that logs the requested size; resizing a live blitz window isn't
/// exposed yet.
fn create_window<'js>(_ctx: Ctx<'js>, width: f64, height: f64) {
    tracing::info!("naive desktop: createWindow({width:.0}, {height:.0})");
}

/// The main bundle's `loadFile(path)` — resolve the page and eval the prebuilt
/// page bundle as window content. Runs inside `ctx.with` (the caller holds the
/// runtime lock), so the page bundle is evaled in the same context; a failed
/// eval surfaces a fatal error (matching naive's KD5 exit behavior).
fn load_file<'js>(ctx: Ctx<'js>, path: String) {
    let (page_bundle, html_path, already_loaded) = MAIN_STATE.with(|state| {
        let state = state.borrow_mut();
        if state.page_loaded {
            tracing::warn!(
                "naive desktop: loadFile called again — page already loaded; ignoring"
            );
            return (None, None, true);
        }
        (
            state.page_bundle.clone(),
            resolve_page_html(state.project_dir.as_deref(), &path),
            false,
        )
    });
    if already_loaded {
        return;
    }

    let Some(html_path) = html_path else {
        eprintln!("naive desktop: page `{path}` not found");
        std::process::exit(1);
    };
    if let Err(error) = std::fs::read_to_string(&html_path) {
        eprintln!(
            "naive desktop: failed to read page `{}`: {error}",
            html_path.display()
        );
        std::process::exit(1);
    }
    let Some(page_bundle) = page_bundle else {
        eprintln!("naive desktop: page bundle missing");
        std::process::exit(1);
    };
    // Clear any stale mount-error flag before evaling a fresh page.
    let _: rquickjs::Result<Value> = ctx.eval("globalThis.__naiveMountError = undefined;");
    if let Err(error) = ctx.eval::<Value, _>(page_bundle.as_str()) {
        let caught = rquickjs::CaughtError::from_error(&ctx, error);
        eprintln!("naive desktop: page bundle eval failed: {caught}");
        std::process::exit(1);
    }
    MAIN_STATE.with(|state| state.borrow_mut().page_loaded = true);
}

/// Resolve a `loadFile` page path against the project dir. Strip leading
/// slashes: `Path::join` treats an absolute argument as a replacement root, so
/// `/index.html` must become `index.html` (the CLI's `findPageEntry` already
/// normalizes the same way).
fn resolve_page_html(project_dir: Option<&Path>, path: &str) -> Option<PathBuf> {
    let path = path.trim_start_matches('/');
    if let Some(dir) = project_dir {
        let candidate = dir.join(path);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

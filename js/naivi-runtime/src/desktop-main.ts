// Desktop main-process API (plan 045, U1; plan 057, U1).
//
// Electron-style entry surface for `naive desktop`: `app.whenReady()` and
// `NaiveWindow`. Backed by the host-injected `globalThis.__naiveMain` FFI
// namespace, which the native guest provides (whenReady / createWindow /
// loadFile). The CLI bundles the project's `main` with `@naive/runtime`
// aliased to this module (KTD7).
//
// Plan 057: the window size is no longer passed through main code. The CLI
// injects `__NAIVE_WINDOW_SIZE__` (an object literal `{ width, height }`,
// mirroring the `__NAIVE_PAGE_SIZE__` contract) into the main bundle; the
// constructor reads it and sizes the native window itself. `load()` replaces
// `loadFile(path)` — the page path is declared in the constructor.

/** The FFI namespace the native host injects before evaling the main bundle. */
export interface MainFfi {
  /** Resolves once the host and runtime are initialized. */
  whenReady(): Promise<void>;
  /** Size the single native window (viewport InnerSize command). */
  createWindow(width: number, height: number): void;
  /** Load a project page file; its Vue entry becomes the window content. */
  loadFile(path: string): void;
}

/** Window size injected by the CLI as `__NAIVE_WINDOW_SIZE__` (plan 057, KTD1). */
export interface WindowSize {
  width: number;
  height: number;
}

declare const __NAIVE_WINDOW_SIZE__: unknown;

/**
 * Read the injected window size. The CLI always injects the resolved size
 * (plan 057, KTD2); this defensive fallback mirrors `readPageSize` and keeps
 * a bare reference from throwing when the define is absent (standalone Vite).
 */
function readWindowSize(): WindowSize {
  if (typeof __NAIVE_WINDOW_SIZE__ !== "undefined" && __NAIVE_WINDOW_SIZE__ !== null) {
    const size = __NAIVE_WINDOW_SIZE__ as Partial<WindowSize>;
    if (
      typeof size.width === "number" &&
      typeof size.height === "number" &&
      size.width > 0 &&
      size.height > 0
    ) {
      return { width: size.width, height: size.height };
    }
  }
  return { width: 800, height: 600 };
}

function getMainFfi(): MainFfi {
  const ffi = (globalThis as unknown as Record<string, unknown>).__naiveMain;
  if (!ffi) {
    throw new Error("[naive] desktop main: globalThis.__naiveMain FFI not injected");
  }
  return ffi as MainFfi;
}

/** The desktop app object (Electron-style). */
export const app = {
  /** Resolves once the host and runtime are initialized. */
  whenReady(): Promise<void> {
    return getMainFfi().whenReady();
  },
};

/** A desktop window (single window in v1, R8). */
export class NaiveWindow {
  /** The page path declared in the constructor (plan 057, R5). */
  readonly page: string;
  /** Resolved window width (injected size; default 800). */
  readonly width: number;
  /** Resolved window height (injected size; default 600). */
  readonly height: number;

  constructor(options: { page: string }) {
    if (typeof options.page !== "string" || options.page.trim().length === 0) {
      throw new Error("[naive] NaiveWindow: `page` must be a non-empty page path");
    }
    this.page = options.page;
    const size = readWindowSize();
    this.width = size.width;
    this.height = size.height;
    // Size the native window immediately (viewport InnerSize command).
    getMainFfi().createWindow(this.width, this.height);
  }

  /** Load the constructor-declared page; its Vue entry becomes window content (R5). */
  load(): void {
    getMainFfi().loadFile(this.page);
  }
}

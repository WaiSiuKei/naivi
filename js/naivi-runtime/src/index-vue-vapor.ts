// Vue Vapor runtime entry for naive — WASM-based render() / mount().
//
// Usage:
//   import { mount } from "@naive/runtime/vue-vapor";
//   import App from "./app.js";
//   mount(App);
//
// Dual-mode: when WASM is available (naive wasm), renders via the mirror
// tree + the U4 wasm host (naivi-counter-wasm). When WASM is absent (naive
// web / standalone Vite), falls back to standard Vue createApp().mount()
// automatically.
//
// IMPORTANT: Vue is imported dynamically (not at top-level) so the WASM path
// stays lazy and the naive renderer (createRenderer) is the only consumer —
// it receives the facade explicitly, so no global `document` patching.

import { bindWasm, registerEventCallback } from "./native-tree.js";
import { createWasmExports, type WasmBindgenModule } from "./wasm-export.js";
import { installFontsPendingHook } from "./placeholder-text.js";
import {
  naiveBodyStyle,
  naiveRootStyle,
  readPageSize,
  resolvePlacement,
  webTargetStyle,
  type PageSize,
} from "./page-size.js";

/**
 * Apply the fixed-size web container placement (plan 055 R3): centered when
 * the window fits the size, top-left otherwise. Re-application replaces the
 * injected declarations while preserving the element's pre-existing inline
 * style.
 *
 * Fit is decided against the ACTUAL visible viewport
 * (document.documentElement.clientWidth/Height), not window.innerWidth:
 * innerWidth includes the DevTools-occluded area and oscillates around the
 * page size during live resize, which flipped the placement between centered
 * and top-left (the resize jump). clientWidth/Height are stable.
 */
function applyWebPlacement(el: HTMLElement, baseStyle: string): void {
  const size = readPageSize();
  const viewportW = document.documentElement.clientWidth;
  const viewportH = document.documentElement.clientHeight;
  const placement = size
    ? resolvePlacement(size, viewportW, viewportH)
    : "top-left";
  const style = webTargetStyle(size, placement);
  el.style.cssText = style ? (baseStyle ? `${baseStyle};${style}` : style) : baseStyle;
}

/** Facade body element used by the naive DOM (wasm pipeline). */
type FacadeBody = {
  setAttribute(name: string, value: string): void;
  removeAttribute?(name: string): void;
};

/**
 * Apply the fixed-size wasm root placement (plan 055 R2): centered when the
 * canvas fits the size, top-left otherwise. The body flex style is removed
 * when the placement is top-left so a shrunken canvas unpins cleanly.
 */
function applyWasmPlacement(
  size: PageSize,
  canvas: HTMLCanvasElement,
  body: FacadeBody,
): void {
  const placement = resolvePlacement(size, canvas.clientWidth, canvas.clientHeight);
  const bodyStyle = naiveBodyStyle(size, placement);
  if (bodyStyle) {
    body.setAttribute("style", bodyStyle);
  } else if (body.removeAttribute) {
    body.removeAttribute("style");
  }
}

export interface MountOptions {
  target?: string | Element;
}

let _wasmReady = false;

/**
 * Resolve the wasm-bindgen module (the U4 host's exports).
 *
 * Trunk host page: trunk loads the wasm glue itself, publishes its bindings
 * on `window.wasmBindings`, and fires `TrunkApplicationStarted` once the
 * glue's `init()` (which runs `#[wasm_bindgen(start)]`) resolves.
 */
async function resolveWasmModule(): Promise<WasmBindgenModule> {
  const existing = (globalThis as { wasmBindings?: unknown }).wasmBindings;
  if (existing) return existing as WasmBindgenModule;

  const trunkStarted = new Promise<WasmBindgenModule>((resolve) => {
    const onStarted = () => {
      resolve((globalThis as { wasmBindings?: unknown }).wasmBindings as WasmBindgenModule);
    };
    window.addEventListener("TrunkApplicationStarted", onStarted, { once: true });
    // Race guard: the event may have fired before this listener was installed.
    const bindings = (globalThis as { wasmBindings?: unknown }).wasmBindings;
    if (bindings) {
      window.removeEventListener("TrunkApplicationStarted", onStarted);
      resolve(bindings as WasmBindgenModule);
    }
  });
  return trunkStarted;
}

async function loadWasm(): Promise<void> {
  if (_wasmReady) return;
  const wasmModule = await resolveWasmModule();
  const wasmExports = createWasmExports(wasmModule);

  // Expose for debugging.
  (globalThis as any).__naiveWasm = wasmModule;

  bindWasm(wasmExports);

  // Route Rust-dispatched events (click/pointer/…) to the JS listener
  // registry installed by the DOM facade (U4 set_event_callback).
  registerEventCallback();

  // Font-state hook parity (plan 040 review #3/#6): the U4 host resolves its
  // bundled font in Rust; the trailing-edge clear is a no-op safety net.
  installFontsPendingHook(() => {
    wasmExports.clear_placeholder_measures();
  });

  _wasmReady = true;
}

// Expose mount for CLI devtools interception
(globalThis as unknown as Record<string, unknown>).__naiveModules = { mount };

export async function mount(
  component: any,
  opts: MountOptions = {},
): Promise<void> {
  // Detect environment: `naive wasm` injects __NAIVE_MODE="wasm".
  // In `naive web` or standalone Vite, fall back to standard Vue mount.
  const isWasmMode = (globalThis as any).__NAIVE_MODE === 'wasm';

  if (!isWasmMode) {
    // Web mode: import Vue and mount to real DOM. Plan 049: when the page
    // declares a fixed size, size and center the mount target in the page
    // (KTD2); otherwise leave it untouched (fill mode).
    const { createApp } = await import("vue");
    const target = typeof opts.target === 'string' ? opts.target : '#app';
    const mountTarget = document.querySelector(target);
    if (mountTarget) {
      // Plan 055 R3: fixed-size container placement reacts to window resize
      // (centered when it fits, top-left otherwise).
      const el = mountTarget as HTMLElement;
      const baseStyle = el.getAttribute("style") ?? "";
      applyWebPlacement(el, baseStyle);
      window.addEventListener("resize", () => applyWebPlacement(el, baseStyle));
      createApp(component).mount(mountTarget as Element);
    }
    return;
  }

  // WASM pipeline: load WASM, start the host render loop, then mount Vue
  // through a naive renderer.
  try {
    await loadWasm();
  } catch (err) {
    console.error('[naive] WASM mode detected but wasm assets not found. Run `naive wasm` to copy them.', err);
    return;
  }

  const target = opts.target ?? "#app";
  // Use the real browser document for DOM queries (canvas mount target).
  const targetEl = typeof target === "string"
    ? document.querySelector(target)
    : target;
  if (!targetEl) throw new Error(`naive: mount target "${target}" not found`);

  // The U4 host (naivi-counter-wasm) owns the render loop: the trunk page
  // ships <canvas id="blitz-target"> and the Rust `start()` drives it (winit
  // + VelloHybrid renderer). No JS-side WebHandle is involved.
  let canvas = (targetEl.querySelector("canvas#blitz-target") as HTMLCanvasElement | null)
    ?? (document.querySelector("canvas#blitz-target") as HTMLCanvasElement | null)
    ?? (targetEl.querySelector("canvas") as HTMLCanvasElement | null);
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.id = "blitz-target";
    canvas.style.cssText = "display:block;width:100%;height:100%";
    targetEl.appendChild(canvas);
  }

  // Yield a frame so the host's first frame completes before we create
  // facade nodes. Hidden / backgrounded pages never fire rAF, so race the
  // two-frame wait against a timeout to avoid stalling the mount forever.
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    };
    requestAnimationFrame(() => requestAnimationFrame(finish));
    setTimeout(finish, 500);
  });

  // Install the naive DOM facade — its nodes carry real wasmIds before the
  // naive renderer starts mounting Vue components.
  const { getNaiveDocument, loadCSSClassStyles, initNaiveDocument } = await import("./naive-dom.js");
  initNaiveDocument();
  await loadCSSClassStyles();

  // Resolve component (supports both Component objects and render functions)
  let vueComponent: any;
  if (typeof component === "function") {
    const result = component();
    if (typeof result === "function" && result.length === 0) {
      vueComponent = { render: result };
    } else {
      vueComponent = component;
    }
  } else {
    vueComponent = component;
  }

  const naiveDoc = getNaiveDocument();
  if (!naiveDoc) throw new Error("naive: naive document facade not initialized");

  const naiveRoot = naiveDoc.createElement("div") as any;
  naiveRoot.setAttribute("id", "naive-root");
  // Plan 049 KTD2: fixed px size when the page declares width/height, else
  // the default 100%×100% fill. The flex-column layout is inline (plan 058
  // U3) — previously `class="flex-col items-center justify-center"`, which
  // only compiled for Tailwind projects.
  const pageSize = readPageSize();
  naiveRoot.setAttribute("style", naiveRootStyle(pageSize));
  if (pageSize) {
    // Fixed mode (plan 055 R2): center the root when the canvas fits the
    // fixed size, pin top-left otherwise; re-evaluate on canvas resize.
    const body = naiveDoc.body as unknown as FacadeBody;
    applyWasmPlacement(pageSize, canvas, body);
    if (typeof ResizeObserver !== "undefined") {
      new ResizeObserver(() => applyWasmPlacement(pageSize, canvas, body)).observe(canvas);
    }
  }

  // Attach the root under the facade body so it lands under the canonical
  // scene root (the first parentless host node) — same wiring as the host
  // page's Vue E2E path — and resolve install-time nodes before Vue mounts so
  // the mount batch addresses the existing root by id (alias/appendId).
  (naiveDoc.body as unknown as { appendChild(child: unknown): void }).appendChild(naiveRoot);
  const { flush } = await import("./batched-bridge.js");
  flush();

  // Mount through a naive renderer (createRenderer) so Vue creates facade
  // nodes that flow into the batched FFI bridge — no global document patching.
  const { createNaiveRenderer } = await import("./naive-renderer.js");
  const renderer = createNaiveRenderer(naiveDoc);
  const app = renderer.createApp(vueComponent);
  app.mount(naiveRoot);

  // Make the Vue-mounted child fill the naiveRoot container. Append to any
  // existing inline style (a `:style` binding on the root) rather than
  // replacing it, so the child's own styles are not clobbered.
  const topChild = naiveRoot.childNodes[0] as any;
  if (topChild && topChild.nodeType === 1) {
    const prevStyle = topChild.getAttribute("style");
    topChild.setAttribute(
      "style",
      prevStyle ? `${prevStyle};width:100%;height:100%` : "width:100%;height:100%",
    );
  }

  (globalThis as any).__naiveRoot = naiveRoot;
}

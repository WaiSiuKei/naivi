// Vue Vapor runtime entry for naive — WASM-based render() / mount().
//
// Usage:
//   import { mount } from "@naive/runtime/vue-vapor";
//   import App from "./app.js";
//   mount(App);
//
// Dual-mode: when WASM is available (naive wasm), renders via the native
// tree + WebHost pipeline. When WASM is absent (naive web / standalone Vite),
// falls back to standard Vue createApp().mount() automatically.
//
// IMPORTANT: Vue is imported dynamically (not at top-level) so the WASM path
// stays lazy and the naive renderer (createRenderer) is the only consumer —
// it receives the facade explicitly, so no global `document` patching.

import { bindWasm, type WasmExports } from "./native-tree.js";
import type { EventDescriptor, EventCallback } from "./wasm-types.js";
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

async function loadWasm(): Promise<void> {
  if (_wasmReady) return;
  // Dev serves the naive-owned copy under node_modules/.naive. Production
  // builds use a naive vite plugin that rewrites this variable import into a
  // literal, so vite bundles the wasm module into dist/assets (hashed).
  const wasmPath = import.meta.env.DEV
    ? "/node_modules/.naive/pkg/naive_host.js"
    : "/assets/naive-wasm/naive_host.js";
  const wasmModule = await import(/* @vite-ignore */ wasmPath);
  await wasmModule.default();

  const wasmExports: WasmExports = {
    create_element: (tag: string) => wasmModule.create_element(tag),
    set_text: (id: bigint, text: string) => wasmModule.set_text(id, text),
    set_style: (id: bigint, key: string, value: string) =>
      wasmModule.set_style(id, key, value),
    append_child: (parent: bigint, child: bigint) =>
      wasmModule.append_child(parent, child),
    remove_node: (id: bigint) => wasmModule.remove_node(id),
    compute_layout: (root: bigint, w: number, h: number) =>
      wasmModule.compute_layout(root, w, h),
    apply_ops: (opsJson: string) => wasmModule.apply_ops(opsJson),
    apply_conditional_styles: (nodeId: bigint, rulesJson: string) =>
      wasmModule.apply_conditional_styles(nodeId, rulesJson),
    add_event_listener: (nodeId: bigint, eventType: string, cb: EventCallback) =>
      wasmModule.add_event_listener(nodeId, eventType, cb),
    remove_event_listener: (handlerId: bigint) =>
      wasmModule.remove_event_listener(handlerId),
    handle_event: (descriptor: EventDescriptor) => wasmModule.handle_event(descriptor),
    set_placeholder_measures: (opsJson: string) =>
      wasmModule.set_placeholder_measures(opsJson),
    clear_placeholder_measures: () => wasmModule.clear_placeholder_measures(),
    get_layout_rect: (nodeId: bigint) => wasmModule.get_layout_rect(nodeId),
    set_rule_table: (rulesJson: string) => wasmModule.set_rule_table(rulesJson),
    flush_styles: () => wasmModule.flush_styles(),
    get_computed_style_json: (nodeId: bigint) =>
      wasmModule.get_computed_style_json(nodeId),
  };

  // Expose for debugging
  (globalThis as any).__naiveWasm = wasmModule;

  bindWasm(wasmExports);

  // Plan 040 (review #3/#6): the Rust font loader flips this hook at
  // start/settle. On the trailing edge placeholders are cleared so they never
  // stay stuck (failure path safety net; the success path already converges
  // in Rust).
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
  } catch {
    console.error('[naive] WASM mode detected but wasm assets not found. Run `naive wasm` to copy them.');
    return;
  }

  const target = opts.target ?? "#app";
  // Use the real browser document for DOM queries (canvas mount target).
  const targetEl = typeof target === "string"
    ? document.querySelector(target)
    : target;
  if (!targetEl) throw new Error(`naive: mount target "${target}" not found`);

  let canvas = targetEl.querySelector("canvas") as HTMLCanvasElement | null;
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.id = "naive-canvas";
    canvas.style.cssText = "display:block;width:100%;height:100%";
    targetEl.appendChild(canvas);
  }

  // Start the WebRunner render loop FIRST — the host context (HostState) is
  // published by HostApp::build_scene_graph on the first frame, and any
  // apply_ops batch flushed before that is rejected. Yield a frame so the
  // first frame completes before we create facade nodes.
  const wasmPath = import.meta.env.DEV
    ? "/node_modules/.naive/pkg/naive_host.js"
    : "/assets/naive-wasm/naive_host.js";
  const wasmModule2 = await import(/* @vite-ignore */ wasmPath);
  const { WebHandle } = wasmModule2;
  const host = new WebHandle();
  await host.start(canvas);
  await new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)));
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

  // Make the Vue-mounted child fill the naiveRoot container.
  const topChild = naiveRoot.childNodes[0] as any;
  if (topChild && topChild.nodeType === 1) {
    topChild.setAttribute("style", "width:100%;height:100%");
  }

  (globalThis as any).__naiveRoot = naiveRoot;
}

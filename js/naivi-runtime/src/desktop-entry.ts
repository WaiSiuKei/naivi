// Desktop (QuickJS) entry for the naive runtime (plan 043, U5).
//
// `naive desktop` esbuild-aliases `@naive/runtime/vue-vapor` to this module,
// so the app's `mount(App)` call lands here. The host (naive-guest-quickjs)
// injects the `globalThis.naive` FFI namespace; this entry binds it to the
// shared mirror-tree/renderer stack and mounts Vue through the naive renderer.
// No document, canvas, or requestAnimationFrame — the native window owns the
// canvas.

import {
  bindWasm,
  registerEventCallback,
  registerFrameRejectedHandler,
  tick,
  type WasmExports,
} from "./native-tree.js";
import { installFontsPendingHook } from "./placeholder-text.js";
import { naiveRootStyle } from "./page-size.js";

export interface MountOptions {
  target?: string | Element;
}

/** The FFI namespace the native host injects before evaling the bundle. */
function getFfi(): WasmExports {
  const ffi = (globalThis as unknown as Record<string, unknown>).naive;
  if (!ffi) {
    throw new Error("[naive] desktop: globalThis.naive FFI not injected");
  }
  return ffi as WasmExports;
}

export async function mount(component: any, _opts: MountOptions = {}): Promise<void> {
  try {
    await mountInner(component);
  } catch (error) {
    // Surface mount failures for the host (diag/logging; the native window
    // stays alive and the error is visible in the guest console/logs).
    const message = (error as Error)?.message ?? String(error);
    const stack = (error as Error)?.stack ?? "";
    (globalThis as unknown as Record<string, unknown>).__naiveMountError = `${message}\n${stack}`;
    throw error;
  }
}

// Frame-rejection self-heal guard (R15/F3): bound rebuild + re-mount attempts.
const MAX_HEAL_ATTEMPTS = 5;
let _healAttempts = 0;

/**
 * Rebuild the facade and re-mount after a `frame_rejected(seq, reason)`
 * (see index-vue-vapor.ts `recoverMount` for the rationale).
 */
async function recoverMount(component: any): Promise<void> {
  _healAttempts++;
  if (_healAttempts > MAX_HEAL_ATTEMPTS) {
    console.error(
      `[naivi] frame-rejection self-heal exceeded ${MAX_HEAL_ATTEMPTS} attempts — giving up`,
    );
    return;
  }
  console.warn(
    `[naivi] self-heal attempt ${_healAttempts}/${MAX_HEAL_ATTEMPTS}: rebuilding facade + re-mounting`,
  );
  const { initNaiveDocument } = await import("./naive-dom.js");
  initNaiveDocument();
  await mount(component);
}

async function mountInner(component: any): Promise<void> {
  const stage = (s: string) => {
    (globalThis as unknown as Record<string, unknown>).__naiveMountStage = s;
  };
  stage("start");
  const ffi = getFfi();
  bindWasm(ffi);

  // Route Rust-dispatched events (click/pointer/…) to the JS listener
  // registry installed by the DOM facade (U5 set_event_callback).
  registerEventCallback();

  // Self-heal wiring (R15/F3): on `frame_rejected` rebuild + re-mount.
  registerFrameRejectedHandler(() => {
    void recoverMount(component);
  });

  // Legacy placeholder-measure hook (plan 040): the native host resolves
  // fonts in Rust; the trailing-edge clear is a no-op.
  installFontsPendingHook(() => {});

  const { getNaiveDocument, loadCSSClassStyles, initNaiveDocument } = await import("./naive-dom.js");
  stage("naive-dom-imported");
  initNaiveDocument();
  stage("doc-init");
  await loadCSSClassStyles();
  stage("styles-loaded");

  // Resolve component (supports both Component objects and render functions).
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
  // Fill root with inline flex-column layout (plan 058 U3) — previously
  // `class="flex-col items-center justify-center"`, which only compiled for
  // Tailwind projects.
  naiveRoot.setAttribute("style", naiveRootStyle(null));
  (naiveDoc.body as unknown as { appendChild(child: unknown): void }).appendChild(naiveRoot);

  // Resolve install-time nodes before Vue mounts so the mount batch addresses
  // the existing root by id (alias/appendId).
  const { flush } = await import("./batched-bridge.js");
  flush();
  stage("flushed");

  const { createNaiveRenderer } = await import("./naive-renderer.js");
  stage("renderer-imported");
  const renderer = createNaiveRenderer(naiveDoc);
  const app = renderer.createApp(vueComponent);
  stage("app-created");
  app.mount(naiveRoot);
  stage("mounted");

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

  // Frame contract (U8): the native host calls `globalThis.__tick()` once per
  // frame — pump jobs, then flush the queued ops as one binary frame.
  (globalThis as unknown as Record<string, unknown>).__tick = () => {
    tick();
  };

  (globalThis as unknown as Record<string, unknown>).__naiveRoot = naiveRoot;
}

// Expose mount for CLI devtools interception parity.
(globalThis as unknown as Record<string, unknown>).__naiveModules = { mount };

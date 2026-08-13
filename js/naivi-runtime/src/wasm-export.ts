// WasmExports factory for the U5 wasm channel (KTD1/8).
//
// Takes the wasm-bindgen module (the trunk-served glue, published on
// `window.wasmBindings`) and returns the [`WasmExports`] object the mirror
// tree binds. The per-op DOM surface is gone — the guest sends one
// `flush_frame(bytes)` per frame boundary and receives events per-callback.

import type { WasmExports } from './wasm-types.js';

/** The wasm-bindgen module surface we consume (duck-typed). */
export interface WasmBindgenModule {
  flush_frame?(bytes: Uint8Array): void;
  set_event_callback?(
    cb: (nodeId: number, kind: number, x: number, y: number, key?: string, code?: string, value?: string) => void,
  ): void;
  set_frame_rejected_callback?(cb: (seq: number, reason: number) => void): void;
  tick?(): void;
}

/**
 * Build the [`WasmExports`] object over a wasm-bindgen module.
 *
 * `wasm` may be the full module namespace or a partial object (e.g. a mock in
 * tests); every export is wrapped defensively so a missing low-level function
 * degrades to a no-op instead of throwing at bind time.
 */
export function createWasmExports(wasm: WasmBindgenModule): WasmExports {
  return {
    flush_frame: (bytes: Uint8Array) => {
      wasm.flush_frame?.(bytes);
    },
    set_event_callback: (cb) => {
      // Rust→JS callback passed through as-is: the glue calls it with
      // `(nodeId, kind, x, y, key, code, value)` per event (KD2).
      wasm.set_event_callback?.(cb);
    },
    set_frame_rejected_callback: (cb) => {
      wasm.set_frame_rejected_callback?.(cb);
    },
    tick: () => {
      wasm.tick?.();
    },
  };
}

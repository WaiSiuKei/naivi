// WasmExports factory for the U4 wasm channel (KTD1).
//
// Takes the wasm-bindgen module (the trunk-served `naivi_counter_wasm.js`
// glue, published on `window.wasmBindings`) and returns the [`WasmExports`]
// object the mirror tree binds. Handles the bigint ↔ number conversions the
// wasm-bindgen surface requires:
//
// - `u64` **returns** arrive as JS `bigint` — wrapped with `BigInt(...)` so
//   the type is stable regardless of glue version.
// - `u64` **params** accept either `number` or `bigint` — passed as `Number`
//   for wasm-bindgen's u64 coercion.
// - `bind_event`'s `kind` is sent as the protocol `u8` (via `eventTypeToKind`);
//   the Rust→JS `set_event_callback` is passed through unchanged.
//
// The removed styles/layout exports are never bound; the legacy
// placeholder-measure members are no-ops on this channel.

import type { EventType, WasmExports } from './wasm-types.js';
import { eventTypeToKind } from './wasm-types.js';

/** The wasm-bindgen module surface we consume (duck-typed). */
export interface WasmBindgenModule {
  create_element?(tag: string): bigint | number;
  create_text_node?(text: string): bigint | number;
  set_text?(nodeId: bigint, text: string): void;
  set_attr?(nodeId: bigint, name: string, value: string): void;
  set_style?(nodeId: bigint, key: string, value: string): void;
  append_child?(parent: bigint, child: bigint): void;
  attach_document_root?(nodeId: bigint): void;
  insert_before?(anchor: bigint, child: bigint): void;
  insert_after?(anchor: bigint, child: bigint): void;
  replace_node?(old: bigint, replacement: bigint): void;
  remove_node?(nodeId: bigint): void;
  bind_event?(nodeId: bigint, kind: number): bigint | number;
  unbind_event?(handlerId: bigint): void;
  set_event_callback?(
    cb: (nodeId: number, kind: number, x: number, y: number, key?: string, code?: string, value?: string) => void,
  ): void;
  tick?(): void;
  add_stylesheet?(css: string): void;
  set_placeholder_measures?(opsJson: string): boolean;
  clear_placeholder_measures?(): boolean;
}

/** Convert a wasm-bindgen u64 return into a `bigint`. */
function toBigInt(value: bigint | number | undefined): bigint {
  return value === undefined ? 0n : BigInt(value);
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
    create_element: (tag: string) => toBigInt(wasm.create_element?.(tag)),
    create_text_node: (text: string) => toBigInt(wasm.create_text_node?.(text)),
    set_text: (nodeId: bigint, text: string) => {
      wasm.set_text?.(nodeId, text);
    },
    set_attr: (nodeId: bigint, name: string, value: string) => {
      wasm.set_attr?.(nodeId, name, value);
    },
    set_style: (nodeId: bigint, key: string, value: string) => {
      wasm.set_style?.(nodeId, key, value);
    },
    append_child: (parent: bigint, child: bigint) => {
      wasm.append_child?.(parent, child);
    },
    attach_document_root: (nodeId: bigint) => {
      wasm.attach_document_root?.(nodeId);
    },
    insert_before: (anchor: bigint, child: bigint) => {
      wasm.insert_before?.(anchor, child);
    },
    insert_after: (anchor: bigint, child: bigint) => {
      wasm.insert_after?.(anchor, child);
    },
    replace_node: (old: bigint, replacement: bigint) => {
      wasm.replace_node?.(old, replacement);
    },
    remove_node: (nodeId: bigint) => {
      wasm.remove_node?.(nodeId);
    },
    bind_event: (nodeId: bigint, kind: EventType) => {
      return toBigInt(wasm.bind_event?.(nodeId, eventTypeToKind(kind)));
    },
    unbind_event: (handlerId: bigint) => {
      wasm.unbind_event?.(handlerId);
    },
    set_event_callback: (cb) => {
      // Rust→JS callback is passed through as-is: the glue calls it with
      // `(nodeId, kind, x, y)`.
      wasm.set_event_callback?.(cb);
    },
    tick: () => {
      wasm.tick?.();
    },
    add_stylesheet: (css: string) => {
      wasm.add_stylesheet?.(css);
    },
    // Legacy placeholder-measure members — no-ops on the U4 wasm channel.
    set_placeholder_measures: () => false,
    clear_placeholder_measures: () => true,
  };
}

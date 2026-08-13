// Guest→Core API surface for the naivi binary-frame bridge (U5, KTD1).
//
// Defines the WASM exports (or QuickJS FFI functions) that a Guest runtime
// must provide to operate the blitz render tree. The mirror tree calls these
// functions; the implementation is injected via `bindWasm()`.
//
// ## Protocol (U5 redefinition)
//
// - DOM changes are **not** per-op FFI calls: the guest queues ops into a
//   [`FrameWriter`] and flushes one binary frame per boundary via
//   `flush_frame(bytes)` (KD1). Node ids are JS-assigned virtual u32 ids
//   (KD3); Rust maps virtual → blitz id.
// - Events arrive **per-event** via the `set_event_callback` Rust→JS callback
//   as `(nodeId, kind, x, y, key, code, value)` — events are not framed (KD2);
//   `kind` follows [`EVENT_KINDS`] order (shared with naivi-dom's generated
//   `NaiviEventKind`).
// - `set_frame_rejected_callback` delivers `frame_rejected(seq, reason)` for
//   the self-heal path (R15/F3).
// - `tick()` is the optional event drain pump (the app loop drains per frame).
// - The legacy placeholder-measure members (`set_placeholder_measures` /
//   `clear_placeholder_measures`) are removed — the host resolves fonts in
//   Rust.

// The event-kind wire table and event-type vocabulary live in the SOT package
// `@naivi/protocol` (the single source of truth — naivi-dom's build.rs parses
// the same table). This module re-exports them so existing imports stay stable.
import type {
  EventType,
  WireEventType,
  SynthesizedEventType,
} from '@naivi/protocol';
export {
  EVENT_KINDS,
  SYNTHESIZED_EVENT_TYPES,
  eventTypeToKind,
  kindToEventType,
} from '@naivi/protocol';
export type {
  EventType,
  WireEventType,
  SynthesizedEventType,
} from '@naivi/protocol';
export type HandlerId = bigint;

/** The engine-neutral event object handed to guest listeners. */
export interface NaiveDomEvent {
  type: EventType;
  target: unknown;
  currentTarget: unknown;
  clientX: number;
  clientY: number;
  /** Keyboard key (e.g. `"Enter"`) for key events; `""` otherwise. */
  key: string;
  /** Physical keyboard code for key events; `""` otherwise. */
  code: string;
  /** Full input value for `input` events; `""` otherwise. */
  value: string;
  /** Mouse button that triggered the event (KTD2); `0` otherwise. */
  button: number;
  /** Bitmask of currently-pressed mouse buttons (KTD2); `0` otherwise. */
  buttons: number;
  /** Wheel delta (KTD2); `0` otherwise (scroll has no engine delta). */
  deltaX: number;
  deltaY: number;
  /** IME composition commit text (KTD2); `""` otherwise. */
  imeData: string;
  preventDefault(): void;
  stopPropagation(): void;
  /** Whether a listener called `stopPropagation()` (naivi-internal). */
  isPropagationStopped(): boolean;
}

/** Callback invoked when a Core event is dispatched to a guest listener. */
export type EventCallback = (event: NaiveDomEvent) => void;

/** The WASM (or FFI) exports that the mirror tree calls into. */
export interface WasmExports {
  /** Flush one DOM-change frame (bytes) to the host (U5 frame transport). */
  flush_frame(bytes: Uint8Array): void;
  /** Rust→JS event callback: `(nodeId, kind, x, y, key, code, value, button, buttons, deltaX, deltaY, imeData, chain?) => void`. */
  set_event_callback(
    cb: (
      nodeId: number,
      kind: number,
      x: number,
      y: number,
      key?: string,
      code?: string,
      value?: string,
      button?: number,
      buttons?: number,
      deltaX?: number,
      deltaY?: number,
      imeData?: string,
      chain?: number[],
    ) => void,
  ): void;
  /**
   * Rust→JS frame-rejection callback: `(seq, reason) => void` — triggers the
   * self-heal path (clear writer → `reset` → rebuild + re-mount, R15/F3).
   */
  set_frame_rejected_callback(cb: (seq: number, reason: number) => void): void;
  /** Force-drain queued events (optional pump; the app loop drains per frame). */
  tick(): void;
}

/** Node type constants (align with DOM nodeType conventions). */
export const NodeType = {
  Element: 1,
  Text: 3,
} as const;
export type NodeType = (typeof NodeType)[keyof typeof NodeType];

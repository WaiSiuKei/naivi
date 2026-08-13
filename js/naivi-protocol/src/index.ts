// @naivi/protocol — Single Source of Truth (SOT) for the naivi bridge protocol.
//
// This module is the ONLY place the event-kind wire mapping is defined.
//
// ## Consumers
//
// - JS runtime (`@naivi/runtime`): imports `EVENT_KINDS` / `EventType` /
//   `eventTypeToKind` / `kindToEventType` for the writer, listener registry and
//   event dispatch.
// - `naivi-dom` build.rs (stage 1): naive-parses the `EVENT_KINDS` literal
//   table (no TS execution) to generate the Rust `NaiviEventKind` enum +
//   `to_u8`/`from_u8`/`from_str`/`name`/`ALL`.
//
// ## Table format constraint (R2)
//
// `EVENT_KINDS` MUST stay a bare literal `{ key: number, ... } as const` block:
// the build.rs parser reads it with a regex and never executes TypeScript. If
// the table shape changes, update the parser in `packages/naivi-dom/build.rs`
// too (drift guard: `js/naivi-protocol/tests/event-kinds.test.ts` pins the
// format).
//
// The explicit `u8` value is AUTHORITATIVE (review fix F15): the build.rs
// parser must read the explicit number; object key order is only a test-time
// invariant, never the wire numbering source.

/**
 * The event-kind wire table: DOM event-type string → protocol `u8` kind.
 *
 * `click=0 … input=11` — order shared with the Rust host's `NaiviEventKind`.
 * `change` is NOT here: it is synthesized (see `SYNTHESIZED_EVENT_TYPES`) and
 * never travels on the wire.
 */
export const EVENT_KINDS = {
  click: 0,
  pointerdown: 1,
  pointerup: 2,
  pointermove: 3,
  wheel: 4,
  contextmenu: 5,
  mouseenter: 6,
  mouseleave: 7,
  dblclick: 8,
  keydown: 9,
  keyup: 10,
  input: 11,
} as const;

/** The wire event kinds (12). */
export type WireEventType = keyof typeof EVENT_KINDS;

/**
 * Synthesized event types — never a wire `u8` kind. The dispatcher emits
 * `change` for checkbox/radio toggles that the engine reports as `input`
 * events; listeners register in the JS registry but skip the host `bind_event`.
 */
export const SYNTHESIZED_EVENT_TYPES = ['change'] as const;

export type SynthesizedEventType = (typeof SYNTHESIZED_EVENT_TYPES)[number];

/**
 * DOM-facing event type: wire kinds ∪ synthesized (`change`). This is the type
 * the runtime's listener registry / `NaiveDomEvent` use; `bind_event` and the
 * wire only ever see `WireEventType`.
 */
export type EventType = WireEventType | SynthesizedEventType;

/**
 * Map an [`EventType`] to its protocol `u8` kind.
 *
 * Synthesized types (`change`) have no wire kind and fall back to `click`
 * (0) — the runtime never calls `bind_event` with them (the guard lives in the
 * runtime's `SYNTHESIZED_EVENT_TYPES` check).
 */
export function eventTypeToKind(type: EventType): number {
  return EVENT_KINDS[type as WireEventType] ?? 0;
}

/** Map a protocol `u8` kind back to a wire [`EventType`] (defaults to `click`). */
export function kindToEventType(kind: number): WireEventType {
  for (const [type, k] of Object.entries(EVENT_KINDS)) {
    if (k === kind) return type as WireEventType;
  }
  return 'click';
}

// ── Op table (stage 2 — batched binary frame transport) ──────────────────────
//
// Frame wire format (KTD1): DOM-change frames are JS→Rust.
//   [seq: u32][count: u16][op…]
// each op is [opcode: u8][operands]; strings are [len: u16][utf8] except
// `AddStylesheet` which uses [len: u32][utf8] (compiled CSS can exceed 64KiB).
// Node operands are JS-assigned virtual ids (u32). `0` is unused/never a node.
//
// The build.rs parser reads this block too — keep it a bare literal.

export const OP = {
  CreateElement: 0x01,
  CreateText: 0x02,
  SetText: 0x03,
  SetAttr: 0x04,
  SetStyle: 0x05,
  AppendChild: 0x06,
  AttachRoot: 0x07,
  InsertBefore: 0x08,
  InsertAfter: 0x09,
  ReplaceNode: 0x0a,
  RemoveNode: 0x0b,
  BindEvent: 0x0c,
  UnbindEvent: 0x0d,
  AddStylesheet: 0x0e,
  Reset: 0x0f,
} as const;

export type OpCode = (typeof OP)[keyof typeof OP];

/**
 * Frame-rejection signal: Rust→JS callback `(seq, reason)`. Not a DOM event
 * and not part of the DOM-change frame — it is delivered via the dedicated
 * `set_frame_rejected_callback` (KTD6).
 */
export const FRAME_REJECTED = 0x01 as const;

/** u16 string-cap for frame operands (except AddStylesheet, which uses u32). */
export const MAX_U16_STRING = 0xffff as const;

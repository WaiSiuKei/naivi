// Guest→Core API surface for the naivi Mutation Mirror Bridge (U4, KTD1).
//
// Defines the WASM exports (or QuickJS FFI functions) that a Guest runtime
// must provide to operate the blitz render tree. The mirror tree calls these
// functions; the implementation is injected via `bindWasm()`.
//
// ## Protocol (U4 redefinition)
//
// - Node ids are the blitz-allocated `NodeId`s, carried as JS `bigint`.
// - `create_text_node` replaces the old `create_element('text')` + `set_text`
//   dance.
// - `bind_event`/`unbind_event` replace `add_event_listener` /
//   `remove_event_listener`: `bind_event` returns the node id as the handler
//   id; `unbind_event` clears the bindings for that handler (node).
// - `set_event_callback` receives Rust-dispatched events as
//   `(nodeId: number, kind: number, x: number, y: number)`; `kind` follows
//   [`EVENT_KINDS`] order (shared with the Rust host's `NaiviEventKind::ALL`).
// - The old styles/layout exports (`set_rule_table`, `flush_styles`,
//   `get_computed_style_json`, `apply_conditional_styles`, `compute_layout`,
//   `get_layout_rect`) are removed; the styles path lands in U6.
// - `set_placeholder_measures` / `clear_placeholder_measures` are retained as
//   legacy members for the desktop (rquickjs) FFI channel (U5); the U4 wasm
//   channel binds them as no-ops.

export type EventType =
  | 'click'
  | 'pointerdown'
  | 'pointerup'
  | 'pointermove'
  | 'wheel'
  | 'contextmenu'
  | 'mouseenter'
  | 'mouseleave'
  | 'dblclick';
export type HandlerId = bigint;

/**
 * The `u8` event-kind encoding shared with the Rust host
 * (`NaiviEventKind::ALL` order: click=0 … dblclick=8).
 */
export const EVENT_KINDS: readonly EventType[] = [
  'click',
  'pointerdown',
  'pointerup',
  'pointermove',
  'wheel',
  'contextmenu',
  'mouseenter',
  'mouseleave',
  'dblclick',
] as const;

/** Map an [`EventType`] to its protocol `u8` kind. */
export function eventTypeToKind(type: EventType): number {
  const kind = EVENT_KINDS.indexOf(type);
  return kind === -1 ? 0 : kind;
}

/** Map a protocol `u8` kind back to an [`EventType`] (defaults to `click`). */
export function kindToEventType(kind: number): EventType {
  return EVENT_KINDS[kind] ?? 'click';
}

/** The engine-neutral event object handed to guest listeners. */
export interface NaiveDomEvent {
  type: EventType;
  target: unknown;
  currentTarget: unknown;
  clientX: number;
  clientY: number;
  preventDefault(): void;
  stopPropagation(): void;
}

/** Callback invoked when a Core event is dispatched to a guest listener. */
export type EventCallback = (event: NaiveDomEvent) => void;

/** The WASM (or FFI) exports that the mirror tree calls into. */
export interface WasmExports {
  create_element(tag: string): bigint;
  create_text_node(text: string): bigint;
  set_text(node_id: bigint, text: string): void;
  set_attr(node_id: bigint, name: string, value: string): void;
  set_style(node_id: bigint, key: string, value: string): void;
  append_child(parent: bigint, child: bigint): void;
  /** Attach a node as a child of the document root (the facade body). */
  attach_document_root(node_id: bigint): void;
  insert_before(anchor: bigint, child: bigint): void;
  insert_after(anchor: bigint, child: bigint): void;
  replace_node(old: bigint, replacement: bigint): void;
  remove_node(node_id: bigint): void;
  /** Bind `kind` on `node_id`; returns the node id as the handler id. */
  bind_event(node_id: bigint, kind: EventType): bigint;
  /** Remove the bindings for the given handler id (a node id). */
  unbind_event(handler_id: bigint): void;
  /** Rust→JS event callback: `(nodeId, kind, x, y) => void`. */
  set_event_callback(cb: (nodeId: number, kind: number, x: number, y: number) => void): void;
  /** Force-drain queued events (optional pump; the app loop drains per frame). */
  tick(): void;
  /** Inject an author stylesheet (U6: SFC `<style>` / AOT CSS text) into stylo. */
  add_stylesheet(css: string): void;

  // Legacy placeholder-measure members, retained for the desktop (rquickjs)
  // FFI channel (U5). The U4 wasm channel binds no-ops.
  /** Write DOM-measured placeholder sizes for pending-font text nodes (plan 040). */
  set_placeholder_measures(ops_json: string): boolean;
  /** Drop every placeholder (plan 040 review #6). */
  clear_placeholder_measures(): boolean;
}

/** Node type constants (align with DOM nodeType conventions). */
export const NodeType = {
  Element: 1,
  Text: 3,
} as const;
export type NodeType = (typeof NodeType)[keyof typeof NodeType];

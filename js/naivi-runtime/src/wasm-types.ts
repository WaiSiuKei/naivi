// Guest→Core API surface for the Guest Mirror Tree.
//
// Defines the minimum set of WASM exports (or QuickJS FFI functions)
// that a Guest runtime must provide to operate the Core render tree.
// The mirror tree calls these functions; the implementation is injected
// via `bindWasm()`.

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

/** Callback invoked when a Core event is dispatched to a guest listener. */
export type EventCallback = (event: Event) => void;

/** Engine-neutral modifier flags passed to JS callbacks (plan 034, R3). */
export interface EventModifiers {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

/** Engine-neutral descriptor for injecting an event into the Rust dispatch. */
export interface EventDescriptor {
  x: number;
  y: number;
  type: EventType;
  button?: number;
  buttons?: number;
  modifiers?: EventModifiers;
  deltaX?: number;
  deltaY?: number;
}

/** The WASM (or FFI) exports that the mirror tree calls into. */
export interface WasmExports {
  // Phase 1-2 (implemented): tree operations plus a batch apply exposed by naive-host.
  /** Store the runtime selector rule table from styles.json (plan 060). */
  set_rule_table(rules_json: string): boolean;
  /** Run StylePass + LayoutPass synchronously (plan 064). */
  flush_styles(): void;
  /** Read a node's computed/used styles as browser-shaped JSON (plan 064). */
  get_computed_style_json(node_id: bigint): string;
  create_element(tag: string): bigint;
  set_style(node_id: bigint, key: string, value: string): void;
  set_text(node_id: bigint, text: string): void;
  append_child(parent: bigint, child: bigint): void;
  remove_node(node_id: bigint): void;
  /** Apply a batch of tree ops (JSON) in one round-trip; returns a ref->node id mapping. */
  apply_ops(ops_json: string): string;
  /** Apply conditional style rules (JSON) to a node; media rules are evaluated per pass. */
  apply_conditional_styles(node_id: bigint, rules_json: string): boolean;
  /** Write DOM measureText placeholder sizes for pending-font text nodes (plan 040). */
  set_placeholder_measures(ops_json: string): boolean;
  /** Drop every placeholder (font load failure / pending period end; plan 040 review #6). */
  clear_placeholder_measures(): boolean;
  /** Read a node's computed layout rect as JSON, or "null" when not laid out. */
  get_layout_rect(node_id: bigint): string;
  // Phase 3 (not implemented yet — retained as placeholders so the mirror
  // tree keeps compiling; layout runs automatically on the Rust side).
  compute_layout(root: bigint, w: number, h: number): string;
  add_event_listener(
    node_id: bigint,
    event_type: string,
    callback: EventCallback,
  ): bigint;
  remove_event_listener(handler_id: bigint): void;
  handle_event(descriptor: EventDescriptor): void;
}

/** Node type constants (align with DOM nodeType conventions). */
export const NodeType = {
  Element: 1,
  Text: 3,
} as const;
export type NodeType = (typeof NodeType)[keyof typeof NodeType];

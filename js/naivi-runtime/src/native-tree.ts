// Guest Mirror Tree — JS-side node management for the Core/Surface/Guest architecture.
//
// Maintains a complete mirror of the Core render tree with parent/child
// bidirectional references. Each mutation is immediately synced to Core
// via the injected WasmExports; the mirror avoids FFI round-trips for
// parent lookups by keeping the full topology in JS memory.
//
// Usage:
//   import { bindWasm, createElement, createTextNode, insertNode } from './native-tree.js';
//   bindWasm(wasmExports);
//   const root = createElement('view');
//   const text = createTextNode('Hello');
//   insertNode(root, text);

// Re-export the desktop main-process API from the package root so the
// Electron-style `import { app, NaiveWindow } from '@naive/runtime'` is
// type-consistent (the CLI aliases the bare specifier for the main bundle;
// plan 045, KTD7).
export { app, NaiveWindow } from './desktop-main.js';

import type {
  WasmExports,
  HandlerId,
  EventType,
  EventDescriptor,
  EventCallback,
} from './wasm-types.js';

// Re-export the guest→core contract so consumers can type the bound exports.
export type { WasmExports, HandlerId, EventType, EventDescriptor } from './wasm-types.js';

// ── Global state ────────────────────────────────────────────────────

let _wasm: WasmExports | null = null;
let _nextId = 1;
const _registry = new Map<number, NodeMirror>();

// ── NodeMirror ──────────────────────────────────────────────────────

export interface NodeMirror {
  readonly id: number;
  readonly type: number;   // 1 = Element, 3 = Text
  parent: NodeMirror | null;
  children: NodeMirror[];
  wasmId: bigint;
  text?: string;
}

// ── Bind WASM ───────────────────────────────────────────────────────

/** Inject the Guest→Core FFI bridge. Call once before any tree operation. */
export function bindWasm(wasm: WasmExports): void {
  _wasm = wasm;
}

/** Check if WASM bridge is ready (for conditional mock-vs-real routing). */
export function isWasmReady(): boolean {
  return _wasm !== null;
}

function wasm(): WasmExports {
  if (!_wasm) throw new Error('bindWasm() must be called before any tree operation');
  return _wasm;
}

/** Access the bound WASM bridge (used by batching adapters). */
export function getWasm(): WasmExports {
  return wasm();
}

// ── Tree operations ─────────────────────────────────────────────────

/** Create an element (view) node. */
export function createElement(tag: string): NodeMirror {
  const w = wasm();
  const wasmId = w.create_element(tag);
  const node: NodeMirror = {
    id: _nextId++,
    type: 1, // Element
    parent: null,
    children: [],
    wasmId,
  };
  _registry.set(node.id, node);
  return node;
}

/** Store the runtime selector rule table from styles.json (plan 060). */
export function setRuleTable(rulesJson: string): boolean {
  return wasm().set_rule_table(rulesJson);
}

/** Create a text node with initial content. */
export function createTextNode(text: string): NodeMirror {
  const w = wasm();
  const wasmId = w.create_element('text');
  w.set_text(wasmId, text);
  const node: NodeMirror = {
    id: _nextId++,
    type: 3, // Text
    parent: null,
    children: [],
    wasmId,
    text,
  };
  _registry.set(node.id, node);
  return node;
}

/** Insert child into parent, optionally before anchor. */
export function insertNode(
  parent: NodeMirror,
  child: NodeMirror,
  anchor?: NodeMirror | null,
): void {
  // Remove from previous parent if any.
  if (child.parent) {
    removeFromParent(child);
  }

  if (anchor && parent.children.includes(anchor)) {
    const idx = parent.children.indexOf(anchor);
    parent.children.splice(idx, 0, child);
  } else {
    parent.children.push(child);
  }
  child.parent = parent;

  wasm().append_child(parent.wasmId, child.wasmId);
}

/** Remove a node from both mirror and Core (recursively removes children). */
export function removeNode(node: NodeMirror): void {
  for (const child of [...node.children]) {
    removeNode(child);
  }
  removeFromParent(node);
  wasm().remove_node(node.wasmId);
  _registry.delete(node.id);
}

/** Set a style property. */
export function setProp(node: NodeMirror, key: string, value: string): void {
  wasm().set_style(node.wasmId, key, value);
}

/** Set text content on a text node. */
export function setText(node: NodeMirror, text: string): void {
  node.text = text;
  wasm().set_text(node.wasmId, text);
}

// ── Event binding ───────────────────────────────────────────────────

/** Register an event listener on a node. Returns HandlerId for later removal. */
export function addEventListener(
  node: NodeMirror,
  eventType: EventType,
  callback: EventCallback,
): HandlerId {
  return wasm().add_event_listener(node.wasmId, eventType, callback);
}

/** Remove a previously registered event listener. */
export function removeEventListener(handlerId: HandlerId): void {
  wasm().remove_event_listener(handlerId);
}

/** Route a browser/DOM event into the Core event system. */
export function handleEvent(descriptor: EventDescriptor): void {
  wasm().handle_event(descriptor);
}

// ── Layout & render ─────────────────────────────────────────────────

/** Trigger layout computation on the Core side. Returns JSON layout result. */
export function computeLayout(
  root: NodeMirror,
  width: number,
  height: number,
): string {
  return wasm().compute_layout(root.wasmId, width, height);
}

// ── Query ───────────────────────────────────────────────────────────

/** Look up a mirror node by its JS-side id. */
export function getNodeById(id: number): NodeMirror | undefined {
  return _registry.get(id);
}

/** Find the root node (the one without a parent). */
export function findRoot(): NodeMirror | undefined {
  for (const node of _registry.values()) {
    if (!node.parent) return node;
  }
  return undefined;
}

// ── Geometry (DOM-`getBoundingClientRect`-style) ────────────────────

/** Computed layout rect of a mirror node (logical px), or null if not laid out. */
export interface MirrorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Read a mirror node's computed layout rect from the Rust host.
 *
 * Returns `null` when the node has no wasm id yet or has not been laid out
 * (host returns JSON `null`), instead of throwing.
 */
export function getBoundingClientRect(node: NodeMirror): MirrorRect | null {
  if (node.wasmId === 0n) return null;
  const json = wasm().get_layout_rect(node.wasmId);
  try {
    return JSON.parse(json) as MirrorRect | null;
  } catch {
    return null;
  }
}

/** Allocate a unique mirror id (used by bulk loaders). */
export function allocateMirrorId(): number {
  return _nextId++;
}

/** Register a mirror node built outside the standard helpers. */
export function registerMirror(node: NodeMirror): void {
  _registry.set(node.id, node);
}

/**
 * Remove a mirror from the registry only (no WASM / tree mutation).
 *
 * Used by the batched FFI bridge, which owns its own removal queue and must
 * not issue a second `remove_node` call; keeping the registry in sync
 * prevents stale mirrors from being collected for placeholder measurement
 * (plan 040) or bounding-box queries after removal.
 */
export function unregisterMirror(node: NodeMirror): void {
  _registry.delete(node.id);
}

// ── Placeholder measurement support (plan 040) ──────────────────────

/**
 * Collect every text node in the mirror tree for placeholder measurement
 * (plan 040, review #3). Returns the nodes with their resolved wasm ids so
 * the pending-font period can write DOM-measured placeholders aligned with
 * the FFI's id-addressed ops.
 */
export function collectTextNodes(): Array<{
  wasmId: bigint;
  text?: string;
}> {
  const nodes: Array<{ wasmId: bigint; text?: string }> = [];
  for (const node of _registry.values()) {
    if (node.type === 3 && node.text !== undefined) {
      nodes.push({ wasmId: node.wasmId, text: node.text });
    }
  }
  return nodes;
}

// ── Helpers ─────────────────────────────────────────────────────────

function removeFromParent(node: NodeMirror): void {
  if (node.parent) {
    node.parent.children = node.parent.children.filter((c) => c !== node);
    node.parent = null;
  }
}

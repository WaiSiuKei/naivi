// Guest Mirror Tree — JS-side node management for the naivi bridge (U4).
//
// Maintains a complete mirror of the blitz render tree with parent/child
// bidirectional references. Each mutation is immediately synced to the host
// via the injected WasmExports; the mirror avoids FFI round-trips for parent
// lookups by keeping the full topology in JS memory.
//
// Protocol (U4, KTD1): node ids are allocated by blitz and returned
// synchronously (`create_element` / `create_text_node`), so no batching or
// ref↔id mapping is needed. `setProp` routes attribute-ish props (`class`,
// `id`) to `set_attr` and everything else to `set_style`. Events bind through
// `bind_event` / `unbind_event`, and Rust-dispatched events arrive through
// `set_event_callback` → [`dispatchHostEvent`], which fans them out to the
// JS-side `(nodeId, kind)` listener registry.
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
  EventCallback,
  NaiveDomEvent,
} from './wasm-types.js';
import { kindToEventType } from './wasm-types.js';

// Re-export the guest→core contract so consumers can type the bound exports.
export type { WasmExports, HandlerId, EventType, EventCallback, NaiveDomEvent } from './wasm-types.js';

// ── Global state ────────────────────────────────────────────────────

let _wasm: WasmExports | null = null;
let _nextId = 1;
const _registry = new Map<number, NodeMirror>();
/** blitz node id (as `number`) → eventType → set of guest callbacks. */
const _listeners = new Map<number, Map<EventType, Set<EventCallback>>>();
/** handler id (the node id) → binding entry, for removal bookkeeping. */
const _handlerEntries = new Map<bigint, { node: NodeMirror; kind: EventType; cb: EventCallback }>();
/**
 * Optional node-id → element resolver (installed by the DOM facade). Used to
 * set `event.target` on dispatched events and to sync the input value into
 * the facade element when an `input` event arrives (so `el.value` reads the
 * engine's current text).
 */
type ElementResolver = (nodeId: number, value?: string) => unknown | null;
let _elementResolver: ElementResolver | null = null;

/** Event types the dispatcher synthesizes locally (no host binding needed). */
const SYNTHESIZED_EVENT_TYPES = new Set<EventType>(['change']);

/** Install (or clear) the node-id → element resolver used by event dispatch. */
export function setEventElementResolver(fn: ElementResolver | null): void {
  _elementResolver = fn;
}

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

/** Create an element node; the id is allocated by blitz and returned synchronously. */
export function createElement(tag: string): NodeMirror {
  const w = wasm();
  const node: NodeMirror = {
    id: _nextId++,
    type: 1, // Element
    parent: null,
    children: [],
    wasmId: w.create_element(tag),
  };
  _registry.set(node.id, node);
  return node;
}

/** Create a text node with initial content. */
export function createTextNode(text: string): NodeMirror {
  const w = wasm();
  const node: NodeMirror = {
    id: _nextId++,
    type: 3, // Text
    parent: null,
    children: [],
    wasmId: w.create_text_node(text),
    text,
  };
  _registry.set(node.id, node);
  return node;
}

/**
 * Sync `child` into `parent`, preserving JS-side order on the host: when the
 * child has a next sibling in the mirror, the host inserts before it
 * (`insert_before`), otherwise it appends. The facade pre-wires the mirror
 * topology, so this only reconciles and syncs the final order.
 */
export function insertNode(parent: NodeMirror, child: NodeMirror): void {
  if (!parent.children.includes(child)) {
    if (child.parent && child.parent !== parent) {
      removeFromParent(child);
    }
    parent.children.push(child);
    child.parent = parent;
  }
  const siblings = parent.children;
  const idx = siblings.indexOf(child);
  const next = siblings[idx + 1];
  const w = wasm();
  if (next !== undefined) {
    w.insert_before(next.wasmId, child.wasmId);
  } else {
    w.append_child(parent.wasmId, child.wasmId);
  }
}

/** Attach a node as a child of the document root (the facade `body`). */
export function attachDocumentRoot(node: NodeMirror): void {
  wasm().attach_document_root(node.wasmId);
}

/** Remove a node from both mirror and Core (recursively removes children). */
export function removeNode(node: NodeMirror): void {
  for (const child of [...node.children]) {
    removeNode(child);
  }
  removeFromParent(node);
  const w = wasm();
  w.remove_node(node.wasmId);
  // Drop JS-side listener entries + host bindings for the removed subtree root.
  unbindAll(node.wasmId);
  _registry.delete(node.id);
}

/** Attribute-ish props route to `set_attr`; everything else is a style prop. */
const ATTR_PROPS = new Set(['class', 'id']);

/** Set a property, routing attribute-ish props (`class`, `id`) to `set_attr` and style props to `set_style`. */
export function setProp(node: NodeMirror, key: string, value: string): void {
  const w = wasm();
  if (ATTR_PROPS.has(key)) {
    w.set_attr(node.wasmId, key, value);
  } else {
    w.set_style(node.wasmId, key, value);
  }
}

/** Set an element attribute (e.g. `class`, `id`, `data-*`). */
export function setAttr(node: NodeMirror, name: string, value: string): void {
  wasm().set_attr(node.wasmId, name, value);
}

/** Sync a `:checked` state through the `checked` attribute (stylo matching). */
export function setChecked(node: NodeMirror, checked: boolean): void {
  wasm().set_attr(node.wasmId, 'checked', checked ? 'true' : 'false');
}

/** Set text content on a text node. */
export function setText(node: NodeMirror, text: string): void {
  node.text = text;
  wasm().set_text(node.wasmId, text);
}

// ── Event binding (U4: bind_event / unbind_event + set_event_callback) ──

/**
 * Register an event listener on a node. Returns the blitz node id as the
 * handler id (the U4 protocol's `bind_event` return), for later removal.
 */
export function addEventListener(
  node: NodeMirror,
  eventType: EventType,
  callback: EventCallback,
): HandlerId {
  const w = wasm();
  const nodeId = Number(node.wasmId);
  let byKind = _listeners.get(nodeId);
  if (!byKind) {
    byKind = new Map();
    _listeners.set(nodeId, byKind);
  }
  let set = byKind.get(eventType);
  if (!set) {
    set = new Set();
    byKind.set(eventType, set);
  }
  set.add(callback);
  // Synthesized event types (`change` for checkboxes/radios) never need a host
  // binding: the engine reports toggles as `input` events, which the dispatcher
  // translates. Binding them would just emit an "unknown event type" warning.
  if (SYNTHESIZED_EVENT_TYPES.has(eventType)) {
    return 0n;
  }
  const handlerId = w.bind_event(node.wasmId, eventType);
  _handlerEntries.set(handlerId, { node, kind: eventType, cb: callback });
  return handlerId;
}

/** Remove a previously registered event listener (by its handler id). */
export function removeEventListener(handlerId: HandlerId): void {
  wasm().unbind_event(handlerId);
  const entry = _handlerEntries.get(handlerId);
  if (entry) {
    const byKind = _listeners.get(Number(entry.node.wasmId));
    byKind?.get(entry.kind)?.delete(entry.cb);
    _handlerEntries.delete(handlerId);
  }
}

/**
 * Register the Rust→JS event callback. The host calls it as
 * `(nodeId, kind, x, y, key, code, value)`; we route it to the JS listener
 * registry.
 */
export function registerEventCallback(): void {
  wasm().set_event_callback((nodeId, kind, x, y, key, code, value) => {
    dispatchHostEvent(nodeId, kind, x, y, key, code, value);
  });
}

/**
 * Route a host-dispatched `(nodeId, kind, x, y, key, code, value)` event to
 * registered listeners. For `input` events the facade element's value is
 * synced first (via the element resolver) so `el.value` / `event.target.value`
 * reflect the engine's current text.
 */
export function dispatchHostEvent(
  nodeId: number,
  kind: number,
  x: number,
  y: number,
  key?: string,
  code?: string,
  value?: string,
): void {
  const type = kindToEventType(kind);
  const byKind = _listeners.get(nodeId);
  if (!byKind) return;
  const handlers = byKind.get(type);
  if (!handlers || handlers.size === 0) return;
  const target = _elementResolver?.(nodeId, type === 'input' ? value : undefined) ?? null;
  const event = makeDomEvent(type, x, y, key ?? '', code ?? '', value ?? '', target);
  for (const cb of [...handlers]) {
    try {
      cb(event);
    } catch (error) {
      console.error('[naivi] guest event listener threw:', error);
    }
  }

  // Checkbox/radio: the engine reports a toggle as an `input` event whose
  // `value` is the new checked state ("true"/"false") — blitz has no `change`
  // DOM event. Translate it into a `change` event (browser semantics) so Vue
  // `v-model` / `@change` handlers fire; the element resolver already synced
  // `_attrs.checked`, so `event.target.checked` reads the new state.
  if (type === 'input' && isCheckboxLike(target) && value !== undefined) {
    const changeHandlers = byKind.get('change');
    if (changeHandlers && changeHandlers.size > 0) {
      const changeEvent = makeDomEvent('change', x, y, '', '', value, target);
      for (const cb of [...changeHandlers]) {
        try {
          cb(changeEvent);
        } catch (error) {
          console.error('[naivi] guest event listener threw:', error);
        }
      }
    }
  }
}

/** Duck-typed checkbox/radio test for a resolved facade element. */
function isCheckboxLike(el: unknown): boolean {
  if (!el || typeof el !== 'object') return false;
  const e = el as { tagName?: string; _attrs?: Record<string, string> };
  return (
    e.tagName === 'INPUT' &&
    (e._attrs?.type === 'checkbox' || e._attrs?.type === 'radio')
  );
}

function makeDomEvent(
  type: EventType,
  x: number,
  y: number,
  key: string,
  code: string,
  value: string,
  target: unknown,
): NaiveDomEvent {
  return {
    type,
    target,
    currentTarget: target,
    clientX: x,
    clientY: y,
    key,
    code,
    value,
    preventDefault() {},
    stopPropagation() {},
  };
}

/** Drop every JS-side listener entry + host binding for a node id. */
function unbindAll(nodeId: bigint): void {
  _listeners.delete(Number(nodeId));
  for (const [handlerId, entry] of _handlerEntries) {
    if (entry.node.wasmId === nodeId) {
      _handlerEntries.delete(handlerId);
    }
  }
  try {
    wasm().unbind_event(nodeId);
  } catch {
    /* node already gone — nothing to unbind */
  }
}

// ── Layout & render ─────────────────────────────────────────────────

/**
 * Computed layout rect of a mirror node. The U4 protocol has no layout-query
 * export (get_layout_rect was removed), so this always returns `null`; the
 * facade's `getBoundingClientRect()` falls back to zeros.
 */
export function getBoundingClientRect(_node: NodeMirror): MirrorRect | null {
  return null;
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

/** Allocate a unique mirror id (used by bulk loaders). */
export function allocateMirrorId(): number {
  return _nextId++;
}

/** Register a mirror node built outside the standard helpers. */
export function registerMirror(node: NodeMirror): void {
  _registry.set(node.id, node);
}

/** Remove a mirror from the registry only (no WASM / tree mutation). */
export function unregisterMirror(node: NodeMirror): void {
  _registry.delete(node.id);
}

/**
 * Collect every text node in the mirror tree (placeholder measurement /
 * diagnostics). Returns the nodes with their resolved wasm ids.
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

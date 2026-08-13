// Guest Mirror Tree — JS-side node management for the naivi bridge (U5).
//
// Maintains a complete mirror of the blitz render tree with parent/child
// bidirectional references. Each mutation is encoded as a protocol op into a
// per-frame [`FrameWriter`]; the whole frame is flushed to the host once per
// frame boundary (`flush_frame`) — no per-op FFI calls.
//
// Protocol (U5, KTD1/2): node ids are **JS-assigned virtual u32 ids**
// (slot + generation + free-list + FinalizationRegistry). Rust maps
// virtual → blitz id and reads `data-naivi-id` to reverse-map events. Events
// arrive per-callback as `(nodeId, kind, x, y, key, code, value)` (KD2),
// fanned out to the JS-side `(virtualId, eventType)` listener registry.
// `frame_rejected(seq, reason)` triggers the self-heal path: clear the
// writer, emit `reset`, rebuild the facade, re-mount (R15/F3).
//
// Usage:
//   import { bindWasm, createElement, createTextNode, insertNode, tick } from './native-tree.js';
//   bindWasm(wasmExports);
//   const root = createElement('view');
//   const text = createTextNode('Hello');
//   insertNode(root, text);
//   tick(); // frame boundary → flush

// Re-export the desktop main-process API from the package root so the
// Electron-style `import { app, NaiveWindow } from '@naive/runtime'` is
// type-consistent (the CLI aliases the bare specifier for the main bundle;
// plan 045, KTD7).
export { app, NaiveWindow } from './desktop-main.js';

import { FrameWriter } from '@naivi/protocol/writer';
import { EVENT_KINDS, eventTypeToKind, kindToEventType } from '@naivi/protocol';
import type {
  WasmExports,
  HandlerId,
  EventType,
  EventCallback,
  NaiveDomEvent,
} from './wasm-types.js';

// Re-export the guest→core contract so consumers can type the bound exports.
export type { WasmExports, HandlerId, EventType, EventCallback, NaiveDomEvent } from './wasm-types.js';

// ── Debug log forwarding (OFF by default) ───────────────────────────
//
// When enabled, every `console.*` level — including tracing_wasm's styled
// Rust logs on the wasm channel — is also POSTed to the configured endpoint,
// so a host-side listener can observe the guest's event flow without reading
// a browser console (useful when the page runs in a remote/embedded browser).
//
// Enable before the guest loads (the check runs at module eval):
//   - `window.__NAIVE_DEBUG_LOG = true` (or a non-empty
//     `window.__NAIVE_DEBUG_LOG_URL` to also override the endpoint), or
//   - a `naivi_debug_log` query param on the page URL.
//
// Default endpoint: `http://localhost:8091/log?lv=<level>&m=<message>`. Keep
// this block self-contained — it is pure diagnostics and must never throw.
const debugLogEndpoint = (() => {
  const g = globalThis as { __NAIVE_DEBUG_LOG?: unknown; __NAIVE_DEBUG_LOG_URL?: unknown };
  const enabled =
    g.__NAIVE_DEBUG_LOG === true ||
    (typeof g.__NAIVE_DEBUG_LOG_URL === 'string' && g.__NAIVE_DEBUG_LOG_URL.length > 0) ||
    (typeof location !== 'undefined' && new URLSearchParams(location.search).has('naivi_debug_log'));
  if (!enabled) return null;
  if (typeof g.__NAIVE_DEBUG_LOG_URL === 'string' && g.__NAIVE_DEBUG_LOG_URL.length > 0) {
    return g.__NAIVE_DEBUG_LOG_URL;
  }
  return 'http://localhost:8091/log';
})();
if (debugLogEndpoint !== null) {
  const forward = (level: string) => (...args: unknown[]) => {
    try {
      fetch(
        `${debugLogEndpoint}?lv=${encodeURIComponent(level)}&m=${encodeURIComponent(
          args.map(String).join(' '),
        )}`,
      );
    } catch { /* best-effort */ }
  };
  const g = globalThis as unknown as {
    console: Record<string, (...a: unknown[]) => void>;
  };
  const orig: Record<string, (...a: unknown[]) => void> = {};
  for (const lv of ['log', 'info', 'warn', 'error', 'debug']) {
    orig[lv] = g.console[lv];
    g.console[lv] = (...a: unknown[]) => {
      try { forward(lv)(...a); } catch { /* ignore */ }
      try { orig[lv]?.apply(g.console, a); } catch { /* ignore */ }
    };
  }
  // eslint-disable-next-line no-console
  console.info(`[naivi] debug log forwarding enabled → ${debugLogEndpoint}`);
}

// ── Global state ────────────────────────────────────────────────────

let _wasm: WasmExports | null = null;
let _writer = new FrameWriter();
const _registry = new Map<number, NodeMirror>();
/** virtual node id → eventType → set of guest callbacks. */
const _listeners = new Map<number, Map<EventType, Set<EventCallback>>>();
/** handler id (the node's virtual id) → binding entry, for removal bookkeeping. */
const _handlerEntries = new Map<number, { node: NodeMirror; kind: EventType; cb: EventCallback }>();
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

// ── Virtual id allocation (U5, KTD2) ───────────────────────────────
//
// u32 id = (generation << 20) | slot. The generation counter makes freed ids
// stale before reuse (a late op referencing a freed id is rejected by Rust
// instead of aliasing a new node). Reclamation is explicit on `removeNode`
// plus GC-driven via `FinalizationRegistry` when a leaked mirror is collected.

const SLOT_BITS = 20;
const SLOT_MASK = (1 << SLOT_BITS) - 1;
const FREE_LIST: number[] = [];
const GENERATIONS: number[] = [];
let nextSlot = 1; // slot 0 / id 0 is never a node

const finalization = new FinalizationRegistry<number>((id) => {
  // Only reclaim if the slot's generation still matches (id not re-issued).
  const slot = id & SLOT_MASK;
  if (GENERATIONS[slot] === ((id >>> SLOT_BITS) & 0xfff)) {
    nodesBySlot[slot] = undefined;
    GENERATIONS[slot] = (GENERATIONS[slot] + 1) & 0xfff;
    FREE_LIST.push(slot);
  }
});

const nodesBySlot: (NodeMirror | undefined)[] = [];

function newId(): number {
  let slot: number;
  if (FREE_LIST.length > 0) {
    slot = FREE_LIST.pop()!;
  } else {
    slot = nextSlot++;
    GENERATIONS[slot] = 0;
  }
  const gen = GENERATIONS[slot];
  return ((gen << SLOT_BITS) | slot) >>> 0;
}

function freeId(id: number): void {
  const slot = id & SLOT_MASK;
  if (GENERATIONS[slot] === ((id >>> SLOT_BITS) & 0xfff)) {
    nodesBySlot[slot] = undefined;
    GENERATIONS[slot] = (GENERATIONS[slot] + 1) & 0xfff;
    FREE_LIST.push(slot);
  }
}

// ── NodeMirror ──────────────────────────────────────────────────────

export interface NodeMirror {
  /** JS-assigned virtual u32 id (the wire node identity). */
  readonly id: number;
  readonly type: number; // 1 = Element, 3 = Text
  parent: NodeMirror | null;
  children: NodeMirror[];
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

// ── Frame flush / tick ──────────────────────────────────────────────

const rafQueue: Array<(now: number) => void> = [];

/** Queue a callback to run at the next frame boundary (rAF shim). */
export function requestFrameFlush(cb: (now: number) => void): void {
  rafQueue.push(cb);
}

/**
 * Frame tick: run the rAF queue, then flush the accumulated ops as one frame.
 * Called by the browser rAF loop (wasm) or by the host's `__tick()` (native).
 */
export function tick(now: number = 0): void {
  const q = rafQueue.splice(0);
  for (const cb of q) {
    try {
      cb(now);
    } catch (e) {
      console.error('[naivi] frame callback threw:', e);
    }
  }
  flushFrame();
}

/** Flush the pending ops to the host as one frame (no-op when empty). */
export function flushFrame(): void {
  if (_writer.opCount === 0) return;
  const bytes = _writer.flush();
  if (bytes.byteLength === 0) return;
  wasm().flush_frame(bytes);
}

/** Number of ops currently queued in the writer (test seam). */
export function queuedOpCount(): number {
  return _writer.opCount;
}

/** Discard the writer's queued ops without flushing (test isolation). */
export function clearQueuedOps(): void {
  _writer.clear();
}

// ── Tree operations ─────────────────────────────────────────────────

/** Create an element node with a fresh JS-assigned virtual id. */
export function createElement(tag: string): NodeMirror {
  const id = newId();
  _writer.createElement(tag);
  const node: NodeMirror = {
    id,
    type: 1, // Element
    parent: null,
    children: [],
  };
  _registry.set(id, node);
  nodesBySlot[id & SLOT_MASK] = node;
  finalization.register(node, id);
  return node;
}

/** Create a text node with initial content. */
export function createTextNode(text: string): NodeMirror {
  const id = newId();
  _writer.createTextNode(text);
  const node: NodeMirror = {
    id,
    type: 3, // Text
    parent: null,
    children: [],
    text,
  };
  _registry.set(id, node);
  nodesBySlot[id & SLOT_MASK] = node;
  finalization.register(node, id);
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
  if (next !== undefined) {
    _writer.insertBefore(next.id, child.id);
  } else {
    _writer.appendChild(parent.id, child.id);
  }
}

/** Attach a node as a child of the document root (the facade `body`). */
export function attachDocumentRoot(node: NodeMirror): void {
  _writer.attachRoot(node.id);
}

/** Remove a node from both mirror and the host frame (recursively). */
export function removeNode(node: NodeMirror): void {
  for (const child of [...node.children]) {
    removeNode(child);
  }
  removeFromParent(node);
  _writer.removeNode(node.id);
  unbindAll(node.id);
  _registry.delete(node.id);
  finalization.unregister(node);
  freeId(node.id);
}

/** Attribute-ish props route to `set_attr`; everything else is a style prop. */
const ATTR_PROPS = new Set(['class', 'id']);

/** Set a property, routing attribute-ish props (`class`, `id`) to `set_attr` and style props to `set_style`. */
export function setProp(node: NodeMirror, key: string, value: string): void {
  if (ATTR_PROPS.has(key)) {
    _writer.setAttr(node.id, key, value);
  } else {
    _writer.setStyle(node.id, key, value);
  }
}

/** Set an element attribute (e.g. `class`, `id`, `data-*`). */
export function setAttr(node: NodeMirror, name: string, value: string): void {
  _writer.setAttr(node.id, name, value);
}

/** Sync a `:checked` state through the `checked` attribute (stylo matching). */
export function setChecked(node: NodeMirror, checked: boolean): void {
  _writer.setAttr(node.id, 'checked', checked ? 'true' : 'false');
}

/** Set text content on a text node. */
export function setText(node: NodeMirror, text: string): void {
  node.text = text;
  _writer.setText(node.id, text);
}

/** Inject an author stylesheet via the frame `add_stylesheet` op. */
export function addStylesheet(css: string): void {
  _writer.addStylesheet(css);
}

/**
 * Emit the `reset` op and reset every JS-side structure (self-heal, R15/F3):
 * the host drops its whole tree + virtual-id map on `reset`, so the guest must
 * too — registry, listener tables, and slot→node backings are cleared and the
 * allocator restarts (any stale mirror held by a doomed facade can never be
 * mistaken for a live node again).
 */
export function emitReset(): void {
  _writer.reset();
  _registry.clear();
  _listeners.clear();
  _handlerEntries.clear();
  nodesBySlot.length = 0;
  FREE_LIST.length = 0;
  GENERATIONS.length = 0;
  nextSlot = 1;
}

// ── Event binding (U5: bind/unbind as frame ops; per-event callback) ──

/**
 * Register an event listener on a node. Returns the node's virtual id as the
 * handler id, for later removal.
 */
export function addEventListener(
  node: NodeMirror,
  eventType: EventType,
  callback: EventCallback,
): HandlerId {
  const nodeId = node.id;
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
  _writer.bindEvent(node.id, eventTypeToKind(eventType));
  _handlerEntries.set(nodeId, { node, kind: eventType, cb: callback });
  return BigInt(nodeId);
}

/** Remove a previously registered event listener (by its handler id). */
export function removeEventListener(handlerId: HandlerId): void {
  const nodeId = Number(handlerId);
  _writer.unbindEvent(nodeId);
  const entry = _handlerEntries.get(nodeId);
  if (entry) {
    const byKind = _listeners.get(nodeId);
    byKind?.get(entry.kind)?.delete(entry.cb);
    _handlerEntries.delete(nodeId);
  }
}

/**
 * Register the Rust→JS event callback. The host calls it as
 * `(nodeId, kind, x, y, key, code, value)` (per-event, not framed — KD2); we
 * route it to the JS listener registry keyed by virtual id.
 */
export function registerEventCallback(): void {
  wasm().set_event_callback((nodeId, kind, x, y, key, code, value) => {
    dispatchHostEvent(nodeId, kind, x, y, key, code, value);
  });
}

/**
 * Self-heal wiring (R15/F3): on `frame_rejected(seq, reason)` the runtime
 * clears the writer, emits `reset`, then runs the installed recovery handler
 * (rebuilt facade + full re-mount) so the JS/Rust sides resync.
 */
export function registerFrameRejectedHandler(recover: () => void): void {
  wasm().set_frame_rejected_callback((seq, reason) => {
    console.warn(`[naivi] frame ${seq} rejected (reason ${reason}) — self-healing`);
    _writer.clear();
    emitReset();
    flushFrame();
    recover();
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

/** Drop every JS-side listener entry + host binding for a node's virtual id. */
function unbindAll(nodeId: number): void {
  _listeners.delete(nodeId);
  for (const [handlerId, entry] of _handlerEntries) {
    if (entry.node.id === nodeId) {
      _handlerEntries.delete(handlerId);
    }
  }
  _writer.unbindEvent(nodeId);
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

/** Allocate a unique virtual id (used by bulk loaders). */
export function allocateMirrorId(): number {
  return newId();
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
 * diagnostics). Returns the nodes with their virtual ids.
 */
export function collectTextNodes(): Array<{
  id: number;
  text?: string;
}> {
  const nodes: Array<{ id: number; text?: string }> = [];
  for (const node of _registry.values()) {
    if (node.type === 3 && node.text !== undefined) {
      nodes.push({ id: node.id, text: node.text });
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

// Batched FFI bridge for the Vue DOM facade (plan 037, U2 / KTD2).
//
// Mirrors the native-tree surface used by vue-vapor-dom but defers every
// mutation into an `apply_ops` batch that flushes at the microtask boundary.
// Batches may address batch-local refs (new nodes) and existing nodes by
// exported id (`appendId`/`styleId`/`textId`/`removeId`/`alias`, R6).

import {
  allocateMirrorId,
  getWasm,
  registerMirror,
  unregisterMirror,
  addEventListener as nativeAddEventListener,
  removeEventListener as nativeRemoveEventListener,
  setRuleTable as nativeSetRuleTable,
  collectTextNodes,
  type NodeMirror,
} from "./native-tree.js";
import { isFontsPending, writePlaceholdersForPending } from "./placeholder-text.js";
import type { EventCallback } from "./wasm-types.js";

export { getBoundingClientRect } from "./native-tree.js";

/** Store the runtime selector rule table (plan 060, U3). */
export function setRuleTable(rulesJson: string): boolean {
  return nativeSetRuleTable(rulesJson);
}

type Op =
  | { type: "create"; reference: string; tag: string }
  | { type: "append"; parent: string; child: string }
  | { type: "style"; node: string; key: string; value: string }
  | { type: "setAttr"; node: string; name: string; value: string }
  | { type: "text"; node: string; text: string }
  | { type: "remove"; node: string }
  | { type: "appendId"; parent: bigint; child: bigint }
  | { type: "styleId"; node: bigint; key: string; value: string }
  | { type: "setAttrId"; node: bigint; name: string; value: string }
  | { type: "textId"; node: bigint; text: string }
  | { type: "checkedId"; node: bigint; checked: boolean }
  | { type: "removeId"; node: bigint }
  | { type: "alias"; reference: string; node: bigint };

/** Event handler shape carried by the batched listener registry. */
type ListenerHandler = EventCallback;

let queue: Op[] = [];
let flushScheduled = false;
const pendingMirrors = new Set<NodeMirror>();
const aliasedRefs = new Map<NodeMirror, string>();
const pendingListeners = new Map<
  NodeMirror,
  Array<{ type: string; handler: ListenerHandler; token: bigint }>
>();
// Mirrors queued for removal in the current batch, mapped to their queued
// remove op. Re-appending such a node within the same batch cancels the
// remove so a move (remove + reinsert) resolves to a single append instead of
// destroy-then-append (P1 #3).
const pendingRemoves = new Map<NodeMirror, Op>();
// Deferred listener token -> real HandlerId once the batch flushes, so a
// facade can still remove a listener it attached while its node was
// batch-pending (P2 #5).
const flushedListenerIds = new Map<bigint, bigint>();
let listenerToken = -1n;
// Bounded retry for a failed apply_ops flush; a transient failure must not
// orphan every pending mirror (P1 #4).
const MAX_FLUSH_RETRIES = 2;
let flushRetries = 0;

function refOf(mirror: NodeMirror): string {
  return String(mirror.id);
}

function ensureAlias(mirror: NodeMirror): string {
  const existing = aliasedRefs.get(mirror);
  if (existing) return existing;
  const ref = refOf(mirror);
  queue.push({ type: "alias", reference: ref, node: mirror.wasmId });
  aliasedRefs.set(mirror, ref);
  return ref;
}

function enqueue(op: Op): void {
  queue.push(op);
  if (!flushScheduled) {
    flushScheduled = true;
    queueMicrotask(flush);
  }
}

/** Create a batch-pending element mirror. */
export function createElement(tag: string): NodeMirror {
  const mirror: NodeMirror = {
    id: allocateMirrorId(),
    type: 1,
    parent: null,
    children: [],
    wasmId: 0n,
  };
  pendingMirrors.add(mirror);
  // Plan 040 regression: batched mirrors must be visible to the placeholder
  // collector (collectTextNodes reads native-tree's registry). Without this,
  // font-pending text nodes are never measured and collapse to 0 width.
  registerMirror(mirror);
  enqueue({ type: "create", reference: refOf(mirror), tag });
  return mirror;
}

/** Create a batch-pending text mirror. */
export function createTextNode(text: string): NodeMirror {
  const mirror: NodeMirror = {
    id: allocateMirrorId(),
    type: 3,
    parent: null,
    children: [],
    wasmId: 0n,
    text,
  };
  pendingMirrors.add(mirror);
  // See createElement: keep the registry in sync so collectTextNodes can
  // find this node for DOM placeholder measurement during font loading.
  registerMirror(mirror);
  const ref = refOf(mirror);
  enqueue({ type: "create", reference: ref, tag: "text" });
  enqueue({ type: "text", node: ref, text });
  return mirror;
}

/** Queue an append; existing parents/children use id addressing, new nodes refs. */
export function insertNode(parent: NodeMirror, child: NodeMirror): void {
  // Facade callers (appendChild/insertBefore) pre-wire mirror topology before
  // calling this function: child.parent is already `parent` and the child is
  // already in `parent.children`. Treat that as the final state and only
  // enqueue the append op — issuing a remove op here would delete the Rust
  // node before the append lands (remove-before-append ordering), orphaning
  // the subtree. Direct callers with an unwired child get full reconciliation.
  if (!parent.children.includes(child)) {
    if (child.parent && child.parent !== parent) {
      removeNode(child);
    }
    parent.children.push(child);
    child.parent = parent;
  }

  // A same-batch remove of `child` (Vue move / keyed v-for reorder) is
  // superseded by this append: cancel the pending removeId/remove so the node
  // is moved by the append instead of destroyed first (P1 #3). Rust
  // `append_child` detaches from the old parent, so a bare append is a move.
  const pendingRemove = pendingRemoves.get(child);
  if (pendingRemove) {
    const removeIndex = queue.indexOf(pendingRemove);
    if (removeIndex !== -1) queue.splice(removeIndex, 1);
    pendingRemoves.delete(child);
  }

  if (child.wasmId !== 0n && parent.wasmId !== 0n) {
    enqueue({ type: "appendId", parent: parent.wasmId, child: child.wasmId });
  } else if (child.wasmId !== 0n) {
    // Existing child under a batch-pending parent (the parent has no id yet):
    // alias the child's exported id and ref-append under the parent's batch
    // ref — appendId with parent 0 would be dropped by Rust (P1 #2).
    enqueue({ type: "append", parent: refOf(parent), child: ensureAlias(child) });
  } else if (parent.wasmId !== 0n) {
    enqueue({ type: "append", parent: ensureAlias(parent), child: refOf(child) });
  } else {
    enqueue({ type: "append", parent: refOf(parent), child: refOf(child) });
  }
}

/** Queue a removal by id (existing) or ref (batch-pending). */
export function removeNode(mirror: NodeMirror): void {
  if (mirror.parent) {
    mirror.parent.children = mirror.parent.children.filter((c) => c !== mirror);
    mirror.parent = null;
  }
  // Keep the native-tree registry in sync so collectTextNodes / bounding-box
  // queries never see removed mirrors (plan 040 regression).
  unregisterMirror(mirror);
  // Replacing an earlier pending remove keeps exactly one remove op queued
  // (a double removal is a no-op in Rust but would confuse the cancel logic).
  const previous = pendingRemoves.get(mirror);
  if (previous) {
    const prevIndex = queue.indexOf(previous);
    if (prevIndex !== -1) queue.splice(prevIndex, 1);
    pendingRemoves.delete(mirror);
  }
  const op: Op =
    mirror.wasmId !== 0n
      ? { type: "removeId", node: mirror.wasmId }
      : { type: "remove", node: refOf(mirror) };
  pendingRemoves.set(mirror, op);
  enqueue(op);
}

/**
 * Normalize a CSS-style key from the facade to the naive-host style wire
 * format (wasm_exports::apply_style). Callers send standard CSS keys with
 * colon-separated variants (`hover:background-color`, `color`), so no key
 * translation is needed. Returns null for non-style keys (e.g. `id`) that
 * must not be forwarded.
 */
function toNaiveStyleKey(rawKey: string): string | null {
  return rawKey === "id" ? null : rawKey;
}

/** Queue a style property update. */
export function setProp(mirror: NodeMirror, key: string, value: string): void {
  const normalized = toNaiveStyleKey(key);
  if (normalized === null) return;
  if (mirror.wasmId !== 0n) {
    enqueue({ type: "styleId", node: mirror.wasmId, key: normalized, value });
  } else {
    enqueue({ type: "style", node: refOf(mirror), key: normalized, value });
  }
}

/** Queue an element-attribute sync (class/id/other) for the Rust host. */
export function setAttr(mirror: NodeMirror, name: string, value: string): void {
  if (mirror.wasmId !== 0n) {
    enqueue({ type: "setAttrId", node: mirror.wasmId, name, value });
  } else {
    enqueue({ type: "setAttr", node: refOf(mirror), name, value });
  }
}

/** Queue a text update. */
export function setText(mirror: NodeMirror, text: string): void {
  mirror.text = text;
  if (mirror.wasmId !== 0n) {
    enqueue({ type: "textId", node: mirror.wasmId, text });
  } else {
    enqueue({ type: "text", node: refOf(mirror), text });
  }
}

/** Queue a checked-state update for :checked matching (plan 050, U4). */
export function setChecked(mirror: NodeMirror, checked: boolean): void {
  if (mirror.wasmId !== 0n) {
    enqueue({ type: "checkedId", node: mirror.wasmId, checked });
  }
}

/** True when the mirror is awaiting batch flush (wasmId not yet resolved). */
export function isBatchPending(mirror: NodeMirror): boolean {
  return pendingMirrors.has(mirror);
}

/** Record a listener; attached after flush once the node has an id. */
export function addEventListener(mirror: NodeMirror, type: string, handler: ListenerHandler): bigint | undefined {
  if (mirror.wasmId !== 0n && !isBatchPending(mirror)) {
    return nativeAddEventListener(
      mirror,
      type as Parameters<typeof nativeAddEventListener>[1],
      handler,
    );
  }
  // Batch-pending: defer registration until flush. Return a negative token so
  // the caller can still remove the listener later (P2 #5); it is swapped for
  // the real HandlerId at flush time.
  const token = listenerToken--;
  const list = pendingListeners.get(mirror) ?? [];
  list.push({ type, handler, token });
  pendingListeners.set(mirror, list);
  return token;
}

export function removeEventListener(token: bigint): void {
  if (token >= 0n) {
    nativeRemoveEventListener(token);
    return;
  }
  // Negative token: a deferred listener. Cancel it while still pending, or
  // detach the real handler registered at flush time (P2 #5).
  for (const [mirror, list] of pendingListeners) {
    const index = list.findIndex((l) => l.token === token);
    if (index !== -1) {
      list.splice(index, 1);
      if (list.length === 0) pendingListeners.delete(mirror);
      return;
    }
  }
  const realId = flushedListenerIds.get(token);
  if (realId !== undefined) {
    nativeRemoveEventListener(realId);
    flushedListenerIds.delete(token);
  }
}

/** Flush the pending batch through apply_ops and resolve wasm ids. */
export function flush(): void {
  flushScheduled = false;
  if (queue.length === 0) return;
  const ops = queue;
  queue = [];
  aliasedRefs.clear();
  pendingRemoves.clear();

  let mapping: Record<string, number>;
  try {
    const serialize = (_key: string, value: unknown): unknown =>
      typeof value === "bigint" ? Number(value) : value;
    mapping = JSON.parse(
      getWasm().apply_ops(JSON.stringify(ops, serialize)),
    ) as Record<string, number>;
  } catch (error) {
    console.error("[naive] apply_ops batch failed", error);
    if (flushRetries < MAX_FLUSH_RETRIES) {
      // Keep the batch and every pending mirror; retry on the next microtask.
      // A transient failure must not orphan the whole facade (P1 #4). The
      // re-run is safe for the common parse/deserialize failures (nothing
      // applied); a persistent failure falls through to the hard error.
      flushRetries += 1;
      queue = [...ops, ...queue];
      flushScheduled = true;
      queueMicrotask(flush);
      return;
    }
    flushRetries = 0;
    console.error("[naive] apply_ops batch failed after retries; dropping batch");
    pendingMirrors.clear();
    return;
  }
  flushRetries = 0;

  for (const mirror of pendingMirrors) {
    const id = mapping[refOf(mirror)];
    if (id !== undefined && id !== 0) mirror.wasmId = BigInt(id);
  }
  pendingMirrors.clear();

  // Plan 040 (review #3): once wasm ids resolve, keep pending-font text nodes
  // measured with DOM placeholders so layout stays stable while the host
  // loads the target font slice. No-op when fonts are not pending.
  if (isFontsPending()) {
    writePlaceholdersForPending(getWasm(), collectTextNodes());
  }

  for (const [mirror, listeners] of pendingListeners) {
    if (mirror.wasmId === 0n) continue;
    for (const { type, handler, token } of listeners) {
      const realId = nativeAddEventListener(
        mirror,
        type as Parameters<typeof nativeAddEventListener>[1],
        handler,
      );
      if (realId) flushedListenerIds.set(token, realId);
    }
    pendingListeners.delete(mirror);
  }
}

/** Test seam: number of queued ops. */
export function queuedOpCount(): number {
  return queue.length;
}

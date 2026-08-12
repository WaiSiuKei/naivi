// Direct FFI bridge for the Vue DOM facade (U4, KTD1).
//
// The U4 wasm protocol returns node ids synchronously (`create_element` /
// `create_text_node`), so batching into an `apply_ops` round-trip is obsolete:
// every facade mutation routes straight to the direct exports via
// native-tree. This module keeps the facade-facing surface
// (`createElement` / `insertNode` / `setProp` / … / `isBatchPending` /
// `flush`) so `naive-dom.ts`, the mount path, and the desktop entry stay
// unchanged. Nothing here is ever "batch pending".

import {
  createElement as nativeCreateElement,
  createTextNode as nativeCreateTextNode,
  insertNode as nativeInsertNode,
  attachDocumentRoot as nativeAttachDocumentRoot,
  removeNode as nativeRemoveNode,
  setProp as nativeSetProp,
  setAttr as nativeSetAttr,
  setChecked as nativeSetChecked,
  setText as nativeSetText,
  addEventListener as nativeAddEventListener,
  removeEventListener as nativeRemoveEventListener,
  type NodeMirror,
} from "./native-tree.js";
import type { EventCallback } from "./wasm-types.js";

export { getBoundingClientRect } from "./native-tree.js";

/** Create a WASM-backed element mirror (id resolves synchronously). */
export function createElement(tag: string): NodeMirror {
  return nativeCreateElement(tag);
}

/** Create a WASM-backed text mirror. */
export function createTextNode(text: string): NodeMirror {
  return nativeCreateTextNode(text);
}

/** Insert `child` under `parent`, preserving JS-side order on the host. */
export function insertNode(parent: NodeMirror, child: NodeMirror): void {
  nativeInsertNode(parent, child);
}

/** Remove a mirror (and its subtree) from mirror + host. */
export function removeNode(mirror: NodeMirror): void {
  nativeRemoveNode(mirror);
}

/** Attach a node as a child of the document root (the facade body). */
export function attachDocumentRoot(mirror: NodeMirror): void {
  nativeAttachDocumentRoot(mirror);
}

/** Queue a style property update (attribute-ish keys excluded). */
export function setProp(mirror: NodeMirror, key: string, value: string): void {
  nativeSetProp(mirror, key, value);
}

/** Sync an element attribute to the host. */
export function setAttr(mirror: NodeMirror, name: string, value: string): void {
  nativeSetAttr(mirror, name, value);
}

/** Sync a text update. */
export function setText(mirror: NodeMirror, text: string): void {
  nativeSetText(mirror, text);
}

/** Sync a checked-state update for `:checked` matching. */
export function setChecked(mirror: NodeMirror, checked: boolean): void {
  nativeSetChecked(mirror, checked);
}

/** True when a mirror is awaiting batch flush — never in the U4 direct protocol. */
export function isBatchPending(_mirror: NodeMirror): boolean {
  return false;
}

/** Bind an event listener on a node; returns the host handler id. */
export function addEventListener(
  mirror: NodeMirror,
  type: string,
  handler: EventCallback,
): bigint | undefined {
  return nativeAddEventListener(
    mirror,
    type as Parameters<typeof nativeAddEventListener>[1],
    handler,
  );
}

/** Remove a previously bound event listener by its handler id. */
export function removeEventListener(token: bigint): void {
  nativeRemoveEventListener(token);
}

/** No-op in the U4 direct protocol (no apply_ops batch to flush). */
export function flush(): void {
  /* nothing to flush — every op already reached the host synchronously */
}

/** Test seam: number of queued ops — always 0 in the direct protocol. */
export function queuedOpCount(): number {
  return 0;
}

// Facade-facing bridge for the U5 frame protocol (KD2/KD3/KD8).
//
// Every facade mutation routes through native-tree, which allocates a JS
// virtual id and queues an op into the [`FrameWriter`]. Mutations never touch
// the host synchronously: the mount loop drives `tick()`/`flushFrame()` at
// each frame boundary, and the writer flushes one binary frame per `flush()`.
// This module keeps the facade-facing surface (`createElement` / `insertNode`
// / `setProp` / … / `isBatchPending` / `flush`) so `naive-dom.ts`, the mount
// path, and the desktop entry stay unchanged.

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
  addStylesheet as nativeAddStylesheet,
  flushFrame as nativeFlushFrame,
  queuedOpCount as nativeQueuedOpCount,
  type NodeMirror,
} from "./native-tree.js";
import type { EventCallback } from "./wasm-types.js";

export { getBoundingClientRect } from "./native-tree.js";

/** Create a writer-backed element mirror (virtual id resolves synchronously). */
export function createElement(tag: string): NodeMirror {
  return nativeCreateElement(tag);
}

/** Create a writer-backed text mirror. */
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

/** Queue an author stylesheet as an `AddStylesheet` frame op. */
export function addStylesheet(css: string): void {
  nativeAddStylesheet(css);
}

/** True when a mirror awaits batch flush — never in the U5 frame protocol. */
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

/** Flush the queued ops to the host as one binary frame (no-op when empty). */
export function flush(): void {
  nativeFlushFrame();
}

/** Test seam: number of queued ops in the writer. */
export function queuedOpCount(): number {
  return nativeQueuedOpCount();
}

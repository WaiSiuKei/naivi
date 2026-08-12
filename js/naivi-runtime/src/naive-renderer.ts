// Naive DOM renderer for Vue (plan 037, U3).
//
// Builds a Vue renderer whose nodeOps/patchProp operate on the naive DOM
// facade instead of the real document, so Vue's reactive updates flow into
// the batched FFI bridge without patching global `document`.

import { createRenderer } from "vue";
import type { NaiveDocumentLike, NaiveNode } from "./naive-dom.js";

export interface NaiveRenderer {
  createApp(rootComponent: unknown): {
    mount(container: unknown): unknown;
  };
}

function naiveNodeOps(doc: NaiveDocumentLike) {
  const cast = <T>(value: unknown): T => value as T;
  return {
    createElement(tag: string): NaiveNode {
      return cast<NaiveNode>(doc.createElement(tag));
    },
    createText(text: string): NaiveNode {
      return cast<NaiveNode>(doc.createTextNode(text));
    },
    createComment(text: string): NaiveNode {
      return cast<NaiveNode>(doc.createComment(text));
    },
    insert(child: NaiveNode, parent: NaiveNode, anchor: NaiveNode | null): void {
      (parent as unknown as { insertBefore(child: unknown, anchor: unknown): unknown }).insertBefore(
        child,
        anchor,
      );
    },
    remove(child: NaiveNode): void {
      const parent = (child as unknown as { parentNode: NaiveNode | null }).parentNode;
      if (parent) {
        (parent as unknown as { removeChild(child: unknown): unknown }).removeChild(child);
      }
    },
    setText(node: NaiveNode, text: string): void {
      (node as unknown as { textContent: string }).textContent = text;
    },
    setElementText(node: NaiveNode, text: string): void {
      (node as unknown as { textContent: string }).textContent = text;
    },
    parentNode(node: NaiveNode): NaiveNode | null {
      return (node as unknown as { parentNode: NaiveNode | null }).parentNode;
    },
    nextSibling(node: NaiveNode): NaiveNode | null {
      return (node as unknown as { nextSibling: NaiveNode | null }).nextSibling;
    },
    querySelector(selector: string): NaiveNode | null {
      return doc.querySelector(selector) as NaiveNode | null;
    },
    setScopeId(): void {
      // No scoped styles in the naive pipeline.
    },
    insertStaticContent(content: string, parent: NaiveNode): [NaiveNode, NaiveNode] {
      (parent as unknown as { innerHTML: string }).innerHTML = content;
      const node = parent as unknown as { firstChild: NaiveNode | null; lastChild: NaiveNode | null };
      return [cast<NaiveNode>(node.firstChild), cast<NaiveNode>(node.lastChild)];
    },
    cloneNode(node: NaiveNode): NaiveNode {
      return node;
    },
  };
}

function naivePatchProp(
  el: NaiveNode,
  key: string,
  prev: unknown,
  next: unknown,
): void {
  const node = el as unknown as {
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
    addEventListener(type: string, handler: EventListener): void;
    removeEventListener(type: string, handler: EventListener): void;
  };
  if (key === "class") {
    node.setAttribute("class", next == null ? "" : String(next));
  } else if (key === "style") {
    node.setAttribute("style", next == null ? "" : String(next));
  } else if (key.startsWith("on")) {
    const type = key.slice(2).toLowerCase();
    if (typeof prev === "function") {
      node.removeEventListener(type, prev as EventListener);
    }
    if (typeof next === "function") {
      node.addEventListener(type, next as EventListener);
    }
  } else if (next == null) {
    node.removeAttribute(key);
  } else {
    node.setAttribute(key, String(next));
  }
}

/** Create a Vue app factory that renders into the naive facade. */
export function createNaiveRenderer(doc: NaiveDocumentLike): NaiveRenderer {
  const renderer = createRenderer({
    ...naiveNodeOps(doc),
    patchProp: naivePatchProp,
  } as never);
  return {
    createApp(rootComponent: unknown) {
      return renderer.createApp(rootComponent as never) as unknown as {
        mount(container: unknown): unknown;
      };
    },
  };
}

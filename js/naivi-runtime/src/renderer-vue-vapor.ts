// Vue Vapor renderer adapter over naive's native tree mirror.
//
// Bridges Vue Vapor's createVaporApp to naive's NodeMirror tree.
// Vue Vapor primitives (createElement, insertNode, setProp, etc.)
// are re-exported from native-tree.ts for the Vue Vapor runtime to use.

import {
  createElement,
  createTextNode,
  insertNode,
  removeNode,
  setProp,
  setText,
  type NodeMirror,
} from "./native-tree.js";

// Re-export for Vue Vapor runtime consumption
export {
  createElement,
  createTextNode,
  insertNode,
  removeNode,
  setProp,
  setText,
  type NodeMirror,
};

// ── Renderer ────────────────────────────────────────────────────────

export interface RenderRoot {
  update(node: unknown): void;
  dispose(): void;
}

/**
 * Render a Vue Vapor component into a NodeMirror root.
 * The `code` function should return a Vapor block (the result of calling
 * a Vue Vapor component's setup function).
 */
export function renderVapor(
  code: () => unknown,
  root: NodeMirror,
): RenderRoot {
  let currentBlock: unknown = null;

  function update(_node: unknown) {
    // Re-run the component to get the new Vapor block
    currentBlock = code();
    // Vue Vapor handles the diffing internally via its block tree
  }

  function dispose() {
    currentBlock = null;
  }

  // Initial render
  update(null);

  return { update, dispose };
}

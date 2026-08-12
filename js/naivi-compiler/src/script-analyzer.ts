// Script Analyzer — extracts handler names and signal references from
// the template IR and <script setup> source.

import type { Bindings, RenderTreeIR } from './ir-types.js';

/** Analyze template IR + script source to produce handler and signal bindings. */
export function analyzeBindings(
  tree: RenderTreeIR,
  scriptSource: string,
): Bindings {
  const handlers: Record<string, string> = {};
  const signalSet = new Set<string>();

  // Scan template IR for handler and signal references.
  walkIR(tree, (node, id) => {
    if (node.handlerId) {
      handlers[id] = node.handlerId;
    }
    if (node.signalId) {
      signalSet.add(node.signalId);
    }
  });

  // Scan script source for signal refs.
  if (scriptSource) {
    extractScriptSignals(scriptSource, signalSet);
  }

  return {
    handlers,
    signals: [...signalSet],
  };
}

/** Walk the RenderTree IR, calling visitor for each node with a generated ID. */
function walkIR(
  node: RenderTreeIR,
  visitor: (node: RenderTreeIR, id: string) => void,
  path: string = 'root',
): void {
  const id = `${path}_${node.kind}_${node.tag ?? node.signalId ?? 'anon'}`;
  visitor(node, id);

  if (node.children) {
    for (let i = 0; i < node.children.length; i++) {
      walkIR(node.children[i], visitor, `${id}_c${i}`);
    }
  }
}

/** Extract signal variable names from script source using simple regex. */
function extractScriptSignals(source: string, signals: Set<string>): void {
  // const name = ref(...)
  const refPattern = /(?:const|let|var)\s+(\w+)\s*=\s*ref\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = refPattern.exec(source)) !== null) {
    signals.add(match[1]);
  }
}

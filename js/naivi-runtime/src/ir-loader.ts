// Guest-side IR loader: walks a compiler `CompileOutput` into a mirror tree
// and applies the whole batch through the bridge's `apply_ops` export in a
// single FFI round-trip.

import { allocateMirrorId, registerMirror, type NodeMirror } from './native-tree.js';
import type { WasmExports } from './wasm-types.js';

// Structural IR types (kept local to avoid a runtime -> compiler dependency).
export interface IRNode {
  kind: 'element' | 'text';
  tag?: string;
  text?: string;
  signalId?: string;
  children?: IRNode[];
  styleId?: number;
  handlerId?: string;
  rawClass?: string;
}

export interface VariantProperties {
  base: Record<string, string | number>;
  hover?: Record<string, string | number>;
  active?: Record<string, string | number>;
  focus?: Record<string, string | number>;
}

export interface StyleRecord {
  id: number;
  properties: VariantProperties;
}

export interface CompileOutputIR {
  tree: IRNode;
  styles: StyleRecord[];
  script: string;
  bindings: { handlers: Record<string, string>; signals: string[] };
}

export interface LoadedNode extends NodeMirror {
  styleId?: number;
  handlerName?: string;
  signalName?: string;
}

type Op =
  | { type: 'create'; reference: string; tag: string }
  | { type: 'append'; parent: string; child: string }
  | { type: 'style'; node: string; key: string; value: string }
  | { type: 'text'; node: string; text: string }
  | { type: 'remove'; node: string };

interface PendingNode {
  ref: string;
  kind: 'element' | 'text';
  tag?: string;
  text?: string;
  signalId?: string;
  styleId?: number;
  handlerId?: string;
  children: PendingNode[];
}

/** Load a `CompileOutput` into the scene through the wasm bridge. */
export function loadIR(output: CompileOutputIR, host: WasmExports): LoadedNode {
  const ops: Op[] = [];
  let counter = 0;
  const nextRef = (): string => `n${counter++}`;

  const pendingRoot = buildPending(output.tree, null, ops, nextRef, output);
  const mapping = JSON.parse(host.apply_ops(JSON.stringify(ops))) as Record<string, number>;

  const root = materialize(pendingRoot, null, mapping, output);
  return root;
}

function buildPending(
  node: IRNode,
  parentRef: string | null,
  ops: Op[],
  nextRef: () => string,
  output: CompileOutputIR,
): PendingNode {
  const ref = nextRef();
  if (node.kind === 'text') {
    ops.push({ type: 'create', reference: ref, tag: 'text' });
    if (node.text) {
      ops.push({ type: 'text', node: ref, text: node.text });
    }
    if (parentRef) {
      ops.push({ type: 'append', parent: parentRef, child: ref });
    }
    return {
      ref,
      kind: 'text',
      text: node.text,
      signalId: node.signalId,
      children: [],
    };
  }

  ops.push({ type: 'create', reference: ref, tag: node.tag ?? 'div' });
  if (parentRef) {
    ops.push({ type: 'append', parent: parentRef, child: ref });
  }
  const styleId = node.styleId;
  if (styleId !== undefined) {
    const record = output.styles.find((s) => s.id === styleId);
    if (record) {
      for (const [key, value] of Object.entries(record.properties.base)) {
        ops.push({ type: 'style', node: ref, key, value: String(value) });
      }
      for (const variant of ['hover', 'active', 'focus'] as const) {
        const props = record.properties[variant];
        if (!props) continue;
        for (const [key, value] of Object.entries(props)) {
          ops.push({ type: 'style', node: ref, key: `${variant}:${key}`, value: String(value) });
        }
      }
    }
  }

  const children = (node.children ?? []).map((child) =>
    buildPending(child, ref, ops, nextRef, output),
  );
  return {
    ref,
    kind: 'element',
    tag: node.tag,
    styleId,
    handlerId: node.handlerId,
    children,
  };
}

function materialize(
  pending: PendingNode,
  parent: LoadedNode | null,
  mapping: Record<string, number>,
  output: CompileOutputIR,
): LoadedNode {
  const mirror: LoadedNode = {
    id: allocateMirrorId(),
    type: pending.kind === 'element' ? 1 : 3,
    parent,
    children: [],
    wasmId: BigInt(mapping[pending.ref] ?? 0),
    text: pending.text,
    styleId: pending.styleId,
  };
  if (pending.handlerId) {
    mirror.handlerName = pending.handlerId;
  }
  if (pending.signalId) {
    mirror.signalName = output.bindings.signals.includes(pending.signalId)
      ? pending.signalId
      : undefined;
  }
  registerMirror(mirror);
  mirror.children = pending.children.map((child) => materialize(child, mirror, mapping, output));
  return mirror;
}

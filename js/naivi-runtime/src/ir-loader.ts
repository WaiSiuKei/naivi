// Guest-side IR loader: walks a compiler `CompileOutput` into a mirror tree.
//
// U4: the old batched `apply_ops` round-trip is obsolete — node ids resolve
// synchronously from `create_element` / `create_text_node`, so the loader
// builds the tree directly through the direct protocol exports.

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

/** Load a `CompileOutput` into the scene through the direct protocol exports. */
export function loadIR(output: CompileOutputIR, host: WasmExports): LoadedNode {
  const build = (node: IRNode, parent: LoadedNode | null): LoadedNode => {
    let wasmId: bigint;
    if (node.kind === 'text') {
      wasmId = host.create_text_node(node.text ?? '');
    } else {
      wasmId = host.create_element(node.tag ?? 'div');
      const styleId = node.styleId;
      if (styleId !== undefined) {
        const record = output.styles.find((s) => s.id === styleId);
        if (record) {
          for (const [key, value] of Object.entries(record.properties.base)) {
            host.set_style(wasmId, key, String(value));
          }
          // Variant styles (hover/active/focus) are the U6 styles path's
          // concern; here they are applied as plain style props.
          for (const variant of ['hover', 'active', 'focus'] as const) {
            const props = record.properties[variant];
            if (!props) continue;
            for (const [key, value] of Object.entries(props)) {
              host.set_style(wasmId, key, String(value));
            }
          }
        }
      }
    }

    const mirror: LoadedNode = {
      id: allocateMirrorId(),
      type: node.kind === 'element' ? 1 : 3,
      parent,
      children: [],
      wasmId,
      text: node.text,
      styleId: node.styleId,
    };
    if (node.handlerId) {
      mirror.handlerName = node.handlerId;
    }
    if (node.signalId) {
      mirror.signalName = output.bindings.signals.includes(node.signalId)
        ? node.signalId
        : undefined;
    }
    registerMirror(mirror);

    if (parent) {
      host.append_child(parent.wasmId, wasmId);
      parent.children.push(mirror);
    }
    mirror.children = (node.children ?? []).map((child) => build(child, mirror));
    return mirror;
  };

  return build(output.tree, null);
}

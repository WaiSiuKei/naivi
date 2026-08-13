// Guest-side IR loader: walks a compiler `CompileOutput` into a mirror tree.
//
// U5: creation goes through native-tree (virtual id + `CreateElement` /
// `CreateTextNode` writer ops); styles route through `setProp`; topology is
// wired with `insertNode`. Nothing touches the host synchronously — the
// mount loop flushes the queued frame at the next tick.

import {
  createElement as nativeCreateElement,
  createTextNode as nativeCreateTextNode,
  insertNode as nativeInsertNode,
  type NodeMirror,
} from './native-tree.js';
import { setProp as nativeSetProp } from './batched-bridge.js';

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

/** Load a `CompileOutput` into the scene through the U5 writer protocol. */
export function loadIR(output: CompileOutputIR): LoadedNode {
  const build = (node: IRNode, parent: LoadedNode | null): LoadedNode => {
    const mirror =
      node.kind === 'text'
        ? nativeCreateTextNode(node.text ?? '')
        : nativeCreateElement(node.tag ?? 'div');
    const loaded = mirror as LoadedNode;

    if (node.kind === 'element' && node.styleId !== undefined) {
      const record = output.styles.find((s) => s.id === node.styleId);
      if (record) {
        for (const [key, value] of Object.entries(record.properties.base)) {
          nativeSetProp(loaded, key, String(value));
        }
        // Variant styles (hover/active/focus) are the U6 styles path's
        // concern; here they are applied as plain style props.
        for (const variant of ['hover', 'active', 'focus'] as const) {
          const props = record.properties[variant];
          if (!props) continue;
          for (const [key, value] of Object.entries(props)) {
            nativeSetProp(loaded, key, String(value));
          }
        }
      }
      loaded.styleId = node.styleId;
    }
    if (node.handlerId) {
      loaded.handlerName = node.handlerId;
    }
    if (node.signalId) {
      loaded.signalName = output.bindings.signals.includes(node.signalId)
        ? node.signalId
        : undefined;
    }

    if (parent) {
      parent.children.push(loaded);
      loaded.parent = parent;
      nativeInsertNode(parent, loaded);
    }
    loaded.children = (node.children ?? []).map((child) => build(child, loaded));
    return loaded;
  };

  return build(output.tree, null);
}

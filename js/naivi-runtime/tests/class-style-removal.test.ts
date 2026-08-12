//! Class style removal: :class only syncs attributes; Rust owns compute
//! (plan 062, U4).

import { describe, expect, it, beforeEach } from 'vitest';

import { bindWasm } from '../src/native-tree.js';
import { getNaiveDocument, initNaiveDocument } from '../src/naive-dom.js';
import type { WasmExports } from '../src/wasm-types.js';

function makeMockWasm(): {
  wasm: WasmExports;
  ops: () => Array<Record<string, unknown>>;
} {
  let next = 1n;
  let opsLog: Array<Record<string, unknown>> = [];
  const wasm: WasmExports = {
    create_element: () => next++,
    set_style: () => {},
    set_rule_table: () => true,
    set_text: () => {},
    append_child: () => {},
    remove_node: () => {},
    apply_ops: (json) => {
      opsLog = JSON.parse(json);
      const mapping: Record<string, number> = {};
      for (const op of opsLog) {
        if (op.type === 'create') mapping[op.reference as string] = Number(next++);
      }
      return JSON.stringify(mapping);
    },
    apply_conditional_styles: () => false,
    set_placeholder_measures: () => false,
    clear_placeholder_measures: () => false,
    get_layout_rect: () => 'null',
    compute_layout: () => '{}',
    add_event_listener: () => 0n,
    remove_event_listener: () => {},
    handle_event: () => {},
  };
  return { wasm, ops: () => opsLog };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('class style removal (plan 062)', () => {
  beforeEach(() => {
    initNaiveDocument();
  });

  it('syncs :class via setAttr and never emits style ops from classes', async () => {
    const mock = makeMockWasm();
    bindWasm(mock.wasm);
    initNaiveDocument();

    const doc = getNaiveDocument()!;
    const el = doc.createElement('div') as HTMLElement;
    await flushMicrotasks();
    mock.ops();

    el.setAttribute('class', 'btn text-red-500');
    await flushMicrotasks();

    const ops = mock.ops();
    expect(
      ops.some(
        (op) =>
          (op.type === 'setAttr' || op.type === 'setAttrId') && op.name === 'class',
      ),
    ).toBe(true);
    expect(ops.some((op) => op.type === 'style')).toBe(false);
  });
});

import { describe, expect, it, beforeEach } from 'vitest';

import { bindWasm } from '../src/native-tree.js';
import {
  getNaiveDocument,
  initNaiveDocument,
  loadCSSClassStyles,
} from '../src/naive-dom.js';
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

describe('checked state sync', () => {
  beforeEach(() => {
    initNaiveDocument();
  });

  it('emits a checkedId op from setAttribute("checked")', async () => {
    const mock = makeMockWasm();
    bindWasm(mock.wasm);
    initNaiveDocument();

    const doc = getNaiveDocument()!;
    const input = doc.createElement('input') as HTMLElement;
    await flushMicrotasks();
    mock.ops();

    input.setAttribute('checked', '');
    await flushMicrotasks();

    const checkedOps = mock
      .ops()
      .filter((op) => op.type === 'checkedId');
    expect(checkedOps).toHaveLength(1);
    expect(checkedOps[0].checked).toBe(true);
  });

  it('syncs checked state without JS rule matching (Rust owns compute)', async () => {
    const mock = makeMockWasm();
    bindWasm(mock.wasm);
    initNaiveDocument();

    (globalThis as unknown as Record<string, unknown>).__NAIVE_STYLES = {
      rules: [{ selector: 'input:checked', pseudo: null, conditions: [], chain: [{ tag: 'input', pseudo_classes: ['checked'] }], combinators: [], properties: { opacity: '0.5' } }],
    };
    await loadCSSClassStyles();

    const doc = getNaiveDocument()!;
    const input = doc.createElement('input') as HTMLElement;
    await flushMicrotasks();

    mock.ops();
    input.setAttribute('checked', '');
    await flushMicrotasks();
    const checkedOps = mock.ops().filter((op) => op.type === 'checkedId');
    expect(checkedOps).toHaveLength(1);
    expect(checkedOps[0].checked).toBe(true);

    input.removeAttribute('checked');
    await flushMicrotasks();
    const removed = mock.ops().filter((op) => op.type === 'checkedId');
    expect(removed.at(-1)?.checked).toBe(false);
  });
});

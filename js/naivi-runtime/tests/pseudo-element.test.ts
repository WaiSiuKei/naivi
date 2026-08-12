//! Pseudo-element behavior after the Rust migration (plan 061, U4).
//!
//! The JS facade no longer creates pseudo nodes; rules are passed to Rust,
//! which owns ::before/::after scene nodes. The facade only syncs attributes.

import { describe, expect, it, beforeEach } from 'vitest';

import { bindWasm } from '../src/native-tree.js';
import { getNaiveDocument, initNaiveDocument, loadCSSClassStyles } from '../src/naive-dom.js';
import type { WasmExports } from '../src/wasm-types.js';

function makeMockWasm(): {
  wasm: WasmExports;
  ops: () => Array<Record<string, unknown>>;
  ruleTableCalls: string[];
} {
  let next = 1n;
  let opsLog: Array<Record<string, unknown>> = [];
  const ruleTableCalls: string[] = [];
  const wasm: WasmExports = {
    create_element: () => next++,
    set_style: () => {},
    set_rule_table: (json: string) => {
      ruleTableCalls.push(json);
      return true;
    },
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
  return { wasm, ops: () => opsLog, ruleTableCalls };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('pseudo-element behavior (Rust-owned)', () => {
  beforeEach(() => {
    initNaiveDocument();
  });

  it('passes pseudo rules to Rust and does not create JS pseudo nodes', async () => {
    const mock = makeMockWasm();
    bindWasm(mock.wasm);
    initNaiveDocument();

    (globalThis as unknown as Record<string, unknown>).__NAIVE_STYLES = {
      rules: [
        {
          selector: '.box::before',
          pseudo: 'before',
          conditions: [],
          chain: [{ classes: ['box'] }],
          combinators: [],
          properties: { 'background-color': '#ff0000' },
        },
      ],
    };
    await loadCSSClassStyles();

    expect(mock.ruleTableCalls).toHaveLength(1);
    expect(JSON.parse(mock.ruleTableCalls[0]).rules[0].pseudo).toBe('before');

    const doc = getNaiveDocument()!;
    const box = doc.createElement('div') as HTMLElement;
    box.setAttribute('class', 'box');
    await flushMicrotasks();

    const el = box as unknown as {
      _pseudoElements?: Record<string, unknown>;
    };
    expect(el._pseudoElements).toBeUndefined();
    const ops = mock.ops();
    expect(
      ops.some((op) => op.type === 'create' && op.tag === '::before'),
    ).toBe(false);
    // The class attribute still syncs to Rust for matching.
    expect(ops.some((op) => op.type === 'setAttr' && op.name === 'class')).toBe(true);
  });
});

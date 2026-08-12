//! styles.json rules → Rust bridge input tests (plan 060, U3).

import { afterEach, describe, expect, it } from 'vitest';

import { bindWasm } from '../src/native-tree.js';
import { loadCSSClassStyles } from '../src/naive-dom.js';
import type { WasmExports } from '../src/wasm-types.js';

function makeMockWasm(record: { ruleTableCalls: string[] }): WasmExports {
  return {
    set_rule_table: (json: string) => {
      record.ruleTableCalls.push(json);
      return true;
    },
    create_element: () => 1n,
    set_style: () => {},
    set_text: () => {},
    append_child: () => {},
    remove_node: () => {},
    apply_ops: () => '',
    apply_conditional_styles: () => true,
    set_placeholder_measures: () => true,
    clear_placeholder_measures: () => true,
    get_layout_rect: () => 'null',
    compute_layout: () => '',
    add_event_listener: () => 1n,
    remove_event_listener: () => {},
    handle_event: () => {},
  };
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__NAIVE_STYLES;
});

describe('rule table input (plan 060)', () => {
  it('passes styles.rules to the Rust bridge once when present', async () => {
    const record = { ruleTableCalls: [] as string[] };
    bindWasm(makeMockWasm(record));
    const rules = [
      {
        selector: '.x',
        pseudo: null,
        conditions: [],
        chain: [{ classes: ['x'] }],
        combinators: [],
        properties: { color: '#ff0000' },
      },
    ];
    (globalThis as Record<string, unknown>).__NAIVE_STYLES = {
      foo: { color: '#000000' },
      rules,
    };

    await loadCSSClassStyles();

    expect(record.ruleTableCalls).toHaveLength(1);
    // Rust RuleTable::from_json expects the `{ "rules": [...] }` wire shape.
    expect(JSON.parse(record.ruleTableCalls[0])).toEqual({ rules });
  });

  it('does not call the bridge when styles have no rules', async () => {
    const record = { ruleTableCalls: [] as string[] };
    bindWasm(makeMockWasm(record));
    (globalThis as Record<string, unknown>).__NAIVE_STYLES = {
      foo: { color: '#000000' },
    };

    await loadCSSClassStyles();

    expect(record.ruleTableCalls).toHaveLength(0);
  });
});

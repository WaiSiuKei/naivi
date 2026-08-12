import { describe, expect, it } from 'vitest';

import { loadIR, type CompileOutputIR } from '../src/ir-loader.js';
import type { WasmExports } from '../src/wasm-types.js';

const fixture: CompileOutputIR = {
  tree: {
    kind: 'element',
    tag: 'div',
    styleId: 0,
    children: [
      {
        kind: 'element',
        tag: 'span',
        styleId: 1,
        children: [
          { kind: 'text', text: 'Count: ' },
          { kind: 'text', signalId: 'count' },
        ],
      },
      { kind: 'element', tag: 'button', styleId: 2, handlerId: 'increment' },
    ],
  },
  styles: [
    {
      id: 0,
      properties: {
        base: { display: 'flex', 'flex-direction': 'column' },
        hover: { 'background-color': '#ff0000' },
      },
    },
    { id: 1, properties: { base: { color: 'nope' } } },
    { id: 2, properties: { base: { width: '100px', opacity: 0.5 } } },
  ],
  script: 'const count = ref(0)',
  bindings: { handlers: { any: 'increment' }, signals: ['count'] },
};

function fakeHost(): {
  host: WasmExports;
  calls: () => number;
  ops: () => unknown[];
} {
  let calls = 0;
  let ops: unknown[] = [];
  const unexpected = (): never => {
    throw new Error('loader must use apply_ops only');
  };
  const host: WasmExports = {
    create_element: unexpected,
    set_style: unexpected,
    set_rule_table: () => true,
    set_text: unexpected,
    append_child: unexpected,
    remove_node: unexpected,
    apply_ops: (json) => {
      calls += 1;
      ops = JSON.parse(json);
      const mapping: Record<string, number> = {};
      let id = 1;
      for (const op of ops as { type: string; reference: string }[]) {
        if (op.type === 'create') {
          mapping[op.reference] = id++;
        }
      }
      return JSON.stringify(mapping);
    },
    compute_layout: () => '',
    add_event_listener: () => 0n,
    remove_event_listener: () => {},
    handle_event: () => {},
    set_placeholder_measures: () => false,
    clear_placeholder_measures: () => false,
    get_layout_rect: () => 'null',
  };
  return { host, calls: () => calls, ops: () => ops };
}

describe('loadIR', () => {
  it('builds a mirror tree matching the IR (AE1)', () => {
    const { host } = fakeHost();
    const root = loadIR(fixture, host);

    expect(root.type).toBe(1);
    expect(root.wasmId).toBe(1n);
    expect(root.children).toHaveLength(2);
    const span = root.children[0];
    expect(span.children).toHaveLength(2);
    expect(span.children[0].text).toBe('Count: ');
    expect(span.children[1].signalName).toBe('count');
    expect(root.children[1].handlerName).toBe('increment');
  });

  it('sends styles (base + variants) and text in a single batch (AE2/AE4)', () => {
    const { host, calls, ops } = fakeHost();
    loadIR(fixture, host);

    expect(calls()).toBe(1);
    const styleOps = (ops() as { type: string }[]).filter((op) => op.type === 'style');
    expect(styleOps.length).toBeGreaterThan(0);
    const rootStyle = styleOps.filter((op) =>
      JSON.stringify(op).includes('"node":"n0"'),
    );
    expect(JSON.stringify(rootStyle)).toContain('display');
    expect(JSON.stringify(rootStyle)).toContain('hover:background-color');
    const textOps = (ops() as { type: string }[]).filter((op) => op.type === 'text');
    expect(textOps.length).toBe(1);
  });

  it('records handler and signal bindings on mirrors (AE3)', () => {
    const { host } = fakeHost();
    const root = loadIR(fixture, host);
    expect(root.children[1].handlerName).toBe('increment');
    const signalText = root.children[0].children[1];
    expect(signalText.signalName).toBe('count');
  });

  it('tolerates unknown style keys and missing styleId', () => {
    const { host } = fakeHost();
    const root = loadIR(fixture, host);
    expect(root.wasmId).toBe(1n);
  });
});

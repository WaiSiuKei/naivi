//! Guest-side IR loader tests (U5 frame protocol).
//!
//! `loadIR` builds the mirror tree through native-tree (virtual id +
//! `CreateElement` / `CreateTextNode` writer ops), routes styles through
//! `set_style` ops, and wires topology with `append_child` ops — all flushed
//! as one binary frame.

import { describe, expect, it, beforeEach } from 'vitest';

import { loadIR, type CompileOutputIR } from '../src/ir-loader.js';
import { bindWasm, clearQueuedOps, emitReset, findRoot } from '../src/native-tree.js';
import { flush } from '../src/batched-bridge.js';
import { makeMockWasm, decodeFrames } from './helpers/frame-harness.js';

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

interface StyleCall {
  key: string;
  value: string;
}

describe('loadIR', () => {
  beforeEach(() => {
    // Reset the module-level mirror state between tests (virtual allocator +
    // registry live across the suite) and drop any unflushed writer ops.
    emitReset();
    clearQueuedOps();
  });

  it('builds a mirror tree matching the IR (AE1)', () => {
    const mock = makeMockWasm();
    bindWasm(mock.wasm);
    const root = loadIR(fixture);

    expect(root.type).toBe(1);
    expect(root.id).toBeGreaterThan(0);
    expect(root.children).toHaveLength(2);
    const span = root.children[0];
    expect(span.children).toHaveLength(2);
    expect(span.children[0].text).toBe('Count: ');
    expect(span.children[1].signalName).toBe('count');
    expect(root.children[1].handlerName).toBe('increment');
    // The loaded root is the parentless mirror (scene root).
    expect(findRoot()).toBe(root);
  });

  it('applies base + variant styles and text via frame ops (AE2/AE4)', () => {
    const mock = makeMockWasm();
    bindWasm(mock.wasm);
    loadIR(fixture);
    flush();

    const records = decodeFrames(mock.frames);
    const styles: StyleCall[] = records
      .filter((c) => c.kind === 'set_style')
      .map((c) => ({ key: c.name!, value: c.value! }));
    const keys = styles.map((s) => s.key);
    expect(keys).toContain('display');
    expect(keys).toContain('flex-direction');
    expect(keys).toContain('background-color'); // hover variant
    expect(keys).toContain('width');
    expect(keys).toContain('opacity');
    expect(styles.find((s) => s.key === 'opacity')?.value).toBe('0.5');
    // Text nodes are created with their literal content.
    expect(records.some((c) => c.kind === 'create_text_node' && c.text === 'Count: ')).toBe(true);
    // Every non-root node is appended under its parent.
    expect(records.filter((c) => c.kind === 'append_child')).toHaveLength(4);
  });

  it('records handler and signal bindings on mirrors (AE3)', () => {
    const mock = makeMockWasm();
    bindWasm(mock.wasm);
    const root = loadIR(fixture);
    expect(root.children[1].handlerName).toBe('increment');
    const signalText = root.children[0].children[1];
    expect(signalText.signalName).toBe('count');
  });

  it('tolerates unknown style keys and missing styleId', () => {
    const mock = makeMockWasm();
    bindWasm(mock.wasm);
    const root = loadIR(fixture);
    expect(root.id).toBeGreaterThan(0);
    // `color: 'nope'` is forwarded verbatim; the loader must not throw.
    flush();
    expect(decodeFrames(mock.frames).some((c) => c.kind === 'set_style' && c.name === 'color')).toBe(true);
  });
});

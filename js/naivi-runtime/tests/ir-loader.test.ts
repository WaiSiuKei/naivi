//! Guest-side IR loader tests (U4 direct protocol).
//!
//! `loadIR` builds the mirror tree through the direct exports
//! (`create_element` / `create_text_node` / `set_style` / `append_child`) —
//! there is no `apply_ops` batch anymore; ids resolve synchronously.

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

interface StyleCall {
  key: string;
  value: string;
}

function fakeHost(): {
  host: WasmExports;
  styles: () => StyleCall[];
  textNodes: () => string[];
  appended: () => number;
} {
  let next = 1n;
  const styles: StyleCall[] = [];
  const textNodes: string[] = [];
  let appended = 0;
  const noop = (): void => {};
  const host: WasmExports = {
    create_element: () => next++,
    create_text_node: (text: string) => {
      textNodes.push(text);
      return next++;
    },
    set_text: noop,
    set_attr: noop,
    set_style: (_n: bigint, key: string, value: string) => {
      styles.push({ key, value });
    },
    append_child: () => {
      appended += 1;
    },
    attach_document_root: noop,
    insert_before: noop,
    insert_after: noop,
    replace_node: noop,
    remove_node: noop,
    bind_event: () => 1n,
    unbind_event: noop,
    set_event_callback: noop,
    tick: noop,
    add_stylesheet: noop,
    set_placeholder_measures: () => false,
    clear_placeholder_measures: () => false,
  };
  return {
    host,
    styles: () => styles,
    textNodes: () => textNodes,
    appended: () => appended,
  };
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

  it('applies base + variant styles and text via the direct protocol (AE2/AE4)', () => {
    const { host, styles, textNodes, appended } = fakeHost();
    loadIR(fixture, host);

    const keys = styles().map((s) => s.key);
    expect(keys).toContain('display');
    expect(keys).toContain('flex-direction');
    expect(keys).toContain('background-color'); // hover variant
    expect(keys).toContain('width');
    expect(keys).toContain('opacity');
    expect(styles().find((s) => s.key === 'opacity')?.value).toBe('0.5');
    // Text nodes are created with their literal content.
    expect(textNodes()).toContain('Count: ');
    // Every non-root node is appended under its parent.
    expect(appended()).toBe(4);
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
    // `color: 'nope'` is forwarded verbatim; the loader must not throw.
    expect(
      host.set_style,
    ).toBeDefined();
  });
});

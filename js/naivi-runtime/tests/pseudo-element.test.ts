//! Pseudo-element behavior after the Rust migration (plan 061, U4/U6).
//!
//! The JS facade never creates pseudo nodes; author CSS with `::before` /
//! `::after` rules is injected as a stylo author stylesheet
//! (`add_stylesheet`), and stylo owns the pseudo-element scene nodes. The
//! facade only syncs attributes.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { bindWasm } from '../src/native-tree.js';
import { getNaiveDocument, initNaiveDocument, loadCSSClassStyles } from '../src/naive-dom.js';
import type { WasmExports } from '../src/wasm-types.js';

interface Call {
  kind: string;
  tag?: string;
  name?: string;
  value?: string;
}

function makeMockWasm(): {
  wasm: WasmExports;
  calls: () => Call[];
  cssCalls: () => string[];
} {
  let next = 1n;
  const calls: Call[] = [];
  const cssCalls: string[] = [];
  const wasm: WasmExports = {
    create_element: (tag: string) => {
      calls.push({ kind: 'create_element', tag });
      return next++;
    },
    create_text_node: () => next++,
    set_text: () => {},
    set_attr: (_n: bigint, name: string, value: string) => {
      calls.push({ kind: 'set_attr', name, value });
    },
    set_style: () => {},
    append_child: () => {},
    attach_document_root: () => {},
    insert_before: () => {},
    insert_after: () => {},
    replace_node: () => {},
    remove_node: () => {},
    bind_event: () => 1n,
    unbind_event: () => {},
    set_event_callback: () => {},
    tick: () => {},
    add_stylesheet: (css: string) => {
      cssCalls.push(css);
    },
    set_placeholder_measures: () => false,
    clear_placeholder_measures: () => false,
  };
  return { wasm, calls: () => calls, cssCalls: () => cssCalls };
}

describe('pseudo-element behavior (Rust-owned)', () => {
  beforeEach(() => {
    initNaiveDocument();
  });
  afterEach(() => {
    delete (globalThis as unknown as Record<string, unknown>).__NAIVE_CSS;
  });

  it('passes pseudo CSS to stylo via add_stylesheet and creates no JS pseudo nodes', async () => {
    const mock = makeMockWasm();
    bindWasm(mock.wasm);
    initNaiveDocument();

    const css = '.box::before { background-color: #ff0000; }';
    (globalThis as unknown as Record<string, unknown>).__NAIVE_CSS = css;
    await loadCSSClassStyles();

    expect(mock.cssCalls()).toHaveLength(1);
    expect(mock.cssCalls()[0]).toContain('::before');

    const doc = getNaiveDocument()!;
    const box = doc.createElement('div') as HTMLElement;
    box.setAttribute('class', 'box');

    const el = box as unknown as {
      _pseudoElements?: Record<string, unknown>;
    };
    expect(el._pseudoElements).toBeUndefined();
    // No `::before` scene node is created by the facade.
    expect(
      mock.calls().some((c) => c.kind === 'create_element' && c.tag === '::before'),
    ).toBe(false);
    // The class attribute still syncs to the engine for matching.
    expect(
      mock.calls().some((c) => c.kind === 'set_attr' && c.name === 'class'),
    ).toBe(true);
  });
});

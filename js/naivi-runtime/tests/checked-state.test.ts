//! Checked state sync (U4/U6 direct protocol).
//!
//! `setAttribute('checked', …)` / `removeAttribute('checked')` sync the
//! `checked` attribute to the engine (`set_attr`). `:checked` selector
//! matching is owned by stylo (U6 author CSS) — the JS facade never computes
//! styles from checked state.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { bindWasm } from '../src/native-tree.js';
import {
  getNaiveDocument,
  initNaiveDocument,
  loadCSSClassStyles,
} from '../src/naive-dom.js';
import type { WasmExports } from '../src/wasm-types.js';

interface Call {
  kind: string;
  name?: string;
  value?: string;
}

function makeMockWasm(): {
  wasm: WasmExports;
  calls: () => Call[];
} {
  let next = 1n;
  const calls: Call[] = [];
  const wasm: WasmExports = {
    create_element: () => next++,
    create_text_node: () => next++,
    set_text: () => {},
    set_attr: (_n: bigint, name: string, value: string) => {
      calls.push({ kind: 'set_attr', name, value });
    },
    set_style: (_n: bigint, key: string, value: string) => {
      calls.push({ kind: 'set_style', name: key, value });
    },
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
    add_stylesheet: () => {},
    set_placeholder_measures: () => false,
    clear_placeholder_measures: () => false,
  };
  return { wasm, calls: () => calls };
}

describe('checked state sync', () => {
  beforeEach(() => {
    initNaiveDocument();
  });
  afterEach(() => {
    delete (globalThis as unknown as Record<string, unknown>).__NAIVE_CSS;
  });

  it('syncs setAttribute("checked") via set_attr (Rust owns :checked matching)', () => {
    const mock = makeMockWasm();
    bindWasm(mock.wasm);
    initNaiveDocument();

    const doc = getNaiveDocument()!;
    const input = doc.createElement('input') as HTMLElement;
    input.setAttribute('checked', '');

    const attrs = mock
      .calls()
      .filter((c) => c.kind === 'set_attr' && c.name === 'checked');
    expect(attrs).toHaveLength(1);
    expect(attrs[0].value).toBe('true');
  });

  it('clears checked via "false" and removeAttribute without JS style compute', () => {
    const mock = makeMockWasm();
    bindWasm(mock.wasm);
    initNaiveDocument();

    // Snapshot after the body bootstrap (its width/height UA styles emit
    // set_style); only ops after this point matter.
    const baseline = mock.calls().length;
    const doc = getNaiveDocument()!;
    const input = doc.createElement('input') as HTMLElement;
    input.setAttribute('checked', '');
    input.setAttribute('checked', 'false');
    input.removeAttribute('checked');

    const attrs = mock
      .calls()
      .slice(baseline)
      .filter((c) => c.kind === 'set_attr' && c.name === 'checked');
    expect(attrs.map((a) => a.value)).toEqual(['true', 'false', 'false']);
    // No style ops: the engine (stylo) owns :checked compute.
    expect(mock.calls().slice(baseline).some((c) => c.kind === 'set_style')).toBe(false);
  });

  it('loads the author CSS and never derives checked styles in JS', async () => {
    const mock = makeMockWasm();
    bindWasm(mock.wasm);
    initNaiveDocument();

    (globalThis as unknown as Record<string, unknown>).__NAIVE_CSS =
      'input:checked { opacity: 0.5; }';
    await loadCSSClassStyles();

    const baseline = mock.calls().length;
    const doc = getNaiveDocument()!;
    const input = doc.createElement('input') as HTMLElement;
    input.setAttribute('checked', '');

    const attrCalls = mock.calls().slice(baseline).filter((c) => c.kind === 'set_attr');
    expect(attrCalls.some((c) => c.name === 'checked')).toBe(true);
    expect(mock.calls().slice(baseline).some((c) => c.kind === 'set_style')).toBe(false);
  });
});

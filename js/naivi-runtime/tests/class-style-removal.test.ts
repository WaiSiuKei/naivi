//! Class style removal: :class only syncs attributes; the engine owns style
//! compute (plan 062, U4/U6). `setAttribute('class', …)` routes to
//! `set_attr` — the facade never emits style ops derived from class tokens.

import { describe, expect, it, beforeEach } from 'vitest';

import { bindWasm } from '../src/native-tree.js';
import { getNaiveDocument, initNaiveDocument } from '../src/naive-dom.js';
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

describe('class style removal (plan 062)', () => {
  beforeEach(() => {
    initNaiveDocument();
  });

  it('syncs :class via set_attr and never emits style ops from classes', () => {
    const mock = makeMockWasm();
    bindWasm(mock.wasm);
    initNaiveDocument();

    // Snapshot after the body bootstrap (its width/height UA styles emit
    // set_style); only ops after this point matter.
    const baseline = mock.calls().length;
    const doc = getNaiveDocument()!;
    const el = doc.createElement('div') as HTMLElement;
    el.setAttribute('class', 'btn text-red-500');

    const classAttrs = mock
      .calls()
      .slice(baseline)
      .filter((c) => c.kind === 'set_attr' && c.name === 'class');
    expect(classAttrs).toHaveLength(1);
    expect(classAttrs[0].value).toBe('btn text-red-500');
    // No style ops derived from class tokens — stylo matches `.btn` etc.
    expect(mock.calls().slice(baseline).some((c) => c.kind === 'set_style')).toBe(false);
  });
});

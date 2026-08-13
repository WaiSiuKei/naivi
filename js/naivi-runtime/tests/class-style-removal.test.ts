//! Class style removal: :class only syncs attributes; the engine owns style
//! compute (plan 062, U4/U6). `setAttribute('class', …)` queues a `set_attr`
//! op — the facade never emits style ops derived from class tokens.

import { describe, expect, it, beforeEach } from 'vitest';

import { bindWasm } from '../src/native-tree.js';
import { getNaiveDocument, initNaiveDocument } from '../src/naive-dom.js';
import { flush } from '../src/batched-bridge.js';
import { makeMockWasm, decodeFrames } from './helpers/frame-harness.js';

describe('class style removal (plan 062)', () => {
  beforeEach(() => {
    initNaiveDocument();
  });

  it('syncs :class via set_attr and never emits style ops from classes', () => {
    const mock = makeMockWasm();
    bindWasm(mock.wasm);
    initNaiveDocument();

    // Flush the body bootstrap frame so only the ops below are analyzed.
    flush();
    const baselineFrames = mock.frames.length;

    const doc = getNaiveDocument()!;
    const el = doc.createElement('div') as HTMLElement;
    el.setAttribute('class', 'btn text-red-500');
    flush();

    const records = decodeFrames(mock.frames.slice(baselineFrames));
    const classAttrs = records.filter((c) => c.kind === 'set_attr' && c.name === 'class');
    expect(classAttrs).toHaveLength(1);
    expect(classAttrs[0].value).toBe('btn text-red-500');
    // No style ops derived from class tokens — stylo matches `.btn` etc.
    expect(records.some((c) => c.kind === 'set_style')).toBe(false);
  });
});

//! Checked state sync (U5 frame protocol).
//!
//! `setAttribute('checked', …)` / `removeAttribute('checked')` queue a
//! `set_attr` op for the `checked` attribute. `:checked` selector matching is
//! owned by stylo (U6 author CSS) — the JS facade never computes styles from
//! checked state.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { bindWasm } from '../src/native-tree.js';
import {
  getNaiveDocument,
  initNaiveDocument,
  loadCSSClassStyles,
} from '../src/naive-dom.js';
import { flush } from '../src/batched-bridge.js';
import { makeMockWasm, decodeFrames } from './helpers/frame-harness.js';

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
    flush();

    const attrs = decodeFrames(mock.frames).filter(
      (c) => c.kind === 'set_attr' && c.name === 'checked',
    );
    expect(attrs).toHaveLength(1);
    expect(attrs[0].value).toBe('true');
  });

  it('clears checked via "false" and removeAttribute without JS style compute', () => {
    const mock = makeMockWasm();
    bindWasm(mock.wasm);
    initNaiveDocument();

    // Flush the body bootstrap frame so only the ops below are analyzed.
    flush();
    const baselineFrames = mock.frames.length;

    const doc = getNaiveDocument()!;
    const input = doc.createElement('input') as HTMLElement;
    input.setAttribute('checked', '');
    input.setAttribute('checked', 'false');
    input.removeAttribute('checked');
    flush();

    const records = decodeFrames(mock.frames.slice(baselineFrames));
    const attrs = records.filter((c) => c.kind === 'set_attr' && c.name === 'checked');
    expect(attrs.map((a) => a.value)).toEqual(['true', 'false', 'false']);
    // No style ops: the engine (stylo) owns :checked compute.
    expect(records.some((c) => c.kind === 'set_style')).toBe(false);
  });

  it('loads the author CSS and never derives checked styles in JS', async () => {
    const mock = makeMockWasm();
    bindWasm(mock.wasm);
    initNaiveDocument();

    (globalThis as unknown as Record<string, unknown>).__NAIVE_CSS =
      'input:checked { opacity: 0.5; }';
    await loadCSSClassStyles();
    flush();

    // The stylesheet arrives as an AddStylesheet frame op.
    expect(
      decodeFrames(mock.frames).some((c) => c.kind === 'add_stylesheet'),
    ).toBe(true);

    flush();
    const baselineFrames = mock.frames.length;
    const doc = getNaiveDocument()!;
    const input = doc.createElement('input') as HTMLElement;
    input.setAttribute('checked', '');
    flush();

    const records = decodeFrames(mock.frames.slice(baselineFrames));
    expect(records.some((c) => c.kind === 'set_attr' && c.name === 'checked')).toBe(true);
    expect(records.some((c) => c.kind === 'set_style')).toBe(false);
  });
});

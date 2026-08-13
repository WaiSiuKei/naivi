//! Pseudo-element behavior after the Rust migration (plan 061, U4/U6).
//!
//! The JS facade never creates pseudo nodes; author CSS with `::before` /
//! `::after` rules is queued as an `AddStylesheet` frame op, and stylo owns
//! the pseudo-element scene nodes. The facade only syncs attributes.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { bindWasm } from '../src/native-tree.js';
import { getNaiveDocument, initNaiveDocument, loadCSSClassStyles } from '../src/naive-dom.js';
import { flush } from '../src/batched-bridge.js';
import { makeMockWasm, decodeFrames } from './helpers/frame-harness.js';

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
    flush();

    const stylesheets = decodeFrames(mock.frames).filter((c) => c.kind === 'add_stylesheet');
    expect(stylesheets).toHaveLength(1);
    expect(stylesheets[0].text).toContain('::before');

    const doc = getNaiveDocument()!;
    const box = doc.createElement('div') as HTMLElement;
    box.setAttribute('class', 'box');
    flush();

    const records = decodeFrames(mock.frames);
    const el = box as unknown as {
      _pseudoElements?: Record<string, unknown>;
    };
    expect(el._pseudoElements).toBeUndefined();
    // No `::before` scene node is created by the facade.
    expect(
      records.some((c) => c.kind === 'create_element' && c.tag === '::before'),
    ).toBe(false);
    // The class attribute still syncs to the engine for matching.
    expect(records.some((c) => c.kind === 'set_attr' && c.name === 'class')).toBe(true);
  });
});

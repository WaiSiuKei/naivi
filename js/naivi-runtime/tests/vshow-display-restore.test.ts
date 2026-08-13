//! v-show display restore forwarding (plan 066, U5).
//!
//! The style stub forwards every inline style property to the engine via a
//! `set_style` frame op (kebab-case keys) — including the empty-string
//! restore from v-show, `removeProperty("display")` clears, and `visibility`
//! writes. Forwarding is batched until the next `flush()`.

import { describe, expect, it, beforeEach } from 'vitest';

import { bindWasm } from '../src/native-tree.js';
import { getNaiveDocument, initNaiveDocument } from '../src/naive-dom.js';
import type { NaiveElement } from '../src/naive-dom.js';
import { flush } from '../src/batched-bridge.js';
import { makeMockWasm, decodeFrames } from './helpers/frame-harness.js';

interface StyleCall {
  key: string;
  value: string;
}

function styleOps(frames: Uint8Array[]): StyleCall[] {
  return decodeFrames(frames)
    .filter((c) => c.kind === 'set_style')
    .map((c) => ({ key: c.name!, value: c.value! }));
}

describe('v-show display restore (plan 066)', () => {
  beforeEach(() => {
    initNaiveDocument();
  });

  function setup(): {
    mock: ReturnType<typeof makeMockWasm>;
    el: NaiveElement;
  } {
    const mock = makeMockWasm();
    bindWasm(mock.wasm);
    initNaiveDocument();
    const doc = getNaiveDocument()!;
    const el = doc.createElement('div') as unknown as NaiveElement;
    return { mock, el };
  }

  it('forwards display writes incl. the empty-string restore (Covers AE4)', () => {
    const { mock, el } = setup();

    el.style.display = 'none';
    el.style.display = '';
    flush();
    expect(styleOps(mock.frames)).toContainEqual({ key: 'display', value: 'none' });
    // v-show restore writes '' — must be forwarded (engine maps to Unset).
    expect(styleOps(mock.frames)).toContainEqual({ key: 'display', value: '' });
  });

  it('forwards removeProperty("display") as a clear (Covers AE4)', () => {
    const { mock, el } = setup();

    el.style.removeProperty('display');
    flush();
    expect(styleOps(mock.frames)).toContainEqual({ key: 'display', value: '' });
  });

  it('forwards visibility writes to the engine', () => {
    const { mock, el } = setup();

    el.style.visibility = 'hidden';
    flush();
    expect(styleOps(mock.frames)).toContainEqual({ key: 'visibility', value: 'hidden' });
  });

  it('forwards visibility empty-string and removeProperty clears', () => {
    const { mock, el } = setup();

    el.style.visibility = 'hidden';
    el.style.visibility = '';
    flush();
    expect(styleOps(mock.frames)).toContainEqual({ key: 'visibility', value: '' });

    el.style.removeProperty('visibility');
    flush();
    expect(styleOps(mock.frames)).toContainEqual({ key: 'visibility', value: '' });
  });

  it('forwards arbitrary inline style properties with kebab-case keys', () => {
    const { mock, el } = setup();

    el.style.color = 'red';
    el.style.fontSize = '16px';
    flush();
    expect(styleOps(mock.frames)).toContainEqual({ key: 'color', value: 'red' });
    expect(styleOps(mock.frames)).toContainEqual({ key: 'font-size', value: '16px' });
  });

  it('forwards writes through the live mirror after re-render churn', () => {
    // The style stub must read `el._mirror` live at call time (mirrors are
    // always writer-backed — no mock/upgrade path).
    const doc = getNaiveDocument()!;
    const el = doc.createElement('div') as unknown as NaiveElement;
    el.style.display = 'none';

    const mock = makeMockWasm();
    bindWasm(mock.wasm);
    const parent = doc.createElement('div') as unknown as NaiveElement;
    parent.appendChild(el);

    // A write after the element is wired into the tree must reach the engine
    // through the element's live mirror.
    el.style.visibility = 'hidden';
    flush();
    expect(styleOps(mock.frames)).toContainEqual({ key: 'visibility', value: 'hidden' });
  });

  it('exposes the inline store for diagnostics', () => {
    const { el } = setup();
    el.style.display = 'none';
    expect(el._styleStore?.display).toBe('none');
  });
});

//! Bubbling dispatch along the ordered bound chain (plan 076 U5 / KTD3).
//!
//! The host sends `chain` (target first, then ancestors) as a trailing event
//! callback argument; `dispatchHostEvent` walks it, halting as soon as a
//! listener calls `stopPropagation()`. Non-bubbling kinds (KD5:
//! `mouseenter`/`mouseleave`) only dispatch the chain head. New payload fields
//! (KTD2: `button`/`buttons`/`deltaX`/`deltaY`/`imeData`) ride on the event
//! object. A missing chain degrades to the legacy single-node dispatch.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getNaiveDocument, initNaiveDocument } from '../src/naive-dom.js';
import { bindWasm, registerEventCallback } from '../src/native-tree.js';
import { makeMockWasm } from './helpers/frame-harness.js';

type ElementLike = {
  _mirror: { id: number };
  addEventListener(type: string, handler: (e: unknown) => void): void;
};

describe('event bubbling along the bound chain', () => {
  beforeEach(() => {
    initNaiveDocument();
  });
  afterEach(() => {
    delete (globalThis as unknown as Record<string, unknown>).__NAIVE_CSS;
  });

  /** Nested divs (parent > child) with a fresh mock bridge + doc. */
  function makeNested() {
    const mock = makeMockWasm();
    bindWasm(mock.wasm);
    registerEventCallback();
    initNaiveDocument();
    const doc = getNaiveDocument()!;
    const parent = doc.createElement('div') as ElementLike;
    const child = doc.createElement('div') as ElementLike;
    (parent as unknown as { appendChild(c: unknown): unknown }).appendChild(child);
    return { mock, parent, child };
  }

  it('dispatches to the target and the bound ancestor, target first', () => {
    const { mock, parent, child } = makeNested();
    const childSpy = vi.fn();
    const parentSpy = vi.fn();
    child.addEventListener('click', childSpy);
    parent.addEventListener('click', parentSpy);

    // Host sends the ordered bound chain [child, parent].
    mock.fireEvent(child._mirror.id, 0, undefined, {
      chain: [child._mirror.id, parent._mirror.id],
    });

    expect(childSpy).toHaveBeenCalledTimes(1);
    expect(parentSpy).toHaveBeenCalledTimes(1);
    // Target handler ran before the ancestor handler.
    expect(childSpy.mock.invocationCallOrder[0]).toBeLessThan(
      parentSpy.mock.invocationCallOrder[0],
    );
  });

  it('stopPropagation halts the chain', () => {
    const { mock, parent, child } = makeNested();
    const childSpy = vi.fn((e: { stopPropagation(): void }) => e.stopPropagation());
    const parentSpy = vi.fn();
    child.addEventListener('click', childSpy);
    parent.addEventListener('click', parentSpy);

    mock.fireEvent(child._mirror.id, 0, undefined, {
      chain: [child._mirror.id, parent._mirror.id],
    });

    expect(childSpy).toHaveBeenCalledTimes(1);
    expect(parentSpy).not.toHaveBeenCalled();
  });

  it('non-bubbling kinds only dispatch the chain head', () => {
    const { mock, parent, child } = makeNested();
    const childSpy = vi.fn();
    const parentSpy = vi.fn();
    // kind 6 = mouseenter (KD5 non-bubbling).
    child.addEventListener('mouseenter', childSpy);
    parent.addEventListener('mouseenter', parentSpy);

    mock.fireEvent(child._mirror.id, 6, undefined, {
      chain: [child._mirror.id, parent._mirror.id],
    });

    expect(childSpy).toHaveBeenCalledTimes(1);
    expect(parentSpy).not.toHaveBeenCalled();
  });

  it('legacy single-node dispatch still works without a chain', () => {
    const { mock, parent, child } = makeNested();
    const childSpy = vi.fn();
    const parentSpy = vi.fn();
    child.addEventListener('click', childSpy);
    parent.addEventListener('click', parentSpy);

    // No chain argument → falls back to the single node.
    mock.fireEvent(child._mirror.id, 0);

    expect(childSpy).toHaveBeenCalledTimes(1);
    expect(parentSpy).not.toHaveBeenCalled();
  });

  it('skips unbound middle nodes in the chain', () => {
    const { mock, child } = makeNested();
    const childSpy = vi.fn();
    child.addEventListener('click', childSpy);

    // Chain references a node with no listeners in the middle — only the
    // bound child fires (and it is reached even when it is not chain[0]).
    mock.fireEvent(child._mirror.id, 0, undefined, {
      chain: [child._mirror.id, 999, 1000],
    });

    expect(childSpy).toHaveBeenCalledTimes(1);
  });

  it('carries the new payload fields on the event object', () => {
    const { mock, child } = makeNested();

    // Pointer event (kind 1 = pointerdown): button/buttons.
    const pointerSpy = vi.fn();
    child.addEventListener('pointerdown', pointerSpy);
    mock.fireEvent(child._mirror.id, 1, undefined, {
      button: 2,
      buttons: 3,
      chain: [child._mirror.id],
    });
    const pointerEvt = pointerSpy.mock.calls[0][0] as {
      button: number;
      buttons: number;
    };
    expect(pointerEvt.button).toBe(2);
    expect(pointerEvt.buttons).toBe(3);

    // Wheel event (kind 4): deltaX/deltaY.
    const wheelSpy = vi.fn();
    child.addEventListener('wheel', wheelSpy);
    mock.fireEvent(child._mirror.id, 4, undefined, {
      deltaX: 12.5,
      deltaY: -3,
      chain: [child._mirror.id],
    });
    const wheelEvt = wheelSpy.mock.calls[0][0] as { deltaX: number; deltaY: number };
    expect(wheelEvt.deltaX).toBe(12.5);
    expect(wheelEvt.deltaY).toBe(-3);

    // IME composition (kind 28): imeData.
    const imeSpy = vi.fn();
    child.addEventListener('composition', imeSpy);
    mock.fireEvent(child._mirror.id, 28, undefined, {
      imeData: 'hello',
      chain: [child._mirror.id],
    });
    const imeEvt = imeSpy.mock.calls[0][0] as { imeData: string };
    expect(imeEvt.imeData).toBe('hello');

    // Missing fields default to 0 / ''.
    const plainSpy = vi.fn();
    child.addEventListener('click', plainSpy);
    mock.fireEvent(child._mirror.id, 0, undefined, { chain: [child._mirror.id] });
    const plainEvt = plainSpy.mock.calls[0][0] as {
      button: number;
      deltaX: number;
      imeData: string;
    };
    expect(plainEvt.button).toBe(0);
    expect(plainEvt.deltaX).toBe(0);
    expect(plainEvt.imeData).toBe('');
  });

  it('synthesizes change only at the chain head on a checkbox', () => {
    const mock = makeMockWasm();
    bindWasm(mock.wasm);
    registerEventCallback();
    initNaiveDocument();
    const doc = getNaiveDocument()!;
    const cb = doc.createElement('input') as ElementLike & {
      setAttribute(name: string, value: string): void;
    };
    cb.setAttribute('type', 'checkbox');
    const changeSpy = vi.fn();
    cb.addEventListener('change', changeSpy);

    // kind 11 = input; the chain head is the checkbox itself — change is
    // synthesized exactly once.
    mock.fireEvent(cb._mirror.id, 11, 'true', { chain: [cb._mirror.id] });

    expect(changeSpy).toHaveBeenCalledTimes(1);
    const evt = changeSpy.mock.calls[0][0] as { type: string };
    expect(evt.type).toBe('change');
  });
});

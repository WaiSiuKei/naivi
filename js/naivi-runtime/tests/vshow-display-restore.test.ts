//! v-show display restore forwarding (plan 066, U4/U6).
//!
//! The style stub forwards every inline style property to the engine via the
//! direct protocol (`set_style`, kebab-case keys) — including the empty-string
//! restore from v-show, `removeProperty("display")` clears, and `visibility`
//! writes — and exposes the inline store so the pre-WASM upgrade path can
//! forward it. Forwarding is synchronous (no apply_ops batch anymore).

import { describe, expect, it, beforeEach } from 'vitest';

import { bindWasm } from '../src/native-tree.js';
import { getNaiveDocument, initNaiveDocument } from '../src/naive-dom.js';
import type { NaiveElement } from '../src/naive-dom.js';
import type { WasmExports } from '../src/wasm-types.js';

interface StyleCall {
  key: string;
  value: string;
}

function makeMockWasm(): {
  wasm: WasmExports;
  styles: () => StyleCall[];
} {
  let next = 1n;
  const styles: StyleCall[] = [];
  const wasm: WasmExports = {
    create_element: () => next++,
    create_text_node: () => next++,
    set_text: () => {},
    set_attr: () => {},
    set_style: (_n: bigint, key: string, value: string) => {
      styles.push({ key, value });
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
  return { wasm, styles: () => styles };
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
    expect(mock.styles()).toContainEqual({ key: 'display', value: 'none' });

    // v-show restore writes '' — must be forwarded (engine maps to Unset).
    el.style.display = '';
    expect(mock.styles()).toContainEqual({ key: 'display', value: '' });
  });

  it('forwards removeProperty("display") as a clear (Covers AE4)', () => {
    const { mock, el } = setup();

    el.style.removeProperty('display');
    expect(mock.styles()).toContainEqual({ key: 'display', value: '' });
  });

  it('forwards visibility writes to the engine', () => {
    const { mock, el } = setup();

    el.style.visibility = 'hidden';
    expect(mock.styles()).toContainEqual({ key: 'visibility', value: 'hidden' });
  });

  it('forwards visibility empty-string and removeProperty clears', () => {
    const { mock, el } = setup();

    el.style.visibility = 'hidden';
    el.style.visibility = '';
    expect(mock.styles()).toContainEqual({ key: 'visibility', value: '' });

    el.style.removeProperty('visibility');
    expect(mock.styles()).toContainEqual({ key: 'visibility', value: '' });
  });

  it('forwards arbitrary inline style properties with kebab-case keys', () => {
    const { mock, el } = setup();

    el.style.color = 'red';
    el.style.fontSize = '16px';
    expect(mock.styles()).toContainEqual({ key: 'color', value: 'red' });
    expect(mock.styles()).toContainEqual({ key: 'font-size', value: '16px' });
  });

  it('forwards post-upgrade writes through the live mirror', () => {
    // Adv5: the style stub must read `el._mirror` live at call time. Build an
    // element pre-WASM (mock mirror), bind WASM, then upgrade via appendChild
    // — a write after the upgrade must reach the engine through the swapped
    // mirror, not the stale pre-upgrade mock.
    initNaiveDocument();
    const doc = getNaiveDocument()!;
    const el = doc.createElement('div') as unknown as NaiveElement;
    el.style.display = 'none'; // pre-WASM: stored client-side only
    expect(el._styleStore?.display).toBe('none');

    const mock = makeMockWasm();
    bindWasm(mock.wasm);
    const parent = doc.createElement('div') as unknown as NaiveElement;
    parent.appendChild(el); // triggers upgradeSubtreeToWasm(el)

    // Post-upgrade write must be forwarded via the live (upgraded) mirror.
    el.style.visibility = 'hidden';
    expect(mock.styles()).toContainEqual({ key: 'visibility', value: 'hidden' });
  });

  it('exposes the inline store for the pre-WASM upgrade path', () => {
    const { el } = setup();
    el.style.display = 'none';
    expect(el._styleStore?.display).toBe('none');
  });
});

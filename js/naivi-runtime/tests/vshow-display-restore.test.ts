//! v-show display restore forwarding (plan 066, U4).
//!
//! The style stub must forward `display` writes (including the empty-string
//! clear), `removeProperty("display")` clears, and `visibility` writes to the
//! engine; and must expose the inline store so the pre-WASM upgrade path can
//! forward it. Forwarding goes through the batched FFI bridge (`styleId`
//! ops flushed via `apply_ops` at the microtask boundary).

import { describe, expect, it, beforeEach } from 'vitest';

import { bindWasm } from '../src/native-tree.js';
import { getNaiveDocument, initNaiveDocument } from '../src/naive-dom.js';
import type { NaiveElement } from '../src/naive-dom.js';
import type { WasmExports } from '../src/wasm-types.js';

type Op = Record<string, unknown>;

function makeMockWasm(): {
  wasm: WasmExports;
  ops: () => Op[];
} {
  let next = 1n;
  let opsLog: Op[] = [];
  const wasm: WasmExports = {
    create_element: () => next++,
    set_style: () => {},
    set_rule_table: () => true,
    set_text: () => {},
    append_child: () => {},
    remove_node: () => {},
    apply_ops: (json) => {
      opsLog = JSON.parse(json);
      const mapping: Record<string, number> = {};
      for (const op of opsLog) {
        if (op.type === 'create') mapping[op.reference as string] = Number(next++);
      }
      return JSON.stringify(mapping);
    },
    apply_conditional_styles: () => false,
    set_placeholder_measures: () => false,
    clear_placeholder_measures: () => false,
    get_layout_rect: () => 'null',
    compute_layout: () => '{}',
    add_event_listener: () => 0n,
    remove_event_listener: () => {},
    handle_event: () => {},
  };
  return { wasm, ops: () => opsLog };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function styleOps(log: Op[]): Op[] {
  return log.filter(
    (op) => op.type === 'styleId' || op.type === 'style',
  );
}

describe('v-show display restore (plan 066)', () => {
  beforeEach(() => {
    initNaiveDocument();
  });

  async function setup(): Promise<{
    mock: ReturnType<typeof makeMockWasm>;
    el: NaiveElement;
  }> {
    const mock = makeMockWasm();
    bindWasm(mock.wasm);
    initNaiveDocument();
    const doc = getNaiveDocument()!;
    const el = doc.createElement('div') as unknown as NaiveElement;
    await flushMicrotasks();
    mock.ops().length = 0; // clear bootstrap noise
    return { mock, el };
  }

  it('forwards display writes incl. the empty-string restore (Covers AE4)', async () => {
    const { mock, el } = await setup();

    el.style.display = 'none';
    await flushMicrotasks();
    expect(styleOps(mock.ops())).toContainEqual(
      expect.objectContaining({ key: 'display', value: 'none' }),
    );

    // v-show restore writes '' — must be forwarded (engine maps to Unset).
    mock.ops().length = 0;
    el.style.display = '';
    await flushMicrotasks();
    expect(styleOps(mock.ops())).toContainEqual(
      expect.objectContaining({ key: 'display', value: '' }),
    );
  });

  it('forwards removeProperty("display") as a clear (Covers AE4)', async () => {
    const { mock, el } = await setup();

    el.style.removeProperty('display');
    await flushMicrotasks();
    expect(styleOps(mock.ops())).toContainEqual(
      expect.objectContaining({ key: 'display', value: '' }),
    );
  });

  it('forwards visibility writes to the engine', async () => {
    const { mock, el } = await setup();

    el.style.visibility = 'hidden';
    await flushMicrotasks();
    expect(styleOps(mock.ops())).toContainEqual(
      expect.objectContaining({ key: 'visibility', value: 'hidden' }),
    );
  });

  it('forwards visibility empty-string and removeProperty clears', async () => {
    const { mock, el } = await setup();

    el.style.visibility = 'hidden';
    el.style.visibility = '';
    await flushMicrotasks();
    expect(styleOps(mock.ops())).toContainEqual(
      expect.objectContaining({ key: 'visibility', value: '' }),
    );

    mock.ops().length = 0;
    el.style.removeProperty('visibility');
    await flushMicrotasks();
    expect(styleOps(mock.ops())).toContainEqual(
      expect.objectContaining({ key: 'visibility', value: '' }),
    );
  });

  it('does not forward non-forwarded style properties', async () => {
    const { mock, el } = await setup();

    el.style.color = 'red';
    el.style.fontSize = '16px';
    await flushMicrotasks();
    // Only display/visibility cross the FFI bridge (memory pressure guard).
    expect(styleOps(mock.ops())).toHaveLength(0);
  });

  it('forwards post-upgrade writes through the live mirror', async () => {
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
    await flushMicrotasks();
    mock.ops().length = 0; // clear upgrade-time forwards

    // Post-upgrade write must be forwarded via the live (upgraded) mirror.
    el.style.visibility = 'hidden';
    await flushMicrotasks();
    expect(styleOps(mock.ops())).toContainEqual(
      expect.objectContaining({ key: 'visibility', value: 'hidden' }),
    );
  });

  it('exposes the inline store for the pre-WASM upgrade path', async () => {
    const { el } = await setup();
    el.style.display = 'none';
    expect(el._styleStore?.display).toBe('none');
  });
});

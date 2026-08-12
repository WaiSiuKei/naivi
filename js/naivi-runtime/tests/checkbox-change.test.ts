//! Checkbox `change` translation (synthesized from the engine's `input` event).
//!
//! blitz has no `change` DOM event: toggling a checkbox fires an `input` event
//! whose `value` is the new checked state ("true"/"false"). The dispatcher
//! translates that into a `change` event (browser semantics) so Vue `v-model`
//! / `@change` handlers fire, with `event.target.checked` reading the synced
//! state. `change` listeners register in the JS registry but never bind a host
//! event kind.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import { bindWasm, registerEventCallback } from '../src/native-tree.js';
import {
  getNaiveDocument,
  initNaiveDocument,
} from '../src/naive-dom.js';
import type { WasmExports } from '../src/wasm-types.js';

type EventCb = (
  nodeId: number,
  kind: number,
  x: number,
  y: number,
  key?: string,
  code?: string,
  value?: string,
) => void;

function makeMockWasm(): {
  wasm: WasmExports;
  fireEvent: (nodeId: bigint, kind: number, value?: string) => void;
} {
  let next = 1n;
  let eventCb: EventCb | null = null;
  const wasm: WasmExports = {
    create_element: () => next++,
    create_text_node: () => next++,
    set_text: () => {},
    set_attr: () => {},
    set_style: () => {},
    append_child: () => {},
    attach_document_root: () => {},
    insert_before: () => {},
    insert_after: () => {},
    replace_node: () => {},
    remove_node: () => {},
    bind_event: () => 1n,
    unbind_event: () => {},
    set_event_callback: (cb) => {
      eventCb = cb as EventCb;
    },
    tick: () => {},
    add_stylesheet: () => {},
    set_placeholder_measures: () => false,
    clear_placeholder_measures: () => false,
  };
  return {
    wasm,
    fireEvent: (nodeId, kind, value) =>
      eventCb?.(Number(nodeId), kind, 0, 0, '', '', value),
  };
}

describe('checkbox change translation', () => {
  beforeEach(() => {
    initNaiveDocument();
  });
  afterEach(() => {
    delete (globalThis as unknown as Record<string, unknown>).__NAIVE_CSS;
  });

  it('synthesizes a change event from the engine input event on a checkbox', () => {
    const mock = makeMockWasm();
    bindWasm(mock.wasm);
    registerEventCallback();
    initNaiveDocument();

    const doc = getNaiveDocument()!;
    const cb = doc.createElement('input') as {
      _mirror: { wasmId: bigint };
      setAttribute(name: string, value: string): void;
      addEventListener(type: string, handler: (e: unknown) => void): void;
    };
    cb.setAttribute('type', 'checkbox');
    const nodeId = cb._mirror.wasmId;

    const changeSpy = vi.fn();
    cb.addEventListener('change', changeSpy);

    // Engine reports the toggle as an `input` event (kind 11) with the new
    // checked state; the dispatcher must fire the `change` listeners.
    mock.fireEvent(nodeId, 11, 'true');

    expect(changeSpy).toHaveBeenCalledTimes(1);
    const evt = changeSpy.mock.calls[0][0] as {
      type: string;
      target: { checked: boolean };
    };
    expect(evt.type).toBe('change');
    expect(evt.target.checked).toBe(true);
  });

  it('does not synthesize change for a text input', () => {
    const mock = makeMockWasm();
    bindWasm(mock.wasm);
    registerEventCallback();
    initNaiveDocument();

    const doc = getNaiveDocument()!;
    const input = doc.createElement('input') as {
      _mirror: { wasmId: bigint };
      addEventListener(type: string, handler: (e: unknown) => void): void;
    };
    const nodeId = input._mirror.wasmId;

    const changeSpy = vi.fn();
    input.addEventListener('change', changeSpy);

    // A text input's `input` event carries the editor text — no change event.
    mock.fireEvent(nodeId, 11, 'hello');

    expect(changeSpy).not.toHaveBeenCalled();
  });
});

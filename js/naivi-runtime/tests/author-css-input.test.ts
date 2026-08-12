//! Author CSS (U6 AOT CSS text) → stylo input tests.
//!
//! The CLI compiles SFC `<style>` blocks and project CSS to plain CSS text,
//! delivered as `globalThis.__NAIVE_CSS`. `loadCSSClassStyles` injects that
//! text into stylo via `add_stylesheet` (a stylo author stylesheet) — there
//! is no rule-table JSON anymore (the old plan 060 protocol is removed).

import { afterEach, describe, expect, it } from 'vitest';

import { bindWasm } from '../src/native-tree.js';
import { loadCSSClassStyles } from '../src/naive-dom.js';
import type { WasmExports } from '../src/wasm-types.js';

function makeMockWasm(record: { cssCalls: string[] }): WasmExports {
  return {
    create_element: () => 1n,
    create_text_node: (text: string) => {
      void text;
      return 1n;
    },
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
    set_event_callback: () => {},
    tick: () => {},
    add_stylesheet: (css: string) => {
      record.cssCalls.push(css);
    },
    set_placeholder_measures: () => false,
    clear_placeholder_measures: () => false,
  };
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__NAIVE_CSS;
});

describe('author CSS input (U6)', () => {
  it('passes the CSS text to stylo via add_stylesheet once when present', async () => {
    const record = { cssCalls: [] as string[] };
    bindWasm(makeMockWasm(record));
    const css = '.x { color: #ff0000; }\nbutton:hover { background: #1d4ed8; }';
    (globalThis as Record<string, unknown>).__NAIVE_CSS = css;

    await loadCSSClassStyles();

    expect(record.cssCalls).toHaveLength(1);
    expect(record.cssCalls[0]).toBe(css);
  });

  it('does not call add_stylesheet when the CSS is empty or absent', async () => {
    const record = { cssCalls: [] as string[] };
    bindWasm(makeMockWasm(record));
    (globalThis as Record<string, unknown>).__NAIVE_CSS = '   ';

    await loadCSSClassStyles();

    expect(record.cssCalls).toHaveLength(0);

    delete (globalThis as Record<string, unknown>).__NAIVE_CSS;
    await loadCSSClassStyles();
    expect(record.cssCalls).toHaveLength(0);
  });
});

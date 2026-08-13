//! Author CSS (U6 AOT CSS text) → stylo input tests.
//!
//! The CLI compiles SFC `<style>` blocks and project CSS to plain CSS text,
//! delivered as `globalThis.__NAIVE_CSS`. `loadCSSClassStyles` queues that
//! text as an `AddStylesheet` frame op (a stylo author stylesheet) — there is
//! no rule-table JSON anymore (the old plan 060 protocol is removed).

import { afterEach, describe, expect, it } from 'vitest';

import { bindWasm } from '../src/native-tree.js';
import { loadCSSClassStyles } from '../src/naive-dom.js';
import { flush } from '../src/batched-bridge.js';
import { makeMockWasm, decodeFrames } from './helpers/frame-harness.js';

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__NAIVE_CSS;
});

describe('author CSS input (U6)', () => {
  it('passes the CSS text to stylo via an AddStylesheet op once when present', async () => {
    const mock = makeMockWasm();
    bindWasm(mock.wasm);
    const css = '.x { color: #ff0000; }\nbutton:hover { background: #1d4ed8; }';
    (globalThis as Record<string, unknown>).__NAIVE_CSS = css;

    await loadCSSClassStyles();
    flush();

    const stylesheets = decodeFrames(mock.frames).filter((c) => c.kind === 'add_stylesheet');
    expect(stylesheets).toHaveLength(1);
    expect(stylesheets[0].text).toBe(css);
  });

  it('does not queue an AddStylesheet op when the CSS is empty or absent', async () => {
    const mock = makeMockWasm();
    bindWasm(mock.wasm);
    (globalThis as Record<string, unknown>).__NAIVE_CSS = '   ';

    await loadCSSClassStyles();
    flush();

    expect(decodeFrames(mock.frames).some((c) => c.kind === 'add_stylesheet')).toBe(false);

    delete (globalThis as Record<string, unknown>).__NAIVE_CSS;
    await loadCSSClassStyles();
    flush();
    expect(decodeFrames(mock.frames).some((c) => c.kind === 'add_stylesheet')).toBe(false);
  });
});

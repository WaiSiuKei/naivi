// Placeholder-text tests (plan 040, U2): measureText approximation, line-height
// ratio, and pending-awareness scoping of the batch FFI write.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  LINE_HEIGHT_RATIO,
  measureText,
  setFontsPending,
  setTextMeasurer,
  writePlaceholdersForPending,
  isFontsPending,
  installFontsPendingHook,
} from '../src/placeholder-text.js';
import type { WasmExports } from '../src/wasm-types.js';

function mockWasm(): {
  wasm: WasmExports;
  calls: Array<{ node: number; width: number; lineHeight: number }>;
} {
  const calls: Array<{ node: number; width: number; lineHeight: number }> = [];
  const base: WasmExports = {
    create_element: () => 0n,
    set_style: () => {},
    set_rule_table: () => true,
    set_text: () => {},
    append_child: () => {},
    remove_node: () => {},
    apply_ops: () => '{}',
    apply_conditional_styles: () => false,
    set_placeholder_measures: (opsJson: string) => {
      const ops = JSON.parse(opsJson) as Array<{
        node: number;
        width: number;
        lineHeight: number;
      }>;
      calls.push(...ops);
      return ops.length > 0;
    },
    clear_placeholder_measures: () => true,
    get_layout_rect: () => 'null',
    compute_layout: () => '',
    add_event_listener: () => 0n,
    remove_event_listener: () => {},
    handle_event: () => {},
  };
  return { wasm: base, calls };
}

describe('measureText', () => {
  beforeEach(() => {
    setTextMeasurer(null);
    setFontsPending(false);
  });

  it('returns a non-zero width from the measurer and ratio-based line height', () => {
    setTextMeasurer((text, fontSize, weight) => {
      expect(fontSize).toBe(16);
      expect(weight).toBe(700);
      return { width: text.length * 8 };
    });
    const size = measureText('Click Me', 16, 700);
    expect(size.width).toBeGreaterThan(0);
    expect(size.lineHeight).toBeCloseTo(16 * LINE_HEIGHT_RATIO);
  });

  it('approximates line height from font size', () => {
    setTextMeasurer(() => ({ width: 10 }));
    const size = measureText('x', 20);
    expect(size.lineHeight).toBeCloseTo(20 * LINE_HEIGHT_RATIO);
  });
});

describe('pending-awareness scoping', () => {
  beforeEach(() => {
    setTextMeasurer(() => ({ width: 42 }));
    setFontsPending(false);
  });

  it('writes no placeholders while fonts are not pending', () => {
    const { wasm, calls } = mockWasm();
    const n = writePlaceholdersForPending(wasm, [
      { wasmId: 7n, text: 'hello', fontSize: 16 },
    ]);
    expect(n).toBe(0);
    expect(calls).toHaveLength(0);
    expect(isFontsPending()).toBe(false);
  });

  it('writes a placeholder batch only for pending text nodes', () => {
    const { wasm, calls } = mockWasm();
    setFontsPending(true);
    const n = writePlaceholdersForPending(wasm, [
      { wasmId: 7n, text: 'Click Me', fontSize: 16, fontWeight: 400 },
      { wasmId: 8n, text: '', fontSize: 16 },
      { wasmId: 9n }, // no text content → skipped
    ]);
    expect(n).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ node: 7, width: 42, lineHeight: 16 * LINE_HEIGHT_RATIO });
  });

  it('stops writing once pending clears', () => {
    const { wasm, calls } = mockWasm();
    setFontsPending(true);
    writePlaceholdersForPending(wasm, [{ wasmId: 1n, text: 'a' }]);
    setFontsPending(false);
    writePlaceholdersForPending(wasm, [{ wasmId: 2n, text: 'b' }]);
    expect(calls).toHaveLength(1);
  });
});

describe('installFontsPendingHook', () => {
  beforeEach(() => {
    setFontsPending(false);
    delete (globalThis as Record<string, unknown>).__naiveSetFontsPending;
  });

  it('installs a global hook that flips pending and clears on trailing edge', () => {
    let clears = 0;
    installFontsPendingHook(() => {
      clears += 1;
    });
    const hook = (globalThis as Record<string, unknown>)
      .__naiveSetFontsPending as (pending: boolean) => void;
    expect(typeof hook).toBe('function');

    hook(true);
    expect(isFontsPending()).toBe(true);
    expect(clears).toBe(0);

    // Trailing edge (font loader settle — success or failure) clears.
    hook(false);
    expect(isFontsPending()).toBe(false);
    expect(clears).toBe(1);

    // No spurious clear on the leading edge.
    hook(true);
    expect(clears).toBe(1);
  });
});

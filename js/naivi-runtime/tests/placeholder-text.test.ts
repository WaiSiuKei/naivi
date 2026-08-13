// Placeholder-text tests (plan 040, U2): measureText approximation, line-height
// ratio, and pending-awareness scoping. U5 removed the placeholder-measure
// FFI — `writePlaceholdersForPending` is a no-op that returns 0.

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
import { makeMockWasm } from './helpers/frame-harness.js';

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

  it('writes no placeholders (U5 no-op API)', () => {
    const { wasm, frames } = makeMockWasm();
    setFontsPending(true);
    const n = writePlaceholdersForPending(wasm, [
      { wasmId: 7n, text: 'hello', fontSize: 16 },
      { wasmId: 8n, text: '', fontSize: 16 },
      { wasmId: 9n }, // no text content → skipped
    ]);
    expect(n).toBe(0);
    // The U5 host resolves fonts in Rust — no placeholder FFI is ever called,
    // and no frame is flushed from this API.
    expect(frames).toHaveLength(0);
  });

  it('is pending-aware in its global state, independent of the no-op write', () => {
    const { wasm } = makeMockWasm();
    expect(isFontsPending()).toBe(false);
    setFontsPending(true);
    expect(writePlaceholdersForPending(wasm, [{ wasmId: 1n, text: 'a' }])).toBe(0);
    expect(isFontsPending()).toBe(true);
    setFontsPending(false);
    expect(writePlaceholdersForPending(wasm, [{ wasmId: 2n, text: 'b' }])).toBe(0);
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

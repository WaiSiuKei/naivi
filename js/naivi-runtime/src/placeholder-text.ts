// Placeholder measurement for text whose target font slice is still pending
// (plan 040, U2).
//
// While the Rust host loads a font, JS approximates each text node's size with
// the DOM `measureText` API (system font stack) and writes it into the Rust
// placeholder-measure layer via `set_placeholder_measures`. The placeholder
// keeps layout stable and non-zero during loading; the font-state lifecycle
// (plan 040, U1) clears it and converges to real measurement.
//
// The measurer is injectable so the browser-free vitest environment can stub
// `measureText`; in the browser the default implementation uses a canvas 2D
// context with the system font stack.

import type { WasmExports } from './wasm-types.js';

/** Approximate width + line height for a placeholder (logical px). */
export interface PlaceholderSize {
  width: number;
  lineHeight: number;
}

/** System font stack used to approximate the target webfont (KTD1). */
export const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/** Line height has no `measureText` value; approximate as fontSize * ratio. */
export const LINE_HEIGHT_RATIO = 1.2;

/** Extracted `measureText` strategy, injectable for tests. */
export type TextMeasurer = (
  text: string,
  fontSize: number,
  weight: number,
) => { width: number };

let measurer: TextMeasurer | null = null;

/** Override the measurer (vitest) or restore the default with `null`. */
export function setTextMeasurer(fn: TextMeasurer | null): void {
  measurer = fn;
}

/**
 * Measure a text's approximate width with the system font stack, and derive a
 * line height from the font size.
 */
export function measureText(
  text: string,
  fontSize: number,
  weight = 400,
): PlaceholderSize {
  const lineHeight = fontSize * LINE_HEIGHT_RATIO;
  if (measurer) {
    return { width: measurer(text, fontSize, weight).width, lineHeight };
  }
  const width = measureWithCanvas(text, fontSize, weight);
  return { width, lineHeight };
}

function measureWithCanvas(text: string, fontSize: number, weight: number): number {
  if (typeof document === 'undefined') {
    return 0;
  }
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return 0;
  }
  ctx.font = `${weight} ${fontSize}px ${FONT_STACK}`;
  return ctx.measureText(text).width;
}

// ── Pending-awareness registry ──────────────────────────────────────

let fontsPending = false;

/** Mark the app's target font slices as loading (pending). */
export function setFontsPending(pending: boolean): void {
  fontsPending = pending;
}

/** Whether target font slices are currently pending. */
export function isFontsPending(): boolean {
  return fontsPending;
}

/** A text node known to the guest mirror, addressable by its Core id. */
export interface PendingTextNode {
  wasmId: bigint;
  text?: string;
  fontSize?: number;
  fontWeight?: number;
}

/**
 * Write placeholders for every pending text node, but only while fonts are
 * pending (R1 — placeholder is scoped to the loading window).
 *
 * Returns the number of placeholders written. Calls the batch FFI once per
 * invocation, aligned with `apply_ops`' id-addressed ops (KTD2).
 */
export function writePlaceholdersForPending(
  wasm: WasmExports,
  textNodes: readonly PendingTextNode[],
): number {
  if (!fontsPending) {
    return 0;
  }
  const ops: Array<{ node: number; width: number; lineHeight: number }> = [];
  for (const node of textNodes) {
    const text = node.text;
    if (!text) {
      continue;
    }
    const fontSize = node.fontSize ?? 16;
    const { width, lineHeight } = measureText(text, fontSize, node.fontWeight ?? 400);
    ops.push({ node: Number(node.wasmId), width, lineHeight });
  }
  if (ops.length === 0) {
    return 0;
  }
  wasm.set_placeholder_measures(JSON.stringify(ops));
  return ops.length;
}

/**
 * Install the `__naiveSetFontsPending` global hook (plan 040 review #3/#6).
 *
 * The Rust host flips this when its font loader starts (pending=true) and
 * when it settles — success or failure (pending=false). On the trailing edge
 * the caller-provided `clear` runs so placeholders never stay stuck even if
 * font loading fails (the Rust font-state lifecycle already clears them on
 * the success path, so this is a safe net in both cases).
 */
export function installFontsPendingHook(clear: () => void): void {
  (globalThis as unknown as Record<string, unknown>).__naiveSetFontsPending = (
    pending: boolean,
  ) => {
    setFontsPending(pending);
    if (!pending) {
      clear();
    }
  };
}

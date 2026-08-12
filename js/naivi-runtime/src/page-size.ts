// Plan 049 + plan 055: optional fixed page size injected by the CLI via vite `define`
// (KTD1). The injected value is an object literal `{ width, height }` or
// `null`; the runtime consumes it directly — never `JSON.parse` (vite/esbuild
// inject the expression verbatim, so `{"width":400,"height":400}` is already
// an object at runtime). `declare const` lets the identifier exist in the
// type system while remaining undefined in standalone Vite (where the CLI
// never injects it); the `typeof` guard keeps a bare reference from throwing.

declare const __NAIVE_PAGE_SIZE__: unknown;

export interface PageSize {
  width: number;
  height: number;
}

/** Where the fixed-size container is placed relative to its parent. */
export type Placement = "center" | "top-left";

/** Read the injected page size, or null when absent (plan 049 KTD1/KTD2). */
export function readPageSize(): PageSize | null {
  // Early return before touching the identifier — standalone Vite leaves it
  // undefined and a direct reference would throw ReferenceError.
  if (typeof __NAIVE_PAGE_SIZE__ === "undefined" || __NAIVE_PAGE_SIZE__ === null) {
    return null;
  }
  const size = __NAIVE_PAGE_SIZE__ as Partial<PageSize>;
  // Mirror the CLI's validation contract: both must be positive integers
  // (plan 055 R1); anything else degrades to fill mode instead of emitting
  // broken CSS like `width:NaNpx`.
  // A malformed injected value degrades to fill mode instead of emitting
  // broken CSS like `width:NaNpx`.
  if (
    typeof size.width !== "number" ||
    typeof size.height !== "number" ||
    !Number.isInteger(size.width) ||
    !Number.isInteger(size.height) ||
    size.width <= 0 ||
    size.height <= 0
  ) {
    return null;
  }
  return { width: size.width, height: size.height };
}

/**
 * Decide container placement from the fixed size versus the available
 * container (canvas for wasm, window for web). The container must fit the
 * whole fixed size to center; otherwise the content is pinned top-left with
 * no scaling (plan 055 R2/R3).
 */
export function resolvePlacement(
  size: PageSize,
  containerWidth: number,
  containerHeight: number,
): Placement {
  return containerWidth >= size.width && containerHeight >= size.height
    ? "center"
    : "top-left";
}

/**
 * Naive-tree root inline style: flex-column layout + fixed px size, or fill
 * (plan 049 KTD2). The flex layout is inline (not Tailwind classes) so the
 * mount root stacks its children vertically on every project, including
 * non-Tailwind pages whose AOT class table lacks `flex-col`/`items-center`/
 * `justify-center` (plan 058 U3 — todomvc's top-level children rendered in a
 * row because those classes were never compiled for it).
 */
const ROOT_LAYOUT =
  "display:flex;flex-direction:column;align-items:center;justify-content:center;";

export function naiveRootStyle(size: PageSize | null): string {
  return size
    ? `${ROOT_LAYOUT}width:${size.width}px;height:${size.height}px`
    : `${ROOT_LAYOUT}width:100%;height:100%`;
}

/**
 * Facade body inline style in fixed mode: a flex container that centers its
 * single child (the fixed-size root) when centered; null in top-left or fill
 * mode (body stays as-is, root flows to the top-left by default).
 */
export function naiveBodyStyle(size: PageSize | null, placement: Placement): string | null {
  return size && placement === "center"
    ? "display:flex;align-items:center;justify-content:center"
    : null;
}

/**
 * Real-DOM target inline style in fixed mode (web): when centered, absolutely
 * positioned and centered on both axes via translate; when the window is
 * smaller than the fixed size, pinned top-left with no scaling and overflow
 * hidden (plan 055 R3). Null in fill mode (target left untouched).
 */
export function webTargetStyle(size: PageSize | null, placement: Placement): string | null {
  if (!size) {
    return null;
  }
  const base = `width:${size.width}px;height:${size.height}px;overflow:hidden`;
  return placement === "center"
    ? `position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);${base}`
    : `position:absolute;left:0;top:0;${base}`;
}

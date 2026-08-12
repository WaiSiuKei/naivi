// Plan 049 page-size tests: `readPageSize` (KTD1 encoding) and the dual-mode
// root style helpers (KTD2). `readPageSize` must degrade to null in standalone
// Vite (no injected global) and consume the injected value directly — never
// `JSON.parse`, since the CLI injects an object literal via vite `define`.

import { afterEach, describe, expect, it } from 'vitest';
import {
  naiveBodyStyle,
  naiveRootStyle,
  readPageSize,
  resolvePlacement,
  webTargetStyle,
} from '../src/page-size.js';

function setInjectedSize(value: unknown): void {
  (globalThis as Record<string, unknown>).__NAIVE_PAGE_SIZE__ = value;
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__NAIVE_PAGE_SIZE__;
});

describe('readPageSize (KTD1)', () => {
  it('returns null when the global is undefined (standalone Vite)', () => {
    expect(readPageSize()).toBeNull();
  });

  it('returns null when the global is null', () => {
    setInjectedSize(null);
    expect(readPageSize()).toBeNull();
  });

  it('returns the injected object directly (no JSON.parse)', () => {
    setInjectedSize({ width: 400, height: 400 });
    expect(readPageSize()).toEqual({ width: 400, height: 400 });
  });

  it('returns null for a malformed value', () => {
    setInjectedSize({ width: 400 }); // missing height
    expect(readPageSize()).toBeNull();
  });

  it('returns null for a non-finite or non-positive size (CLI contract mirror)', () => {
    setInjectedSize({ width: NaN, height: 400 });
    expect(readPageSize()).toBeNull();
    setInjectedSize({ width: Infinity, height: 400 });
    expect(readPageSize()).toBeNull();
    setInjectedSize({ width: 400, height: -1 });
    expect(readPageSize()).toBeNull();
    setInjectedSize({ width: 0, height: 400 });
    expect(readPageSize()).toBeNull();
  });

  it('returns null for a non-integer size (plan 055 R1)', () => {
    setInjectedSize({ width: 400.5, height: 400 });
    expect(readPageSize()).toBeNull();
    setInjectedSize({ width: 400, height: 399.9 });
    expect(readPageSize()).toBeNull();
  });

  it('accepts positive integers only (plan 055 R1)', () => {
    setInjectedSize({ width: 400, height: 400 });
    expect(readPageSize()).toEqual({ width: 400, height: 400 });
  });

  it('returns null for a string-typed width (defensive shape check)', () => {
    setInjectedSize({ width: '400', height: 400 });
    expect(readPageSize()).toBeNull();
  });
});

describe('root style helpers (KTD2)', () => {
  it('naiveRootStyle: flex-column layout + fixed px size when sized, fill otherwise', () => {
    expect(naiveRootStyle({ width: 400, height: 400 })).toBe(
      'display:flex;flex-direction:column;align-items:center;justify-content:center;width:400px;height:400px',
    );
    expect(naiveRootStyle(null)).toBe(
      'display:flex;flex-direction:column;align-items:center;justify-content:center;width:100%;height:100%',
    );
  });

  it('naiveBodyStyle: flex centering when sized+centered, null for top-left/fill', () => {
    expect(naiveBodyStyle({ width: 400, height: 400 }, 'center')).toBe(
      'display:flex;align-items:center;justify-content:center',
    );
    expect(naiveBodyStyle({ width: 400, height: 400 }, 'top-left')).toBeNull();
    expect(naiveBodyStyle(null, 'center')).toBeNull();
  });

  it('webTargetStyle: transform-centered when sized+centered, top-left when pinned, null otherwise', () => {
    const style = webTargetStyle({ width: 400, height: 400 }, 'center');
    expect(style).toContain('position:absolute');
    expect(style).toContain('left:50%');
    expect(style).toContain('top:50%');
    expect(style).toContain('transform:translate(-50%,-50%)');
    expect(style).toContain('width:400px');
    expect(style).toContain('height:400px');
    expect(style).toContain('overflow:hidden');
    const topLeft = webTargetStyle({ width: 400, height: 400 }, 'top-left');
    expect(topLeft).toContain('left:0');
    expect(topLeft).toContain('top:0');
    expect(topLeft).not.toContain('translate');
    expect(webTargetStyle(null, 'center')).toBeNull();
  });
});

describe('resolvePlacement (plan 055 R2/R3)', () => {
  it('centers when the container fits the fixed size', () => {
    expect(resolvePlacement({ width: 400, height: 400 }, 900, 800)).toBe('center');
    expect(resolvePlacement({ width: 400, height: 400 }, 400, 400)).toBe('center');
  });

  it('pins top-left when the container is smaller on either axis', () => {
    expect(resolvePlacement({ width: 400, height: 400 }, 300, 300)).toBe('top-left');
    expect(resolvePlacement({ width: 400, height: 400 }, 300, 800)).toBe('top-left');
    expect(resolvePlacement({ width: 400, height: 400 }, 900, 300)).toBe('top-left');
  });
});

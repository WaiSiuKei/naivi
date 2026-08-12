// Desktop main-process API tests (plan 045, U1; plan 057, U1).
//
// Exercises `app.whenReady()` and the plan-057 `NaiveWindow` shape (`{ page }`
// constructor + `load()`, injected `__NAIVE_WINDOW_SIZE__`) against a mock
// `globalThis.__naiveMain` FFI: whenReady resolution, window sizing from the
// injected define, the 800×600 fallback, load() routing, and the
// missing-FFI/empty-page errors.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { app, NaiveWindow } from '../src/desktop-main.js';
import type { MainFfi } from '../src/desktop-main.js';

interface MockFfi extends MainFfi {
  createCalls: Array<{ width: number; height: number }>;
  loadCalls: Array<string>;
  resolveReady: () => void;
}

let mock: MockFfi;

function installMock(): void {
  let resolveReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const m: MockFfi = {
    createCalls: [],
    loadCalls: [],
    resolveReady,
    whenReady: () => ready,
    createWindow: (width, height) => {
      m.createCalls.push({ width, height });
    },
    loadFile: (path) => {
      m.loadCalls.push(path);
    },
  };
  (globalThis as unknown as Record<string, unknown>).__naiveMain = m;
  mock = m;
}

function uninstallMock(): void {
  delete (globalThis as unknown as Record<string, unknown>).__naiveMain;
  delete (globalThis as unknown as Record<string, unknown>).__NAIVE_WINDOW_SIZE__;
}

function setWindowSize(size: unknown): void {
  (globalThis as unknown as Record<string, unknown>).__NAIVE_WINDOW_SIZE__ = size;
}

describe('desktop main API', () => {
  beforeEach(() => {
    installMock();
  });
  afterEach(() => {
    uninstallMock();
  });

  it('app.whenReady() returns the host promise and resolves with it', async () => {
    const readyPromise = app.whenReady();
    mock.resolveReady();
    await expect(readyPromise).resolves.toBeUndefined();
  });

  it('NaiveWindow({ page }) sizes the window from the injected define', () => {
    setWindowSize({ width: 400, height: 400 });
    const win = new NaiveWindow({ page: 'index.html' });
    expect(win.page).toBe('index.html');
    expect(win.width).toBe(400);
    expect(win.height).toBe(400);
    expect(mock.createCalls).toEqual([{ width: 400, height: 400 }]);
  });

  it('falls back to 800x600 when the injected size is absent', () => {
    const win = new NaiveWindow({ page: 'index.html' });
    expect(win.width).toBe(800);
    expect(win.height).toBe(600);
    expect(mock.createCalls).toEqual([{ width: 800, height: 600 }]);
  });

  it('falls back to 800x600 when the injected size is malformed', () => {
    setWindowSize({ width: 'x', height: 0 });
    const win = new NaiveWindow({ page: 'index.html' });
    expect(win.width).toBe(800);
    expect(win.height).toBe(600);
    expect(mock.createCalls).toEqual([{ width: 800, height: 600 }]);
  });

  it('load() routes the constructor page to FFI.loadFile', () => {
    setWindowSize({ width: 400, height: 400 });
    const win = new NaiveWindow({ page: 'index.html' });
    win.load();
    expect(mock.loadCalls).toEqual(['index.html']);
  });

  it('throws a descriptive error when page is missing or empty', () => {
    // @ts-expect-error page is intentionally missing
    expect(() => new NaiveWindow({})).toThrow(/page/);
    expect(() => new NaiveWindow({ page: '  ' })).toThrow(/page/);
  });

  it('throws a descriptive error when the main FFI is not injected', () => {
    uninstallMock();
    expect(() => app.whenReady()).toThrow(/__naiveMain FFI not injected/);
    expect(() => new NaiveWindow({ page: 'index.html' })).toThrow(
      /__naiveMain FFI not injected/,
    );
  });
});

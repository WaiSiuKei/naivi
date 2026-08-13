// Browser entry for the wasm host E2E page: exposes loadIR on `window`.

import { loadIR } from './ir-loader.js';

(globalThis as Record<string, unknown>).__naiveLoadIR = (
  output: unknown,
): unknown => loadIR(output as Parameters<typeof loadIR>[0]);

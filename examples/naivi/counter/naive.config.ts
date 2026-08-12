// naivi counter demo config (U4) — mirrors the hello demo: a `pages` entry
// with the index.html page, fill mode (no fixed width/height), and the vue
// plugin. The config-file name stays `naive.config.ts` so `loadNaiveConfig`
// keeps discovering it unchanged.
//
// WASM-mode note: `mount()` detects wasm mode by reading
// `globalThis.__NAIVE_MODE` at runtime (see index-vue-vapor.ts), so a
// compile-time `define: { __NAIVE_MODE: '"wasm"' }` is NOT the mechanism.
// Instead the cli's `naivi wasm --release` emits a wrapper `guest.js` that
// sets `globalThis.__NAIVE_MODE = "wasm"` before importing the Vite-built
// bundle (see js/naivi-cli/src/cli.ts `buildWasmSite`).
import { fileURLToPath } from 'node:url';
import { defineNaiveConfig, defineViteConfig } from '@naivi/cli';
import vue from '@vitejs/plugin-vue';

const demoRoot = fileURLToPath(new URL('.', import.meta.url));
const jsToolchain = fileURLToPath(new URL('../../../js', import.meta.url));

export default defineNaiveConfig({
  name: 'Naivi Counter',
  pages: [
    {
      entry: 'index.html',
      vite: defineViteConfig({
        base: './',
        plugins: [vue()],
        // Keep the runtime's `@vite-ignore`'d wasm import unresolved in web
        // mode (see hello demo for details).
        optimizeDeps: {
          exclude: ['@naivi/runtime'],
        },
        server: {
          fs: {
            allow: [demoRoot, jsToolchain],
          },
        },
      }),
    },
  ],
});

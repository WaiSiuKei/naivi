// naivi counter demo config — mirrors the hello demo: a `pages` entry with
// the index.html page, fill mode (no fixed width/height), and the vue
// plugin. The config-file name stays `naive.config.ts` so `loadNaiveConfig`
// keeps discovering it unchanged.
//
// The CLI owns the naivi-managed vite defaults — `optimizeDeps.exclude` for
// the runtime's `@vite-ignore`'d wasm import, and `server.fs.allow` for the
// js/ toolchain sources — so the demo only declares its own plugins/base
// (see js/naivi-cli/src/vite-config.ts `applyNaiviServerDefaults`).
//
// WASM-mode note: `mount()` detects wasm mode by reading
// `globalThis.__NAIVE_MODE` at runtime (see index-vue-vapor.ts), so a
// compile-time `define: { __NAIVE_MODE: '"wasm"' }` is NOT the mechanism.
// Instead the cli's `naivi wasm --release` emits a wrapper `guest.js` that
// sets `globalThis.__NAIVE_MODE = "wasm"` before importing the Vite-built
// bundle (see js/naivi-cli/src/cli.ts `buildWasmSite`).
import { defineNaiveConfig, defineViteConfig } from '@naivi/cli';
import vue from '@vitejs/plugin-vue';

export default defineNaiveConfig({
  name: 'Naivi Counter',
  pages: [
    {
      entry: 'index.html',
      vite: defineViteConfig({
        base: './',
        plugins: [vue()],
      }),
    },
  ],
});

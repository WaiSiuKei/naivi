// naivi demo config (U2) — mirrors the naive todomvc demo shape: a `pages`
// entry with the index.html page, fill mode (no fixed width/height), and a
// page `vite` config declaring the vue plugin. The config-file name stays
// `naive.config.ts` so `loadNaiveConfig` keeps discovering it unchanged.
import { fileURLToPath } from 'node:url';
import { defineNaiveConfig, defineViteConfig } from '@naivi/cli';
import vue from '@vitejs/plugin-vue';

// The naivi JS toolchain lives in the sibling `js/` pnpm workspace, outside
// the demo's own workspace root. Vite's dev-server fs sandbox blocks serving
// files outside the workspace root, so the symlinked `@naivi/runtime` sources
// must be allow-listed here (`resolveWebViteConfig` now preserves the page's
// `server` options, merging only the CLI-forced port). Setting `server.fs.allow`
// replaces Vite's default list, so the demo root itself is listed alongside
// the toolchain dir.
const demoRoot = fileURLToPath(new URL('.', import.meta.url));
const jsToolchain = fileURLToPath(new URL('../../../js', import.meta.url));

export default defineNaiveConfig({
  name: 'Naivi Hello',
  pages: [
    {
      entry: 'index.html',
      vite: defineViteConfig({
        base: './',
        plugins: [vue()],
        // The runtime's wasm import is intentionally `@vite-ignore`'d and must
        // stay unresolved in web mode. Exclude it from Vite's dependency
        // prebundling so it is served as source (the variable + @vite-ignore
        // form) instead of being statically resolved during optimizeDeps.
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

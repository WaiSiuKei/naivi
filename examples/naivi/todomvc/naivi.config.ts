// naivi todomvc demo config — mirrors the counter demo: a `pages` entry with
// the index.html page, fill mode (no fixed width/height), and the vue +
// tailwind plugins. The config-file name is `naivi.config.ts`, discovered
// by `loadNaiveConfig`.
//
// The CLI owns the naivi-managed vite defaults — `optimizeDeps.exclude` for
// the runtime's `@vite-ignore`'d wasm import, and `server.fs.allow` for the
// js/ toolchain sources — so the demo only declares its own plugins/base
// (see js/naivi-cli/src/vite-config.ts `applyNaiviServerDefaults`).
import { defineNaiveConfig, defineViteConfig } from '@naivi/cli';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';

export default defineNaiveConfig({
  name: 'Naivi TodoMVC',
  main: 'app/main.ts',
  pages: [
    {
      entry: 'index.html',
      vite: defineViteConfig({
        base: './',
        plugins: [vue(), tailwindcss()],
      }),
    },
  ],
});

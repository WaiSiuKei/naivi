// naivi todomvc demo config — mirrors the counter demo: a `pages` entry with
// the index.html page, fill mode (no fixed width/height), and the vue plugin.
// The config-file name stays `naive.config.ts` so `loadNaiveConfig` keeps
// discovering it unchanged.
import { fileURLToPath } from 'node:url';
import { defineNaiveConfig, defineViteConfig } from '@naivi/cli';
import vue from '@vitejs/plugin-vue';

const demoRoot = fileURLToPath(new URL('.', import.meta.url));
const jsToolchain = fileURLToPath(new URL('../../../js', import.meta.url));

export default defineNaiveConfig({
  name: 'Naivi TodoMVC',
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

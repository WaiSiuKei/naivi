// Build the host e2e entries through Vite (plan 065, U4).
//
// Replaces the rolldown CLI invocations in `make build-host`: bundles
// `src/e2e-entry.ts` and `src/vue-e2e-entry.ts` into single-file ESM at
// `crates/naive-host/pkg/{ir-loader,vue-e2e}.js` — the shape the host page
// (`crates/naive-host/index.html`) imports as module scripts.

import { build } from 'vite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = join(here, '..');
const pkgOut = join(runtimeRoot, '..', '..', 'crates', 'naive-host', 'pkg');

// The runtime's `loadCSSClassStyles` dynamically imports
// `/node_modules/.naive/styles.json`; the host e2e page has no compiled styles
// (the scene is driven by the IR loader), and the old rolldown pipeline
// tree-shook the branch. Resolve it to an empty stub so the build succeeds
// and the unused branch is eliminated.
const STYLES_STUB = '\0e2e-styles';
const stylesStubPlugin = {
  name: 'naive-e2e-styles-stub',
  resolveId(source) {
    if (source === '/node_modules/.naive/styles.json') return STYLES_STUB;
    return null;
  },
  load(id) {
    if (id === STYLES_STUB) return 'export default {};';
    return null;
  },
};

const entries = [
  { src: join(runtimeRoot, 'src', 'e2e-entry.ts'), out: 'ir-loader.js' },
  { src: join(runtimeRoot, 'src', 'vue-e2e-entry.ts'), out: 'vue-e2e.js' },
];

for (const { src, out } of entries) {
  await build({
    root: runtimeRoot,
    configFile: false,
    logLevel: 'info',
    plugins: [stylesStubPlugin],
    build: {
      outDir: pkgOut,
      emptyOutDir: false,
      minify: false,
      target: 'es2020',
      // Lib mode preserves the entry's exports (index.html consumes
      // `startVueE2E` at runtime) while still tree-shaking unused internals
      // (the styles.json branch), keeping each bundle single-file ESM.
      lib: {
        entry: src,
        formats: ['es'],
        fileName: () => out,
      },
    },
  });
}

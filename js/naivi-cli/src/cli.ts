#!/usr/bin/env node
// @naivi/cli — naivi toolchain CLI.
// Usage: npx naivi web | npx naivi wasm [--release] | npx naivi desktop [--release]

import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { C, findRoot } from './compile.ts';
import { parseCommand, type ParsedCommand } from './command.ts';
import { validateHostStyles } from './host-style.ts';
import { DevServer } from './dev-server.ts';
import { createServer } from 'vite';

const HELP_TEXT = `naivi — Vue Vapor CLI

Usage:
  npx naivi web                 Start dev server with standard Vite (no WASM)
  npx naivi wasm                Start dev server with naivi WASM renderer
  npx naivi wasm --release      Build a production static site with the WASM renderer
  npx naivi desktop             Start the native desktop renderer (QuickJS guest)
  npx naivi desktop --release   Package a macOS .app bundle into release/`;

// ── commands ────────────────────────────────────────────────────────

async function cmdWeb(_root: string, cwd: string, port: number) {
  // Pure Vite passthrough — no naive compilation, no WASM, no naive plugins.
  // Reads the `index.html` page's vite config from `naive.config.ts` (plan
  // 047, R5/KTD5); a standalone vite.config.ts is never loaded (R2). The only
  // naive addition is the `__NAIVE_PAGE_SIZE__` define (plan 049 KTD1).
  const { resolveWebViteConfig } = await import('./vite-config.ts');
  const config = await resolveWebViteConfig(cwd, port);

  const server = await createServer(config);

  await server.listen();
  server.printUrls();
}

async function cmdWasm(root: string, cwd: string, parsed: ParsedCommand) {
  if (parsed.release) {
    await buildWasmSite(root, cwd);
    return;
  }

  // Dev: Vite dev server with the wasm-mode marker (__NAIVE_MODE) injected
  // into the served index.html. The U4 host module is trunk-built, so the
  // dev flow serves the guest JS only; run `trunk serve` in the sibling
  // `-wasm` crate for the full host.
  const server = new DevServer(parsed.port, cwd, parsed.devtools);

  server.onFileChange((filePath: string) => {
    server.log(`File changed: ${filePath}`);
    server.broadcast('reload');
  });

  await server.start();
}

/**
 * Build the U4 wasm guest bundle (Vite) and copy it into the trunk crate's
 * `assets/guest/`, ready for `trunk build`.
 *
 * Layout (documented, reproducible): running `naivi wasm --release` in a demo
 * dir `<root>/examples/naivi/<name>` produces
 * `<root>/examples/naivi/<name>-wasm/assets/guest/` containing
 * - `guest.js` — a thin wrapper setting `globalThis.__NAIVE_MODE = "wasm"`,
 *   inlining the U6 author CSS (`globalThis.__NAIVE_CSS`), and importing
 *   `./guest.bundle.js`;
 * - `guest.bundle.js` — the Vite-built single-file guest module
 *   (`inlineDynamicImports`; its runtime wasm import stays a non-literal
 *   dynamic import).
 *
 * The trunk host page (`<name>-wasm/index.html`) references
 * `./assets/guest/guest.js`; trunk copies `assets/` verbatim into `dist/`.
 */
async function buildWasmSite(root: string, cwd: string) {
  const { build } = await import('vite');
  const { compileIfNeeded } = await import('./compile.ts');
  const { runCssSubsetCheck } = await import('./check.ts');
  const { resolveNaiveViteConfig, loadPageViteConfig, pageSizeOf } = await import('./vite-config.ts');
  const page = await loadPageViteConfig(cwd, 'naivi wasm --release');
  const config = await resolveNaiveViteConfig({
    cwd,
    pageViteConfig: page.vite,
    pageSize: pageSizeOf(page),
    singleFileGuest: true,
  });

  // U6: compile the author CSS (SFC `<style>` blocks + project CSS), then
  // gate the build on the CSS subset check (plan 073 U3): compileIfNeeded
  // produces `node_modules/.naive/styles.css`, which runCssSubsetCheck scans.
  // Compiling + checking happen BEFORE the Vite build so a hit fails fast
  // without wasting the build; the throw propagates to main()'s catch-all →
  // process.exit(1) (KTD5).
  const stylesCss = await compileIfNeeded(cwd);
  runCssSubsetCheck(cwd);

  await build(config);

  // Inline the compiled author CSS into guest.js so `loadCSSClassStyles` can
  // inject it into stylo.
  const cssText = readFileSync(stylesCss, 'utf8');

  const outDir = typeof config.build?.outDir === 'string' ? config.build.outDir : 'dist';

  // The wasm host is a SINGLE shared generic trunk crate
  // (`packages/naivi-wasm`): its host page loads `./assets/guest/guest.js`
  // and serves whichever demo's guest was built last. No per-demo host crates
  // — `naivi wasm --release` works for any demo.
  const trunkCrateDir = join(root, 'packages', 'naivi-wasm');
  const guestDir = join(trunkCrateDir, 'assets', 'guest');
  mkdirSync(guestDir, { recursive: true });
  cpSync(join(outDir, 'guest.bundle.js'), join(guestDir, 'guest.bundle.js'));
  writeFileSync(join(guestDir, 'guest.js'), makeGuestWrapper(cssText));
  console.log(C.ok(`Guest bundle → ${guestDir}`));
  console.log(C.dim(`Next: cd ${trunkCrateDir} && trunk build`));
}

/** The `guest.js` wrapper emitted by `naivi wasm --release` (do not edit). */
function makeGuestWrapper(cssText: string): string {
  const cssLine = cssText.trim()
    ? `globalThis.__NAIVE_CSS = ${JSON.stringify(cssText)};`
    : '';
  return `// Generated by \`naivi wasm --release\` (js/naivi-cli) — do not edit.
// Turns on the runtime's wasm-mode branch, inlines the U6 author CSS, then
// loads the Vite-built guest bundle. The U4 host's wasm glue is loaded by
// trunk itself (window.wasmBindings + TrunkApplicationStarted), so the bundle
// only needs __NAIVE_MODE set before it runs.
globalThis.__NAIVE_MODE = 'wasm';
${cssLine}
import('./guest.bundle.js');
`;
}

async function cmdDesktop(root: string, cwd: string, parsed: ParsedCommand) {
  const { cmdDesktopImpl } = await import('./desktop.ts');
  await cmdDesktopImpl(root, cwd, parsed.release);
}

// ── main ────────────────────────────────────────────────────────────

async function main() {
  const cwd = process.cwd();
  const parsed = parseCommand(process.argv.slice(2));

  if (!parsed.command) {
    console.log(HELP_TEXT);
    process.exit(1);
  }

  // `naivi web` skips the top-level monorepo-root lookup (wasm/desktop need
  // it to locate the shared host crates); the web config resolver resolves
  // the root itself, only to extend the fs.allow list with the js/ toolchain.
  if (parsed.command === 'web') {
    // Host-page style validation runs for every command (plan 056 R7): the
    // renderer (wasm canvas / native / web) depends on a full-viewport host
    // container, and a missing `height:100%` silently collapses the canvas.
    validateHostStyles(cwd, 'naivi web');
    await cmdWeb('' /* unused */, cwd, parsed.port);
    return;
  }

  const root = findRoot();
  if (!root) {
    console.error('naivi: could not find the blitz monorepo root (Cargo.toml with a [workspace] containing naivi-dom).');
    process.exit(1);
  }

  validateHostStyles(cwd, `naivi ${parsed.command}`);

  if (parsed.command === 'wasm') {
    await cmdWasm(root, cwd, parsed);
  } else if (parsed.command === 'desktop') {
    await cmdDesktop(root, cwd, parsed);
  } else {
    console.error(`naivi: unknown command \`${parsed.command}\`.`);
    console.log(HELP_TEXT);
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });

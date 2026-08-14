#!/usr/bin/env node
// @naivi/cli — naivi toolchain CLI.
// Usage: npx nv web | npx nv wasm [--release] | npx nv desktop [--release]

import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import { join } from 'node:path';
import { C, findRoot } from './compile.ts';
import { parseCommand, TRUNK_PORT, type ParsedCommand } from './command.ts';
import { validateHostStyles } from './host-style.ts';
import { createServer } from 'vite';

const HELP_TEXT = `nv — naivi Vue Vapor CLI

Usage:
  npx nv web                 Start dev server with standard Vite (no WASM)
  npx nv wasm                Build the guest + serve the WASM host (trunk, http://localhost:8090)
  npx nv wasm --release      Build the guest + the production WASM host into packages/naivi-wasm/dist
  npx nv desktop             Start the native desktop renderer (QuickJS guest)
  npx nv desktop --release   Package a macOS .app bundle into release/`;

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

/** PIDs with a listening socket on `port` (empty when free). */
function listenersOn(port: number): number[] {
  try {
    const out = execSync(`lsof -tiTCP:${port} -sTCP:LISTEN`, { encoding: 'utf8' });
    return out.trim().split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

/** The command line of `pid` (empty string when the process is gone). */
function processCommand(pid: number): string {
  try {
    return execSync(`ps -p ${pid} -o command=`, { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/**
 * `nv wasm` — the ONE command for the full wasm flow.
 *
 * 1. Build the demo's guest JS into the SHARED trunk host
 *    (`packages/naivi-wasm/assets/guest/`).
 * 2. Build/serve the host — the trunk-built Rust cdylib that actually runs
 *    the engine. A Vite-only dev server alone renders blank: the guest is
 *    application content, but the wasm engine + canvas come from the host.
 *
 * Dev (`nv wasm`): `trunk serve --release` on the trunk port (8090 by
 * default — local nginx owns 8080; `--port` overrides). Any stale trunk host
 * still holding the port is restarted so the freshly built guest is served.
 *
 * Release (`nv wasm --release`): also `trunk build --release` the host so
 * `packages/naivi-wasm/dist` is a deployable static site.
 */
async function cmdWasm(root: string, cwd: string, parsed: ParsedCommand) {
  await buildWasmSite(root, cwd);

  const trunkCrateDir = join(root, 'packages', 'naivi-wasm');
  if (parsed.release) {
    console.log(C.dim('[naivi] Building wasm host (trunk build --release)...'));
    execFileSync('trunk', ['build', '--release'], { cwd: trunkCrateDir, stdio: 'inherit' });
    console.log(C.ok(`Wasm host → ${join(trunkCrateDir, 'dist')}`));
    return;
  }

  const port = parsed.port === 3000 ? TRUNK_PORT : parsed.port;
  const stale = listenersOn(port).filter((pid) => processCommand(pid).includes('trunk'));
  if (stale.length > 0) {
    console.log(C.dim(`[naivi] Port ${port} held by a stale trunk host — restarting`));
    execSync(`kill ${stale.join(' ')}`, { stdio: 'ignore' });
  }
  console.log(C.ok(`nv wasm → http://localhost:${port}`));
  // Blocking: the trunk host owns the dev server until Ctrl+C.
  execFileSync('trunk', ['serve', '--release', '--port', String(port)], {
    cwd: trunkCrateDir,
    stdio: 'inherit',
  });
}

/**
 * Build the U4 wasm guest bundle (Vite) and copy it into the SHARED trunk
 * crate's `assets/guest/`, ready for the host to serve.
 *
 * Layout (documented, reproducible): running `nv wasm` (any demo dir) puts
 * `<root>/packages/naivi-wasm/assets/guest/` containing
 * - `guest.js` — a thin wrapper setting `globalThis.__NAIVE_MODE = "wasm"`,
 *   inlining the U6 author CSS (`globalThis.__NAIVE_CSS`), and importing
 *   `./guest.bundle.js`;
 * - `guest.bundle.js` — the Vite-built single-file guest module
 *   (`inlineDynamicImports`; its runtime wasm import stays a non-literal
 *   dynamic import).
 *
 * The trunk host page (`packages/naivi-wasm/index.html`) references
 * `./assets/guest/guest.js`; trunk copies `assets/` verbatim into `dist/`.
 * The host itself is built/served by `cmdWasm` (trunk build / trunk serve).
 */
async function buildWasmSite(root: string, cwd: string) {
  const { build } = await import('vite');
  const { compileIfNeeded } = await import('./compile.ts');
  const { runCssSubsetCheck } = await import('./check.ts');
  const { resolveNaiveViteConfig, loadPageViteConfig, pageSizeOf } = await import('./vite-config.ts');
  const page = await loadPageViteConfig(cwd, 'nv wasm --release');
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
  // — `nv wasm --release` works for any demo.
  const trunkCrateDir = join(root, 'packages', 'naivi-wasm');
  const guestDir = join(trunkCrateDir, 'assets', 'guest');
  mkdirSync(guestDir, { recursive: true });
  cpSync(join(outDir, 'guest.bundle.js'), join(guestDir, 'guest.bundle.js'));
  writeFileSync(join(guestDir, 'guest.js'), makeGuestWrapper(cssText));
  console.log(C.ok(`Guest bundle → ${guestDir}`));
}

/** The `guest.js` wrapper emitted by `nv wasm --release` (do not edit). */
function makeGuestWrapper(cssText: string): string {
  const cssLine = cssText.trim()
    ? `globalThis.__NAIVE_CSS = ${JSON.stringify(cssText)};`
    : '';
  return `// Generated by \`nv wasm --release\` (js/naivi-cli) — do not edit.
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

  // `nv web` skips the top-level monorepo-root lookup (wasm/desktop need
  // it to locate the shared host crates); the web config resolver resolves
  // the root itself, only to extend the fs.allow list with the js/ toolchain.
  if (parsed.command === 'web') {
    // Host-page style validation runs for every command (plan 056 R7): the
    // renderer (wasm canvas / native / web) depends on a full-viewport host
    // container, and a missing `height:100%` silently collapses the canvas.
    validateHostStyles(cwd, 'nv web');
    await cmdWeb('' /* unused */, cwd, parsed.port);
    return;
  }

  const root = findRoot();
  if (!root) {
    console.error('nv: could not find the blitz monorepo root (Cargo.toml with a [workspace] containing naivi-dom).');
    process.exit(1);
  }

  validateHostStyles(cwd, `nv ${parsed.command}`);

  if (parsed.command === 'wasm') {
    await cmdWasm(root, cwd, parsed);
  } else if (parsed.command === 'desktop') {
    await cmdDesktop(root, cwd, parsed);
  } else {
    console.error(`nv: unknown command \`${parsed.command}\`.`);
    console.log(HELP_TEXT);
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });

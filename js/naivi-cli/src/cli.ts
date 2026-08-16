#!/usr/bin/env node
// @naivi/cli — naivi toolchain CLI.
// Usage: npx nv web | npx nv wasm [--release] | npx nv desktop [--release]

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { C, findRoot } from './compile.ts';
import { parseCommand, TRUNK_PORT, type ParsedCommand } from './command.ts';
import { validateHostStyles } from './host-style.ts';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);

const HELP_TEXT = `nv — naivi Vue Vapor CLI

Usage:
  npx nv web                 Start dev server with standard Vite (no WASM)
  npx nv web --release       Production-build the page into dist/ (no dev server)
  npx nv wasm                Build the guest + serve the WASM host (trunk, http://localhost:8090)
  npx nv wasm --release      Build the deployable WASM site (engine + guest) into dist/
  npx nv desktop             Start the native desktop renderer (QuickJS guest)
  npx nv desktop --release   Package a macOS .app bundle into release/`;

// ── commands ────────────────────────────────────────────────────────

async function cmdWeb(_root: string, cwd: string, parsed: ParsedCommand) {
  // Pure Vite passthrough — no naive compilation, no WASM, no naive plugins.
  // Reads the `index.html` page's vite config from `naivi.config.ts` (plan
  // 047, R5/KTD5); a standalone vite.config.ts is never loaded (R2). The only
  // naive addition is the `__NAIVE_PAGE_SIZE__` define (plan 049 KTD1).
  if (parsed.release) {
    // `nv web --release`: production-build the page into `dist/` (the page's
    // `build.outDir`, Vite default `dist`). No dev server — mirrors
    // `nv wasm --release` / `nv desktop --release`.
    const { build } = await import('vite');
    const { resolveWebBuildConfig } = await import('./vite-config.ts');
    const config = await resolveWebBuildConfig(cwd);
    await build(config);
    const outDir = typeof config.build?.outDir === 'string' ? config.build.outDir : 'dist';
    console.log(C.ok(`Web build → ${join(cwd, outDir)}`));
    return;
  }

  const { resolveWebViteConfig } = await import('./vite-config.ts');
  const config = await resolveWebViteConfig(cwd, parsed.port);

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
 * Resolve the wasm host working directory.
 *
 * - Monorepo (`root` found): `packages/naivi-wasm` — the trunk crate; the
 *   CLI injects the guest into its `assets/guest` and trunk builds/serves it.
 * - Standalone (no monorepo): the prebuilt `@naivi/wasm-host` package. Its
 *   `dist/` is a ready-to-serve static site (engine wasm + host page); the
 *   CLI copies it to a writable working dir under `node_modules/.naive` so
 *   the per-demo guest can be injected (node_modules may be read-only, e.g.
 *   the pnpm store), then serves/copies that directly — no trunk, no Rust.
 */
function resolveWasmHost(root: string | null, cwd: string): { dir: string; standalone: boolean } {
  if (root) {
    return { dir: join(root, 'packages', 'naivi-wasm'), standalone: false };
  }
  let hostPkg: string;
  try {
    hostPkg = dirname(require.resolve('@naivi/wasm-host/package.json'));
  } catch {
    throw new Error(
      'nv wasm: no naivi monorepo found and `@naivi/wasm-host` is not installed — ' +
        'install it with `npm i -D @naivi/wasm-host` to run wasm standalone.',
    );
  }
  const work = join(cwd, 'node_modules', '.naive', 'wasm-host');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(dirname(work), { recursive: true });
  // Copy the package's dist/ (the ready-to-serve static site) — not the
  // package itself, which would drag in package.json/LICENSE/scripts and a
  // nested dist/.
  cpSync(join(hostPkg, 'dist'), work, { recursive: true });
  return { dir: work, standalone: true };
}

const STATIC_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** Serve a static directory (standalone wasm host). Blocking until Ctrl+C. */
function serveStatic(dir: string, port: number): void {
  const root = resolve(dir);
  const server = createHttpServer((req, res) => {
    let path = normalize(join(root, decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)));
    if (!path.startsWith(root)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    if (!existsSync(path) || statSync(path).isDirectory()) {
      path = join(path, 'index.html');
    }
    if (!existsSync(path)) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const type = STATIC_MIME[extname(path)] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(readFileSync(path));
  });
  server.listen(port, () => {
    console.log(C.ok(`nv wasm → http://localhost:${port}`));
  });
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
async function cmdWasm(root: string | null, cwd: string, parsed: ParsedCommand) {
  // Resolve the wasm host: the monorepo trunk crate (dev) or the prebuilt
  // `@naivi/wasm-host` package (standalone npm install — no trunk/Rust).
  const host = resolveWasmHost(root, cwd);
  await buildWasmSite(cwd, host.dir);

  if (parsed.release) {
    if (host.standalone) {
      // Prebuilt host — it IS a deployable dist already (guest was just
      // injected into its assets/guest). Copy it straight to <demo>/dist/.
      const demoDist = join(cwd, 'dist');
      rmSync(demoDist, { recursive: true, force: true });
      cpSync(host.dir, demoDist, { recursive: true });
      console.log(C.ok(`Wasm site → ${demoDist}`));
      console.log(C.ok(`  deployable static site (wasm engine + guest) — serve this directory`));
      return;
    }
    // Monorepo: compile the engine from source with trunk, then copy its
    // dist (engine + host page + THIS demo's guest) into <demo>/dist/.
    console.log(C.dim('[naivi] Building wasm host (trunk build --release)...'));
    // --public-url ./ (also pinned in packages/naivi-wasm/Trunk.toml) keeps
    // index.html's asset URLs relative, so dist/ is portable to any base
    // path / static host / IDE preview server.
    execFileSync('trunk', ['build', '--release', '--public-url', './'], {
      cwd: host.dir,
      stdio: 'inherit',
    });
    const demoDist = join(cwd, 'dist');
    rmSync(demoDist, { recursive: true, force: true });
    cpSync(join(host.dir, 'dist'), demoDist, { recursive: true });
    console.log(C.ok(`Wasm site → ${demoDist}`));
    console.log(C.ok(`  deployable static site (wasm engine + guest) — serve this directory`));
    return;
  }

  const port = parsed.port === 3000 ? TRUNK_PORT : parsed.port;
  if (host.standalone) {
    // Prebuilt host — no trunk needed; serve the static site directly.
    // Blocking: the static server owns the dev port until Ctrl+C.
    serveStatic(host.dir, port);
    return;
  }

  // Monorepo dev: build/serve the trunk host (engine compiled from source).
  const stale = listenersOn(port).filter((pid) => processCommand(pid).includes('trunk'));
  if (stale.length > 0) {
    console.log(C.dim(`[naivi] Port ${port} held by a stale trunk host — restarting`));
    execSync(`kill ${stale.join(' ')}`, { stdio: 'ignore' });
  }
  console.log(C.ok(`nv wasm → http://localhost:${port}`));
  // Blocking: the trunk host owns the dev server until Ctrl+C.
  // --public-url ./ keeps dev URL paths relative, matching the release build.
  execFileSync(
    'trunk',
    ['serve', '--release', '--port', String(port), '--public-url', './'],
    { cwd: host.dir, stdio: 'inherit' },
  );
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
async function buildWasmSite(cwd: string, hostDir: string) {
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

  // The guest is an INTERMEDIATE build artifact — it only becomes a runnable
  // app once copied into the shared trunk host (packages/naivi-wasm). Emit it
  // under node_modules/.naive (like the desktop bundles) so a stray,
  // non-deployable `dist/` never appears in the demo dir and gets mistaken
  // for the wasm output. The deployable site is packages/naivi-wasm/dist.
  const guestOutDir = join(cwd, 'node_modules', '.naive', 'guest');
  config.build = { ...(config.build ?? {}), outDir: guestOutDir };

  await build(config);

  // Inline the compiled author CSS into guest.js so `loadCSSClassStyles` can
  // inject it into stylo.
  const cssText = readFileSync(stylesCss, 'utf8');

  const outDir = typeof config.build?.outDir === 'string' ? config.build.outDir : 'dist';

  // The wasm host (the monorepo trunk crate OR the prebuilt `@naivi/wasm-host`
  // working copy) loads `./assets/guest/guest.js` and serves whichever demo's
  // guest was built last. No per-demo host crates — `nv wasm --release` works
  // for any demo.
  const guestDir = join(hostDir, 'assets', 'guest');
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
    await cmdWeb('' /* unused */, cwd, parsed);
    return;
  }

  // `nv wasm` also runs standalone: without the monorepo it uses the
  // prebuilt `@naivi/wasm-host` package (no trunk / Rust toolchain). Desktop
  // still needs the monorepo — the `naivi-native` binary is distributed
  // separately (pending).
  if (parsed.command === 'wasm') {
    validateHostStyles(cwd, 'nv wasm');
    await cmdWasm(findRoot(), cwd, parsed);
    return;
  }

  const root = findRoot();
  if (!root) {
    console.error('nv: could not find the blitz monorepo root (Cargo.toml with a [workspace] containing naivi-dom).');
    process.exit(1);
  }

  validateHostStyles(cwd, `nv ${parsed.command}`);

  if (parsed.command === 'desktop') {
    await cmdDesktop(root, cwd, parsed);
  } else {
    console.error(`nv: unknown command \`${parsed.command}\`.`);
    console.log(HELP_TEXT);
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });

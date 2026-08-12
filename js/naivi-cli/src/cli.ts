#!/usr/bin/env node
// @naive/cli — naive toolchain CLI.
// Usage: npx naive web | npx naive wasm [--release] | npx naive desktop [--release]

import { cpSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileIfNeeded, findRoot } from './compile.ts';
import { parseCommand, type ParsedCommand } from './command.ts';
import { validateHostStyles } from './host-style.ts';
import { DevServer } from './dev-server.ts';
import { createServer } from 'vite';

const HELP_TEXT = `naive — Vue Vapor CLI

Usage:
  npx naive web                 Start dev server with standard Vite (no WASM)
  npx naive wasm                Start dev server with naive WASM renderer
  npx naive wasm --release      Build a production static site with the WASM renderer
  npx naive desktop             Start the native desktop renderer (QuickJS guest)
  npx naive desktop --release   Package a macOS .app bundle into release/`;

const C = {
  ok:   (s: string) => `\x1b[32m✓\x1b[0m ${s}`,
  dim:  (s: string) => `\x1b[2m${s}\x1b[0m`,
};

// ── copy WASM assets into the project's naive dir ──────────────────

function copyWasm(root: string, targetDir: string): boolean {
  const srcPkg = join(root, 'crates', 'naive-host', 'pkg');
  const srcRuntime = join(root, 'crates', 'naive-host', 'runtime.js');
  // Naive-owned assets live under node_modules/.naive (same convention as the
  // compiled styles.json) so the business project tree stays clean.
  const dstPkg = join(targetDir, 'node_modules', '.naive', 'pkg');
  const dstRuntime = join(targetDir, 'node_modules', '.naive', 'runtime.js');

  if (!existsSync(srcPkg)) {
    console.log(C.dim('[naive] wasm pkg not found — run `make build-host` for WASM support'));
    return false;
  }

  mkdirSync(dstPkg, { recursive: true });
  cpSync(srcPkg, dstPkg, { recursive: true });

  // Fix import path: in the host dir it's '../node_modules/.naive/pkg/',
  // in the consumer project it's './node_modules/.naive/pkg/'.
  if (existsSync(srcRuntime)) {
    let runtime = readFileSync(srcRuntime, 'utf8');
    runtime = runtime.replace(
      "from '../node_modules/.naive/pkg/naive_host.js'",
      "from './node_modules/.naive/pkg/naive_host.js'",
    );
    writeFileSync(dstRuntime, runtime);
  }

  console.log(C.ok(`Copied WASM assets to ${dstPkg}`));
  return true;
}

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

  await compileIfNeeded(cwd);
  copyWasm(root, cwd);

  const server = new DevServer(parsed.port, cwd, parsed.devtools);

  server.onFileChange((filePath: string) => {
    server.log(`File changed: ${filePath}`);
    try {
      void compileIfNeeded(cwd).then(() => {
        server.log(`\x1b[32m✓\x1b[0m Recompiled`);
        server.broadcast('reload');
      });
    } catch (e) {
      console.error(`\x1b[31m✗\x1b[0m ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  await server.start();
}

async function buildWasmSite(root: string, cwd: string) {
  await compileIfNeeded(cwd);
  if (!copyWasm(root, cwd)) {
    console.error('[naive] wasm assets not found — run `make build-host` before `naive wasm --release`.');
    process.exit(1);
  }

  const { build } = await import('vite');
  const { resolveNaiveViteConfig, loadPageViteConfig, pageSizeOf } = await import('./vite-config.ts');
  const page = await loadPageViteConfig(cwd, 'naive wasm --release');
  const config = await resolveNaiveViteConfig({
    cwd,
    pageViteConfig: page.vite,
    pageSize: pageSizeOf(page),
  });
  await build(config);

  // The naive-wasm-bundle plugin rewrites the runtime import to a literal,
  // so vite bundles the wasm module + binary into dist/assets (hashed).
  const outDir = typeof config.build?.outDir === 'string' ? config.build.outDir : 'dist';
  console.log(C.ok(`Build complete → ${join(cwd, outDir)}`));
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

  // `naive web` does not need the monorepo root
  if (parsed.command === 'web') {
    // Host-page style validation runs for every command (plan 056 R7): the
    // renderer (wasm canvas / native / web) depends on a full-viewport host
    // container, and a missing `height:100%` silently collapses the canvas.
    validateHostStyles(cwd, 'naive web');
    await cmdWeb('' /* unused */, cwd, parsed.port);
    return;
  }

  const root = findRoot();
  if (!root) {
    console.error('naive: could not find naive monorepo root (Cargo.toml with naive-core).');
    process.exit(1);
  }

  validateHostStyles(cwd, `naive ${parsed.command}`);

  if (parsed.command === 'wasm') {
    await cmdWasm(root, cwd, parsed);
  } else if (parsed.command === 'desktop') {
    await cmdDesktop(root, cwd, parsed);
  } else {
    console.error(`naive: unknown command \`${parsed.command}\`.`);
    console.log(HELP_TEXT);
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });

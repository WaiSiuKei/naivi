// Desktop pipeline for `naivi desktop` (plan 072, U5).
//
// 1. Vite: bundle the PAGE entry (discovered from `index.html`'s Vue
//    module script) into a single-file IIFE, aliasing `@naivi/runtime/vue-vapor`
//    to the desktop entry (`js/naivi-runtime/src/desktop-entry.ts`) so the
//    page's `mount(App)` routes to the QuickJS-aware mount.
// 2. cargo run the native guest (`naivi-counter-native`) with the bundle
//    path, which evals it against `globalThis.naive` (the ops FFI) in a
//    winit window.
//
// The naive main/page split (`app.whenReady()` + `loadFile`) is NOT part of
// the U5 counter milestone: the demo has no main entry and the guest evals
// the page bundle directly. `--release` packaging is deferred to U7.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from 'vite';
import { compileIfNeeded } from './compile.ts';
import { loadNaiveConfig } from './config.ts';
import { loadPageViteConfig, resolveDesktopViteConfig } from './vite-config.ts';

const C = {
  ok:   (s: string) => `\x1b[32m✓\x1b[0m ${s}`,
  dim:  (s: string) => `\x1b[2m${s}\x1b[0m`,
};

/** Extract a quoted attribute value from a lowercase tag. */
function extractAttr(tag: string, name: string): string | null {
  const idx = tag.indexOf(name);
  if (idx < 0) return null;
  let after = tag.slice(idx + name.length).trimStart();
  if (!after.startsWith('=')) return null;
  after = after.slice(1).trimStart();
  const quote = after[0];
  if (quote !== '"' && quote !== "'") return null;
  const end = after.indexOf(quote, 1);
  if (end < 0) return null;
  return after.slice(1, end);
}

/** Unified page-entry rule (plan 045, KTD6): first `<script type="module"
 * src="...">`. Mirrors the guest's `html_entry`; a cross-layer test pins
 * agreement. */
export function findModuleScriptSrc(html: string): string | null {
  const lower = html.toLowerCase();
  let pos = 0;
  for (;;) {
    const rel = lower.indexOf('<script', pos);
    if (rel < 0) return null;
    const start = rel;
    const endRel = lower.indexOf('>', start);
    if (endRel < 0) return null;
    const end = endRel + 1;
    const tag = lower.slice(start, end);
    if (extractAttr(tag, 'type') === 'module') {
      const src = extractAttr(tag, 'src');
      if (src) return src.trim();
    }
    pos = end;
  }
}

/** Resolve the page Vue entry from `index.html` (plan 045, KTD6). */
export function findPageEntry(cwd: string): string {
  const htmlPath = join(cwd, 'index.html');
  if (!existsSync(htmlPath)) {
    throw new Error(`naive desktop: ${htmlPath} not found`);
  }
  const html = readFileSync(htmlPath, 'utf8');
  const src = findModuleScriptSrc(html);
  if (!src) {
    throw new Error(`naive desktop: no Vue module entry script in ${htmlPath}`);
  }
  const entry = join(cwd, src.replace(/^\/\/+/, ''));
  if (!existsSync(entry)) {
    throw new Error(`naive desktop: page entry not found at ${entry}`);
  }
  return entry;
}

/** Bundle the page entry into a single-file IIFE for the QuickJS guest.
 * Supports both `.tsx` (jsx transform) and `.vue` SFC (via the page's vue
 * plugins, plan 058 U2/KTD1). Reuses the page's `pages[].vite` config through
 * the shared desktop-mode builder (plan 065, U2). */
export async function buildDesktopBundle(root: string, cwd: string, entry: string): Promise<string> {
  const runtimeSrc = join(root, 'js', 'naivi-runtime', 'src');
  const desktopEntry = join(runtimeSrc, 'desktop-entry.ts');
  const outfile = join(cwd, 'node_modules', '.naive', 'page-bundle.js');

  const page = await loadPageViteConfig(cwd, 'naivi desktop');
  const config = resolveDesktopViteConfig({
    cwd,
    pageViteConfig: page.vite,
    entry,
    outfile,
    // Route the app's `mount(App)` (from @naivi/runtime/vue-vapor) to the
    // desktop entry (U5 review #2).
    aliases: { '@naivi/runtime/vue-vapor': desktopEntry },
  });
  await build(config);

  return outfile;
}

export async function cmdDesktopImpl(root: string, cwd: string, release: boolean): Promise<void> {
  // U5 scope: the counter demo has no `main` entry and no styles path (that's
  // U6) — require the index.html page only. `--release` packaging is deferred
  // to U7.
  const commandLabel = release ? 'naivi desktop --release' : 'naivi desktop';
  const config = await loadNaiveConfig(cwd, {
    requireMain: false,
    requirePages: true,
    requireName: false,
    commandLabel,
  });

  if (release) {
    throw new Error(
      'naivi desktop --release: not implemented in U5 (macOS .app packaging lands in U7)',
    );
  }

  // A declared `main` is a no-op for now (the naive main/page split is not
  // part of the counter milestone); the page bundle is evaled directly.
  if (config.main) {
    console.log(C.dim('[naivi] desktop: `main` entry ignored in U5 (page-only flow)'));
  }

  console.log(C.dim('[naivi] Compiling styles...'));
  const stylesPath = await compileIfNeeded(cwd);

  console.log(C.dim('[naivi] Bundling page...'));
  const pageEntry = findPageEntry(cwd);
  const pageBundlePath = await buildDesktopBundle(root, cwd, pageEntry);

  console.log(
    C.dim(`[naivi] Running guest: cargo run -p naivi-counter-native -- ${pageBundlePath} ${stylesPath}`),
  );
  // Blocking: the guest owns the window event loop until it closes. Pass argv
  // directly (no shell interpolation) so paths with $/backticks/quotes work.
  execFileSync('cargo', ['run', '-p', 'naivi-counter-native', '--', pageBundlePath, stylesPath], {
    cwd: root,
    stdio: 'inherit',
  });
}

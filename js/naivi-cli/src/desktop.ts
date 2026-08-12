// Desktop pipeline for `naive desktop` (plan 043, U5; plan 045, U3; plan
// 065, U2).
//
// 1. compileIfNeeded → `node_modules/.naive/styles.json` (shared pipeline).
// 2. Vite: bundle the MAIN entry (from `naive.config.ts` `main`) into
//    `main-bundle.js`, aliasing `@naive/runtime` to the desktop-main API.
// 3. Vite: bundle the PAGE entry (discovered from `index.html`'s Vue
//    module script) into `page-bundle.js`, aliasing `@naive/runtime/vue-vapor`
//    to the desktop entry so the page's `mount(App)` routes to the
//    QuickJS-aware mount. Both bundles reuse the page's `pages[].vite` config
//    via the shared desktop-mode config builder (plan 065, U1).
// 4. cargo run the native guest with main-bundle + page-bundle + styles +
//    project dir (dev), or package a `.app` with the same assets (--release).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { build } from 'vite';
import { compileIfNeeded } from './compile.ts';
import { findIndexHtmlPage, loadNaiveConfig, type LoadedNaiveConfig } from './config.ts';
import { assembleApp } from './macos-app.ts';
import { loadPageViteConfig, pageSizeOf, resolveDesktopViteConfig } from './vite-config.ts';

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

/** Resolve the config-declared main entry against the project dir (R11). */
function resolveMainEntry(cwd: string, main: string): string {
  const entry = join(cwd, main);
  if (!existsSync(entry)) {
    throw new Error(`naive desktop: main entry not found at ${entry}`);
  }
  return entry;
}

/** Bundle the page entry into a single-file IIFE for the QuickJS guest.
 * Supports both `.tsx` (jsx transform) and `.vue` SFC (via the page's vue
 * plugins, plan 058 U2/KTD1). Reuses the page's `pages[].vite` config through
 * the shared desktop-mode builder (plan 065, U2). */
export async function buildDesktopBundle(root: string, cwd: string, entry: string): Promise<string> {
  const runtimeSrc = join(root, 'packages', 'runtime', 'src');
  const desktopEntry = join(runtimeSrc, 'desktop-entry.ts');
  const outfile = join(cwd, 'node_modules', '.naive', 'page-bundle.js');

  const page = await loadPageViteConfig(cwd, 'naive desktop');
  const config = resolveDesktopViteConfig({
    cwd,
    pageViteConfig: page.vite,
    entry,
    outfile,
    // Route the app's `mount(App)` (from @naive/runtime/vue-vapor) to the
    // desktop entry (plan 043 U5 review #2).
    aliases: { '@naivi/runtime/vue-vapor': desktopEntry },
  });
  await build(config);

  return outfile;
}

/** Bundle the project's main entry into a single-file IIFE for the guest,
 * aliasing `@naive/runtime` to the desktop-main API (plan 045, KTD7). The
 * window size is baked in as `__NAIVE_WINDOW_SIZE__` so the runtime sizes the
 * native window from config without main-code plumbing (plan 057, KTD1). */
export async function buildDesktopMainBundle(
  root: string,
  cwd: string,
  mainEntry: string,
  windowSize: { width: number; height: number },
): Promise<string> {
  const runtimeSrc = join(root, 'packages', 'runtime', 'src');
  const desktopMain = join(runtimeSrc, 'desktop-main.ts');
  const outfile = join(cwd, 'node_modules', '.naive', 'main-bundle.js');

  const page = await loadPageViteConfig(cwd, 'naive desktop');
  const config = resolveDesktopViteConfig({
    cwd,
    pageViteConfig: page.vite,
    windowSize,
    entry: mainEntry,
    outfile,
    // Route the main's `import { app, NaiveWindow } from '@naivi/runtime'`
    // to the desktop-main API module.
    aliases: { '@naivi/runtime': desktopMain },
  });
  await build(config);

  return outfile;
}

export async function cmdDesktopImpl(root: string, cwd: string, release: boolean): Promise<void> {
  // R11: main is mandatory for desktop (requireMain, plan 047 R8). Plan 057
  // R1/R2: desktop now also requires pages containing an index.html page,
  // matching wasm/web. Release additionally requires the packaged app `name`
  // (046) — error wording is command-scoped.
  const commandLabel = release ? 'naive desktop --release' : 'naive desktop';
  const config = await loadNaiveConfig(cwd, {
    requireMain: true,
    requirePages: true,
    requireName: release,
    commandLabel,
  });

  // The loader guarantees a non-empty `main` when `requireMain` is set (R11);
  // the guard narrows the optional type for the bundling step below.
  if (!config.main) {
    throw new Error(`${commandLabel}: main entry missing`);
  }

  // Plan 057 R3/R4: the window size is the index.html page's fixed size, or
  // 800x600 when the page declares none. `findIndexHtmlPage` also enforces the
  // index.html requirement (R2) with a command-scoped error.
  const windowSize = pageSizeOf(findIndexHtmlPage(config.pages, commandLabel)) ?? {
    width: 800,
    height: 600,
  };

  console.log(C.dim('[naive] Compiling styles...'));
  const stylesPath = await compileIfNeeded(cwd);

  console.log(C.dim('[naive] Bundling main...'));
  const mainBundlePath = await buildDesktopMainBundle(
    root,
    cwd,
    resolveMainEntry(cwd, config.main),
    windowSize,
  );

  console.log(C.dim('[naive] Bundling page...'));
  const pageEntry = findPageEntry(cwd);
  const pageBundlePath = await buildDesktopBundle(root, cwd, pageEntry);

  if (release) {
    await packageDesktopApp(root, cwd, config);
    return;
  }

  const guestArgs = [mainBundlePath, pageBundlePath, stylesPath, cwd];
  console.log(
    C.dim(`[naive] Running guest: cargo run -p naive-guest-quickjs -- ${guestArgs.join(' ')}`),
  );
  // Blocking: the guest owns the window event loop until it closes. Pass argv
  // directly (no shell interpolation) so paths with $/backticks/quotes work.
  execFileSync('cargo', ['run', '-p', 'naive-guest-quickjs', '--', ...guestArgs], {
    cwd: root,
    stdio: 'inherit',
  });
}

/** `naive desktop --release`: build the release guest and assemble the `.app`
 * (plan 044 U3, 046 U2, 045 U3). */
async function packageDesktopApp(root: string, cwd: string, config: LoadedNaiveConfig): Promise<void> {
  // App name comes from naive.config.ts (validated by requireName above);
  // package.json is read only for the version (plan 046, KTD7).
  if (!config.name) {
    throw new Error('naive desktop --release: naive.config.ts must declare a non-empty `name`');
  }
  const pkgPath = join(cwd, 'package.json');
  const version = existsSync(pkgPath)
    ? ((JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }).version ?? '0.1.0')
    : '0.1.0';

  console.log(C.dim('[naive] Building release guest...'));
  execSync('cargo build --release -p naive-guest-quickjs', { cwd: root, stdio: 'inherit' });

  console.log(C.dim('[naive] Assembling .app...'));
  const { appDir, displayName } = assembleApp({
    root,
    cwd,
    appName: config.name,
    displayName: config.name,
    version,
  });
  console.log(C.ok(`Packaged ${displayName} → ${appDir}`));
}

// Desktop pipeline for `nv desktop` (plan 072, U5; main/page split).
//
// 1. compileIfNeeded → `node_modules/.naive/styles.css` (shared pipeline).
// 2. Vite: bundle the MAIN entry (from `naive.config.ts` `main`) into
//    `main-bundle.js`, aliasing `@naivi/runtime` to the desktop-main API
//    (`app.whenReady()` + `NaiveWindow`) and baking the window size in as
//    `__NAIVE_WINDOW_SIZE__`.
// 3. Vite: bundle the PAGE entry (discovered from `index.html`'s Vue
//    module script) into `page-bundle.js`, aliasing `@naivi/runtime/vue-vapor`
//    to the desktop entry so the page's `mount(App)` routes to the
//    QuickJS-aware mount. Both bundles reuse the page's `pages[].vite` config
//    via the shared desktop-mode config builder (plan 065, U1).
// 4. cargo run the shared native guest (`naivi-native`) with
//    main-bundle + page-bundle + styles + project dir. The host evals the
//    main bundle first; `app.whenReady()` + `loadFile('index.html')` drive
//    window creation and page loading (`loadFile` evals the page bundle).
//
// `--release` packaging is deferred to U7.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from 'vite';
import { runCssSubsetCheck } from './check.ts';
import { C, compileIfNeeded } from './compile.ts';
import { findIndexHtmlPage, loadNaiveConfig } from './config.ts';
import { loadPageViteConfig, pageSizeOf, resolveDesktopViteConfig } from './vite-config.ts';

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
  const runtimeSrc = join(root, 'js', 'naivi-runtime', 'src');
  const desktopEntry = join(runtimeSrc, 'desktop-entry.ts');
  const outfile = join(cwd, 'node_modules', '.naive', 'page-bundle.js');

  const page = await loadPageViteConfig(cwd, 'nv desktop');
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

/** Bundle the project's main entry into a single-file IIFE for the guest,
 * aliasing `@naivi/runtime` to the desktop-main API (`app` + `NaiveWindow`).
 * The window size is baked in as `__NAIVE_WINDOW_SIZE__` so the runtime
 * sizes the native window from config without main-code plumbing (plan 057
 * KTD1). */
export async function buildDesktopMainBundle(
  root: string,
  cwd: string,
  mainEntry: string,
  windowSize: { width: number; height: number },
): Promise<string> {
  const runtimeSrc = join(root, 'js', 'naivi-runtime', 'src');
  const desktopMain = join(runtimeSrc, 'desktop-main.ts');
  const outfile = join(cwd, 'node_modules', '.naive', 'main-bundle.js');

  const page = await loadPageViteConfig(cwd, 'nv desktop');
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
  // R11: main is mandatory for desktop (requireMain); pages with an
  // index.html page are required too, matching wasm/web. `--release`
  // packaging is deferred to U7.
  const commandLabel = release ? 'nv desktop --release' : 'nv desktop';
  const config = await loadNaiveConfig(cwd, {
    requireMain: true,
    requirePages: true,
    requireName: false,
    commandLabel,
  });

  if (release) {
    throw new Error(
      'nv desktop --release: not implemented in U5 (macOS .app packaging lands in U7)',
    );
  }

  // The loader guarantees a non-empty `main` when `requireMain` is set (R11);
  // the guard narrows the optional type for the bundling step below.
  if (!config.main) {
    throw new Error(`${commandLabel}: main entry missing`);
  }

  // The window size is the index.html page's fixed size, or 800x600 when the
  // page declares none (plan 057 R3/R4). `findIndexHtmlPage` also enforces
  // the index.html requirement with a command-scoped error.
  const windowSize = pageSizeOf(findIndexHtmlPage(config.pages, commandLabel)) ?? {
    width: 800,
    height: 600,
  };

  console.log(C.dim('[naivi] Compiling styles...'));
  const stylesPath = await compileIfNeeded(cwd);

  // Plan 073 U3: gate the desktop build on the CSS subset check — a hit
  // throws here, before any bundling or window launch (KTD5).
  runCssSubsetCheck(cwd);

  console.log(C.dim('[naivi] Bundling main...'));
  const mainBundlePath = await buildDesktopMainBundle(
    root,
    cwd,
    resolveMainEntry(cwd, config.main),
    windowSize,
  );

  console.log(C.dim('[naivi] Bundling page...'));
  const pageEntry = findPageEntry(cwd);
  const pageBundlePath = await buildDesktopBundle(root, cwd, pageEntry);

  // The native host is a SINGLE shared generic crate (`naivi-native`): it
  // evals the main bundle (app.whenReady → NaiveWindow.loadFile → page
  // bundle) for whichever demo's bundles it is handed. No per-demo host
  // crates — `nv desktop` works for any demo.
  const nativeCrate = 'naivi-native';
  const guestArgs = [mainBundlePath, pageBundlePath, stylesPath, cwd];
  console.log(
    C.dim(`[naivi] Running guest: cargo run -p ${nativeCrate} -- ${guestArgs.join(' ')}`),
  );
  // Blocking: the guest owns the window event loop until it closes. Pass argv
  // directly (no shell interpolation) so paths with $/backticks/quotes work.
  try {
    execFileSync('cargo', ['run', '-p', nativeCrate, '--', ...guestArgs], {
      cwd: root,
      stdio: 'inherit',
    });
  } catch (error) {
    // Ctrl+C (or an external kill) sends a signal to the whole process group;
    // the guest's signal-terminated exit makes execFileSync throw. That is a
    // normal quit path — exit cleanly instead of dumping a "Command failed"
    // stack trace. A child killed by a signal has `status === null` and a
    // `signal`; a real non-zero exit keeps `status` set and must rethrow.
    const childError = error as {
      status?: number | null;
      signal?: NodeJS.Signals | null;
    };
    if (childError.status === null && childError.signal) {
      process.exit(0);
    }
    throw error;
  }
}

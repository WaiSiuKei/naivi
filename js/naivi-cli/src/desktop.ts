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
// `nv desktop --release` (U7, macOS first) additionally assembles
// `release/<name>.app` from those bundles + the release binary
// (`packageDesktopApp`).

import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  // index.html page are required too, matching wasm/web. `--release` also
  // requires `name` — it names the .app bundle (U7).
  const commandLabel = release ? 'nv desktop --release' : 'nv desktop';
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

  if (release) {
    // U7: macOS .app packaging. `name` is guaranteed by requireName above;
    // the guard narrows the optional type.
    if (!config.name) {
      throw new Error(`${commandLabel}: naive.config.ts must declare \`name\``);
    }
    await packageDesktopApp(root, cwd, config.name, {
      mainBundlePath,
      pageBundlePath,
      stylesPath,
    });
    return;
  }

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

/**
 * macOS .app packaging for `nv desktop --release` (plan 065, U7 — macOS
 * first). Assembles `release/<name>.app` (name kebab-cased from
 * `naive.config.ts` `name`, e.g. "Naivi TodoMVC" → `naivi-todomvc.app`):
 *
 *   Contents/
 *     Info.plist            — name / display name / bundle id / launcher
 *     MacOS/
 *       naivi-native        — the release binary (`cargo build -p naivi-native`)
 *       launcher            — execs naivi-native against the Resources bundles
 *     Resources/
 *       main-bundle.js      — desktop main bundle (whenReady + NaiveWindow)
 *       page-bundle.js      — page bundle (mount → desktop entry)
 *       styles.css          — compiled author CSS (__NAIVE_CSS)
 *       index.html          — loadFile('index.html') resolves against here
 *
 * Launch with `open release/<name>.app`.
 */
export async function packageDesktopApp(
  root: string,
  cwd: string,
  name: string,
  bundles: { mainBundlePath: string; pageBundlePath: string; stylesPath: string },
): Promise<void> {
  const kebab =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'naive-app';

  // Build the shared native host as a release binary (no per-demo host
  // crates — the same binary serves every app).
  console.log(C.dim('[naivi] Building native host (cargo build --release -p naivi-native)...'));
  execFileSync('cargo', ['build', '--release', '-p', 'naivi-native'], {
    cwd: root,
    stdio: 'inherit',
  });
  const hostBinary = join(root, 'target', 'release', 'naivi-native');
  if (!existsSync(hostBinary)) {
    throw new Error(`nv desktop --release: native host binary not found at ${hostBinary}`);
  }

  const appDir = join(cwd, 'release', `${kebab}.app`);
  const macosDir = join(appDir, 'Contents', 'MacOS');
  const resourcesDir = join(appDir, 'Contents', 'Resources');

  rmSync(appDir, { recursive: true, force: true });
  mkdirSync(macosDir, { recursive: true });
  mkdirSync(resourcesDir, { recursive: true });

  cpSync(hostBinary, join(macosDir, 'naivi-native'));
  writeFileSync(join(macosDir, 'launcher'), makeLauncherScript());
  chmodSync(join(macosDir, 'naivi-native'), 0o755);
  chmodSync(join(macosDir, 'launcher'), 0o755);

  cpSync(bundles.mainBundlePath, join(resourcesDir, 'main-bundle.js'));
  cpSync(bundles.pageBundlePath, join(resourcesDir, 'page-bundle.js'));
  cpSync(bundles.stylesPath, join(resourcesDir, 'styles.css'));
  cpSync(join(cwd, 'index.html'), join(resourcesDir, 'index.html'));
  writeFileSync(join(appDir, 'Contents', 'Info.plist'), makeInfoPlist(kebab, name));

  console.log(C.ok(`App → ${appDir}`));
  console.log(C.ok(`  open ${appDir}`));
}

/** The `Contents/MacOS/launcher` script — execs the host against Resources. */
function makeLauncherScript(): string {
  return `#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
RES="$DIR/../Resources"
exec "$DIR/naivi-native" "$RES/main-bundle.js" "$RES/page-bundle.js" "$RES/styles.css" "$RES"
`;
}

/** The `Contents/Info.plist` for the app bundle (name-derived ids). */
function makeInfoPlist(kebab: string, displayName: string): string {
  // Bundle id: com.naivi.<kebab>, dropping a redundant leading "naivi-"
  // (so "naivi-todomvc" → com.naivi.todomvc).
  const bundleId = kebab.startsWith('naivi-')
    ? `com.naivi.${kebab.slice('naivi-'.length)}`
    : `com.naivi.${kebab}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>${kebab}</string>
    <key>CFBundleDisplayName</key>
    <string>${displayName}</string>
    <key>CFBundleIdentifier</key>
    <string>${bundleId}</string>
    <key>CFBundleVersion</key>
    <string>0.1</string>
    <key>CFBundleShortVersionString</key>
    <string>0.1</string>
    <key>CFBundleExecutable</key>
    <string>launcher</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>LSMinimumSystemVersion</key>
    <string>13.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
</dict>
</plist>
`;
}

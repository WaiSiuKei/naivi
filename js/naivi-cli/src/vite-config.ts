// Naive Vite configuration construction (plans 039, 047, 065).
//
// The wasm pipeline reads the page's vite config from `naive.config.ts`
// `pages` (plan 047 R4/KTD4) and merges it with the naive defaults. A
// standalone `vite.config.ts` is no longer discovered anywhere (R2): the
// merged config pins `configFile: false`. User-declared vue/vueJsx plugins
// win by name so they never instantiate twice; naive-only plugins (WASM mode
// marker, style watcher, devtools) are always appended. Desktop mode (plan
// 065) reuses the page's vite config but swaps the wasm-only naive plugins
// for the desktop set (IIFE output, CSS drop, aliases, desktop defines).

import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import vue from "@vitejs/plugin-vue";
import vueJsx from "@vitejs/plugin-vue-jsx";
import {
  mergeConfig,
  searchForWorkspaceRoot,
  type InlineConfig,
  type Plugin,
  type PluginOption,
  type UserConfig,
} from "vite";
import { findRoot } from "./compile.ts";
import { findIndexHtmlPage, loadNaiveConfig, type NaivePageConfig } from "./config.ts";

export interface ResolveNaiveViteConfigOptions {
  /** Project root containing the `naive.config.ts`. */
  cwd: string;
  /** The selected page's declared vite config from `pages[].vite` (R3). */
  pageViteConfig?: UserConfig;
  /** Fixed page size from `pages[].width/height` (plan 049); null when absent. */
  pageSize?: { width: number; height: number } | null;
  /** Inject the naive devtools overlay (dev only). */
  devtools?: boolean;
  /** Called on project file changes (dev watcher wiring). */
  onStylesChange?: (filePath: string) => void;
  /**
   * U4 wasm build: emit the guest bundle as a single self-contained module
   * named `guest.bundle.js` (`inlineDynamicImports`) so the CLI can copy it
   * into the trunk crate's `assets/guest/` verbatim.
   */
  singleFileGuest?: boolean;
}

/**
 * The loaded `index.html` page (plan 047 U2, extended in plan 049 U2): its
 * declared vite config plus the optional fixed page size — the page's
 * `NaivePageConfig` projection minus `entry`. `width`/`height` are
 * both-or-neither by validation (R1).
 */
export type LoadedPage = Pick<NaivePageConfig, "vite" | "width" | "height">;

/** Extract a page's fixed size as a pair, or null when absent (plan 049). */
export function pageSizeOf(page: LoadedPage): { width: number; height: number } | null {
  return page.width !== undefined && page.height !== undefined
    ? { width: page.width, height: page.height }
    : null;
}

/**
 * Deep-merge the page size into the user's own define (plan 049 KTD1): the
 * injected `__NAIVE_PAGE_SIZE__` is a JS expression — an object literal when
 * sized, `null` otherwise — and the user's other define keys are preserved.
 */
function injectPageSizeDefine(
  userConfig: UserConfig,
  size: { width: number; height: number } | null,
): Record<string, string> {
  return {
    ...(userConfig.define ?? {}),
    __NAIVE_PAGE_SIZE__: JSON.stringify(size ?? null),
  };
}

/**
 * Naivi packages that must never be dependency-pre-bundled (CLI-managed; a
 * demo does not declare them): the runtime's wasm import is intentionally
 * `@vite-ignore`'d and must stay a runtime dynamic import. Prebundling would
 * statically resolve it and fail with UNRESOLVED_IMPORT.
 */
const NAIVI_PREBUNDLE_EXCLUDE = ['@naivi/runtime'];

/**
 * Merge the CLI-managed dev-server defaults into a page vite config without
 * clobbering the user's own values:
 *
 * - `optimizeDeps.exclude` always lists the naivi runtime (see
 *   `NAIVI_PREBUNDLE_EXCLUDE`), keeping its `@vite-ignore`'d wasm import
 *   unresolved during prebundling.
 * - `server.fs.allow` always lists the project root, Vite's own workspace
 *   root, and the naivi JS toolchain dir (`<monorepo-root>/js`, where the
 *   linked `@naivi/runtime` sources live in this monorepo). Setting
 *   `fs.allow` replaces Vite's default allow list, so the CLI must re-add
 *   those roots itself — a demo must not have to know about them.
 */
function applyNaiviServerDefaults(cwd: string, userConfig: UserConfig): UserConfig {
  const allow = new Set<string>([searchForWorkspaceRoot(cwd), resolve(cwd)]);
  const root = findRoot(cwd);
  if (root) allow.add(resolve(root, 'js'));
  for (const entry of userConfig.server?.fs?.allow ?? []) {
    allow.add(resolve(cwd, entry));
  }
  return {
    ...userConfig,
    optimizeDeps: {
      ...(userConfig.optimizeDeps ?? {}),
      exclude: [...NAIVI_PREBUNDLE_EXCLUDE, ...(userConfig.optimizeDeps?.exclude ?? [])],
    },
    server: {
      ...(userConfig.server ?? {}),
      fs: {
        ...(userConfig.server?.fs ?? {}),
        allow: [...allow],
      },
    },
  };
}

function pluginName(plugin: unknown): string | undefined {
  if (Array.isArray(plugin)) return plugin.map(pluginName).find(Boolean);
  if (plugin && typeof plugin === "object" && "name" in plugin) {
    return (plugin as { name?: unknown }).name as string | undefined;
  }
  return undefined;
}

function naivePolyfillPlugin(): Plugin {
  return {
    name: "naive-polyfill",
    transformIndexHtml(html: string) {
      // Flag the WASM pipeline so the runtime mounts through the naive
      // renderer instead of falling back to a plain Vue mount.
      return html.replace(
        "<head>",
        '<head>\n<script>window.__NAIVE_MODE = "wasm";</script>',
      );
    },
  };
}

function naiveStylesPlugin(onChange?: (filePath: string) => void): Plugin {
  return {
    name: "naive-styles",
    configureServer(server) {
      server.watcher.on("change", (filePath: string) => {
        if (onChange) onChange(filePath);
      });
    },
  };
}

function naiveDevtoolsPlugin(cwd: string): Plugin {
  return {
    name: "naive-devtools",
    transformIndexHtml(html: string) {
      return html.replace(
        "</head>",
        `<script type="module" src="/@fs/${join(cwd, "devtools.js")}"></script>\n</head>`,
      );
    },
  };
}

/**
 * Load the wasm/web page from `naive.config.ts` (plan 047 U2/U3, plan 049
 * U2): requires `pages`, selects the `index.html` page (KTD3), and returns
 * its declared vite config plus optional fixed size.
 */
export async function loadPageViteConfig(
  cwd: string,
  commandLabel: string,
): Promise<LoadedPage> {
  const config = await loadNaiveConfig(cwd, { requirePages: true, commandLabel });
  const page = findIndexHtmlPage(config.pages, commandLabel);
  return { vite: page.vite, width: page.width, height: page.height };
}

/**
 * Build the `naive web` server config (plan 047 U3/KTD5, plan 049 U2):
 * loads the `index.html` page's vite config from `naive.config.ts` (pages
 * required, R6), derives the page size internally (KTD1), and returns a
 * passthrough server config — the page's own plugins, no naive plugin
 * injection, `configFile` disabled, page size injected via `define`. The
 * CLI-managed defaults (prebundle exclusion + fs allow list) are applied so
 * the demo does not need to declare them.
 */
export async function resolveWebViteConfig(
  cwd: string,
  port: number,
): Promise<InlineConfig> {
  const page = await loadPageViteConfig(cwd, "nv web");
  const userConfig = applyNaiviServerDefaults(cwd, page.vite ?? {});
  return {
    root: cwd,
    ...userConfig,
    configFile: false,
    // Plan 049 KTD1: inject the page size into the passthrough build.
    define: injectPageSizeDefine(userConfig, pageSizeOf(page)),
    // Passthrough: keep the page's own server options (incl. the
    // CLI-managed `fs.allow`); only the port is forced by the CLI.
    server: { ...userConfig.server, port },
  };
}

/**
 * Build the `nv web --release` config: the same passthrough page config as
 * the dev server (plan 047 U3/KTD5, plan 049 KTD1) but in production build
 * mode — `vite build` emits the static site into the page's `build.outDir`
 * (Vite default `dist`). Server-only keys are dropped; the page's own
 * plugins and base are preserved unchanged.
 */
export async function resolveWebBuildConfig(cwd: string): Promise<InlineConfig> {
  const page = await loadPageViteConfig(cwd, "nv web --release");
  const userConfig = applyNaiviServerDefaults(cwd, page.vite ?? {});
  return {
    root: cwd,
    ...userConfig,
    configFile: false,
    // Plan 049 KTD1: inject the page size into the passthrough build.
    define: injectPageSizeDefine(userConfig, pageSizeOf(page)),
  };
}

/**
 * Build the merged Vite configuration for the wasm pipeline.
 *
 * The naive base plugins are deduped against the page's declared plugins by
 * plugin name; the merged result keeps user plugins in their declared order
 * followed by the naive-only plugins. `configFile` is pinned to `false` so a
 * stray legacy `vite.config.ts` is never discovered or merged (R2/KTD4).
 */
export async function resolveNaiveViteConfig(
  options: ResolveNaiveViteConfigOptions,
): Promise<InlineConfig> {
  const userConfig = applyNaiviServerDefaults(options.cwd, options.pageViteConfig ?? {});

  const userPlugins = (userConfig.plugins ?? []) as PluginOption[];
  const userNames = new Set(userPlugins.map(pluginName));
  const naiveBase = [vue(), vueJsx()].filter((p) => !userNames.has(pluginName(p)));
  const naiveOnly: Plugin[] = [
    naiveStylesPlugin(options.onStylesChange),
    naivePolyfillPlugin(),
    ...(options.devtools ? [naiveDevtoolsPlugin(options.cwd)] : []),
  ];

  const merged = mergeConfig({ root: options.cwd }, userConfig) as InlineConfig;
  // mergeConfig concatenates plugin arrays; pin the deduped order explicitly.
  merged.plugins = [...naiveBase, ...userPlugins, ...naiveOnly];
  // No standalone vite.config.ts support (R2): disable discovery on every path.
  merged.configFile = false;
  // Plan 049 KTD1: inject the page size (object-literal-or-null expression),
  // deep-merging the user's own define entries.
  merged.define = injectPageSizeDefine(userConfig, options.pageSize ?? null);

  // U4 wasm build: single-file guest bundle named `guest.bundle.js`, with the
  // runtime's dynamic wasm import left inline (a non-literal specifier is not
  // resolved by rollup). The CLI copies this one file into the trunk crate.
  if (options.singleFileGuest) {
    const userOutput = merged.build?.rollupOptions?.output;
    merged.build = {
      ...merged.build,
      rollupOptions: {
        ...merged.build?.rollupOptions,
        output: [
          ...(Array.isArray(userOutput) ? userOutput : userOutput ? [userOutput] : []),
          {
            entryFileNames: 'guest.bundle.js',
            codeSplitting: false,
          },
        ],
      },
    };
  }

  return merged;
}

// ── Desktop mode (plan 065) ─────────────────────────────────────────

/** Vite plugin: remap `.js` imports to `.ts`/`.tsx` when the `.js` file does
 * not exist on disk (the runtime sources import `.js` names for `.ts` files;
 * demos reference `./app.js` for `app.tsx`). Same resolveId shape the desktop
 * pipeline previously used with rolldown (plan 065 U1). */
export function jsToTsPlugin(): Plugin {
  return {
    name: 'naive-js-to-ts',
    resolveId(source, importer) {
      if (!importer) return null;
      // Only remap relative imports; bare package imports resolve normally.
      if (!source.startsWith('./') && !source.startsWith('../')) return null;
      if (!source.endsWith('.js')) return null;
      const base = resolve(dirname(importer), source);
      if (existsSync(base)) return null;
      for (const ext of ['.ts', '.tsx']) {
        const alt = base.replace(/\.js$/, ext);
        if (existsSync(alt)) {
          return { id: alt };
        }
      }
      return null;
    },
  };
}

/**
 * Vite plugin: drop CSS from desktop bundles (plan 065, R5). SFC `<style>`
 * blocks and CSS imports would otherwise be inlined by Vite as style-tag JS;
 * the QuickJS guest has no `document`, so that injection would crash eval.
 * The U6 author CSS is delivered separately as text (`styles.css` →
 * `globalThis.__NAIVE_CSS` → `add_stylesheet`), never via the page bundle.
 * Must run `enforce: 'pre'` ahead of the page's own plugins (Tailwind's is
 * also pre-enforced) and map `.css` specifiers to a virtual id that does NOT
 * end in `.css` so vite:css never parses the stub (verified against Vite
 * 8.2.0).
 */
function naiveCssDropPlugin(): Plugin {
  const CSS_ID = '\0naive-css';
  return {
    name: 'naive-css-drop',
    enforce: 'pre',
    resolveId(source) {
      const clean = source.split('?')[0];
      if (clean.endsWith('.css')) return CSS_ID;
      return null;
    },
    load(id) {
      if (id === CSS_ID) return 'export default {};';
      return null;
    },
  };
}

export interface ResolveDesktopViteConfigOptions {
  /** Project root containing the `naive.config.ts`. */
  cwd: string;
  /** The selected page's declared vite config from `pages[].vite`. */
  pageViteConfig?: UserConfig;
  /** Fixed window size baked in as `__NAIVE_WINDOW_SIZE__` (plan 057 KTD1);
   * the main bundle passes it, the page bundle omits it. */
  windowSize?: { width: number; height: number };
  /** Absolute bundle entry (main or page). */
  entry: string;
  /** Absolute output file (e.g. `node_modules/.naive/page-bundle.js`). */
  outfile: string;
  /** Route `@naive/runtime` / `@naive/runtime/vue-vapor` to the desktop API. */
  aliases: Record<string, string>;
}

/**
 * Build the merged Vite configuration for a desktop bundle (plan 065, U1).
 *
 * Reuses the page's `pages[].vite` config and plugins (Product KD1 — reverses
 * plan 047 KD1) plus the naive vue/vueJsx base (deduped by name), then adds
 * the desktop-only pieces: CSS drop, js→ts remap, desktop defines,
 * neutral-ish resolution, and IIFE single-file output at es2020.
 * The wasm-only naive plugins (wasm-mode polyfill, devtools, style watcher)
 * are excluded (Product KD3).
 */
export function resolveDesktopViteConfig(
  options: ResolveDesktopViteConfigOptions,
): InlineConfig {
  const userConfig = applyNaiviServerDefaults(options.cwd, options.pageViteConfig ?? {});
  const userPlugins = (userConfig.plugins ?? []) as PluginOption[];
  const userNames = new Set(userPlugins.map(pluginName));
  const naiveBase = [vue(), vueJsx()].filter((p) => !userNames.has(pluginName(p)));

  const merged = mergeConfig({ root: options.cwd }, userConfig) as InlineConfig;
  // CSS drop must sit ahead of the page's plugins (it is pre-enforced and the
  // page's Tailwind is too — array position decides). The resolver plugins may
  // follow; they return null for non-matching ids.
  merged.plugins = [naiveCssDropPlugin(), ...naiveBase, ...userPlugins, jsToTsPlugin()];
  merged.configFile = false;
  merged.define = {
    ...(userConfig.define ?? {}),
    'process.env.NODE_ENV': '"production"',
    ...(options.windowSize
      ? { __NAIVE_WINDOW_SIZE__: JSON.stringify(options.windowSize) }
      : {}),
  };
  // Approximate rolldown's `platform: 'neutral'` (plan 065 KTD3): avoid the
  // browser export condition so no browser-only branch is pulled in.
  merged.resolve = {
    ...(userConfig.resolve ?? {}),
    alias: { ...(userConfig.resolve?.alias ?? {}), ...options.aliases },
    conditions: ['module', 'import', 'default'],
    mainFields: ['module', 'main'],
  };
  merged.build = {
    ...(userConfig.build ?? {}),
    target: 'es2020',
    minify: false,
    emptyOutDir: false,
    cssCodeSplit: false,
    outDir: dirname(options.outfile),
    rollupOptions: {
      ...(userConfig.build?.rollupOptions ?? {}),
      input: options.entry,
      output: {
        format: 'iife',
        // codeSplitting defaults to false for IIFE; the bundle is single-file.
        entryFileNames: basename(options.outfile),
      },
      // IIFE cannot express `import.meta` (rolldown would otherwise emit
      // EMPTY_IMPORT_META warnings for the desktop entry's dynamic imports
      // and Vite's injected preload helper). In this single-file bundle all
      // dynamic imports are inlined, so the replacement `{}` is dead code —
      // define it explicitly to silence the warning (rolldown docs,
      // "Non ESM Output Formats" → `import.meta`).
      transform: {
        define: { 'import.meta': '{}' },
      },
    },
  };
  return merged;
}

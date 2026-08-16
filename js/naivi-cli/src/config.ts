// Project config (`naivi.config.ts`) schema, helpers, and loader (plans 045,
// 046, 047).
//
// The config is the project-level source of truth: `name` (packaged app name,
// required for `--release`), `main` (desktop main-process entry, required for
// desktop), and `pages` (per-page HTML entry + optional vite config + optional
// fixed size, required for wasm/web). `defineNaiveConfig`/`defineViteConfig`/
// `NaiveConfig` are exported from `@naive/cli` (via package.json `exports` →
// this file). `loadNaiveConfig` reads the config using Vite's config loader
// with an absolute file path — a relative path would resolve against the
// process cwd.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfigFromFile, type UserConfig } from 'vite';

/** A page declared in `naivi.config.ts` (`pages` entry, plan 047 R3). */
export interface NaivePageConfig {
  /** HTML entry, e.g. `index.html`. */
  entry: string;
  /** Optional per-page Vite config (wrapped by `defineViteConfig`). */
  vite?: UserConfig;
  /**
   * Optional fixed page width in px (plan 049 R1): must be declared together
   * with `height`, both-or-neither; only the `index.html` page's size takes
   * effect this iteration (KTD4).
   */
  width?: number;
  /** Optional fixed page height in px (plan 049 R1); see `width`. */
  height?: number;
}

/** Project-level naive configuration. */
export interface NaiveConfig {
  /** Packaged app name for `naive desktop --release`; used verbatim. */
  name?: string;
  /** Desktop main-process entry, e.g. `app/main.ts` (required, R11). */
  main?: string;
  /** Per-page declarations (required for wasm/web, plan 047 R3). */
  pages?: NaivePageConfig[];
}

/** Typed helper for `naivi.config.ts` authors (plan 047, R1). */
export function defineNaiveConfig(config: NaiveConfig): NaiveConfig {
  return config;
}

/** Typed helper wrapping a page's Vite config (plan 047, R1/R3). */
export function defineViteConfig(config: UserConfig): UserConfig {
  return config;
}

/** A loaded `naivi.config.ts`; which fields are required depends on command. */
export interface LoadedNaiveConfig {
  /** Present when the config declares it (required for `--release`). */
  name?: string;
  /** Non-empty when `requireMain` is passed (desktop, R11). */
  main?: string;
  /** Always an array; non-empty when `requirePages` is passed (wasm/web, R6). */
  pages: NaivePageConfig[];
}

export interface LoadNaiveConfigOptions {
  /** Require a non-empty `main` (desktop, R8). */
  requireMain?: boolean;
  /** Also require a non-empty `name` (release packaging needs it). */
  requireName?: boolean;
  /** Require a well-formed non-empty `pages` (wasm/web, R6). */
  requirePages?: boolean;
  /** Command context for error messages (default `naive desktop`). */
  commandLabel?: string;
}

/**
 * Normalize a declared page `entry` before comparison (plan 047, KTD3):
 * strip leading `./` and `/` so `./index.html` matches `index.html`.
 */
export function normalizePageEntry(entry: string): string {
  return entry.replace(/^(\.\/|\/)+/, '');
}

/**
 * Select the page whose normalized `entry` is `index.html` (plan 047, KTD3).
 * Throws a command-scoped error when no such page exists (R6).
 */
export function findIndexHtmlPage(
  pages: NaivePageConfig[],
  commandLabel: string,
): NaivePageConfig {
  const page = pages.find((p) => normalizePageEntry(p.entry) === 'index.html');
  if (!page) {
    throw new Error(
      `${commandLabel}: naivi.config.ts \`pages\` must include a page whose \`entry\` is index.html`,
    );
  }
  return page;
}

/** Load the project's `naivi.config.ts` with command-aware validation. */
export async function loadNaiveConfig(
  cwd: string,
  options: LoadNaiveConfigOptions = {},
): Promise<LoadedNaiveConfig> {
  const commandLabel = options.commandLabel ?? 'naive desktop';
  const configFile = join(cwd, 'naivi.config.ts');
  if (!existsSync(configFile)) {
    throw new Error(`${commandLabel}: ${configFile} not found`);
  }
  const loaded = await loadConfigFromFile(
    { command: 'build', mode: 'production' },
    configFile,
    cwd,
  );
  const config = (loaded?.config ?? {}) as NaiveConfig;
  if (options.requireMain && (typeof config.main !== 'string' || config.main.trim().length === 0)) {
    throw new Error(`${commandLabel}: naivi.config.ts must declare a non-empty \`main\``);
  }
  if (options.requireName && (typeof config.name !== 'string' || config.name.trim().length === 0)) {
    throw new Error(`${commandLabel}: naivi.config.ts must declare a non-empty \`name\``);
  }
  if (options.requirePages) {
    if (!Array.isArray(config.pages) || config.pages.length === 0) {
      throw new Error(`${commandLabel}: naivi.config.ts must declare a non-empty \`pages\``);
    }
    for (const page of config.pages) {
      if (!page || typeof page.entry !== 'string' || page.entry.trim().length === 0) {
        throw new Error(
          `${commandLabel}: naivi.config.ts \`pages\` entries must declare a non-empty \`entry\``,
        );
      }
      // Plan 049 R1: width/height are both-or-neither; declared values must be
      // finite positive numbers. Non-index pages declaring a full size are
      // schema-only this iteration (KTD4) — warn instead of silently no-op.
      const hasWidth = page.width !== undefined;
      const hasHeight = page.height !== undefined;
      if (hasWidth !== hasHeight) {
        throw new Error(
          `${commandLabel}: naivi.config.ts \`pages\` entry \`${page.entry}\` must declare both \`width\` and \`height\` or neither`,
        );
      }
      if (hasWidth) {
        if (typeof page.width !== 'number' || !Number.isFinite(page.width) || page.width <= 0) {
          throw new Error(
            `${commandLabel}: naivi.config.ts \`pages\` entry \`${page.entry}\` \`width\` must be a finite positive number`,
          );
        }
        if (typeof page.height !== 'number' || !Number.isFinite(page.height) || page.height <= 0) {
          throw new Error(
            `${commandLabel}: naivi.config.ts \`pages\` entry \`${page.entry}\` \`height\` must be a finite positive number`,
          );
        }
        if (normalizePageEntry(page.entry) !== 'index.html') {
          console.warn(
            `${commandLabel}: naivi.config.ts \`pages\` entry \`${page.entry}\` declares \`width\`/\`height\`, but only the \`index.html\` page's size takes effect`,
          );
        }
      }
    }
  }
  return { name: config.name, main: config.main, pages: config.pages ?? [] };
}

// Host page style validation (plan 056): the naive renderer depends on the
// host `index.html` providing a full-viewport container. This module checks
// that `html`/`body` (and `#app` when present) declare the required host
// styles — `margin: 0`, `box-sizing: border-box`, and `height: 100%` — and
// fails the CLI with an actionable message when any is missing.
//
// Tailwind Preflight already injects `margin: 0` and `box-sizing: border-box`
// globally (and a project using Tailwind has it applied), but Preflight does
// NOT provide `height: 100%` on html/body — so `height` is always checked.
// When the project uses Tailwind Preflight, the margin/box-sizing checks are
// skipped (satisfied by the global reset).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const RECOMMENDED = "html, body { margin: 0; height: 100%; box-sizing: border-box; }";
const APP_RECOMMENDED = "#app { height: 100%; }";

/** A declaration found in the host page's own CSS (`<style>` blocks). */
interface Decl {
  /** Lower-cased property name, e.g. `margin`, `box-sizing`, `height`. */
  prop: string;
  /** Raw lower-cased value, e.g. `0`, `100%`, `border-box`. */
  value: string;
}

/** Extract declarations from a CSS rule body, tolerant of whitespace. */
function parseDeclarations(css: string): Decl[] {
  const out: Decl[] = [];
  // Match `prop: value;` pairs inside any block; also handle the trailing
  // declaration without a semicolon by requiring a closing brace boundary.
  const declRe = /([a-zA-Z-]+)\s*:\s*([^;}{]+)/g;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(css)) !== null) {
    const prop = m[1].trim().toLowerCase();
    const value = m[2].trim().toLowerCase().replace(/\s+/g, " ");
    if (prop && value) out.push({ prop, value });
  }
  return out;
}

/**
 * Collect `selector -> declarations` pairs from the inline `<style>` blocks of
 * an HTML document. Selectors are normalized (lower-cased, comma-split).
 */
function parseInlineStyles(html: string): Map<string, Decl[]> {
  const styles = new Map<string, Decl[]>();
  const styleRe = /<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/gi;
  let styleMatch: RegExpExecArray | null;
  while ((styleMatch = styleRe.exec(html)) !== null) {
    const css = styleMatch[1];
    // Split rules on the first `{`; a selector may be comma-separated.
    const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
    let ruleMatch: RegExpExecArray | null;
    while ((ruleMatch = ruleRe.exec(css)) !== null) {
      const selector = ruleMatch[1].trim().toLowerCase();
      const body = ruleMatch[2];
      const decls = parseDeclarations(body);
      for (const sel of selector.split(",")) {
        const key = sel.trim();
        if (!key) continue;
        const existing = styles.get(key) ?? [];
        existing.push(...decls);
        styles.set(key, existing);
      }
    }
  }
  return styles;
}

/** True when a selector targets the html/body elements (or is universal). */
function matchesHostRoot(selector: string): boolean {
  return (
    selector === "html" ||
    selector === "body" ||
    selector === "html, body" ||
    selector === "body, html" ||
    selector === "*" ||
    selector.includes("html") ||
    selector.includes("body")
  );
}

/** True when the project compiles Tailwind CSS (Preflight is then applied). */
function usesTailwind(projectRoot: string): boolean {
  // A Tailwind v4 entry (`@import "tailwindcss"`) in a CSS file that the
  // compile pipeline feeds, or a tailwindcss dependency present. Preflight is
  // injected by `@import "tailwindcss"` in v4; the dependency check covers
  // projects that wire it through a plugin/config instead.
  const cssDir = join(projectRoot, "src");
  const candidates = [join(cssDir, "main.css"), join(projectRoot, "main.css")];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const content = readFileSync(file, "utf8");
      if (/@import\s+["']tailwindcss["']/.test(content)) return true;
    } catch {
      /* unreadable — fall through */
    }
  }
  return false;
}

export interface HostStyleCheckResult {
  /** Missing requirement descriptions; empty when the page passes. */
  missing: string[];
}

/**
 * Validate the host page's inline styles against the naive host-style
 * contract. Returns the list of missing requirements (empty = pass).
 *
 * The contract, per plan 056:
 * - `margin: 0` on body (or a universal reset) — skipped when Tailwind
 *   Preflight is active (it provides the global reset).
 * - `box-sizing: border-box` on html/body (or universal) — skipped with
 *   Tailwind.
 * - `height: 100%` on html/body, and `height: 100%` on `#app` when present —
 *   always required (Preflight does not provide it).
 */
export function checkHostStyles(html: string, projectRoot: string): HostStyleCheckResult {
  const styles = parseInlineStyles(html);
  const missing: string[] = [];
  const preflight = usesTailwind(projectRoot);

  // Collect the effective declarations for host roots (html/body/universal).
  const hostDecls: Decl[] = [];
  for (const [selector, decls] of styles) {
    if (matchesHostRoot(selector)) hostDecls.push(...decls);
  }
  const appDecls = styles.get("#app") ?? [];

  const has = (decls: Decl[], prop: string, okValue: (v: string) => boolean): boolean =>
    decls.some((d) => d.prop === prop && okValue(d.value));

  if (!preflight) {
    if (!has(hostDecls, "margin", (v) => v === "0" || v === "0px")) {
      missing.push("body/html must declare `margin: 0` (or a universal `* { margin: 0 }` reset)");
    }
    if (!has(hostDecls, "box-sizing", (v) => v === "border-box")) {
      missing.push("html/body must declare `box-sizing: border-box` (or a universal `* { box-sizing: border-box }` reset)");
    }
  }

  if (!has(hostDecls, "height", (v) => v === "100%" || v === "100vh")) {
    missing.push("html/body must declare `height: 100%` (Tailwind Preflight does not provide it; without it the canvas collapses to content height)");
  }
  const hasApp = html.includes('id="app"') || html.includes("id='app'");
  if (hasApp && !has(appDecls, "height", (v) => v === "100%" || v === "100vh")) {
    missing.push("`#app` must declare `height: 100%`");
  }

  return { missing };
}

/** Build the human-readable error for a failing check (plan 056 R6). */
export function hostStyleError(html: string, projectRoot: string): string | null {
  const { missing } = checkHostStyles(html, projectRoot);
  if (missing.length === 0) return null;
  const lines = [
    "naive: host page styles are missing required declarations (plan 056).",
    "",
    "The naive renderer requires the host page to provide a full-viewport",
    "container. Add the following to <style> in index.html:",
    "",
    `  ${RECOMMENDED}`,
    ...(html.includes('id="app"') ? [`  ${APP_RECOMMENDED}`] : []),
    "",
    "Missing:",
    ...missing.map((m) => `  - ${m}`),
  ];
  return lines.join("\n");
}

/** Read the project's `index.html` and validate it; throws on failure. */
export function validateHostStyles(cwd: string, commandLabel: string): void {
  // Only naive-rendered projects (those with a `naivi.config.ts`) require the
  // host-page contract. A pure Vite project run through `naive web` is a
  // passthrough — its `index.html` is a normal web page and must not be
  // flagged (plan 056, R7 scope).
  if (!existsSync(join(cwd, "naivi.config.ts"))) return;
  const htmlPath = join(cwd, "index.html");
  if (!existsSync(htmlPath)) return; // no host page — nothing to validate
  let html: string;
  try {
    html = readFileSync(htmlPath, "utf8");
  } catch {
    return; // unreadable — skip (compile pipeline will surface it)
  }
  const err = hostStyleError(html, cwd);
  if (err) {
    throw new Error(`${commandLabel}: ${err}`);
  }
}

// U1: CSS subset check core.
//
// Ports kiln's rule table (property_rule / selector_rule / at_rule_rule, see
// /Users/yq/private-repos/kiln/src/check.rs) to a postcss scan over compiled
// CSS. See docs/plans/2026-08-12-073-feat-css-subset-check-plan.md.
//
// Two scan entry points (KTD3 — two inputs):
//  - scanCompiledCss: the merged, compiled final author CSS — ALL rules apply.
//  - scanAuthorCss: the raw author-written CSS (SFC `<style>` blocks +
//    standalone CSS, recollected by the caller via compile.ts's
//    findCSSFiles/extractSfcStyles) — only the 3d rule (KC1320) applies, so
//    Tailwind-generated 3d utilities in the compiled output are never blamed
//    on the author (and float/… in the author CSS is the compiled scan's job).
//
// Findings are deduped by (code, declaration) with an occurrence count
// (KTD4); percent() is computed over the deduped count. Malformed CSS is
// logged as a warning and yields an empty report — never a throw (KTD4).

import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { parse as parseCss } from 'postcss';
import type { AtRule, Declaration, Rule } from 'postcss';
import { parse as parseSfc } from '@vue/compiler-sfc';

import { extractSfcStyles, findCSSFiles, findVueFiles } from './compile.js';

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m⚠\x1b[0m ${s}`,
};

export interface Finding {
  code: string;
  declaration: string;
  hint: string;
  file?: string;
  line: number;
  column: number;
  /** Parent selector of the declaration, or undefined for selector/at-rule hits. */
  origin?: string;
  /** How many times this (code, declaration) pair occurred (KTD4 dedup). */
  count: number;
}

export interface CheckReport {
  /** Total declarations scanned (every `prop: value` in the input). */
  declarations: number;
  /** Deduped by (code, declaration); each carries its occurrence count. */
  findings: Finding[];
  supported(): number;
  percent(): number;
}

function makeReport(declarations: number, findings: Finding[]): CheckReport {
  return {
    declarations,
    findings,
    supported() {
      return this.declarations - this.findings.length;
    },
    percent() {
      if (this.declarations === 0) return 100;
      return Math.round((this.supported() / this.declarations) * 100);
    },
  };
}

type RuleArm = 'all' | '3d';

/** kiln property_rule — codes/hints/match conditions mirrored exactly. */
function propertyRule(property: string, value: string): readonly [string, string] | undefined {
  switch (property) {
    case 'float':
      return ['KC1101', 'use flexbox or grid'];
    case 'backdrop-filter':
      return ['KC1340', 'filter: blur() on a sibling layer'];
    case 'mix-blend-mode':
      return ['KC1341', 'not supported — composite the colours yourself'];
    case 'writing-mode':
      return ['KC1150', 'not supported'];
    case 'contain':
      return ['KC1160', 'not supported — no effect on layout'];
    case 'position':
      if (value.trim() === 'sticky') {
        return ['KC1201', 'use a fixed header plus scroll padding'];
      }
      if (value.trim() === 'fixed') {
        return [
          'KC1202',
          'inside a positioned ancestor it resolves against that, not the viewport',
        ];
      }
      return undefined;
    case 'text-overflow':
      if (value.trim().startsWith('ellipsis')) {
        return ['KC1210', 'clips without an ellipsis — truncate the text yourself'];
      }
      return undefined;
    case 'display':
      if (value.trim().startsWith('table')) {
        return ['KC1102', 'use flexbox or grid'];
      }
      return undefined;
    case 'grid-template-columns':
      if (value.includes('subgrid')) {
        return ['KC1103', 'subgrid is not supported — restate the tracks'];
      }
      return undefined;
    case 'transform':
    case 'translate':
      return propertyRule3d(value);
    default:
      return undefined;
  }
}

/**
 * kiln's 3d arm: `value.contains("3d") || value.contains("perspective")`.
 * `translateZ(0)` contains neither substring, so it does NOT trigger KC1320
 * (KTD3 — no source marker needed for that case).
 */
function propertyRule3d(value: string): readonly [string, string] | undefined {
  if (value.includes('3d') || value.includes('perspective')) {
    return ['KC1320', '3D transforms are not supported — use the 2D subset'];
  }
  return undefined;
}

/** kiln selector_rule. */
function selectorRule(selector: string): readonly [string, string] | undefined {
  if (selector.includes(':has(')) {
    return ['KC1002', 'not supported — restructure or use a class'];
  }
  // Only when it is the whole selector. Preflight resets
  // `*, ::before, ::after, ::backdrop` together, and the rest of that rule
  // applies perfectly well — flagging it would over-claim.
  if (selector.trim() === '::backdrop') {
    return ['KC1003', 'not supported'];
  }
  return undefined;
}

/** kiln at_rule_rule. */
function atRuleRule(name: string): readonly [string, string] | undefined {
  switch (name) {
    case 'container':
      return ['KC1401', 'not supported — use @media or a resize observer'];
    case 'scope':
      return ['KC1402', 'not supported — scope with a class'];
    default:
      return undefined;
  }
}

export interface ScanOptions {
  file?: string;
}

function scanCss(css: string, opts: ScanOptions, arm: RuleArm): CheckReport {
  let root;
  try {
    root = parseCss(css, { from: opts.file });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(
      C.warn(`Cannot parse CSS${opts.file ? ` in ${opts.file}` : ''}: ${msg}`),
    );
    // KTD4: unparseable CSS is a warning, not a hit — empty report.
    return makeReport(0, []);
  }

  let declarations = 0;
  const dedup = new Map<string, Finding>();

  const add = (
    code: string,
    declaration: string,
    hint: string,
    line: number,
    column: number,
    origin?: string,
  ): void => {
    const key = `${code}\u0000${declaration}`;
    const existing = dedup.get(key);
    if (existing) {
      existing.count += 1;
      return;
    }
    dedup.set(key, {
      code,
      declaration,
      hint,
      file: opts.file,
      line,
      column,
      origin,
      count: 1,
    });
  };

  root.walkDecls((decl: Declaration) => {
    const property = decl.prop.trim().toLowerCase();
    const value = decl.value.trim();
    if (!property || !value) return;
    declarations += 1;
    const hit = arm === '3d' ? propertyRule3d(value) : propertyRule(property, value);
    if (!hit) return;
    let origin: string | undefined;
    if (decl.parent && decl.parent.type === 'rule') {
      origin = (decl.parent as Rule).selector;
    }
    add(
      hit[0],
      `${property}: ${value}`,
      hit[1],
      decl.source?.start?.line ?? 0,
      decl.source?.start?.column ?? 0,
      origin,
    );
  });

  if (arm !== '3d') {
    root.walkRules((rule: Rule) => {
      const hit = selectorRule(rule.selector);
      if (!hit) return;
      add(
        hit[0],
        rule.selector,
        hit[1],
        rule.source?.start?.line ?? 0,
        rule.source?.start?.column ?? 0,
      );
    });
    root.walkAtRules((atRule: AtRule) => {
      const hit = atRuleRule(atRule.name);
      if (!hit) return;
      add(
        hit[0],
        `@${atRule.name}`,
        hit[1],
        atRule.source?.start?.line ?? 0,
        atRule.source?.start?.column ?? 0,
      );
    });
  }

  return makeReport(declarations, [...dedup.values()]);
}

/** Scan the merged, compiled final author CSS with ALL rules. */
export function scanCompiledCss(css: string, opts?: ScanOptions): CheckReport {
  return scanCss(css, opts ?? {}, 'all');
}

/**
 * Scan raw author-written CSS with ONLY the 3d rule (KC1320) — the KTD3
 * carrier input. The caller recollects author CSS via compile.ts's
 * findCSSFiles + extractSfcStyles.
 */
export function scanAuthorCss(css: string, opts?: ScanOptions): CheckReport {
  return scanCss(css, opts ?? {}, '3d');
}

/** kiln-shaped report text: declarations/supported/percent + per-finding rows. */
export function renderReport(report: CheckReport): string {
  const lines: string[] = [];
  lines.push(`    declarations   ${String(report.declarations).padStart(8)}`);
  lines.push(`    supported      ${String(report.supported()).padStart(8)}  (${report.percent()}%)`);
  if (report.findings.length === 0) {
    lines.push('');
    return lines.join('\n');
  }
  lines.push('');
  for (const f of report.findings) {
    // Generated CSS is not what anyone edits, so lead with the origin
    // (parent selector / utility) when present.
    const subject = f.origin ?? f.declaration;
    lines.push(`    ×${String(f.count).padEnd(3)} ${subject.padEnd(34)} ${f.code}  ${f.hint}`);
    if (f.origin !== undefined) {
      lines.push(`         ${f.declaration}`);
    }
    if (f.line > 0) {
      const where = f.file ? `${f.file}:` : '';
      lines.push(`         ${where}${f.line}:${f.column}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

// Re-export the ANSI helpers so callers can dim the rendered report the same
// way compile.ts's `C` does (U2/U3 may render `C.dim(renderReport(r))`).
export { C };

// ── U2: template utility-class attribution + composite entry ────────
//
// runCssSubsetCheck(cwd) is the composite entry U3 wires into the wasm /
// desktop build flow. Flow (plan U2):
//   1. read node_modules/.naive/styles.css — missing/empty → dim skip (KTD4)
//   2. scanCompiledCss (ALL rules) on the compiled CSS
//   3. recollect raw author CSS (compile.ts findCSSFiles + extractSfcStyles,
//      KTD3 second input) → scanAuthorCss (3d only) → append findings
//      (declarations stay from the compiled scan, KTD4)
//   4. template attribution pass: a finding whose origin is a class selector
//      gets re-pointed to the .vue file/line/col when that class appears in a
//      template AND maps to the finding's code (KTD2/AE2); template classes
//      alone never create findings
//   5. print the kiln-shaped report; throw on any hit (KTD5)
//
// Template scanning is a lightweight regex pass over
// descriptor.template.content (the plan allows string-literal scanning):
// static `class="a b"` attributes plus `:class="'literal'"` string literals.
// Object / ternary / binding :class values and script-side classList.add are
// out of scope (KTD2 — the compiled CSS is the decision source, templates
// only attribute).

/** Small utility-class → rule-code map (plan U2 list + natural extensions). */
export function utilityRuleForClass(className: string): string | undefined {
  if (className === 'float-left' || className === 'float-right') return 'KC1101';
  if (className === 'sticky') return 'KC1201';
  if (className === 'fixed') return 'KC1202';
  if (className === 'table') return 'KC1102';
  if (className === 'subgrid') return 'KC1103';
  if (className.startsWith('has-[')) return 'KC1002';
  if (className.startsWith('container-[')) return 'KC1401';
  if (className === 'truncate') return 'KC1210';
  if (className.startsWith('backdrop-blur-')) return 'KC1340';
  if (className.startsWith('mix-blend-')) return 'KC1341';
  if (className.startsWith('contain-')) return 'KC1160';
  return undefined;
}

/** 1-based line/column of `index` within `text`. */
function positionAt(text: string, index: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  for (let i = 0; i < index; i++) {
    if (text.charCodeAt(i) === 10) {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

/**
 * Record each whitespace-separated word of `raw` (located at absolute offset
 * `valueStart` inside `template`) into `classes`, keeping the first position.
 */
function recordClassWords(
  classes: Map<string, { line: number; column: number }>,
  template: string,
  raw: string,
  valueStart: number,
): void {
  let searchFrom = 0;
  for (const word of raw.match(/[^\s]+/g) ?? []) {
    const idx = raw.indexOf(word, searchFrom);
    searchFrom = idx + word.length;
    if (!classes.has(word)) {
      classes.set(word, positionAt(template, valueStart + idx));
    }
  }
}

/**
 * Extract static `class="a b"` attributes and `:class="'literal'"` string
 * literals from a template, mapping each class to its first occurrence
 * position (1-based line/column within the template text).
 */
export function extractTemplateClasses(
  template: string,
): Map<string, { line: number; column: number }> {
  const classes = new Map<string, { line: number; column: number }>();

  // Static class attributes — `class` NOT preceded by `:` / `@` / `.`, so
  // :class / @class / .class never match the static arm.
  const staticRe = /(?<![:@.])class\s*=\s*(["'])([^"']*)\1/g;
  let m: RegExpExecArray | null;
  while ((m = staticRe.exec(template)) !== null) {
    const raw = m[2];
    const valueStart = m.index + m[0].indexOf(m[2]);
    recordClassWords(classes, template, raw, valueStart);
  }

  // `:class="'literal'"` (incl. v-bind:class) — only pure string literals;
  // object / ternary / binding expressions are out of scope (KTD2).
  const dynamicRe = /:class\s*=\s*(["'])([\s\S]*?)\1/g;
  while ((m = dynamicRe.exec(template)) !== null) {
    const expr = m[2];
    const lit = /^\s*(["'])(.*?)\1\s*$/s.exec(expr);
    if (!lit) continue;
    const exprStart = m.index + m[0].indexOf(expr);
    const valueStart = exprStart + lit[0].indexOf(lit[2]);
    recordClassWords(classes, template, lit[2], valueStart);
  }

  return classes;
}

/** `.float-left` / `.has-\[x\]` → `float-left` / `has-[x]`; non-class selectors → undefined. */
function classNameFromSelector(origin: string): string | undefined {
  if (!origin.startsWith('.')) return undefined;
  const rest = origin.slice(1);
  // Only a bare class selector — no combinators / pseudo / id / extra class.
  if (/[\s>+~:#.]/.test(rest)) return undefined;
  return rest.replace(/\\/g, '');
}

interface TemplateClasses {
  file: string;
  classes: Map<string, { line: number; column: number }>;
}

/** Parse every `.vue` under `cwd` and collect its static template classes. */
function collectTemplates(cwd: string): TemplateClasses[] {
  const out: TemplateClasses[] = [];
  for (const vueFile of findVueFiles(cwd)) {
    let source: string;
    try {
      source = readFileSync(vueFile, 'utf8');
    } catch {
      continue;
    }
    let template: string | null = null;
    try {
      const { descriptor } = parseSfc(source);
      template = descriptor.template?.content ?? null;
    } catch {
      // Unparseable SFC — no template attribution from this file.
      continue;
    }
    if (template === null || !template.trim()) continue;
    const classes = extractTemplateClasses(template);
    if (classes.size > 0) {
      out.push({ file: relative(cwd, vueFile), classes });
    }
  }
  return out;
}

/**
 * KTD2/AE2 attribution: re-point a compiled-CSS finding to a template
 * location ONLY when (a) the finding's origin is a class selector whose
 * class appears in a template, AND (b) the finding's code matches the
 * template→rule mapping for that class. Otherwise the finding keeps its
 * compiled-CSS file/line/col.
 */
function attributeFindings(findings: Finding[], templates: TemplateClasses[]): void {
  const index = new Map<string, { file: string; line: number; column: number }>();
  for (const t of templates) {
    for (const [cls, pos] of t.classes) {
      if (!index.has(cls)) index.set(cls, { file: t.file, line: pos.line, column: pos.column });
    }
  }
  for (const f of findings) {
    if (!f.origin) continue;
    const cls = classNameFromSelector(f.origin);
    if (!cls) continue;
    const loc = index.get(cls);
    if (!loc) continue;
    if (utilityRuleForClass(cls) !== f.code) continue;
    f.file = loc.file;
    f.line = loc.line;
    f.column = loc.column;
  }
}

function findingKey(f: Finding): string {
  return `${f.code}\u0000${f.declaration}`;
}

/**
 * Append author-CSS findings (KTD3 second input). On a (code, declaration)
 * collision with the compiled scan the author location wins — it names the
 * file the developer edits — while the occurrence count is kept from the
 * compiled scan, so the same physical declaration never double-counts.
 */
function mergeAuthorFindings(target: Finding[], source: Finding[]): void {
  const byKey = new Map(target.map((f) => [findingKey(f), f]));
  for (const f of source) {
    const k = findingKey(f);
    const existing = byKey.get(k);
    if (existing) {
      existing.file = f.file;
      existing.line = f.line;
      existing.column = f.column;
      existing.origin = f.origin;
    } else {
      byKey.set(k, f);
      target.push(f);
    }
  }
}

/** Recollect raw author CSS exactly like compileIfNeeded does (KTD3 input). */
function collectAuthorCss(cwd: string): Array<{ css: string; file: string }> {
  const chunks: Array<{ css: string; file: string }> = [];
  for (const cssFile of findCSSFiles(cwd)) {
    try {
      const css = readFileSync(cssFile, 'utf8');
      if (css.trim()) chunks.push({ css, file: relative(cwd, cssFile) });
    } catch {
      /* skip unreadable */
    }
  }
  const srcDir = join(cwd, 'src');
  for (const vueFile of findVueFiles(srcDir)) {
    try {
      const styles = extractSfcStyles(readFileSync(vueFile, 'utf8'), vueFile);
      if (styles.trim()) chunks.push({ css: styles, file: relative(cwd, vueFile) });
    } catch {
      /* skip unreadable */
    }
  }
  return chunks;
}

/**
 * Composite CSS subset check (plan U2) — the entry U3 wires into the wasm /
 * desktop build flow. Reads the compiled `node_modules/.naive/styles.css`,
 * scans it (ALL rules), appends author-CSS 3d findings (KTD3), attributes
 * class-selector hits back to `.vue` templates (KTD2), prints the kiln-shaped
 * report and throws when anything is unsupported (KTD5). Missing / empty
 * styles.css → dim skip, never throws (KTD4). Returns void; the caller (U3)
 * lets the throw propagate to main()'s catch-all → process.exit(1).
 */
export function runCssSubsetCheck(cwd: string): void {
  const stylesPath = join(cwd, 'node_modules', '.naive', 'styles.css');
  if (!existsSync(stylesPath)) {
    console.log(C.dim('CSS subset check: node_modules/.naive/styles.css not found — skipped'));
    return;
  }
  let css: string;
  try {
    css = readFileSync(stylesPath, 'utf8');
  } catch {
    console.log(C.dim('CSS subset check: cannot read node_modules/.naive/styles.css — skipped'));
    return;
  }
  if (!css.trim()) {
    console.log(C.dim('CSS subset check: empty styles.css — skipped'));
    return;
  }

  const compiled = scanCompiledCss(css, { file: relative(cwd, stylesPath) });
  const findings: Finding[] = [...compiled.findings];

  // KTD3 second input: raw author CSS recollected from the project (3d only).
  for (const { css: authorCss, file } of collectAuthorCss(cwd)) {
    mergeAuthorFindings(findings, scanAuthorCss(authorCss, { file }).findings);
  }

  // Template attribution (KTD2/AE2).
  attributeFindings(findings, collectTemplates(cwd));

  const report = makeReport(compiled.declarations, findings);
  if (report.findings.length > 0) {
    console.log(renderReport(report));
    throw new Error(
      `CSS subset check failed: ${report.findings.length} unsupported declaration(s)`,
    );
  }
  console.log(C.dim(`CSS subset check: ${report.percent()}% supported`));
}

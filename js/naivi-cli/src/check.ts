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

import { parse as parseCss } from 'postcss';
import type { AtRule, Declaration, Rule } from 'postcss';

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

// U1: CSS subset check core — kiln rule table ported to TS (postcss scan).
//
// Covers the plan's U1 test scenarios:
//  - float / sticky / fixed property hits with line/column
//  - :has() and whole-selector ::backdrop; the combined `*, ::before,
//    ::after, ::backdrop` preflight reset is NOT a hit
//  - @container / @scope at-rule hits
//  - 3d rule (KC1320): only on the author-written CSS input (KTD3 two-input
//    separation); translateZ(0) does not trigger
//  - dedup by (code, declaration); percent over the dedup'd count (KTD4)
//  - empty CSS -> 0 hits, percent 100; malformed CSS -> warn, never throw

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  extractTemplateClasses,
  renderReport,
  runCssSubsetCheck,
  scanAuthorCss,
  scanCompiledCss,
  utilityRuleForClass,
} from '../src/check.js';

describe('property rules', () => {
  it('reports float: left as KC1101 with line/column and parent selector origin', () => {
    const report = scanCompiledCss(
      [
        '.foo {',
        '  float: left;',
        '}',
      ].join('\n'),
      { file: 'styles.css' },
    );
    expect(report.declarations).toBe(1);
    expect(report.findings).toHaveLength(1);
    const f = report.findings[0];
    expect(f.code).toBe('KC1101');
    expect(f.declaration).toBe('float: left');
    expect(f.hint).toBe('use flexbox or grid');
    expect(f.line).toBe(2);
    expect(f.column).toBe(3);
    expect(f.origin).toBe('.foo');
    expect(f.file).toBe('styles.css');
  });

  it('reports position: sticky as KC1201 and position: fixed as KC1202', () => {
    const report = scanCompiledCss(
      [
        'a { position: sticky; }',
        'b { position: fixed; }',
        'c { position: absolute; }',
      ].join('\n'),
    );
    const codes = report.findings.map((f) => f.code).sort();
    expect(codes).toEqual(['KC1201', 'KC1202']);
    expect(report.declarations).toBe(3);
  });

  it('reports the rest of the property rule table with kiln codes/hints', () => {
    const css = [
      'text-overflow: ellipsis;', // invalid at top level — use a rule instead
    ].join('\n');
    const report = scanCompiledCss(
      [
        '.a { text-overflow: ellipsis; }', // KC1210
        '.b { display: table; }', // KC1102
        '.c { grid-template-columns: subgrid; }', // KC1103
        '.d { backdrop-filter: blur(4px); }', // KC1340
        '.e { mix-blend-mode: multiply; }', // KC1341
        '.f { writing-mode: vertical-rl; }', // KC1150
        '.g { contain: layout; }', // KC1160
        '.h { display: table-cell; }', // KC1102 (starts_with "table")
        '.i { text-overflow: ellipsis ellipsis; }', // KC1210 (starts_with "ellipsis")
      ].join('\n'),
    );
    const byCode = new Map(report.findings.map((f) => [f.code, f.hint]));
    expect(byCode.get('KC1210')).toBe('clips without an ellipsis — truncate the text yourself');
    expect(byCode.get('KC1102')).toBe('use flexbox or grid');
    expect(byCode.get('KC1103')).toBe('subgrid is not supported — restate the tracks');
    expect(byCode.get('KC1340')).toBe('filter: blur() on a sibling layer');
    expect(byCode.get('KC1341')).toBe('not supported — composite the colours yourself');
    expect(byCode.get('KC1150')).toBe('not supported');
    expect(byCode.get('KC1160')).toBe('not supported — no effect on layout');
    expect(report.declarations).toBe(9);
    // 9 declarations, 9 hits — `display: table` vs `display: table-cell` and
    // the two text-overflow values are distinct (code, declaration) pairs, so
    // KTD4 dedup does not merge them.
    expect(report.findings).toHaveLength(9);
  });
});

describe('selector rules', () => {
  it('reports a selector containing :has( as KC1002', () => {
    const report = scanCompiledCss('a:has(b) { color: red; }', { file: 'app.css' });
    const f = report.findings.find((x) => x.code === 'KC1002');
    expect(f).toBeDefined();
    expect(f?.hint).toBe('not supported — restructure or use a class');
    expect(f?.declaration).toBe('a:has(b)');
    expect(f?.line).toBe(1);
    expect(f?.column).toBe(1);
  });

  it('reports ::backdrop only as a whole selector (KC1003), not inside a preflight reset', () => {
    const css = [
      '::backdrop { background: black; }',
      '*, ::before, ::after, ::backdrop { box-sizing: border-box; }',
    ].join('\n');
    const report = scanCompiledCss(css);
    const backdrop = report.findings.filter((f) => f.code === 'KC1003');
    expect(backdrop).toHaveLength(1);
    expect(backdrop[0].declaration).toBe('::backdrop');
    expect(backdrop[0].line).toBe(1);
    // The preflight reset must NOT be flagged.
    expect(report.findings.filter((f) => f.declaration.includes('::before'))).toHaveLength(0);
  });
});

describe('at-rule rules', () => {
  it('reports @container as KC1401 and @scope as KC1402', () => {
    const report = scanCompiledCss(
      [
        '@container (min-width: 400px) {',
        '  .x { color: red; }',
        '}',
        '@scope (.a) {',
        '  .b { color: blue; }',
        '}',
      ].join('\n'),
    );
    const byCode = new Map(report.findings.map((f) => [f.code, f]));
    expect(byCode.get('KC1401')?.hint).toBe('not supported — use @media or a resize observer');
    expect(byCode.get('KC1401')?.declaration).toBe('@container');
    expect(byCode.get('KC1401')?.line).toBe(1);
    expect(byCode.get('KC1402')?.hint).toBe('not supported — scope with a class');
    expect(byCode.get('KC1402')?.declaration).toBe('@scope');
    expect(byCode.get('KC1402')?.line).toBe(4);
  });
});

describe('3d rule (KC1320) and the KTD3 two-input separation', () => {
  it('scanCompiledCss reports 3d transforms on the merged compiled CSS', () => {
    const report = scanCompiledCss('.x { transform: translate3d(0, 0, 0); }');
    expect(report.findings.map((f) => f.code)).toEqual(['KC1320']);
    expect(report.findings[0].hint).toBe('3D transforms are not supported — use the 2D subset');
  });

  it('scanCompiledCss reports perspective-valued transforms (value contains "perspective")', () => {
    const report = scanCompiledCss('.x { transform: perspective(500px); }');
    expect(report.findings.map((f) => f.code)).toEqual(['KC1320']);
  });

  it('translateZ(0) and 2D rotate/scale/translate do not trigger KC1320 (R3)', () => {
    const report = scanCompiledCss(
      [
        '.a { transform: translateZ(0); }',
        '.b { translate: 10px; }',
        '.c { rotate: 45deg; }',
        '.d { scale: 1.5; }',
        '.e { scale: 1 2; }',
      ].join('\n'),
    );
    expect(report.findings).toHaveLength(0);
    expect(report.declarations).toBe(5);
  });

  it('flags the Tailwind v4 3D utility surface (perspective / preserve-3d / rotate axis / 3-value scale)', () => {
    const report = scanCompiledCss(
      [
        '.a { perspective: 1000px; }',
        '.b { perspective-origin: center; }',
        '.c { transform-style: preserve-3d; }',
        '.d { rotate: x 45deg; }',
        '.e { scale: 1 1 1.5; }',
      ].join('\n'),
    );
    expect(report.findings).toHaveLength(5);
    expect(report.findings.every((f) => f.code === 'KC1320')).toBe(true);
  });

  it('scanAuthorCss applies ONLY the 3d rule (KTD3 carrier input)', () => {
    // Compiled CSS with float + 3d transform: the author-CSS scan must NOT
    // report the float (that is the compiled-CSS scan's job).
    const report = scanAuthorCss(
      [
        '.foo {',
        '  float: left;',
        '  transform: translate3d(0, 0, 0);',
        '}',
      ].join('\n'),
      { file: 'src/App.vue' },
    );
    expect(report.findings.map((f) => f.code)).toEqual(['KC1320']);
    expect(report.findings[0].declaration).toBe('transform: translate3d(0, 0, 0)');
    expect(report.findings[0].line).toBe(3);
  });
});

describe('dedup and percent (KTD4)', () => {
  it('dedups by (code, declaration) and counts occurrences as ×count', () => {
    const report = scanCompiledCss(
      [
        '.a { float: left; }',
        '.b { float: left; }',
        '.c { position: sticky; }',
        '.d { float: left; }',
      ].join('\n'),
    );
    expect(report.declarations).toBe(4);
    expect(report.findings).toHaveLength(2);
    const float = report.findings.find((f) => f.code === 'KC1101');
    const sticky = report.findings.find((f) => f.code === 'KC1201');
    expect(float?.count).toBe(3);
    expect(sticky?.count).toBe(1);
  });

  it('percent() uses the deduped finding count', () => {
    // 3 declarations, 2 of them the same (code, declaration) -> 1 deduped hit.
    const report = scanCompiledCss(
      [
        '.a { float: left; }',
        '.b { float: left; }',
        '.c { color: red; }',
      ].join('\n'),
    );
    expect(report.findings).toHaveLength(1);
    expect(report.supported()).toBe(2);
    expect(report.percent()).toBe(67);
  });

  it('percent() is 100 when everything is supported', () => {
    const report = scanCompiledCss('.a { color: red; }');
    expect(report.supported()).toBe(1);
    expect(report.percent()).toBe(100);
  });
});

describe('empty and malformed CSS (KTD4)', () => {
  it('empty CSS yields 0 hits, 0 declarations and percent 100', () => {
    const report = scanCompiledCss('');
    expect(report.declarations).toBe(0);
    expect(report.findings).toHaveLength(0);
    expect(report.percent()).toBe(100);
  });

  it('whitespace-only CSS is treated as empty', () => {
    const report = scanCompiledCss('  \n\n  ');
    expect(report.declarations).toBe(0);
    expect(report.percent()).toBe(100);
  });

  it('malformed CSS warns and never throws', () => {
    expect(() => scanCompiledCss('.foo { color: red;')).not.toThrow();
    const report = scanCompiledCss('.foo { color: "unclosed }');
    expect(report.declarations).toBe(0);
    expect(report.findings).toHaveLength(0);
    expect(report.percent()).toBe(100);
  });
});

describe('renderReport (kiln-shaped report text)', () => {
  it('renders declarations/supported/percent and per-finding code/hint/line:col', () => {
    const report = scanCompiledCss(
      [
        '.foo {',
        '  float: left;',
        '}',
      ].join('\n'),
      { file: 'styles.css' },
    );
    const text = renderReport(report);
    expect(text).toContain('declarations');
    expect(text).toContain('supported');
    expect(text).toContain('(0%)');
    expect(text).toContain('×1');
    expect(text).toContain('KC1101');
    expect(text).toContain('use flexbox or grid');
    expect(text).toContain('styles.css:2:3');
  });

  it('renders an empty report with percent 100 and no findings section', () => {
    const text = renderReport(scanCompiledCss(''));
    expect(text).toContain('(100%)');
    expect(text).not.toContain('×');
  });
});

// ── U2: template attribution + runCssSubsetCheck composite entry ────
//
// Fixtures are built in a tmp dir (node:fs mkdtempSync) and cleaned up —
// runCssSubsetCheck reads files relative to cwd only, so it never needs the
// real naivi monorepo.

afterEach(() => {
  vi.restoreAllMocks();
});

function makeFixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'naivi-check-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

/** Run runCssSubsetCheck capturing stdout; returns { text, error }. */
function runAndCapture(dir: string): { text: string; error: unknown } {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  let error: unknown;
  try {
    runCssSubsetCheck(dir);
  } catch (e) {
    error = e;
  }
  const text = spy.mock.calls.map((c) => String(c[0])).join('\n');
  return { text, error };
}

describe('extractTemplateClasses', () => {
  it('extracts static class attributes with 1-based positions', () => {
    const classes = extractTemplateClasses('<div class="float-left sticky">x</div>');
    expect([...classes.keys()]).toEqual(['float-left', 'sticky']);
    expect(classes.get('float-left')).toEqual({ line: 1, column: 13 });
    expect(classes.get('sticky')).toEqual({ line: 1, column: 24 });
  });

  it('extracts :class string literals but skips object/ternary bindings (KTD2)', () => {
    const template = [
      '<div :class="\'fixed\'">a</div>',
      '<div :class="{ active: isActive }">b</div>',
      '<div :class="cond ? \'x\' : \'y\'">c</div>',
      '<div :class="\'a b\'">d</div>',
    ].join('\n');
    const classes = extractTemplateClasses(template);
    expect(classes.has('fixed')).toBe(true);
    expect(classes.has('active')).toBe(false);
    expect(classes.has('x')).toBe(false);
    expect(classes.has('y')).toBe(false);
    expect(classes.has('a')).toBe(true);
    expect(classes.has('b')).toBe(true);
  });

  it('does not treat :class / @class / .class as a static class attribute', () => {
    const template = '<div :class="\'fixed\'" @class="handler" .class="x">y</div>';
    const classes = extractTemplateClasses(template);
    // Only `fixed` from the :class literal; `handler`/`x` are not classes.
    expect([...classes.keys()]).toEqual(['fixed']);
  });

  it('counts lines and columns across a multi-line template', () => {
    const template = ['<template>', '  <p class="a b"></p>', '</template>'].join('\n');
    const classes = extractTemplateClasses(template);
    expect(classes.get('a')).toEqual({ line: 2, column: 13 });
    expect(classes.get('b')).toEqual({ line: 2, column: 15 });
  });

  it('extracts from v-bind:class string literals', () => {
    const classes = extractTemplateClasses('<div v-bind:class="\'fixed\'">x</div>');
    expect(classes.has('fixed')).toBe(true);
  });
});

describe('utilityRuleForClass', () => {
  it('maps the plan list and natural extensions', () => {
    expect(utilityRuleForClass('float-left')).toBe('KC1101');
    expect(utilityRuleForClass('float-right')).toBe('KC1101');
    expect(utilityRuleForClass('sticky')).toBe('KC1201');
    expect(utilityRuleForClass('fixed')).toBe('KC1202');
    expect(utilityRuleForClass('table')).toBe('KC1102');
    expect(utilityRuleForClass('subgrid')).toBe('KC1103');
    expect(utilityRuleForClass('has-[.foo]')).toBe('KC1002');
    expect(utilityRuleForClass('container-[.foo]')).toBe('KC1401');
    expect(utilityRuleForClass('truncate')).toBe('KC1210');
    expect(utilityRuleForClass('backdrop-blur-sm')).toBe('KC1340');
    expect(utilityRuleForClass('mix-blend-multiply')).toBe('KC1341');
    expect(utilityRuleForClass('contain-layout')).toBe('KC1160');
  });

  it('returns undefined for business/unmappable class names (KTD2)', () => {
    expect(utilityRuleForClass('business-card')).toBeUndefined();
    expect(utilityRuleForClass('my-widget')).toBeUndefined();
    expect(utilityRuleForClass('flex')).toBeUndefined();
  });
});

describe('runCssSubsetCheck — template attribution (KTD2/AE2)', () => {
  it('attributes a compiled .float-left hit to the .vue static class= line (KC1101, AE1)', () => {
    const dir = makeFixture({
      'node_modules/.naive/styles.css': '.float-left{float:left}\n.x{color:red}\n',
      'src/App.vue': [
        '<template>',
        '  <div class="float-left">hi</div>',
        '</template>',
      ].join('\n'),
    });
    try {
      const { text, error } = runAndCapture(dir);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/CSS subset check failed: 1 unsupported/);
      expect(text).toContain('×1');
      expect(text).toContain('KC1101');
      expect(text).toContain('use flexbox or grid');
      expect(text).toContain('.float-left');
      expect(text).toContain('src/App.vue:2:15');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('attributes a compiled .fixed hit to the :class string-literal position (KC1202, AE2)', () => {
    const dir = makeFixture({
      'node_modules/.naive/styles.css': '.fixed{position:fixed}\n',
      'src/App.vue': [
        '<template>',
        '  <div :class="\'fixed\'">sticky header</div>',
        '</template>',
      ].join('\n'),
    });
    try {
      const { text, error } = runAndCapture(dir);
      expect(error).toBeInstanceOf(Error);
      expect(text).toContain('KC1202');
      expect(text).toContain('src/App.vue:2:17');
      expect(text).toContain('.fixed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not attribute when the template class maps to nothing (KTD2)', () => {
    const dir = makeFixture({
      'node_modules/.naive/styles.css': '.float-left{float:left}\n.my-widget{position:sticky}\n',
      'src/App.vue': [
        '<template>',
        '  <div class="float-left my-widget business-card">x</div>',
        '</template>',
      ].join('\n'),
    });
    try {
      const { text, error } = runAndCapture(dir);
      expect(error).toBeInstanceOf(Error);
      // float-left IS attributed (maps to KC1101)
      expect(text).toContain('src/App.vue:2:15');
      // my-widget does NOT map to KC1201 → stays at the compiled CSS
      expect(text).toContain('KC1201');
      expect(text).toContain('node_modules/.naive/styles.css:2:1');
      // exactly two findings — business-card adds nothing
      expect(text.match(/×/g)).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips template attribution with no .vue files — compiled CSS only', () => {
    const dir = makeFixture({
      'node_modules/.naive/styles.css': '.float-left{float:left}\n',
      'src/main.css': 'body{color:red}\n',
    });
    try {
      const { text, error } = runAndCapture(dir);
      expect(error).toBeInstanceOf(Error);
      expect(text).toContain('KC1101');
      expect(text).toContain('node_modules/.naive/styles.css:1:1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips template attribution for an empty <template>', () => {
    const dir = makeFixture({
      'node_modules/.naive/styles.css': '.float-left{float:left}\n',
      'src/App.vue': '<template></template>\n',
    });
    try {
      const { text, error } = runAndCapture(dir);
      expect(error).toBeInstanceOf(Error);
      expect(text).toContain('node_modules/.naive/styles.css:1:1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips with a dim note when styles.css is missing (KTD4)', () => {
    const dir = makeFixture({
      'src/App.vue': '<template><div class="float-left">x</div></template>\n',
    });
    try {
      const { text, error } = runAndCapture(dir);
      expect(error).toBeUndefined();
      expect(text).toContain('skipped');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runCssSubsetCheck — author-CSS 3d merge (KTD3)', () => {
  it('appends an author-CSS KC1320 finding; declarations stay from the compiled scan', () => {
    const dir = makeFixture({
      'node_modules/.naive/styles.css': '.a{color:red}\n.b{color:blue}\n',
      'src/main.css': '.hero{transform:perspective(500px)}\n',
    });
    try {
      const { text, error } = runAndCapture(dir);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/CSS subset check failed: 1 unsupported/);
      expect(text).toContain('KC1320');
      expect(text).toContain('3D transforms are not supported — use the 2D subset');
      // column = the declaration's property start inside `.hero{...}` (col 7)
      expect(text).toContain('src/main.css:1:7');
      expect(text).toMatch(/declarations\s+2/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('dedups an author 3d finding against the compiled scan — no double count, author location wins', () => {
    const dir = makeFixture({
      'node_modules/.naive/styles.css': '.hero{transform:perspective(500px)}\n.a{color:red}\n',
      'src/main.css': '.hero{transform:perspective(500px)}\n',
    });
    try {
      const { text, error } = runAndCapture(dir);
      expect(error).toBeInstanceOf(Error);
      expect(text).toContain('KC1320');
      expect(text).toContain('×1');
      expect(text).toContain('src/main.css:1:7');
      expect(text).not.toContain('node_modules/.naive/styles.css:1:1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runCssSubsetCheck — Tailwind 产物豁免 (U4 calibration)', () => {
  it('exempts a generated utility class that no template uses and is not authored (KC1202 .fixed)', () => {
    // Mirrors the todomvc case: Tailwind's oxide scanner picked `fixed` out
    // of a naivi.config.ts comment and compiled `.fixed { position: fixed }`,
    // but no template uses the class and no author CSS declares it — the
    // rule is generated cruft, never applied by the app.
    const dir = makeFixture({
      'node_modules/.naive/styles.css': '.fixed{position:fixed}\n.x{color:red}\n',
      'src/App.vue': '<template><div class="business-card">x</div></template>\n',
    });
    try {
      const { text, error } = runAndCapture(dir);
      expect(error).toBeUndefined();
      expect(text).toContain('100% supported');
      expect(text).not.toContain('KC1202');
      expect(text).not.toContain('×');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('KEEPS the hit when the utility class IS used in a template (author-chosen)', () => {
    const dir = makeFixture({
      'node_modules/.naive/styles.css': '.fixed{position:fixed}\n',
      'src/App.vue': '<template><div class="fixed">x</div></template>\n',
    });
    try {
      const { text, error } = runAndCapture(dir);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/CSS subset check failed: 1 unsupported/);
      expect(text).toContain('KC1202');
      // parseSfc strips the <template> wrapper, so `fixed` sits at template-
      // content column 13 (<div class="fixed">x</div>).
      expect(text).toContain('src/App.vue:1:13');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('KEEPS the hit with no .vue files — no template evidence of non-use', () => {
    const dir = makeFixture({
      'node_modules/.naive/styles.css': '.fixed{position:fixed}\n',
    });
    try {
      const { text, error } = runAndCapture(dir);
      expect(error).toBeInstanceOf(Error);
      expect(text).toContain('KC1202');
      // No template evidence → the compiled-CSS hit is kept, at the
      // declaration's property start (col 8 in `.fixed{position:fixed}`).
      expect(text).toContain('node_modules/.naive/styles.css:1:8');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('KEEPS the hit when the declaration is hand-written in author CSS (KTD3 second input)', () => {
    const dir = makeFixture({
      'node_modules/.naive/styles.css': '.fixed{position:fixed}\n',
      'src/App.vue': [
        '<template><div class="business-card">x</div></template>',
        '<style>.fixed{position:fixed}</style>',
      ].join('\n'),
    });
    try {
      const { text, error } = runAndCapture(dir);
      expect(error).toBeInstanceOf(Error);
      expect(text).toContain('KC1202');
      // The authored declaration keeps the strict hit (calibration never
      // drops hand-written CSS); like all non-3d findings it stays at the
      // compiled-CSS location (the KTD3 author merge only re-points 3d).
      expect(text).toContain('node_modules/.naive/styles.css:1:8');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runCssSubsetCheck — success path', () => {
  it('prints a dim confirmation and does not throw when everything is supported', () => {
    const dir = makeFixture({
      'node_modules/.naive/styles.css': '.a{color:red}\n.b{color:blue}\n',
      'src/App.vue': '<template><div class="business-card">x</div></template>\n',
    });
    try {
      const { text, error } = runAndCapture(dir);
      expect(error).toBeUndefined();
      expect(text).toContain('100% supported');
      expect(text).not.toContain('×');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('code-review followups (ce-code-review 073)', () => {
  it('applies the 3d rule only to transform/translate properties in author CSS (kiln parity)', () => {
    const report = scanAuthorCss(
      '.a{content:"3d"}\n.b{font-family:perspective}\n.c{transform:translate3d(0,0,0)}',
    );
    // Benign values containing "3d"/"perspective" on other properties must
    // NOT trip KC1320; only the transform/translate property does.
    expect(report.findings.map((f) => f.code)).toEqual(['KC1320']);
    expect(report.findings[0].declaration).toBe('transform: translate3d(0,0,0)');
  });

  it('never reports 100% supported when there are hits but zero declarations', () => {
    const report = scanCompiledCss('a:has(b) {}');
    expect(report.declarations).toBe(0);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].code).toBe('KC1002');
    expect(report.supported()).toBe(0);
    expect(report.percent()).toBe(0);
  });

  it('KEEPS the hit when a utility class is used via a non-literal :class binding (no silent pass)', () => {
    const dir = makeFixture({
      'node_modules/.naive/styles.css': '.fixed{position:fixed}\n',
      'src/App.vue': '<template><div :class="cond ? \'fixed\' : \'x\'">x</div></template>\n',
    });
    try {
      const { text, error } = runAndCapture(dir);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/CSS subset check failed: 1 unsupported/);
      expect(text).toContain('KC1202');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not treat commented-out classes as usage — the exemption still applies', () => {
    const dir = makeFixture({
      'node_modules/.naive/styles.css': '.fixed{position:fixed}\n.x{color:red}\n',
      'src/App.vue': [
        '<template>',
        '<!-- <div class="fixed"></div> -->',
        '<div class="business-card">x</div>',
        '</template>',
      ].join('\n'),
    });
    try {
      const { text, error } = runAndCapture(dir);
      expect(error).toBeUndefined();
      expect(text).toContain('100% supported');
      expect(text).not.toContain('KC1202');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats index.html class usage as usage — a hit used there is not exempted', () => {
    const dir = makeFixture({
      'node_modules/.naive/styles.css': '.fixed{position:fixed}\n',
      'index.html': '<div id="app" class="fixed"></div>\n',
    });
    try {
      const { text, error } = runAndCapture(dir);
      expect(error).toBeInstanceOf(Error);
      expect(text).toContain('KC1202');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not attribute/exempt a pseudo-variant selector hit — stays at the compiled CSS line', () => {
    const dir = makeFixture({
      'node_modules/.naive/styles.css': '.float-left:hover{float:left}\n',
      'src/App.vue': '<template><div class="float-left">x</div></template>\n',
    });
    try {
      const { text, error } = runAndCapture(dir);
      expect(error).toBeInstanceOf(Error);
      expect(text).toContain('KC1101');
      expect(text).toContain('node_modules/.naive/styles.css');
      expect(text).not.toContain('App.vue');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a tag-selector hit that is not a known utility class', () => {
    const dir = makeFixture({
      'node_modules/.naive/styles.css': 'div{position:fixed}\n',
      'src/App.vue': '<template><div class="business-card">x</div></template>\n',
    });
    try {
      const { text, error } = runAndCapture(dir);
      expect(error).toBeInstanceOf(Error);
      expect(text).toContain('KC1202');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips with a dim note when styles.css exists but is empty (KTD4)', () => {
    const dir = makeFixture({
      'node_modules/.naive/styles.css': '',
      'src/App.vue': '<template><div class="float-left">x</div></template>\n',
    });
    try {
      const { text, error } = runAndCapture(dir);
      expect(error).toBeUndefined();
      expect(text).toContain('empty styles.css');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the utility→rule mapping in lockstep with the CSS-side rule table', () => {
    const cases: Array<[string, string]> = [
      ['float-left', '.x{float:left}'],
      ['sticky', '.x{position:sticky}'],
      ['fixed', '.x{position:fixed}'],
      ['table', '.x{display:table}'],
      ['subgrid', '.x{grid-template-columns:subgrid}'],
      ['truncate', '.x{text-overflow:ellipsis}'],
      ['backdrop-blur-sm', '.x{backdrop-filter:blur(4px)}'],
      ['mix-blend-multiply', '.x{mix-blend-mode:multiply}'],
      ['contain-layout', '.x{contain:layout}'],
    ];
    for (const [cls, css] of cases) {
      const code = utilityRuleForClass(cls);
      const codes = new Set(scanCompiledCss(css).findings.map((f) => f.code));
      expect(codes.has(code as string)).toBe(true);
    }
    expect(scanCompiledCss('a:has(b){}').findings[0].code).toBe('KC1002');
    expect(scanCompiledCss('@container (min-width:400px){.a{color:red}}').findings[0].code)
      .toBe('KC1401');
  });

  it('fails the check when the compiled styles.css cannot be parsed (fail-closed, R1)', () => {
    const dir = makeFixture({
      'node_modules/.naive/styles.css': '.foo { color: red;\n',
      'src/App.vue': '<template><div class="business-card">x</div></template>\n',
    });
    try {
      const { error } = runAndCapture(dir);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/Cannot parse CSS/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('scanCompiledCss still warns (never throws) on malformed CSS by default (KTD4)', () => {
    const report = scanCompiledCss('.foo { color: red;');
    expect(report.declarations).toBe(0);
    expect(report.findings).toHaveLength(0);
    expect(report.percent()).toBe(100);
  });

  it('scanCompiledCss throws with strictParse — the compiled gate input (R1)', () => {
    expect(() => scanCompiledCss('.foo { color: red;', { strictParse: true }))
      .toThrow(/Cannot parse CSS/);
  });
});

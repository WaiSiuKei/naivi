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

import { describe, expect, it } from 'vitest';

import { renderReport, scanAuthorCss, scanCompiledCss } from '../src/check.js';

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

  it('translateZ(0) and a bare perspective property do not trigger KC1320 (kiln rule text)', () => {
    const report = scanCompiledCss(
      [
        '.a { transform: translateZ(0); }',
        '.b { perspective: 1000px; }',
        '.c { translate: 10px; }',
      ].join('\n'),
    );
    expect(report.findings).toHaveLength(0);
    expect(report.declarations).toBe(3);
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

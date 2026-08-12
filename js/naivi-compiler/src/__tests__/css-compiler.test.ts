// css-compiler.test.ts — Unit tests for the CSS compilation pipeline.
import { describe, it, expect } from 'vitest';
import { compileCSSFull, type CSSElement } from '../css-compiler.js';

// ── Test helpers ────────────────────────────────────────────────────

function makeNode(
  id: number,
  tag: string = 'view',
  parent: number | null = null,
  opts?: { classes?: string[]; elementId?: string; attrs?: Record<string, string> }
): CSSElement {
  return {
    id,
    tag,
    parent,
    classes: opts?.classes,
    elementId: opts?.elementId,
    attrs: opts?.attrs,
  };
}

function getStyles(
  result: Record<string, Record<string, string | number>>,
  id: number
): Record<string, string | number> | undefined {
  return result[String(id)];
}

// ── Tests ───────────────────────────────────────────────────────────

describe('compileCSSFull', () => {
  it('parses a single class rule with one declaration', () => {
    const nodes = [
      makeNode(0, 'view', null, { classes: ['box'] }),
    ];
    const result = compileCSSFull('.box { padding: 8px; }', nodes);
    const s = getStyles(result, 0);
    expect(s).toBeDefined();
    expect(s!['padding-top']).toBe(8);
    expect(s!['padding-right']).toBe(8);
    expect(s!['padding-bottom']).toBe(8);
    expect(s!['padding-left']).toBe(8);
  });

  it('parses multiple declarations per rule', () => {
    const nodes = [
      makeNode(0, 'view', null, { classes: ['card'] }),
    ];
    const result = compileCSSFull('.card { display: flex; gap: 16px; opacity: 0.8; }', nodes);
    const s = getStyles(result, 0);
    expect(s).toBeDefined();
    expect(s!['display']).toBe('flex');
    expect(s!['gap']).toBe(16);
    expect(s!['opacity']).toBe(0.8);
  });

  it('matches by tag selector', () => {
    const nodes = [
      makeNode(0, 'button'),
      makeNode(1, 'view'),
    ];
    const result = compileCSSFull('button { cursor: pointer; }', nodes);
    expect(getStyles(result, 0)?.['cursor']).toBe('pointer');
    expect(getStyles(result, 1)).toBeUndefined();
  });

  it('matches by class selector', () => {
    const nodes = [
      makeNode(0, 'view', null, { classes: ['btn', 'primary'] }),
      makeNode(1, 'view', null, { classes: ['btn'] }),
      makeNode(2, 'view', null, { classes: ['other'] }),
    ];
    const result = compileCSSFull('.btn { border-radius: 4px; }', nodes);
    expect(getStyles(result, 0)?.['border-radius']).toBe(4);
    expect(getStyles(result, 1)?.['border-radius']).toBe(4);
    expect(getStyles(result, 2)).toBeUndefined();
  });

  it('matches compound class selectors', () => {
    const nodes = [
      makeNode(0, 'view', null, { classes: ['btn', 'primary'] }),
      makeNode(1, 'view', null, { classes: ['btn'] }),
    ];
    const result = compileCSSFull('.btn.primary { background-color: #3b82f6; }', nodes);
    expect(getStyles(result, 0)?.['background-color']).toBe('#3b82f6');
    expect(getStyles(result, 1)).toBeUndefined();
  });

  it('matches by ID selector', () => {
    const nodes = [
      makeNode(0, 'view', null, { elementId: 'app' }),
      makeNode(1, 'view', null, { elementId: 'other' }),
    ];
    const result = compileCSSFull('#app { width: 100%; }', nodes);
    expect(getStyles(result, 0)?.['width']).toBe('100%');
    expect(getStyles(result, 1)).toBeUndefined();
  });

  it('matches descendant combinator', () => {
    const nodes = [
      makeNode(0, 'view', null, { classes: ['parent'] }),
      makeNode(1, 'view', 0, { classes: ['child'] }),
      makeNode(2, 'view', null, { classes: ['child'] }), // not under .parent
    ];
    const result = compileCSSFull('.parent .child { color: #ff0000; }', nodes);
    expect(getStyles(result, 1)?.['color']).toBe('#ff0000');
    expect(getStyles(result, 2)).toBeUndefined();
  });

  it('matches attribute selector', () => {
    const nodes = [
      makeNode(0, 'button', null, { attrs: { disabled: '' } }),
      makeNode(1, 'button', null),
    ];
    const result = compileCSSFull('[disabled] { opacity: 0.5; }', nodes);
    expect(getStyles(result, 0)?.['opacity']).toBe(0.5);
    expect(getStyles(result, 1)).toBeUndefined();
  });

  it('resolves CSS variables', () => {
    const nodes = [
      makeNode(0, 'view', null, { classes: ['btn'] }),
    ];
    const result = compileCSSFull(
      ':root { --primary: #3b82f6; } .btn { background-color: var(--primary); }',
      nodes
    );
    expect(getStyles(result, 0)?.['background-color']).toBe('#3b82f6');
  });

  it('resolves var() with fallback', () => {
    const nodes = [
      makeNode(0, 'view', null, { classes: ['txt'] }),
    ];
    const result = compileCSSFull(
      '.txt { color: var(--unknown, #333333); }',
      nodes
    );
    expect(getStyles(result, 0)?.['color']).toBe('#333333');
  });

  it('parses hex colors', () => {
    const nodes = [makeNode(0, 'view', null, { classes: ['x'] })];
    const result = compileCSSFull('.x { color: #ff0000; background-color: #00ff00; }', nodes);
    expect(getStyles(result, 0)?.['color']).toBe('#ff0000');
    expect(getStyles(result, 0)?.['background-color']).toBe('#00ff00');
  });

  it('parses rgb/rgba colors', () => {
    const nodes = [makeNode(0, 'view', null, { classes: ['x'] })];
    const result = compileCSSFull('.x { color: rgb(255, 0, 0); background-color: rgba(0,0,255,0.5); }', nodes);
    expect(getStyles(result, 0)?.['color']).toBe('#ff0000');
    const bg = getStyles(result, 0)?.['background-color'] as string | undefined;
    expect(bg).toBeDefined();
    expect(bg!.startsWith('#')).toBe(true);
  });

  it('parses percentage values', () => {
    const nodes = [makeNode(0, 'view', null, { classes: ['full'] })];
    const result = compileCSSFull('.full { width: 100%; height: 50%; }', nodes);
    expect(getStyles(result, 0)?.['width']).toBe('100%');
    expect(getStyles(result, 0)?.['height']).toBe('50%');
  });

  it('maps flexbox properties', () => {
    const nodes = [makeNode(0, 'view', null, { classes: ['flex'] })];
    const result = compileCSSFull(
      '.flex { display: flex; flex-direction: column; justify-content: center; align-items: flex-start; }',
      nodes
    );
    const s = getStyles(result, 0)!;
    expect(s['display']).toBe('flex');
    expect(s['flex-direction']).toBe('column');
    expect(s['justify-content']).toBe('center');
    expect(s['align-items']).toBe('start');
  });

  it('silently drops unknown properties', () => {
    const nodes = [makeNode(0, 'view', null, { classes: ['x'] })];
    const result = compileCSSFull('.x { box-shadow: 0 0 10px red; padding: 8px; }', nodes);
    // box-shadow is dropped, padding is kept
    expect(getStyles(result, 0)?.['padding-top']).toBe(8);
    expect(getStyles(result, 0)?.['box-shadow']).toBeUndefined();
  });

  it('handles empty stylesheet', () => {
    const nodes = [makeNode(0, 'view')];
    const result = compileCSSFull('', nodes);
    expect(Object.keys(result).length).toBe(0);
  });

  it('handles no matching rules', () => {
    const nodes = [makeNode(0, 'view', null, { classes: ['foo'] })];
    const result = compileCSSFull('.bar { color: red; }', nodes);
    expect(Object.keys(result).length).toBe(0);
  });

  it('strips CSS comments', () => {
    const nodes = [makeNode(0, 'view', null, { classes: ['x'] })];
    const result = compileCSSFull('/* comment */ .x { /* inner */ color: red; }', nodes);
    expect(getStyles(result, 0)?.['color']).toBe('#ff0000');
  });

  it('expands 2-value shorthand padding', () => {
    const nodes = [makeNode(0, 'view', null, { classes: ['box'] })];
    const result = compileCSSFull('.box { padding: 8px 16px; }', nodes);
    // top/bottom = 8, left/right = 16
    expect(getStyles(result, 0)?.['padding-top']).toBe(8);
    expect(getStyles(result, 0)?.['padding-bottom']).toBe(8);
    expect(getStyles(result, 0)?.['padding-left']).toBe(16);
    expect(getStyles(result, 0)?.['padding-right']).toBe(16);
  });

  it('expands 3-value shorthand margin', () => {
    const nodes = [makeNode(0, 'view', null, { classes: ['box'] })];
    const result = compileCSSFull('.box { margin: 4px 8px 12px; }', nodes);
    // top=4, left/right=8, bottom=12
    expect(getStyles(result, 0)?.['margin-top']).toBe(4);
    expect(getStyles(result, 0)?.['margin-right']).toBe(8);
    expect(getStyles(result, 0)?.['margin-bottom']).toBe(12);
    expect(getStyles(result, 0)?.['margin-left']).toBe(8);
  });

  it('expands 4-value shorthand padding', () => {
    const nodes = [makeNode(0, 'view', null, { classes: ['box'] })];
    const result = compileCSSFull('.box { padding: 1px 2px 3px 4px; }', nodes);
    expect(getStyles(result, 0)?.['padding-top']).toBe(1);
    expect(getStyles(result, 0)?.['padding-right']).toBe(2);
    expect(getStyles(result, 0)?.['padding-bottom']).toBe(3);
    expect(getStyles(result, 0)?.['padding-left']).toBe(4);
  });

  it('handles padding longhand properties', () => {
    const nodes = [makeNode(0, 'view', null, { classes: ['box'] })];
    const result = compileCSSFull('.box { padding-top: 8px; padding-left: 16px; }', nodes);
    expect(getStyles(result, 0)?.['padding-top']).toBe(8);
    expect(getStyles(result, 0)?.['padding-left']).toBe(16);
    expect(getStyles(result, 0)?.['padding-right']).toBeUndefined();
  });

  it('maps flex-grow and flex-shrink', () => {
    const nodes = [makeNode(0, 'view', null, { classes: ['grow'] })];
    const result = compileCSSFull('.grow { flex-grow: 1; flex-shrink: 0; }', nodes);
    expect(getStyles(result, 0)?.['flex-grow']).toBe(1);
    expect(getStyles(result, 0)?.['flex-shrink']).toBe(0);
  });

  it('maps cursor values', () => {
    const nodes = [makeNode(0, 'view', null, { classes: ['click'] })];
    const result = compileCSSFull('.click { cursor: pointer; }', nodes);
    expect(getStyles(result, 0)?.['cursor']).toBe('pointer');
  });

  it('maps transform scale', () => {
    const nodes = [makeNode(0, 'view', null, { classes: ['scale'] })];
    const result = compileCSSFull('.scale { transform: scale(0.95); }', nodes);
    expect(getStyles(result, 0)?.['scale']).toBe(0.95);
  });

  it('maps flex-wrap', () => {
    const nodes = [makeNode(0, 'view', null, { classes: ['wrap'] })];
    const result = compileCSSFull('.wrap { flex-wrap: wrap; }', nodes);
    expect(getStyles(result, 0)?.['flex-wrap']).toBe('wrap');
  });

  it('maps visibility hidden to visibility (plan 066 R6)', () => {
    const nodes = [makeNode(0, 'view', null, { classes: ['hide'] })];
    const result = compileCSSFull('.hide { visibility: hidden; }', nodes);
    // visibility:hidden keeps layout but is not painted / not hittable; it
    // must no longer degrade to display:none (which collapses layout).
    expect(getStyles(result, 0)?.['visibility']).toBe('hidden');
    expect(getStyles(result, 0)?.['display']).toBeUndefined();
  });

  it('does not emit a mapping for visibility visible', () => {
    const nodes = [makeNode(0, 'view', null, { classes: ['show'] })];
    const result = compileCSSFull('.show { visibility: visible; }', nodes);
    // 'visible' is the default; no explicit rule is needed.
    expect(getStyles(result, 0)?.['visibility']).toBeUndefined();
    expect(getStyles(result, 0)?.['display']).toBeUndefined();
  });

  it('passes through font-weight', () => {
    const nodes = [makeNode(0, 'view', null, { classes: ['bold'] })];
    const result = compileCSSFull('.bold { font-weight: bold; }', nodes);
    expect(getStyles(result, 0)?.['font-weight']).toBe('bold');
  });

  it('passes through text-align', () => {
    const nodes = [makeNode(0, 'view', null, { classes: ['center'] })];
    const result = compileCSSFull('.center { text-align: center; }', nodes);
    expect(getStyles(result, 0)?.['text-align']).toBe('center');
  });

  it('expands border shorthand', () => {
    const nodes = [makeNode(0, 'view', null, { classes: ['box'] })];
    const result = compileCSSFull('.box { border: 1px solid #ff0000; }', nodes);
    expect(getStyles(result, 0)?.['border-width']).toBe(1);
    expect(getStyles(result, 0)?.['border-color']).toBe('#ff0000');
  });

  it('expands flex: 1 shorthand', () => {
    const nodes = [makeNode(0, 'view', null, { classes: ['item'] })];
    const result = compileCSSFull('.item { flex: 1; }', nodes);
    expect(getStyles(result, 0)?.['flex-grow']).toBe(1);
    expect(getStyles(result, 0)?.['flex-shrink']).toBe(1);
    expect(getStyles(result, 0)?.['flex-basis']).toBe(0);
  });

  it('expands flex: 1 0 auto shorthand', () => {
    const nodes = [makeNode(0, 'view', null, { classes: ['item'] })];
    const result = compileCSSFull('.item { flex: 1 0 auto; }', nodes);
    expect(getStyles(result, 0)?.['flex-grow']).toBe(1);
    expect(getStyles(result, 0)?.['flex-shrink']).toBe(0);
    expect(getStyles(result, 0)?.['flex-basis']).toBe('auto');
  });

  it('expands flex: none shorthand', () => {
    const nodes = [makeNode(0, 'view', null, { classes: ['item'] })];
    const result = compileCSSFull('.item { flex: none; }', nodes);
    expect(getStyles(result, 0)?.['flex-grow']).toBe(0);
    expect(getStyles(result, 0)?.['flex-shrink']).toBe(0);
    expect(getStyles(result, 0)?.['flex-basis']).toBe('auto');
  });

  it('extracts color from background shorthand', () => {
    const nodes = [makeNode(0, 'view', null, { classes: ['bg'] })];
    const result = compileCSSFull('.bg { background: #eee; }', nodes);
    expect(getStyles(result, 0)?.['background-color']).toBe('#eeeeee');
  });
});

// integration.test.ts — End-to-end CSS pipeline tests
import { describe, it, expect } from 'vitest';
import { compileCSSFull, type CSSElement } from '../css-compiler.js';

describe('CSS pipeline integration', () => {
  it('compiles real-world CSS with variables', () => {
    const nodes: CSSElement[] = [
      { id: 0, tag: 'view', parent: null, classes: ['container'] },
      { id: 1, tag: 'view', parent: 0, classes: ['card'] },
      { id: 2, tag: 'view', parent: 1, classes: ['title'] },
    ];
    const css = `
      :root { --primary: #3b82f6; --spacing: 16px; }
      .container { display: flex; flex-direction: column; gap: 8px; }
      .card { padding: var(--spacing); border-radius: 8px; background-color: #fff; }
      .title { font-size: 20px; color: var(--primary); cursor: pointer; }
    `;
    const result = compileCSSFull(css, nodes);
    
    const container = result['0'];
    expect(container).toBeDefined();
    expect(container!['display']).toBe('flex');
    expect(container!['flex-direction']).toBe('column');
    expect(container!['gap']).toBe(8);
    
    const card = result['1'];
    expect(card).toBeDefined();
    expect(card!['padding-top']).toBe(16);
    expect(card!['border-radius']).toBe(8);
    expect(card!['background-color']).toBe('#ffffff');
    
    const title = result['2'];
    expect(title).toBeDefined();
    expect(title!['font-size']).toBe(20);
    expect(title!['color']).toBe('#3b82f6');
    expect(title!['cursor']).toBe('pointer');
  });

  it('handles descendant combinator with nested elements', () => {
    const nodes: CSSElement[] = [
      { id: 0, tag: 'view', parent: null, classes: ['form'] },
      { id: 1, tag: 'view', parent: 0, classes: ['input'] },
      { id: 2, tag: 'view', parent: 1, classes: ['input'] },
      { id: 3, tag: 'view', parent: null, classes: ['input'] },
    ];
    const css = '.form .input { border-radius: 4px; }';
    const result = compileCSSFull(css, nodes);
    
    expect(result['1']?.['border-radius']).toBe(4);
    expect(result['2']?.['border-radius']).toBe(4);
    expect(result['3']?.['border-radius']).toBeUndefined();
  });

  it('ignores @media and @keyframes, keeps style rules', () => {
    const nodes: CSSElement[] = [
      { id: 0, tag: 'view', parent: null, classes: ['x'] },
    ];
    const css = '@media (max-width: 600px) { .x { color: red; } } @keyframes spin { from { transform: rotate(0deg); } } .x { padding: 8px; }';
    const result = compileCSSFull(css, nodes);
    expect(result['0']?.['padding-top']).toBe(8);
    expect(result['0']?.['color']).toBeUndefined();
  });
});

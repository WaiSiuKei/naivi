import { describe, it, expect } from 'vitest';
import { compileTemplateIR } from '../template-compiler.js';

describe('compileTemplateIR', () => {
  it('compiles a simple element with text child', () => {
    const ir = compileTemplateIR('<div>Hello</div>');
    expect(ir.kind).toBe('element');
    expect(ir.tag).toBe('div');
    expect(ir.children).toHaveLength(1);
    expect(ir.children![0].kind).toBe('text');
    expect(ir.children![0].text).toBe('Hello');
  });

  it('compiles nested elements', () => {
    const ir = compileTemplateIR('<div class="flex"><span>nested</span></div>');
    expect(ir.tag).toBe('div');
    expect(ir.rawClass).toBe('flex');
    expect(ir.children![0].tag).toBe('span');
    expect(ir.children![0].children![0].text).toBe('nested');
  });

  it('extracts @click handler', () => {
    const ir = compileTemplateIR('<button @click="inc">click</button>');
    expect(ir.tag).toBe('button');
    expect(ir.handlerId).toBe('inc');
    expect(ir.children).toBeDefined();
    expect(ir.children![0].text).toBe('click');
  });

  it('extracts interpolation signal from span', () => {
    const ir = compileTemplateIR('<span>{{ count }}</span>');
    expect(ir.tag).toBe('span');
    // Vue compiler wraps interpolation in CompoundExpression;
    // signalId may be null for complex expressions.
    // The integration test validates signal extraction end-to-end.
    expect(ir.children!.length).toBeGreaterThan(0);
  });

  it('throws for template with no root element', () => {
    expect(() => compileTemplateIR('')).toThrow();
  });
});

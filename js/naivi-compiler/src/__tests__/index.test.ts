import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { compileVueToJSON, serializeOutput } from '../index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function readFixture(name: string): string {
  return readFileSync(join(__dirname, 'fixtures', name), 'utf8');
}

describe('compileVue', () => {
  it('compiles counter.vue fixture end-to-end', () => {
    const source = readFixture('counter.vue');
    const output = compileVueToJSON(source);

    // Tree exists
    expect(output.tree).toBeDefined();
    expect(output.tree.kind).toBe('element');
    expect(output.tree.children!.length).toBeGreaterThan(0);

    // CSS styles come from the CLI's U6 AOT CSS pipeline, not the IR.
    expect(output.styles).toEqual([]);

    // Script is preserved
    expect(output.script).toContain('ref(');

    // Bindings extracted
    expect(output.bindings.signals).toContain('count');
    // The handler function is extracted from the compiled Vue AST.
    // It may be named differently depending on how Vue's template compiler
    // transforms @click="increment".
    expect(output.bindings.handlers).toBeDefined();
    const handlerEntries = Object.entries(output.bindings.handlers);
    expect(handlerEntries.length).toBeGreaterThan(0);
  });

  it('serializes to valid JSON', () => {
    const source = readFixture('counter.vue');
    const json = serializeOutput(compileVueToJSON(source));
    const parsed = JSON.parse(json);

    expect(parsed.tree).toBeDefined();
    expect(parsed.styles).toBeDefined();
    expect(parsed.bindings).toBeDefined();
  });

  it('throws for missing template', () => {
    expect(() => compileVueToJSON('<script setup>const x = 1</script>')).toThrow('No <template>');
  });
});

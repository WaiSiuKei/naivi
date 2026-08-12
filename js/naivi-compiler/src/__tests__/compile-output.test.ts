import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { compileVueToJSON } from '../compile-vue-to-json.js';

const counterSource = readFileSync(
  fileURLToPath(new URL('./fixtures/counter.vue', import.meta.url)),
  'utf8',
);

describe('compileVueToJSON', () => {
  it('produces a complete CompileOutput for counter.vue', () => {
    const output = compileVueToJSON(counterSource);

    expect(output.tree.kind).toBe('element');
    expect(output.tree.children?.length).toBeGreaterThan(0);
    // Class styles come from the runtime styles.json pipeline, not the IR.
    expect(output.styles).toEqual([]);
    expect(output.script).toContain('ref');
    expect(Object.keys(output.bindings.handlers).length).toBeGreaterThan(0);
    expect(output.bindings.signals).toContain('count');
  });
});

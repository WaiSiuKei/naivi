// Compose the full compiler pipeline into a single `CompileOutput` producer.

import type { CompileOutput, StyleRecord } from './ir-types.js';
import { analyzeBindings } from './script-analyzer.js';
import { getScriptContent, getTemplateContent, parseSFC } from './sfc-parser.js';
import { compileTemplateIR } from './template-compiler.js';

/** Compile a `.vue` source string into a complete `CompileOutput`. */
export function compileVueToJSON(source: string): CompileOutput {
  const { descriptor } = parseSFC(source);
  const tree = compileTemplateIR(getTemplateContent(descriptor));
  const script = getScriptContent(descriptor);

  // CSS styles are produced by the CLI's U6 AOT CSS pipeline (compile.ts →
  // styles.css → __NAIVE_CSS → stylo); the static IR carries no styles.
  const styles: StyleRecord[] = [];
  const bindings = analyzeBindings(tree, script);
  return { tree, styles, script, bindings };
}

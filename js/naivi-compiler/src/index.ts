// @naive/compiler — build-time optimizer for naive.
//
// Compiler does build-time IR generation. CSS styles are produced by the
// CLI's U6 AOT CSS pipeline (`naivi-cli` `compile.ts` → `styles.css` →
// `__NAIVE_CSS` → stylo), not by the static IR or a Tailwind re-parser.

export { parseSFC, getTemplateContent, getScriptContent, getSfcStyles, compileSfcStyles } from './sfc-parser.js';
export { compileCSS, compileCSSFull } from './css-compiler.js';
export { compileVueToJSON } from './compile-vue-to-json.js';
export { serializeOutput } from './ir-types.js';
export type { CSSElement, CSSRule } from './css-compiler.js';
export type { CompileOutput, RenderTreeIR, StyleRecord, VariantProperties } from './ir-types.js';

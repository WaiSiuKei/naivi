// @naive/compiler — build-time optimizer for naive.
//
// Compiler does build-time IR generation. Class styles are produced by the
// CLI's single-source styles.json pipeline, not by a Tailwind re-parser.

export { parseSFC, getTemplateContent, getScriptContent, getSfcStyles, compileSfcStyles } from './sfc-parser.js';
export { compileCSS, compileCSSFull } from './css-compiler.js';
export { compileVueToJSON } from './compile-vue-to-json.js';
export { serializeOutput } from './ir-types.js';
export type { CSSElement, CSSRule } from './css-compiler.js';
export type { CompileOutput, RenderTreeIR, StyleRecord, VariantProperties } from './ir-types.js';

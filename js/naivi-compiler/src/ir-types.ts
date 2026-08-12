// IR type definitions for the naive compiler pipeline.
// These types define the declarative IR that naive-core consumes at startup.

/** A single node in the RenderTree IR. */
export interface RenderTreeIR {
  kind: 'element' | 'text';
  /** HTML tag name (element only). */
  tag?: string;
  /** Static text content (text only). */
  text?: string;
  /** Signal name for dynamic text binding (text interpolation). */
  signalId?: string;
  /** Child nodes (element only). */
  children?: RenderTreeIR[];
  /** Index into the styles table (element only). */
  styleId?: number;
  /** Event handler function name (from @click attribute). */
  handlerId?: string;
  /** Raw class string before compilation (for debugging). */
  rawClass?: string;
}

/** Per-variant style properties. */
export interface VariantProperties {
  base: Record<string, string | number>;
  focus?: Record<string, string | number>;
  active?: Record<string, string | number>;
  hover?: Record<string, string | number>;
}

/** A single compiled Style record in the styles table. */
export interface StyleRecord {
  /** Unique selector ID for this style record. */
  id: number;
  /** Compiled style properties, split by variant. */
  properties: VariantProperties;
}

/** Extracted bindings from template + script analysis. */
export interface Bindings {
  /** Maps node handler IDs to script function names. */
  handlers: Record<string, string>;
  /** Signal variable names referenced in the template. */
  signals: string[];
}

/** Complete compiler output. */
export interface CompileOutput {
  /** RenderTree IR for the template. */
  tree: RenderTreeIR;
  /** Compiled Tailwind style table (deduplicated). */
  styles: StyleRecord[];
  /** Original <script setup> source code. */
  script: string;
  /** Extracted handler and signal bindings. */
  bindings: Bindings;
}

/** Serialize CompileOutput to JSON string. */
export function serializeOutput(output: CompileOutput): string {
  return JSON.stringify(output, null, 2);
}

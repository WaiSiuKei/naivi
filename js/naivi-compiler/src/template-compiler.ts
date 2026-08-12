// Template Compiler — converts Vue template AST to RenderTree IR.
//
// Walks the AST produced by @vue/compiler-sfc's compiler and produces
// a declarative JSON IR suitable for naive-core consumption.

import { compileTemplate, type SFCTemplateCompileResults } from '@vue/compiler-sfc';
import type { RenderTreeIR } from './ir-types.js';

/** The AST node types we handle from Vue's template compiler. */
interface VueASTNode {
  type: number;       // 0=ROOT, 1=ELEMENT, 2=TEXT, 5=INTERPOLATION, 8=COMPOUND
  tag?: string;
  children?: VueASTNode[];
  content?: string;   // TEXT / INTERPOLATION
  props?: VueProp[];
  loc?: { source: string };
}

interface VueProp {
  type: number;       // 6=ATTRIBUTE, 7=DIRECTIVE
  name: string;
  arg?: { type: number; content?: string; loc?: { source: string } };
  exp?: { type: number; content?: string; loc?: { source: string } };
  value?: { content?: string; loc?: { source: string } };
}

/** AST node type constants from @vue/compiler-core. */
const NodeTypes = {
  ROOT: 0,
  ELEMENT: 1,
  TEXT: 2,
  INTERPOLATION: 5,
  COMPOUND_EXPRESSION: 8,
} as const;

/** Prop type constants. */
const PropTypes = {
  ATTRIBUTE: 6,
  DIRECTIVE: 7,
} as const;

let _nodeCounter = 0;

/** Compile a template string to RenderTree IR. */
export function compileTemplateIR(templateContent: string): RenderTreeIR {
  _nodeCounter = 0;

  const compiled = compileTemplate({
    source: templateContent,
    id: 'app',
    filename: 'App.vue',
    compilerOptions: { mode: 'module' },
  });

  // Walk the compiled AST via private internals.
  const ast = (compiled as unknown as { ast: VueASTNode }).ast;
  if (!ast || !ast.children || ast.children.length === 0) {
    throw new Error('Template compilation produced no AST nodes');
  }

  // Find the first element child of the root.
  const rootChild = ast.children.find(c => c.type === NodeTypes.ELEMENT);
  if (!rootChild) {
    throw new Error('Template must contain at least one root element');
  }

  return walkNode(rootChild);
}

function walkNode(node: VueASTNode): RenderTreeIR {
  if (node.type === NodeTypes.TEXT) {
    return {
      kind: 'text',
      text: (node.content ?? '').trim(),
    };
  }

  if (node.type === NodeTypes.INTERPOLATION) {
    return {
      kind: 'text',
      signalId: extractSignalName(node),
    };
  }

  if (node.type === NodeTypes.ELEMENT) {
    const ir: RenderTreeIR = {
      kind: 'element',
      tag: node.tag!,
      children: [],
    };

    // Process attributes
    for (const prop of (node.props ?? [])) {
      if (prop.type === PropTypes.ATTRIBUTE) {
        if (prop.name === 'class') {
          ir.rawClass = (prop.value?.content) ?? '';
        }
      } else if (prop.type === PropTypes.DIRECTIVE) {
        if (prop.name === 'on' && prop.arg?.content === 'click') {
          ir.handlerId = extractHandlerName(prop);
        }
        if (prop.name === 'bind' && prop.arg?.content === 'class') {
          // Dynamic class binding — keep raw for now
          ir.rawClass = prop.exp?.content ?? undefined;
        }
      }
    }

    // Process children
    for (const child of (node.children ?? [])) {
      const childIR = walkNode(child);
      if (childIR.kind === 'text' && !childIR.text && !childIR.signalId) {
        continue; // skip empty text nodes
      }
      ir.children!.push(childIR);
    }

    return ir;
  }

  // Unknown node type — skip
  return { kind: 'text', text: '' };
}

/** Extract the handler function name from a Vue directive prop. */
function extractHandlerName(prop: VueProp): string | undefined {
  // @click="inc" → exp.content = "_ctx.inc && _ctx.inc(...args)"
  // @click="inc()" → exp.content = "_ctx.inc && _ctx.inc()"
  const exp = prop.exp;
  if (!exp) return undefined;
  const content = typeof exp.content === 'string' ? exp.content : '';
  // Try to extract just the function name: look for _ctx.<name>
  const match = content.match(/_ctx\.(\w+)/);
  return match?.[1] ?? undefined;
}

function extractSignalName(node: VueASTNode): string | undefined {
  // INTERPOLATION: {{ count }} or {{ obj.prop }}
  if (node.type === NodeTypes.INTERPOLATION) {
    const content = node.content;
    // Vue AST INTERPOLATION content can be:
    // - a string (simple expression)
    // - a CompoundExpressionNode with `loc.source`
    // - a SimpleExpressionNode with `content` string property
    let expr = '';
    if (typeof content === 'string') {
      expr = content;
    } else if (content && typeof content === 'object') {
      // CompoundExpression or SimpleExpression
      const obj = content as Record<string, unknown>;
      if (typeof obj.content === 'string') {
        expr = obj.content;
      } else if (obj.loc && typeof (obj.loc as Record<string,unknown>).source === 'string') {
        expr = (obj.loc as Record<string,string>).source;
      }
    }
    const trimmed = expr.trim();
    if (!trimmed) return undefined;
    // Simple identifier
    if (/^[a-zA-Z_$][\w]*$/.test(trimmed)) {
      return trimmed;
    }
    // Member expression: `obj.prop` → return first part
    const first = trimmed.split('.')[0];
    if (first && /^[a-zA-Z_$][\w]*$/.test(first)) {
      return first;
    }
  }
  return undefined;
}

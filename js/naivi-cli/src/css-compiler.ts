// css-compiler.ts — AOT CSS → Style IR compiler.
// Uses postcss for CSS parsing + AST traversal, custom var() resolution,
// and selector matching against the naive element tree.
//
// Pipeline:
//   SCSS → sass.compileString() → plain CSS
//   CSS  → postcss.parse() → AST
//   AST  → resolveVariables() → resolved declarations
//   AST  → matchSelectors() → per-node style map

import postcss, { type Rule, type Declaration } from 'postcss';
import valueParser from 'postcss-value-parser';

// ── Types ───────────────────────────────────────────────────────────

/** Minimal element descriptor for selector matching. */
export interface CSSElement {
  id: number;
  tag: string;
  parent: number | null;
  elementId?: string;        // HTML id attribute (for #id selector matching)
  classes?: string[];
  attrs?: Record<string, string>;
}

export interface CSSRule {
  selector: string;
  declarations: Map<string, string>;
}

// ── Main entry ─────────────────────────────────────────────────────

/**
 * Compile a CSS string against an element tree, returning per-node style properties.
 * Takes plain CSS — SCSS should be pre-compiled by the caller via `sass` npm.
 */
export function compileCSS(
  css: string,
  nodes: CSSElement[]
): Record<string, Record<string, string | number>> {
  return compileCSSFull(css, nodes);
}

// ── CSS Variable Resolution ────────────────────────────────────────

/** Registry of CSS custom properties: --name → value */
type VarRegistry = Map<string, string>;

/** Resolve a single var() reference against the registry. */
function resolveVarValue(
  rawValue: string,
  registry: VarRegistry,
  depth: number = 0
): string {
  if (depth > 3) return rawValue; // prevent infinite recursion

  return rawValue.replace(
    /var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\s*\)/g,
    (_match, varName: string, fallback: string | undefined) => {
      const resolved = registry.get(varName);
      if (resolved !== undefined) {
        // Recursively resolve nested var() in the resolved value
        return resolveVarValue(resolved, registry, depth + 1);
      }
      if (fallback !== undefined) {
        return resolveVarValue(fallback.trim(), registry, depth + 1);
      }
      // Unresolved — keep the var() reference as-is (best effort)
      return _match;
    }
  );
}

// ── Selector Matching ──────────────────────────────────────────────

/** Simple selector parts after parsing. */
interface SelectorPart {
  tag?: string;
  classes: string[];
  id?: string;
  attrs: Record<string, string | null>; // attr → value (null = boolean attr)
}

/** Parse a selector string into an array of SelectorPart (descendant combinator splits by whitespace). */
function parseSelector(selector: string): SelectorPart[] {
  // Split by whitespace for descendant combinators
  const parts = selector.trim().split(/\s+/);
  return parts.map((part) => {
    const result: SelectorPart = { classes: [], attrs: {} };
    let remaining = part;

    // Extract attribute selectors: [attr], [attr=value], [attr="value"]
    remaining = remaining.replace(/\[([^\]]+)\]/g, (_m, attrStr: string) => {
      const eqIdx = attrStr.indexOf('=');
      if (eqIdx >= 0) {
        const key = attrStr.slice(0, eqIdx).trim();
        let val = attrStr.slice(eqIdx + 1).trim();
        // Strip quotes
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        result.attrs[key] = val;
      } else {
        result.attrs[attrStr.trim()] = null;
      }
      return '';
    });

    // Extract ID: #id
    const idMatch = remaining.match(/#([\w-]+)/);
    if (idMatch) {
      result.id = idMatch[1];
      remaining = remaining.replace(idMatch[0], '');
    }

    // Extract classes: .class
    const classMatches = remaining.match(/\.([\w-]+)/g);
    if (classMatches) {
      result.classes = classMatches.map((c) => c.slice(1));
      remaining = remaining.replace(/\.[\w-]+/g, '');
    }

    // Remaining is the tag name (or empty for universal)
    if (remaining.length > 0 && remaining !== '*') {
      result.tag = remaining;
    }

    return result;
  });
}

/** Check if an element matches a single selector part. */
function matchesPart(element: CSSElement, part: SelectorPart): boolean {
  // Tag match
  if (part.tag && element.tag !== part.tag) {
    return false;
  }
  // Class match — all classes in selector must be present on element
  for (const cls of part.classes) {
    if (!element.classes?.includes(cls)) {
      return false;
    }
  }
  // ID match
  if (part.id && element.elementId !== part.id) {
    return false;
  }
  // Attribute match
  for (const [attr, expectedVal] of Object.entries(part.attrs)) {
    const elVal = element.attrs?.[attr];
    if (elVal === undefined) return false;
    if (expectedVal !== null && elVal !== expectedVal) return false;
  }
  return true;
}

/** Check if an element matches a full selector (may include descendant combinator). */
function matchesSelector(
  element: CSSElement,
  parts: SelectorPart[],
  nodeMap: Map<number, CSSElement>
): boolean {
  if (parts.length === 0) return false;

  // Match from rightmost part (the target element) leftwards
  if (!matchesPart(element, parts[parts.length - 1])) {
    return false;
  }

  // If only one part, we're done
  if (parts.length === 1) return true;

  // Descendant combinator: walk up the parent chain to find ancestor matches
  let ancestorIdx = parts.length - 2;
  let current: CSSElement | null = element;

  while (ancestorIdx >= 0 && current !== null) {
    // Walk up to parent
    current = current.parent !== null
      ? (nodeMap.get(current.parent) ?? null)
      : null;

    if (current && matchesPart(current, parts[ancestorIdx])) {
      ancestorIdx--;
      // Continue walking up to match remaining ancestors
      if (ancestorIdx < 0) break;
    }
    // If no match at this level, continue walking up (descendant combinator allows skipping levels)
  }

  return ancestorIdx < 0;
}

/** Match CSS rules against the element tree, returning per-node style properties. */
function matchSelectors(
  rules: CSSRule[],
  nodes: CSSElement[]
): Record<string, Record<string, string | number>> {
  const result: Record<string, Record<string, string | number>> = {};
  // Build node lookup for O(1) parent traversal
  const nodeMap = new Map<number, CSSElement>();
  for (const n of nodes) nodeMap.set(n.id, n);

  for (const element of nodes) {
    const props: Record<string, string | number> = {};

    for (const rule of rules) {
      // Parse selector once per rule
      const parts = parseSelector(rule.selector);
      if (matchesSelector(element, parts, nodeMap)) {
        // Apply all declarations from this rule
        for (const [prop, value] of rule.declarations) {
          mapCSSDecl(prop, value, (k, v) => { props[k] = v; });
        }
      }
    }

    if (Object.keys(props).length > 0) {
      result[String(element.id)] = props;
    }
  }

  return result;
}

// ── CSS Value → Style Property Mapping ─────────────────────────────

type SetProp = (key: string, value: string | number) => void;

/** Extract word tokens from a CSS value (skipping spaces, commas, dividers). */
function valueWords(raw: string): string[] {
  const parsed = valueParser(raw);
  return parsed.nodes
    .filter(n => n.type === 'word')
    .map(n => n.value);
}

/** Check if a word token is a color value. */
function isColorWord(w: string): boolean {
  return parseCSSColor(w) !== null;
}

/** Try to parse a word as a px length. */
function tryLength(w: string): number | null {
  return parseCSSLength(w);
}

/**
 * Map a CSS property+value to naive-compatible [key, value] pairs via setProp.
 * Uses postcss-value-parser for reliable shorthand decomposition.
 */
function mapCSSDecl(prop: string, value: string, setProp: SetProp): void {
  const v = value.trim();

  // ═══ Shorthand expansion (via postcss-value-parser) ═══════════

  // border: <width> <style> <color>
  if (prop === 'border') {
    for (const w of valueWords(v)) {
      const len = tryLength(w);
      if (len !== null) { setProp('border-width', len); continue; }
      if (isColorWord(w)) { setProp('border-color', parseCSSColor(w)!); continue; }
      // 'solid', 'dashed', etc. — skip
    }
    return;
  }

  // flex: <grow> <shrink> <basis>
  if (prop === 'flex') {
    if (v === 'none') {
      setProp('flex-grow', 0); setProp('flex-shrink', 0); setProp('flex-basis', 'auto');
      return;
    }
    if (v === 'auto') {
      setProp('flex-grow', 1); setProp('flex-shrink', 1); setProp('flex-basis', 'auto');
      return;
    }
    const words = valueWords(v);
    const grow = parseFloat(words[0]);
    if (!isNaN(grow)) setProp('flex-grow', grow);
    if (words.length >= 2) {
      const shrink = parseFloat(words[1]);
      if (!isNaN(shrink)) setProp('flex-shrink', shrink);
    } else {
      setProp('flex-shrink', 1);
    }
    if (words.length >= 3) {
      const b = words[2];
      if (b === 'auto') { setProp('flex-basis', 'auto'); }
      else if (b.endsWith('%')) { setProp('flex-basis', b); }
      else { const n = tryLength(b); if (n !== null) setProp('flex-basis', n); }
    } else if (words.length === 1 && !isNaN(parseFloat(words[0]))) {
      setProp('flex-basis', 0);
    }
    return;
  }

  // background: <color> ... — extract first color
  if (prop === 'background') {
    for (const w of valueWords(v)) {
      if (isColorWord(w)) { setProp('background-color', parseCSSColor(w)!); return; }
    }
    return;
  }

  // padding / margin: <top> <right> <bottom> <left>
  if (prop === 'padding' || prop === 'margin') {
    const values = valueWords(v).map(w => tryLength(w));
    if (values.some(n => n === null)) return;
    const [a, b, c, d] = values;
    if (values.length === 1) {
      setProp(prop + '-top', a!); setProp(prop + '-right', a!);
      setProp(prop + '-bottom', a!); setProp(prop + '-left', a!);
    } else if (values.length === 2) {
      setProp(prop + '-top', a!); setProp(prop + '-right', b!);
      setProp(prop + '-bottom', a!); setProp(prop + '-left', b!);
    } else if (values.length === 3) {
      setProp(prop + '-top', a!); setProp(prop + '-right', b!);
      setProp(prop + '-bottom', c!); setProp(prop + '-left', b!);
    } else if (values.length === 4) {
      setProp(prop + '-top', a!); setProp(prop + '-right', b!);
      setProp(prop + '-bottom', c!); setProp(prop + '-left', d!);
    }
    return;
  }

  // ═══ Individual properties ══════════════════════════════════════

  // ── Color properties ─────────────────────────────────────────
  if (prop === 'color') {
    const c = parseCSSColor(v);
    if (c) setProp('color', c);
    return;
  }
  if (prop === 'background-color') {
    const c = parseCSSColor(v);
    if (c) setProp('background-color', c);
    return;
  }

  // ── Layout properties ────────────────────────────────────────
  if (prop === 'display') {
    if (v === 'flex') setProp('display', 'flex');
    else if (v === 'none') setProp('display', 'none');
    return;
  }
  if (prop === 'flex-direction') {
    if (v === 'column' || v === 'row') setProp('flex-direction', v);
    return;
  }
  if (prop === 'flex-wrap') {
    if (v === 'wrap') setProp('flex-wrap', 'wrap');
    // 'nowrap' → default, no mapping needed
    return;
  }
  if (prop === 'justify-content') {
    const map: Record<string, string> = {
      'flex-start': 'start', 'flex-end': 'end',
      'center': 'center', 'space-between': 'space-between',
      'space-around': 'space-around',
    };
    if (map[v]) setProp('justify-content', map[v]);
    return;
  }
  if (prop === 'align-items') {
    const map: Record<string, string> = {
      'flex-start': 'start', 'flex-end': 'end',
      'center': 'center', 'stretch': 'stretch',
    };
    if (map[v]) setProp('align-items', map[v]);
    return;
  }

  // ── Gap ──────────────────────────────────────────────────────
  if (prop === 'gap') {
    const n = parseCSSLength(v);
    if (n !== null) setProp('gap', n);
    return;
  }

  // ── Sizing ───────────────────────────────────────────────────
  if (prop === 'width' || prop === 'height' ||
      prop === 'min-width' || prop === 'min-height' ||
      prop === 'max-width' || prop === 'max-height') {
    if (v.endsWith('%')) { setProp(prop, v); return; }
    const n = parseCSSLength(v);
    if (n !== null) setProp(prop, n);
    return;
  }

  // ── Padding / Margin longhand ────────────────────────────────
  if (prop.startsWith('padding-') || prop.startsWith('margin-')) {
    const n = parseCSSLength(v);
    if (n !== null) setProp(prop, n);
    return;
  }

  // ── Border ───────────────────────────────────────────────────
  if (prop === 'border-color') {
    const c = parseCSSColor(v);
    if (c) setProp('border-color', c);
    return;
  }
  if (prop === 'border-width') {
    const n = parseCSSLength(v);
    if (n !== null) setProp('border-width', n);
    return;
  }
  if (prop === 'border-radius') {
    const n = parseCSSLength(v);
    if (n !== null) setProp('border-radius', n);
    return;
  }

  // ── Opacity / Visibility ─────────────────────────────────────
  if (prop === 'opacity') {
    const n = parseFloat(v);
    if (!isNaN(n)) setProp('opacity', n);
    return;
  }
  if (prop === 'visibility') {
    // Plan 066 R6: visibility:hidden is a first-class property (keeps layout,
    // not painted / not hittable) — no longer degraded to display:none.
    if (v === 'hidden') setProp('visibility', 'hidden');
    // 'visible' → no mapping needed (default)
    return;
  }

  // ── Font / Text ──────────────────────────────────────────────
  if (prop === 'font-size') {
    const n = parseCSSLength(v);
    if (n !== null) setProp('font-size', n);
    return;
  }
  if (prop === 'font-weight') {
    // Pass through as string — Style::apply_str may add support later
    setProp('font-weight', v);
    return;
  }
  if (prop === 'text-align') {
    setProp('text-align', v);
    return;
  }

  // ── Flex properties ──────────────────────────────────────────
  if (prop === 'flex-grow') {
    const n = parseFloat(v);
    if (!isNaN(n)) setProp('flex-grow', n);
    return;
  }
  if (prop === 'flex-shrink') {
    const n = parseFloat(v);
    if (!isNaN(n)) setProp('flex-shrink', n);
    return;
  }
  if (prop === 'flex-basis') {
    if (v === 'auto') { setProp('flex-basis', 'auto'); return; }
    if (v.endsWith('%')) { setProp('flex-basis', v); return; }
    const n = parseCSSLength(v);
    if (n !== null) setProp('flex-basis', n);
    return;
  }

  // ── Cursor ───────────────────────────────────────────────────
  if (prop === 'cursor') {
    const cursors: Record<string, string> = {
      'default': 'default', 'pointer': 'pointer', 'text': 'text',
      'crosshair': 'crosshair', 'not-allowed': 'not-allowed',
      'grab': 'grab', 'grabbing': 'grabbing',
    };
    if (cursors[v]) setProp('cursor', cursors[v]);
    return;
  }

  // ── Transform ────────────────────────────────────────────────
  if (prop === 'transform') {
    const scaleMatch = v.match(/scale\(([\d.]+)\)/);
    if (scaleMatch) { setProp('scale', parseFloat(scaleMatch[1])); return; }
    const rotateMatch = v.match(/rotate\(([\d.]+)deg\)/);
    if (rotateMatch) { setProp('rotate', rotateMatch[1] + 'deg'); return; }
    return;
  }

  // Unknown property — silently drop
}

// ── Value Parsing Helpers ───────────────────────────────────────────

/** Parse a CSS length value (px / rem / em). rem/em resolve to px with a
 *  16px root, matching the Rust naive-css AOT compiler — a unitless number is
 *  treated as px, so without conversion `1.25rem` would render as 1.25px
 *  text (the counter-demo "text too small" bug). Returns number or null. */
function parseCSSLength(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '0') return 0;

  const pxMatch = trimmed.match(/^([\d.]+)px$/);
  if (pxMatch) return parseFloat(pxMatch[1]);

  const remMatch = trimmed.match(/^([\d.]+)rem$/);
  if (remMatch) return parseFloat(remMatch[1]) * 16;

  const emMatch = trimmed.match(/^([\d.]+)em$/);
  if (emMatch) return parseFloat(emMatch[1]) * 16;

  // Auto / other units — not supported
  if (trimmed === 'auto') return null;

  // Plain number without unit (treat as px)
  const numMatch = trimmed.match(/^([\d.]+)$/);
  if (numMatch) return parseFloat(numMatch[1]);

  return null;
}

/** Parse a CSS color value to a hex string (#rrggbb). Returns null for unsupported formats. */
function parseCSSColor(value: string): string | null {
  const trimmed = value.trim().toLowerCase();

  // Named colors (subset)
  const named: Record<string, string> = {
    'red': '#ff0000', 'blue': '#0000ff', 'green': '#008000',
    'white': '#ffffff', 'black': '#000000', 'transparent': '#00000000',
    'gray': '#808080', 'grey': '#808080', 'yellow': '#ffff00',
    'orange': '#ffa500', 'purple': '#800080', 'pink': '#ffc0cb',
  };
  if (named[trimmed]) return named[trimmed];

  // #rgb → #rrggbb
  const shortHex = trimmed.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/);
  if (shortHex) {
    return `#${shortHex[1]}${shortHex[1]}${shortHex[2]}${shortHex[2]}${shortHex[3]}${shortHex[3]}`;
  }

  // #rrggbb
  if (/^#[0-9a-f]{6}$/.test(trimmed)) return trimmed;

  // #rrggbbaa
  if (/^#[0-9a-f]{8}$/.test(trimmed)) return trimmed;

  // rgb(r, g, b)
  const rgbMatch = trimmed.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
  if (rgbMatch) {
    return `#${hex(rgbMatch[1])}${hex(rgbMatch[2])}${hex(rgbMatch[3])}`;
  }

  // rgba(r, g, b, a)
  const rgbaMatch = trimmed.match(/^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/);
  if (rgbaMatch) {
    const a = Math.round(parseFloat(rgbaMatch[4]) * 255);
    return `#${hex(rgbaMatch[1])}${hex(rgbaMatch[2])}${hex(rgbaMatch[3])}${hex(a)}`;
  }

  return null;
}

function hex(n: string | number): string {
  const v = typeof n === 'string' ? parseInt(n, 10) : n;
  return v.toString(16).padStart(2, '0');
}

// ── Full Pipeline ──────────────────────────────────────────────────

/**
 * Full CSS compilation pipeline: parse → resolve variables → match → map.
 * Takes plain CSS (caller should compile SCSS → CSS first via sass npm).
 */
export function compileCSSFull(
  css: string,
  nodes: CSSElement[]
): Record<string, Record<string, string | number>> {
  const root = postcss.parse(css, { from: undefined });

  // First pass: collect CSS custom properties
  const registry: VarRegistry = new Map();
  root.walkDecls((decl: Declaration) => {
    if (decl.prop.startsWith('--')) {
      registry.set(decl.prop, decl.value.trim());
    }
  });

  // Second pass: extract rules with resolved declarations
  const rules: CSSRule[] = [];
  root.walk((node) => {
    if (node.type === 'rule') {
      // Skip rules nested inside @media, @keyframes, @font-face, etc.
      if (node.parent && node.parent.type === 'atrule') return;

      const rule = node as Rule;
      const declarations = new Map<string, string>();

      rule.walkDecls((decl: Declaration) => {
        if (decl.prop.startsWith('--')) return; // skip var definitions
        const resolved = resolveVarValue(decl.value.trim(), registry);
        declarations.set(decl.prop, resolved);
      });

      if (declarations.size > 0) {
        rules.push({ selector: rule.selector, declarations });
      }
    }
  });

  // Match selectors against element tree
  return matchSelectors(rules, nodes);
}

// ── CSS class → properties compilation (no element tree needed) ───

/**
 * Compile a CSS string to a class-name → properties map.
 * No element tree required — extracts all class-based rules and maps
 * their declarations to Style IR properties.
 * Handles @import by resolving them BEFORE calling this function.
 */
export function compileCSSClasses(css: string): Record<string, Record<string, string | number>> {
  const root = postcss.parse(css, { from: undefined });
  const result: Record<string, Record<string, string | number>> = {};

  // First pass: collect CSS custom properties
  const registry: VarRegistry = new Map();
  root.walkDecls((decl: Declaration) => {
    if (decl.prop.startsWith('--')) {
      registry.set(decl.prop, decl.value.trim());
    }
  });

  // Second pass: extract rules
  root.walk((node) => {
    if (node.type === 'rule') {
      if (node.parent && node.parent.type === 'atrule') return;
      const rule = node as Rule;

      // Process each comma-separated selector independently
      const selectors = rule.selector.split(',').map(s => s.trim());

      for (const sel of selectors) {
        // Extract class names from the selector (e.g. ".todoapp" → "todoapp")
        // For simplicity, we only support simple class selectors and
        // compound selectors (e.g. ".todo-list li" → store under each class)
        const classes = extractClassNames(sel);
        if (classes.length === 0) continue; // skip non-class selectors (body, html, etc.)

        const props: Record<string, string | number> = {};
        rule.walkDecls((decl: Declaration) => {
          if (decl.prop.startsWith('--')) return;
          const resolved = resolveVarValue(decl.value.trim(), registry);
          mapCSSDecl(decl.prop, resolved, (k, v) => { props[k] = v; });
        });

        if (Object.keys(props).length > 0) {
          for (const cls of classes) {
            // Merge properties (later rules override earlier ones for same class)
            result[cls] = { ...(result[cls] || {}), ...props };
          }
        }
      }
    }
  });

  return result;
}

/** Extract class names from a CSS selector string. */
function extractClassNames(selector: string): string[] {
  const classes: string[] = [];
  const re = /\.([a-zA-Z_-][\w-]*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(selector)) !== null) {
    classes.push(match[1]);
  }
  return classes;
}

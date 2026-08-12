// Naive DOM facade for Vue Vapor over naive's native tree mirror.
//
// The naive renderer (naive-renderer.ts) builds a Vue createRenderer whose
// nodeOps/patchProp operate on these DOM-like facade nodes, so Vue's reactive
// updates flow into the batched FFI bridge without touching the real
// `document`. Before WASM is bound, nodes are JS mocks; once WASM is ready
// they are backed by native-tree mirrors routed through batched-bridge.

import {
  type NodeMirror,
  isWasmReady,
  setEventElementResolver,
} from "./native-tree.js";
import {
  createElement as nativeCreateElement,
  createTextNode as nativeCreateTextNode,
  insertNode as nativeInsertNode,
  attachDocumentRoot as nativeAttachDocumentRoot,
  removeNode as nativeRemoveNode,
  setProp as nativeSetProp,
  setAttr as nativeSetAttr,
  setChecked as nativeSetChecked,
  setText as nativeSetText,
  addEventListener as nativeAddEventListener,
  removeEventListener as nativeRemoveEventListener,
  getBoundingClientRect as nativeGetBoundingClientRect,
  isBatchPending,
} from "./batched-bridge.js";
import type { EventType, EventCallback } from "./wasm-types.js";

// ── DOM-like node classes ───────────────────────────────────────────

/** DOMRect-like layout rect returned by facade `getBoundingClientRect()`. */
export interface NaiveRect {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  left: number;
  right: number;
  bottom: number;
  toJSON(): {
    x: number;
    y: number;
    width: number;
    height: number;
    top: number;
    left: number;
    right: number;
    bottom: number;
  };
}

/** Build a DOMRect-like object from a mirror's computed layout rect. */
function makeRect(mirror: NodeMirror): NaiveRect {
  const rect = nativeGetBoundingClientRect(mirror);
  if (!rect) {
    return {
      x: 0, y: 0, width: 0, height: 0,
      top: 0, left: 0, right: 0, bottom: 0,
      toJSON() {
        return { x: this.x, y: this.y, width: this.width, height: this.height, top: this.top, left: this.left, right: this.right, bottom: this.bottom };
      },
    };
  }
  return {
    x: rect.x, y: rect.y, width: rect.width, height: rect.height,
    top: rect.y, left: rect.x, right: rect.x + rect.width, bottom: rect.y + rect.height,
    toJSON() {
      return { x: this.x, y: this.y, width: this.width, height: this.height, top: this.top, left: this.left, right: this.right, bottom: this.bottom };
    },
  };
}

interface DOMNodeBase {
  nodeType: number;
  nodeName: string;
  parentNode: NaiveNode | null;
  firstChild: NaiveNode | null;
  lastChild: NaiveNode | null;
  nextSibling: NaiveNode | null;
  previousSibling: NaiveNode | null;
  childNodes: NaiveNode[];
  textContent: string;
  _mirror: NodeMirror;
  appendChild(child: NaiveNode): NaiveNode;
  insertBefore(child: NaiveNode, anchor: NaiveNode | null): NaiveNode;
  removeChild(child: NaiveNode): NaiveNode;
  addEventListener(type: string, handler: EventListener): void;
  removeEventListener(type: string, handler: EventListener): void;
  getBoundingClientRect(): NaiveRect;
}

export interface NaiveElement extends DOMNodeBase {
  nodeType: 1;
  tagName: string;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  removeAttribute(name: string): void;
  hasAttribute(name: string): boolean;
  setAttributeNS(_ns: string, name: string, value: string): void;
  style: CSSStyleDeclaration;
  classList: DOMTokenList;
  className: string;
  id: string;
  value: string;
  innerHTML: string;
  _events: Record<string, EventListener[]>;
  _attrs: Record<string, string>;
  /** Generated pseudo-element mirrors keyed by "before"/"after" (plan 050). */
  _handlerIds?: Map<EventListener, bigint>;
  _styleStore?: Record<string, string>;
}

export interface NaiveTextNode extends DOMNodeBase {
  nodeType: 3;
}

export type NaiveNode = NaiveElement | NaiveTextNode;

let _mockId = 0;

function nextId(): number {
  return ++_mockId;
}

// ── Child list helpers ──────────────────────────────────────────────

function updateSiblingLinks(children: NaiveNode[]): void {
  for (let i = 0; i < children.length; i++) {
    children[i].previousSibling = i > 0 ? children[i - 1] : null;
    children[i].nextSibling = i < children.length - 1 ? children[i + 1] : null;
  }
  if (children.length > 0) {
    const parent = children[0].parentNode;
    if (parent) {
      (parent as NaiveElement).firstChild = children[0];
      (parent as NaiveElement).lastChild = children[children.length - 1];
    }
  }
}

function childIndex(parent: NaiveNode, child: NaiveNode): number {
  return parent.childNodes.indexOf(child);
}

// ── CSS class → style property resolver ────────────────────────────

/**
 * Inject the build-time author stylesheet (U6).
 *
 * The CLI compiles SFC `<style>` blocks (and project CSS) to CSS text and
 * delivers it as `globalThis.__NAIVE_CSS`:
 * - wasm channel: `naivi wasm --release` inlines it into `guest.js`;
 * - native channel: `naivi desktop` passes `node_modules/.naive/styles.css`
 *   and the host evals `__NAIVE_CSS` before the guest bundle.
 *
 * The text is injected as a stylo author stylesheet (`add_stylesheet`), so
 * class / tag / attribute / `:hover` / `:active` / `:checked` selectors are
 * matched natively by blitz's style engine. Inline `:style` bindings
 * (el.style → `set_style`) win the cascade.
 */
export async function loadCSSClassStyles(): Promise<void> {
  const css = (globalThis as unknown as Record<string, unknown>).__NAIVE_CSS;
  if (typeof css !== "string" || css.trim() === "") {
    return;
  }
  const { getWasm } = await import("./native-tree.js");
  getWasm().add_stylesheet(css);
}

/**
 * Recursively upgrade a mock node subtree to WASM-backed mirrors.
 * Called when a node created before WASM was ready is inserted into
 * a WASM-backed parent (e.g., Vue components imported before mount()).
 */
function upgradeSubtreeToWasm(node: NaiveNode): void {
  if (node.nodeType === 3) {
    // Text node: create a WASM text mirror with current text content
    const newMirror = nativeCreateTextNode(node.textContent || '');
    node._mirror = newMirror;
  } else if (node.nodeType === 1) {
    // Element node: create a WASM element mirror
    const el = node as NaiveElement;
    const tag = el.tagName?.toLowerCase() || 'div';
    const newMirror = nativeCreateElement(tag);
    // Copy attributes already set on the node (attribute-ish keys only — the
    // U4 split routes class/id to set_attr and other props to set_style, so
    // arbitrary data-* attrs must go through set_attr).
    for (const [k, v] of Object.entries(el._attrs)) {
      nativeSetAttr(newMirror, k, String(v));
    }
    const cls = el._attrs['class'] || el._attrs['className'] || '';
    if (cls) {
      nativeSetAttr(newMirror, 'class', cls);
    }
    // Forward stored inline style properties (e.g. display:none from v-show)
    const styleStore = el._styleStore as Record<string, string> | undefined;
    if (styleStore) {
      for (const [k, v] of Object.entries(styleStore)) {
        nativeSetProp(newMirror, k, v);
      }
    }
    el._mirror = newMirror;
    // Recursively upgrade children, then insert them into the new mirror
    for (const child of el.childNodes) {
      upgradeSubtreeToWasm(child);
      newMirror.children.push(child._mirror);
      child._mirror.parent = newMirror;
      nativeInsertNode(newMirror, child._mirror);
    }
  }
}

function createNaiveElement(tag: string): NaiveElement {
  // Trace INPUT creation
  if (tag === "input") {
    console.trace("[naive] Creating INPUT element");
  }
  // Use native-tree WASM when available, otherwise JS mock
  let mirror: NodeMirror;
  if (isWasmReady()) {
    mirror = nativeCreateElement(tag.toLowerCase());
  } else {
    mirror = {
      id: nextId(),
      type: 1,
      parent: null,
      children: [],
      wasmId: 0n,
    };
  }

  const el: NaiveElement = {
    nodeType: 1,
    nodeName: tag.toUpperCase(),
    tagName: tag.toUpperCase(),
    parentNode: null,
    firstChild: null,
    lastChild: null,
    nextSibling: null,
    previousSibling: null,
    childNodes: [],
    _mirror: mirror,
    _events: Object.create(null),
    _attrs: Object.create(null),

    get textContent() {
      return this.childNodes.map(c => c.textContent).join("");
    },
    set textContent(v: string) {
      for (const c of [...this.childNodes]) this.removeChild(c);
      if (v) this.appendChild(createNaiveTextNode(v));
    },

    get innerHTML() {
      return this.textContent;
    },
    set innerHTML(v: string) {
      this.textContent = "";
      if (v) {
        const parsed = parseTemplateHtml(v);
        for (const child of parsed) this.appendChild(child);
      }
    },

    get className() { return this._attrs["class"] ?? ""; },
    set className(v: string) { this.setAttribute("class", v); },

    get id() { return this._attrs["id"] ?? ""; },
    set id(v: string) { this.setAttribute("id", v); },

    // Value property (text inputs): the getter reflects the last engine-synced
    // value; the setter routes through setAttribute → set_attr so the engine's
    // text-input editor updates (e.g. Vue's `v-model` / clearing after submit).
    get value() { return this._attrs["value"] ?? ""; },
    set value(v: string) { this.setAttribute("value", String(v)); },

    style: null as unknown as CSSStyleDeclaration,
    classList: createClassListStub(),

    appendChild(child: NaiveNode): NaiveNode {
      if (child.parentNode) {
        child.parentNode.removeChild(child);
      }
      this.childNodes.push(child);
      child.parentNode = this;
      updateSiblingLinks(this.childNodes);
      if (!this._mirror.children.includes(child._mirror)) {
        this._mirror.children.push(child._mirror);
        child._mirror.parent = this._mirror;
      }
      // Upgrade child to WASM if needed (Vue may have created it before WASM was ready)
      if (isWasmReady() && child._mirror.wasmId === 0n && !isBatchPending(child._mirror)) {
        upgradeSubtreeToWasm(child);
      }
      // Sync to WASM
      if (isWasmReady()) {
        nativeInsertNode(this._mirror, child._mirror);
      }
      return child;
    },

    insertBefore(child: NaiveNode, anchor: NaiveNode | null): NaiveNode {
      if (child.parentNode) {
        child.parentNode.removeChild(child);
      }
      const idx = anchor ? childIndex(this, anchor) : this.childNodes.length;
      if (idx === -1) {
        this.childNodes.push(child);
      } else {
        this.childNodes.splice(idx, 0, child);
      }
      child.parentNode = this;
      updateSiblingLinks(this.childNodes);
      if (!this._mirror.children.includes(child._mirror)) {
        const mIdx = anchor ? this._mirror.children.indexOf(anchor._mirror) : this._mirror.children.length;
        if (mIdx === -1 || mIdx >= this._mirror.children.length) {
          this._mirror.children.push(child._mirror);
        } else {
          this._mirror.children.splice(mIdx, 0, child._mirror);
        }
        child._mirror.parent = this._mirror;
      }
      // Upgrade child to WASM if needed
      if (isWasmReady() && child._mirror.wasmId === 0n && !isBatchPending(child._mirror)) {
        upgradeSubtreeToWasm(child);
      }
      // Sync to WASM
      if (isWasmReady()) {
        nativeInsertNode(this._mirror, child._mirror);
      }
      return child;
    },

    removeChild(child: NaiveNode): NaiveNode {
      const idx = childIndex(this, child);
      if (idx === -1) throw new Error("Node not found");
      this.childNodes.splice(idx, 1);
      child.parentNode = null;
      updateSiblingLinks(this.childNodes);
      const mIdx = this._mirror.children.indexOf(child._mirror);
      if (mIdx !== -1) {
        this._mirror.children.splice(mIdx, 1);
        child._mirror.parent = null;
      }
      // Sync to WASM
      if (isWasmReady()) {
        nativeRemoveNode(child._mirror);
      }
      return child;
    },

    setAttribute(name: string, value: string): void {
      this._attrs[name] = value;
      if (!isWasmReady() || (this._mirror.wasmId === 0n && !isBatchPending(this._mirror))) return;
      if (name === "class") {
        // Sync the class attribute to Rust for selector matching (plan 061).
        nativeSetAttr(this._mirror, "class", value);
      } else if (name === "style") {
        // Inline style: "key:value;key:value"
        for (const decl of value.split(";")) {
          const colon = decl.indexOf(":");
          if (colon > 0) {
            const k = decl.substring(0, colon).trim();
            const v = decl.substring(colon + 1).trim();
            nativeSetProp(this._mirror, k, v);
          }
        }
      } else if (name === "checked") {
        nativeSetChecked(this._mirror, value !== "false");
      } else if (name === "id") {
        nativeSetAttr(this._mirror, name, value);
      } else {
        nativeSetAttr(this._mirror, name, value);
      }
    },
    getAttribute(name: string): string | null {
      return name in this._attrs ? this._attrs[name] : null;
    },
    removeAttribute(name: string): void {
      delete this._attrs[name];
      if (name === "checked" && isWasmReady()) {
        nativeSetChecked(this._mirror, false);
      }
    },
    hasAttribute(name: string): boolean {
      return name in this._attrs;
    },
    setAttributeNS(_ns: string, name: string, value: string): void {
      this.setAttribute(name, value);
    },

    addEventListener(type: string, handler: EventListener): void {
      if (!this._events[type]) this._events[type] = [];
      this._events[type].push(handler);
      // Route through the WASM event bridge when the node is real (plan 034,
      // U5): Rust dispatch invokes the JS handler on interaction.
      if (isWasmReady() && (this._mirror.wasmId !== 0n || isBatchPending(this._mirror))) {
        const handlerId = nativeAddEventListener(
          this._mirror,
          type as EventType,
          // DOM EventListener → engine-neutral EventCallback (the dispatched
          // event is the NaiveDomEvent subset; Vue handlers read type/coords).
          handler as unknown as EventCallback,
        ) ?? 0n;
        if (handlerId !== 0n) {
          if (!this._handlerIds) this._handlerIds = new Map();
          this._handlerIds.set(handler, handlerId);
        }
      }
    },
    removeEventListener(type: string, handler: EventListener): void {
      const list = this._events[type];
      if (list) {
        const idx = list.indexOf(handler);
        if (idx !== -1) list.splice(idx, 1);
      }
      if (isWasmReady() && (this._mirror.wasmId !== 0n || isBatchPending(this._mirror))) {
        const handlerId = this._handlerIds?.get(handler);
        if (handlerId) {
          nativeRemoveEventListener(handlerId);
          this._handlerIds?.delete(handler);
        }
      }
    },

    getBoundingClientRect(): NaiveRect {
      return makeRect(this._mirror);
    },
  };

  // Plan 066 U4: the style stub wires `_styleStore` on the element so the
  // pre-WASM upgrade path can forward stored inline styles (incl. visibility).
  el.style = createStyleStub(el);

  // Register real (wasm-backed) elements by blitz node id so event dispatch
  // can set `event.target` and sync the input value into the facade.
  if (mirror.wasmId !== 0n) {
    _elByWasmId.set(Number(mirror.wasmId), el);
  }

  // Text inputs: keep the facade `value` in sync with the engine's text
  // editor even when no `v-model` / `input` listener is bound (the reference
  // todomvc reads `event.target.value` on `keyup.enter`). The engine fires an
  // `input` DOM event per keystroke; this internal listener routes it through
  // the dispatcher, which syncs `_attrs.value` via the element resolver.
  if (tag === "input") {
    el.addEventListener("input", () => {});
  }
  return el;
}

function createNaiveTextNode(text = ""): NaiveTextNode {
  let mirror: NodeMirror;
  if (isWasmReady()) {
    mirror = nativeCreateTextNode(text);
  } else {
    mirror = {
      id: nextId(),
      type: 3,
      parent: null,
      children: [],
      wasmId: 0n,
      text,
    };
  }

  return {
    nodeType: 3,
    nodeName: "#text",
    parentNode: null,
    firstChild: null,
    lastChild: null,
    nextSibling: null,
    previousSibling: null,
    childNodes: [],
    _mirror: mirror,

    get textContent() {
      return mirror.text ?? "";
    },
    set textContent(v: string) {
      mirror.text = v;
      if (isWasmReady() && (mirror.wasmId !== 0n || isBatchPending(mirror))) {
        nativeSetText(mirror, v);
      }
    },

    appendChild(_child: NaiveNode): NaiveNode {
      throw new Error("Cannot append child to text node");
    },
    insertBefore(_child: NaiveNode, _anchor: NaiveNode | null): NaiveNode {
      throw new Error("Cannot insert child into text node");
    },
    removeChild(_child: NaiveNode): NaiveNode {
      throw new Error("Cannot remove child from text node");
    },
    addEventListener() {},
    removeEventListener() {},

    getBoundingClientRect(): NaiveRect {
      return makeRect(mirror);
    },
  };
}

// ── Style stub ──────────────────────────────────────────────────────

function createStyleStub(el: NaiveElement): CSSStyleDeclaration {
  const store: Record<string, string> = Object.create(null);
  // Expose the store so the pre-WASM upgrade path can forward inline styles
  // (plan 066 U4: display + visibility survive an upgrade to WASM mirrors).
  el._styleStore = store;
  // CSSOM-style key normalization: Vue assigns camelCase keys
  // (`flexDirection`), while blitz/stylo expect kebab-case
  // (`flex-direction`). Property names are ASCII case-insensitive in CSS,
  // but normalizing avoids relying on stylo's case handling.
  const toCssProp = (k: string) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  // Forward EVERY inline style property to the engine: blitz's stylo/taffy
  // owns layout and paint, so a style that stays client-side never reaches
  // the render tree. (naive's display/visibility-only forwarding was a wasm
  // protocol-size optimization that does not apply to the direct naivi
  // protocol.)
  const forward = (k: string, v: string) => {
    // Read the LIVE mirror at call time: after `upgradeSubtreeToWasm` swaps
    // el._mirror, the stub must forward to the upgraded WASM mirror, not the
    // pre-upgrade mock (plan 066 review fix).
    const m = el._mirror;
    if (
      isWasmReady() &&
      (m.wasmId !== 0n || isBatchPending(m))
    ) {
      nativeSetProp(m, toCssProp(k), v);
    }
  };
  const proxy = new Proxy(store, {
    get(_t, key: string) {
      if (key === "cssText") {
        return Object.entries(store).map(([k, v]) => `${k}:${v}`).join(";");
      }
      if (key === "setProperty") {
        return function(k: string, v: string) {
          store[k] = v;
          forward(k, v);
        };
      }
      if (key === "removeProperty") {
        return function(k: string) {
          const old = store[k];
          delete store[k];
          // Plan 066 U4: removing display/visibility clears the inline value
          // on the engine side too (v-show restore via removeProperty).
          forward(k, "");
          return old;
        };
      }
      if (key in store) return store[key];
      return "";
    },
    set(_t, key: string, value: unknown) {
      // Internal keys (e.g. anything prefixed `_`) are not style properties —
      // never store or forward them. (A prior `(proxy as any)._mirror = …`
      // slipped through the trap and forwarded an object as a style prop,
      // crashing passStringToWasm0.)
      if (typeof key === "string" && key.startsWith("_")) return true;
      if (key === "cssText") {
        for (const k of Object.keys(store)) delete store[k];
        if (value != null && typeof value === "string") {
          for (const decl of value.split(";")) {
            const colon = decl.indexOf(":");
            if (colon > 0) {
              const k = decl.substring(0, colon).trim();
              const v = decl.substring(colon + 1).trim();
              store[k] = v;
              forward(k, v);
            }
          }
        }
        return true;
      }
      const v = String(value);
      store[key] = v;
      forward(key, v);
      return true;
    },
  }) as unknown as CSSStyleDeclaration;
  return proxy;
}

// ── classList stub ──────────────────────────────────────────────────

function createClassListStub(): DOMTokenList {
  let classes: string[] = [];
  const el = { _attrs: {} as Record<string, string> };
  const proxy = {
    get value() { return classes.join(" "); },
    set value(v: string) { classes = v.split(/\s+/).filter(Boolean); el._attrs["class"] = classes.join(" "); },
    add(...tokens: string[]) { for (const t of tokens) if (!classes.includes(t)) classes.push(t); el._attrs["class"] = classes.join(" "); },
    remove(...tokens: string[]) { classes = classes.filter(c => !tokens.includes(c)); el._attrs["class"] = classes.join(" "); },
    contains(token: string) { return classes.includes(token); },
    toggle(token: string) {
      if (classes.includes(token)) { classes = classes.filter(c => c !== token); return false; }
      else { classes.push(token); return true; }
    },
    get length() { return classes.length; },
    item(i: number) { return classes[i] ?? null; },
    *[Symbol.iterator]() { yield* classes; },
  };
  return proxy as unknown as DOMTokenList;
}

// ── Template parsing ────────────────────────────────────────────────

function parseNaiveAttrs(raw: string, el: NaiveElement): void {
  const re = /([A-Za-z_:][-A-Za-z0-9_:]*)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw))) {
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    el.setAttribute(match[1], value);
  }
}

function parseTemplateHtml(html: string): NaiveNode[] {
  if (!html) return [];
  if (!html.startsWith("<")) return [createNaiveTextNode(html)];
  const match = html.match(/^<([A-Za-z][A-Za-z0-9_-]*)([^>]*)>([\s\S]*)$/);
  if (!match) return [createNaiveTextNode(html)];
  const [, tag, attrs, rest] = match;
  const el = createNaiveElement(tag.toLowerCase());
  parseNaiveAttrs(attrs, el);
  const text = rest.replace(new RegExp(`</${tag}>$`, "i"), "");
  if (text) el.appendChild(createNaiveTextNode(text));
  return [el];
}

// ── Document Facade ─────────────────────────────────────────────────

export interface NaiveDocumentLike {
  createElement(tag: string): NaiveElement;
  createElementNS(namespace: string, tag: string): NaiveElement;
  createTextNode(value?: string): NaiveTextNode;
  createComment(value?: string): NaiveTextNode;
  querySelector(selector: string): NaiveElement | null;
  body: NaiveElement;
}

let _globalDoc: NaiveDocumentLike | null = null;

/** blitz node id (as `number`) → facade element, for event target resolution. */
const _elByWasmId = new Map<number, NaiveElement>();

function createNaiveDocument(): NaiveDocumentLike {
  const doc = {} as NaiveDocumentLike;

  // UA-style default: the facade body fills the viewport, so host-created
  // roots (and their percent-sized descendants) get a real layout container
  // instead of collapsing to content size.
  const body = createNaiveElement("body");
  if (isWasmReady()) {
    nativeSetProp(body._mirror, "width", "100%");
    nativeSetProp(body._mirror, "height", "100%");
    // Attach the body to the blitz document root so resolve / hit-test see a
    // real DOM (blitz treats the root as DOM-less until it has an element
    // child; without this nothing renders and hittest warns "No DOM").
    nativeAttachDocumentRoot(body._mirror);
  }

  // Fill in the doc shell — only the methods the naive renderer / host use.
  Object.assign(doc, {
    createElement(tag: string) { return createNaiveElement(tag); },
    createElementNS(_namespace: string, tag: string) { return createNaiveElement(tag); },
    createTextNode(value = "") { return createNaiveTextNode(value); },
    createComment(_value = "") { return createNaiveTextNode(""); },
    querySelector(_selector: string) { return null; },
    body,
  });

  return doc;
}

// ── Install ─────────────────────────────────────────────────────────

/** Install the naive document facade. Called at mount time in wasm mode. */
export function initNaiveDocument(): void {
  _globalDoc = createNaiveDocument();

  // Wire the event dispatcher's element resolver: set `event.target` on
  // dispatched events and sync the engine's input value into the facade
  // element's `_attrs.value` on `input` events (so `el.value` and
  // `event.target.value` reflect the typed text).
  setEventElementResolver((nodeId: number, value?: string) => {
    const el = _elByWasmId.get(nodeId) ?? null;
    if (el && value !== undefined) {
      el._attrs.value = value;
    }
    return el;
  });
}

/** Get the installed naive document (for internal use). */
export function getNaiveDocument(): NaiveDocumentLike | null {
  return _globalDoc;
}

// installNaiveVueVaporDom() is exported but NOT auto-called at module load.
// In naive wasm mode, mount() calls it after confirming WASM is available.
// In naive web mode, it is never called — standard Vue uses real DOM.

// Tests for the Vue DOM facade routing over the U4 direct FFI protocol.
//
// The facade is driven with a recording mock WASM bridge; every mutation
// flows synchronously through the direct exports (`create_element` /
// `create_text_node` / `set_attr` / `set_style` / `append_child` / …). There
// is no `apply_ops` batch anymore — `batched-bridge.flush()` is a no-op.

import { describe, it, expect, beforeEach } from "vitest";
import { bindWasm, collectTextNodes } from "../src/native-tree.js";
import { initNaiveDocument, getNaiveDocument, type NaiveElement } from "../src/naive-dom.js";
import { flush, queuedOpCount, isBatchPending } from "../src/batched-bridge.js";
import type { WasmExports } from "../src/wasm-types.js";

interface CallRecord {
  kind: string;
  tag?: string;
  text?: string;
  name?: string;
  value?: string;
  node?: bigint;
  child?: bigint;
  parent?: bigint;
  handler?: bigint;
}

function makeMockWasm(): {
  wasm: WasmExports;
  calls: CallRecord[];
  listenerIds: () => bigint[];
  removedListeners: () => bigint[];
} {
  let next = 1n;
  let nextListener = 10n;
  const calls: CallRecord[] = [];
  const listenerIds: bigint[] = [];
  const removedListeners: bigint[] = [];
  const wasm: WasmExports = {
    create_element: (tag: string) => {
      calls.push({ kind: "create_element", tag });
      const id = next++;
      return id;
    },
    create_text_node: (text: string) => {
      calls.push({ kind: "create_text_node", text });
      const id = next++;
      return id;
    },
    set_text: (node: bigint, text: string) => {
      calls.push({ kind: "set_text", node, text });
    },
    set_attr: (node: bigint, name: string, value: string) => {
      calls.push({ kind: "set_attr", node, name, value });
    },
    set_style: (node: bigint, key: string, value: string) => {
      calls.push({ kind: "set_style", node, name: key, value });
    },
    append_child: (parent: bigint, child: bigint) => {
      calls.push({ kind: "append_child", parent, child });
    },
    attach_document_root: (node: bigint) => {
      calls.push({ kind: "attach_document_root", node });
    },
    insert_before: (anchor: bigint, child: bigint) => {
      calls.push({ kind: "insert_before", node: anchor, child });
    },
    insert_after: (anchor: bigint, child: bigint) => {
      calls.push({ kind: "insert_after", node: anchor, child });
    },
    replace_node: (old: bigint, replacement: bigint) => {
      calls.push({ kind: "replace_node", node: old, child: replacement });
    },
    remove_node: (node: bigint) => {
      calls.push({ kind: "remove_node", node });
    },
    bind_event: (node: bigint, kind: string) => {
      const id = nextListener++;
      listenerIds.push(id);
      calls.push({ kind: "bind_event", node, name: kind });
      return id;
    },
    unbind_event: (handler: bigint) => {
      removedListeners.push(handler);
      calls.push({ kind: "unbind_event", handler });
    },
    set_event_callback: () => {},
    tick: () => {},
    add_stylesheet: () => {},
    set_placeholder_measures: () => false,
    clear_placeholder_measures: () => false,
  };
  return {
    wasm,
    calls,
    listenerIds: () => listenerIds,
    removedListeners: () => removedListeners,
  };
}

describe("vue-vapor-dom facade (U4 direct protocol)", () => {
  beforeEach(() => {
    initNaiveDocument();
  });

  it("routes create/append/style/text through the direct exports", () => {
    const mock = makeMockWasm();
    bindWasm(mock.wasm);

    const doc = getNaiveDocument()!;
    const el = doc.createElement("div") as HTMLElement;
    const text = doc.createTextNode("hi");
    el.appendChild(text);
    el.setAttribute("style", "color:red");

    const calls = mock.calls;
    expect(
      calls.some((c) => c.kind === "create_element" && c.tag === "div"),
    ).toBe(true);
    expect(
      calls.some((c) => c.kind === "create_text_node" && c.text === "hi"),
    ).toBe(true);
    expect(calls.some((c) => c.kind === "append_child")).toBe(true);
    expect(
      calls.some((c) => c.kind === "set_style" && c.name === "color" && c.value === "red"),
    ).toBe(true);
    // No batching anywhere.
    expect(calls.some((c) => c.kind === "apply_ops")).toBe(false);
  });

  it("gives the facade body viewport-filling UA styles when wasm is ready", () => {
    const mock = makeMockWasm();
    bindWasm(mock.wasm);
    initNaiveDocument(); // reinstall so the body is created wasm-backed

    const calls = mock.calls;
    const styleKeys = calls.filter((c) => c.kind === "set_style").map((c) => c.name);
    expect(styleKeys).toEqual(expect.arrayContaining(["width", "height"]));
    // The body is attached to the blitz document root.
    expect(calls.some((c) => c.kind === "attach_document_root")).toBe(true);
  });

  it("forwards same-tick updates immediately (no batching)", () => {
    const mock = makeMockWasm();
    bindWasm(mock.wasm);

    const doc = getNaiveDocument()!;
    const el = doc.createElement("div") as HTMLElement;
    const text = doc.createTextNode("hi");
    el.appendChild(text);

    text.textContent = "a";
    text.textContent = "b";
    el.setAttribute("style", "width:10px");

    const texts = mock.calls.filter((c) => c.kind === "set_text").map((c) => c.text);
    expect(texts).toEqual(["a", "b"]);
    expect(
      mock.calls.some((c) => c.kind === "set_style" && c.name === "width" && c.value === "10px"),
    ).toBe(true);
    expect(queuedOpCount()).toBe(0);
  });

  it("appends an existing child under a new parent with the parent's real id", () => {
    const mock = makeMockWasm();
    bindWasm(mock.wasm);

    const doc = getNaiveDocument()!;
    const existing = doc.createElement("div") as HTMLElement;
    doc.body.appendChild(existing);

    const first = mock.calls.filter((c) => c.kind === "append_child").at(-1)!;
    expect(first.parent).toBe((doc.body as unknown as NaiveElement)._mirror.wasmId);
    expect(first.parent).not.toBe(0n);

    const pending = doc.createElement("div") as HTMLElement;
    pending.appendChild(existing);

    const last = mock.calls.filter((c) => c.kind === "append_child").at(-1)!;
    expect(last.parent).toBe((pending as unknown as NaiveElement)._mirror.wasmId);
    expect(last.parent).not.toBe(0n);
    expect(last.child).toBe((existing as unknown as NaiveElement)._mirror.wasmId);
    expect(doc.body.childNodes).not.toContain(existing);
    expect(pending.childNodes).toContain(existing);
  });

  it("moves an existing node to a new parent (remove + re-append)", () => {
    const mock = makeMockWasm();
    bindWasm(mock.wasm);

    const doc = getNaiveDocument()!;
    const a = doc.createElement("div") as HTMLElement;
    const b = doc.createElement("div") as HTMLElement;
    const child = doc.createElement("div") as HTMLElement;
    a.appendChild(child);
    b.appendChild(child);

    const last = mock.calls.filter((c) => c.kind === "append_child").at(-1)!;
    expect(last.parent).toBe((b as unknown as NaiveElement)._mirror.wasmId);
    expect(last.child).toBe((child as unknown as NaiveElement)._mirror.wasmId);
    expect(a.childNodes).not.toContain(child);
    expect(b.childNodes).toContain(child);
  });

  it("resolves ids synchronously and flush() is a no-op", () => {
    const mock = makeMockWasm();
    bindWasm(mock.wasm);

    const doc = getNaiveDocument()!;
    const el = doc.createElement("div") as unknown as NaiveElement;
    expect(el._mirror.wasmId).not.toBe(0n);
    expect(isBatchPending(el._mirror)).toBe(false);
    expect(queuedOpCount()).toBe(0);
    expect(() => flush()).not.toThrow();
  });

  it("binds and unbinds events through bind_event / unbind_event", () => {
    const mock = makeMockWasm();
    bindWasm(mock.wasm);

    const doc = getNaiveDocument()!;
    const el = doc.createElement("div") as unknown as NaiveElement;
    const handler = () => {};
    el.addEventListener("click", handler);

    expect(mock.listenerIds()).toHaveLength(1);
    expect(
      mock.calls.some((c) => c.kind === "bind_event" && c.name === "click"),
    ).toBe(true);
    const token = el._handlerIds?.get(handler);
    expect(token).toBe(mock.listenerIds()[0]);

    el.removeEventListener("click", handler);
    expect(mock.removedListeners()).toEqual([mock.listenerIds()[0]]);
    expect(el._handlerIds?.get(handler)).toBeUndefined();
  });

  it("registers text mirrors so collectTextNodes sees them (plan 040 regression)", () => {
    const mock = makeMockWasm();
    bindWasm(mock.wasm);

    const doc = getNaiveDocument()!;
    const root = doc.createElement("div") as HTMLElement;
    const text = doc.createTextNode("Click Me");
    root.appendChild(text);

    // The direct protocol registers the mirror immediately, so the
    // placeholder collector sees it (font-pending text nodes keep their size).
    const nodes = collectTextNodes();
    expect(nodes.some((n) => n.text === "Click Me")).toBe(true);
    const found = nodes.find((n) => n.text === "Click Me")!;
    expect(found.wasmId).toBeGreaterThan(0n);

    // Removing the node must drop it from the registry.
    root.removeChild(text);
    expect(collectTextNodes().some((n) => n.text === "Click Me")).toBe(false);
  });
});

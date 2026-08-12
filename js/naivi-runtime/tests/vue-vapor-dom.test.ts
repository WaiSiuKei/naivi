// Tests for the Vue DOM facade routing + apply_ops batching (plan 037,
// U1/U2). The facade is driven with a recording mock WASM bridge; every
// mutation must flow through apply_ops batches.

import { describe, it, expect, beforeEach } from "vitest";
import { bindWasm } from "../src/native-tree.js";
import { initNaiveDocument, getNaiveDocument } from "../src/naive-dom.js";
import type { WasmExports } from "../src/wasm-types.js";

interface CallRecord {
  kind: string;
  payload?: unknown;
}

function makeMockWasm(): {
  calls: CallRecord[];
  applyOpsCalls: () => number;
  nextId: () => bigint;
  listenerIds: () => bigint[];
  removedListeners: () => bigint[];
} {
  let next = 1n;
  let nextListener = 10n;
  const calls: CallRecord[] = [];
  let applyOpsCalls = 0;
  const listenerIds: bigint[] = [];
  const removedListeners: bigint[] = [];
  const wasm: WasmExports = {
    create_element: (tag: string) => {
      calls.push({ kind: "create_element", payload: { tag } });
      const id = next++;
      return id;
    },
    set_style: (_node: bigint, key: string, value: string) => {
      calls.push({ kind: "set_style", payload: { key, value } });
    },
    set_rule_table: () => true,
    set_text: (_node: bigint, text: string) => {
      calls.push({ kind: "set_text", payload: { text } });
    },
    append_child: (_parent: bigint, _child: bigint) => {
      calls.push({ kind: "append_child" });
    },
    remove_node: (_node: bigint) => {
      calls.push({ kind: "remove_node" });
    },
    apply_ops: (opsJson: string) => {
      applyOpsCalls += 1;
      const ops = JSON.parse(opsJson) as Array<Record<string, unknown>>;
      const mapping: Record<string, number> = {};
      for (const op of ops) {
        if (op.type === "create") {
          const id = next++;
          mapping[op.reference as string] = Number(id);
        } else if (op.type === "alias") {
          mapping[op.reference as string] = Number(op.node as bigint);
        }
      }
      calls.push({ kind: "apply_ops", payload: { ops } });
      return JSON.stringify(mapping);
    },
    apply_conditional_styles: () => false,
    set_placeholder_measures: () => false,
    clear_placeholder_measures: () => false,
    get_layout_rect: () => 'null',
    compute_layout: () => "{}",
    add_event_listener: () => {
      const id = nextListener++;
      listenerIds.push(id);
      return id;
    },
    remove_event_listener: (id: bigint) => {
      removedListeners.push(id);
    },
    handle_event: () => {},
  };
  return {
    wasm,
    calls,
    applyOpsCalls: () => applyOpsCalls,
    nextId: () => next,
    listenerIds: () => listenerIds,
    removedListeners: () => removedListeners,
  };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("vue-vapor-dom facade", () => {
  beforeEach(() => {
    initNaiveDocument();
  });

  it("routes create/append/style/text through a single apply_ops batch", async () => {
    const mock = makeMockWasm();
    bindWasm(mock.wasm);

    const doc = getNaiveDocument()!;
    const el = doc.createElement("div") as HTMLElement;
    const text = doc.createTextNode("hi");
    el.appendChild(text);
    el.setAttribute("style", "color:red");

    await flushMicrotasks();

    expect(mock.applyOpsCalls()).toBe(1);
    const batch = mock.calls.find((c) => c.kind === "apply_ops")!.payload as {
      ops: Array<{ type: string }>;
    };
    const types = batch.ops.map((op) => op.type);
    expect(types).toContain("create");
    expect(types).toContain("append");
    expect(types).toContain("text");
    expect(types).toContain("style");
    // Facade pre-wires mirror parents before the batch; inserting a child into
    // its already-wired parent must NOT emit a remove-before-append pair.
    expect(types).not.toContain("remove");
    // No per-operation FFI round-trips.
    expect(mock.calls.filter((c) => c.kind !== "apply_ops").length).toBe(0);
  });

  it("gives the facade body viewport-filling UA styles when wasm is ready", async () => {
    const mock = makeMockWasm();
    bindWasm(mock.wasm);
    // Reinstall while bound so the document body is created wasm-backed.
    initNaiveDocument();
    await flushMicrotasks();

    const batch = mock.calls.find((c) => c.kind === "apply_ops")!.payload as {
      ops: Array<{ type: string; key?: string }>;
    };
    const styleKeys = batch.ops
      .filter((op) => op.type === "style")
      .map((op) => op.key);
    expect(styleKeys).toEqual(expect.arrayContaining(["width", "height"]));
  });

  it("coalesces same-tick updates into one batch and uses id addressing for existing nodes", async () => {
    const mock = makeMockWasm();
    bindWasm(mock.wasm);

    const doc = getNaiveDocument()!;
    const el = doc.createElement("div") as HTMLElement;
    const text = doc.createTextNode("hi");
    el.appendChild(text);
    await flushMicrotasks();
    const firstBatchCalls = mock.applyOpsCalls();

    // Same synchronous tick: two text updates + one style update.
    text.textContent = "a";
    text.textContent = "b";
    el.setAttribute("style", "width:10px");
    await flushMicrotasks();

    expect(mock.applyOpsCalls()).toBe(firstBatchCalls + 1);
    const last = mock.calls.filter((c) => c.kind === "apply_ops").at(-1)!
      .payload as { ops: Array<{ type: string; node?: bigint }> };
    const types = last.ops.map((op) => op.type);
    expect(types).toEqual(expect.arrayContaining(["textId", "textId", "styleId"]));
    for (const op of last.ops) {
      if (op.type.endsWith("Id")) {
        expect(typeof op.node).toBe("number");
        expect(op.node as number).toBeGreaterThan(0);
      }
    }
  });

  it("aliases an existing parent when appending a batch-pending child", async () => {
    const mock = makeMockWasm();
    bindWasm(mock.wasm);

    const doc = getNaiveDocument()!;
    const root = doc.createElement("div") as HTMLElement;
    await flushMicrotasks();

    const child = doc.createElement("div") as HTMLElement;
    root.appendChild(child);
    await flushMicrotasks();

    const last = mock.calls.filter((c) => c.kind === "apply_ops").at(-1)!
      .payload as { ops: Array<{ type: string }> };
    const types = last.ops.map((op) => op.type);
    expect(types).toContain("alias");
    expect(types).toContain("create");
    expect(types).toContain("append");
  });

  it("does not flush an empty tick", async () => {
    const mock = makeMockWasm();
    bindWasm(mock.wasm);

    await flushMicrotasks();
    expect(mock.applyOpsCalls()).toBe(0);
  });

  it("appends an existing child under a batch-pending parent without a zero parent id (P1 #2)", async () => {
    const mock = makeMockWasm();
    bindWasm(mock.wasm);

    const doc = getNaiveDocument()!;
    const existing = doc.createElement("div") as HTMLElement;
    doc.body.appendChild(existing);
    await flushMicrotasks();
    expect(existing._mirror.wasmId).not.toBe(0n);

    // Same tick: new (batch-pending) parent takes an existing child. The
    // batch must alias the child and ref-append it — never appendId with a
    // parent id of 0, which Rust would silently drop.
    const pending = doc.createElement("div") as HTMLElement;
    pending.appendChild(existing);
    await flushMicrotasks();

    const last = mock.calls.filter((c) => c.kind === "apply_ops").at(-1)!
      .payload as { ops: Array<{ type: string; parent?: number }> };
    const types = last.ops.map((op) => op.type);
    expect(types).toContain("append");
    expect(types).toContain("alias");
    for (const op of last.ops) {
      if (op.type === "appendId") {
        expect(op.parent ?? 0).toBeGreaterThan(0);
      }
    }
    // The existing child moved out of body's mirror children.
    expect(doc.body.childNodes).not.toContain(existing);
    expect(pending.childNodes).toContain(existing);
  });

  it("moves an existing node within one batch without destroy-then-append (P1 #3)", async () => {
    const mock = makeMockWasm();
    bindWasm(mock.wasm);

    const doc = getNaiveDocument()!;
    const a = doc.createElement("div") as HTMLElement;
    const b = doc.createElement("div") as HTMLElement;
    const child = doc.createElement("div") as HTMLElement;
    a.appendChild(child);
    await flushMicrotasks();
    expect(child._mirror.wasmId).not.toBe(0n);

    // Same synchronous tick: move child from a to b (Vue keyed reorder). The
    // remove op must be cancelled — the batch must carry a single appendId.
    b.appendChild(child);
    await flushMicrotasks();

    const last = mock.calls.filter((c) => c.kind === "apply_ops").at(-1)!
      .payload as { ops: Array<{ type: string }> };
    const types = last.ops.map((op) => op.type);
    expect(types).toContain("appendId");
    expect(types).not.toContain("removeId");
    expect(last.ops.filter((op) => op.type === "appendId")).toHaveLength(1);
    expect(a.childNodes).not.toContain(child);
    expect(b.childNodes).toContain(child);
  });

  it("retries a failed flush instead of orphaning pending mirrors (P1 #4)", async () => {
    let failNext = true;
    let applyCalls = 0;
    const wasm: WasmExports = {
      create_element: () => 0n,
      set_style: () => {},
      set_rule_table: () => true,
      set_text: () => {},
      append_child: () => {},
      remove_node: () => {},
      apply_ops: (opsJson: string) => {
        applyCalls += 1;
        if (failNext) {
          failNext = false;
          throw new Error("simulated transient apply_ops failure");
        }
        const ops = JSON.parse(opsJson) as Array<Record<string, unknown>>;
        const mapping: Record<string, number> = {};
        let id = 1;
        for (const op of ops) {
          if (op.type === "create") mapping[op.reference as string] = id++;
        }
        return JSON.stringify(mapping);
      },
      compute_layout: () => "{}",
      add_event_listener: () => 0n,
      remove_event_listener: () => {},
      handle_event: () => {},
      set_placeholder_measures: () => false,
      clear_placeholder_measures: () => false,
      get_layout_rect: () => 'null',
    };
    bindWasm(wasm);

    const doc = getNaiveDocument()!;
    const el = doc.createElement("div") as HTMLElement;
    await flushMicrotasks();

    // The transient failure was retried and the mirror still resolved its id.
    expect(applyCalls).toBeGreaterThanOrEqual(2);
    expect(el._mirror.wasmId).not.toBe(0n);
  });

  it("defers listeners on batch-pending nodes and removes them by token (P2 #5)", async () => {
    const mock = makeMockWasm();
    bindWasm(mock.wasm);

    const doc = getNaiveDocument()!;
    const el = doc.createElement("div") as HTMLElement;
    const handler = () => {};
    el.addEventListener("click", handler);

    // Node is batch-pending: the facade must hold a removable token, not a
    // real handler id yet.
    const token = el._handlerIds?.get(handler);
    expect(token).toBeDefined();
    expect((token as bigint) < 0n).toBe(true);

    await flushMicrotasks();
    // The deferred listener was registered with the real Rust handler id.
    expect(mock.listenerIds()).toHaveLength(1);

    el.removeEventListener("click", handler);
    expect(mock.removedListeners()).toEqual([mock.listenerIds()[0]]);
    expect(el._handlerIds?.get(handler)).toBeUndefined();
  });

  it("registers batched text mirrors so collectTextNodes sees them for placeholder measurement (plan 040 regression)", async () => {
    const mock = makeMockWasm();
    bindWasm(mock.wasm);
    const { collectTextNodes } = await import("../src/native-tree.js");

    const doc = getNaiveDocument()!;
    const root = doc.createElement("div") as HTMLElement;
    const text = doc.createTextNode("Click Me");
    root.appendChild(text);
    await flushMicrotasks();

    // After the batch resolves, the text mirror must be visible to the
    // placeholder collector — without this, font-pending text nodes collapse
    // to 0 width because set_placeholder_measures is never called.
    const nodes = collectTextNodes();
    expect(nodes.some((n) => n.text === "Click Me")).toBe(true);
    const found = nodes.find((n) => n.text === "Click Me")!;
    expect(found.wasmId).toBeGreaterThan(0n);

    // Removing the node must drop it from the registry so it is no longer
    // collected (and cannot keep a stale placeholder).
    root.removeChild(text);
    await flushMicrotasks();
    expect(collectTextNodes().some((n) => n.text === "Click Me")).toBe(false);
  });
});

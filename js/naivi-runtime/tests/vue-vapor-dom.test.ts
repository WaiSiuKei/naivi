// Tests for the Vue DOM facade routing over the U5 binary frame protocol.
//
// The facade is driven with a recording mock bridge that captures every
// `flush_frame(bytes)` payload; a small decoder turns frames back into
// per-op records so tests can assert the exact op stream. Mutations are
// queued into a [`FrameWriter`] and only reach the host at flush time — no
// per-op FFI calls (KD1/KD3).

import { describe, it, expect, beforeEach } from "vitest";
import { bindWasm, clearQueuedOps, collectTextNodes } from "../src/native-tree.js";
import { initNaiveDocument, getNaiveDocument, type NaiveElement } from "../src/naive-dom.js";
import { flush, queuedOpCount, isBatchPending } from "../src/batched-bridge.js";
import type { WasmExports } from "../src/wasm-types.js";

interface CallRecord {
  kind: string;
  tag?: string;
  text?: string;
  name?: string;
  value?: string;
  node?: number;
  child?: number;
  parent?: number;
}

function makeMockWasm(): {
  wasm: WasmExports;
  frames: Uint8Array[];
  eventCb: ((nodeId: number, kind: number, x: number, y: number) => void) | null;
  rejectedCb: ((seq: number, reason: number) => void) | null;
} {
  const frames: Uint8Array[] = [];
  let eventCb: ((nodeId: number, kind: number, x: number, y: number) => void) | null = null;
  let rejectedCb: ((seq: number, reason: number) => void) | null = null;
  const wasm: WasmExports = {
    flush_frame: (bytes: Uint8Array) => {
      frames.push(bytes);
    },
    set_event_callback: (cb) => {
      eventCb = cb;
    },
    set_frame_rejected_callback: (cb) => {
      rejectedCb = cb;
    },
    tick: () => {},
  };
  return { wasm, frames, eventCb, rejectedCb };
}

/** Decode every captured frame back into a flat list of per-op records. */
function decodeFrames(frames: Uint8Array[]): CallRecord[] {
  const records: CallRecord[] = [];
  const decoder = new TextDecoder();
  for (const f of frames) {
    const view = new DataView(f.buffer, f.byteOffset, f.byteLength);
    let off = 0;
    const count = view.getUint16(4, true); // [seq u32][count u16]
    off += 6;
    const u32 = () => {
      const v = view.getUint32(off, true);
      off += 4;
      return v;
    };
    const str = () => {
      const len = view.getUint16(off, true);
      off += 2;
      const s = decoder.decode(f.subarray(off, off + len));
      off += len;
      return s;
    };
    for (let i = 0; i < count; i++) {
      const op = f[off++];
      switch (op) {
        case 0x01: {
          const id = u32();
          records.push({ kind: "create_element", node: id, tag: str() });
          break;
        }
        case 0x02: {
          const id = u32();
          records.push({ kind: "create_text_node", node: id, text: str() });
          break;
        }
        case 0x03: records.push({ kind: "set_text", node: u32(), text: str() }); break;
        case 0x04: records.push({ kind: "set_attr", node: u32(), name: str(), value: str() }); break;
        case 0x05: records.push({ kind: "set_style", node: u32(), name: str(), value: str() }); break;
        case 0x06: records.push({ kind: "append_child", parent: u32(), child: u32() }); break;
        case 0x07: records.push({ kind: "attach_document_root", node: u32() }); break;
        case 0x08: records.push({ kind: "insert_before", node: u32(), child: u32() }); break;
        case 0x09: records.push({ kind: "insert_after", node: u32(), child: u32() }); break;
        case 0x0a: records.push({ kind: "replace_node", node: u32(), child: u32() }); break;
        case 0x0b: records.push({ kind: "remove_node", node: u32() }); break;
        case 0x0c: {
          const node = u32();
          const kind = f[off++];
          records.push({ kind: "bind_event", node, name: String(kind) });
          break;
        }
        case 0x0d: records.push({ kind: "unbind_event", node: u32() }); break;
        case 0x0e: {
          const len = view.getUint32(off, true);
          off += 4;
          const s = decoder.decode(f.subarray(off, off + len));
          off += len;
          records.push({ kind: "add_stylesheet", text: s });
          break;
        }
        case 0x0f: records.push({ kind: "reset" }); break;
        default: throw new Error(`unexpected opcode ${op}`);
      }
    }
  }
  return records;
}

describe("vue-vapor-dom facade (U5 frame protocol)", () => {
  beforeEach(() => {
    initNaiveDocument();
    clearQueuedOps();
  });

  it("routes create/append/style/text into one frame", () => {
    const mock = makeMockWasm();
    bindWasm(mock.wasm);

    const doc = getNaiveDocument()!;
    const el = doc.createElement("div") as HTMLElement;
    const text = doc.createTextNode("hi");
    el.appendChild(text);
    el.setAttribute("style", "color:red");

    flush();
    const records = decodeFrames(mock.frames);
    expect(records.some((c) => c.kind === "create_element" && c.tag === "div")).toBe(true);
    expect(records.some((c) => c.kind === "create_text_node" && c.text === "hi")).toBe(true);
    expect(records.some((c) => c.kind === "append_child")).toBe(true);
    expect(
      records.some((c) => c.kind === "set_style" && c.name === "color" && c.value === "red"),
    ).toBe(true);
    // Still no apply_ops anywhere.
    expect(records.some((c) => c.kind === "apply_ops")).toBe(false);
  });

  it("gives the facade body viewport-filling UA styles in the first frame", () => {
    const mock = makeMockWasm();
    bindWasm(mock.wasm);
    // Reinstall so the body's bootstrap ops are queued after the mock bind
    // (the beforeEach's body ops were cleared for isolation).
    initNaiveDocument();
    flush();

    const calls = decodeFrames(mock.frames);
    const styleKeys = calls.filter((c) => c.kind === "set_style").map((c) => c.name);
    expect(styleKeys).toEqual(expect.arrayContaining(["width", "height"]));
    expect(calls.some((c) => c.kind === "attach_document_root")).toBe(true);
  });

  it("buffers same-tick updates and flushes them as one frame", () => {
    const mock = makeMockWasm();
    bindWasm(mock.wasm);

    const doc = getNaiveDocument()!;
    const el = doc.createElement("div") as HTMLElement;
    const text = doc.createTextNode("hi");
    el.appendChild(text);

    text.textContent = "a";
    text.textContent = "b";
    el.setAttribute("style", "width:10px");

    expect(mock.frames).toHaveLength(0); // nothing reached the host yet
    expect(queuedOpCount()).toBeGreaterThan(0);
    flush();
    const records = decodeFrames(mock.frames);
    const texts = records.filter((c) => c.kind === "set_text").map((c) => c.text);
    expect(texts).toEqual(["a", "b"]);
    expect(
      records.some((c) => c.kind === "set_style" && c.name === "width" && c.value === "10px"),
    ).toBe(true);
    // After flush the writer is empty again.
    expect(queuedOpCount()).toBe(0);
  });

  it("appends an existing child under a new parent with the parent's virtual id", () => {
    const mock = makeMockWasm();
    bindWasm(mock.wasm);

    const doc = getNaiveDocument()!;
    const existing = doc.createElement("div") as HTMLElement;
    doc.body.appendChild(existing);

    flush();
    let records = decodeFrames(mock.frames);
    const first = records.filter((c) => c.kind === "append_child").at(-1)!;
    expect(first.parent).toBe((doc.body as unknown as NaiveElement)._mirror.id);
    expect(first.parent).not.toBe(0);

    const pending = doc.createElement("div") as HTMLElement;
    pending.appendChild(existing);
    flush();
    records = decodeFrames(mock.frames);
    const last = records.filter((c) => c.kind === "append_child").at(-1)!;
    expect(last.parent).toBe((pending as unknown as NaiveElement)._mirror.id);
    expect(last.parent).not.toBe(0);
    expect(last.child).toBe((existing as unknown as NaiveElement)._mirror.id);
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

    flush();
    const records = decodeFrames(mock.frames);
    const last = records.filter((c) => c.kind === "append_child").at(-1)!;
    expect(last.parent).toBe((b as unknown as NaiveElement)._mirror.id);
    expect(last.child).toBe((child as unknown as NaiveElement)._mirror.id);
    expect(a.childNodes).not.toContain(child);
    expect(b.childNodes).toContain(child);
  });

  it("resolves virtual ids synchronously; flush() emits one frame", () => {
    const mock = makeMockWasm();
    bindWasm(mock.wasm);

    const doc = getNaiveDocument()!;
    const el = doc.createElement("div") as unknown as NaiveElement;
    expect(el._mirror.id).not.toBe(0);
    expect(isBatchPending(el._mirror)).toBe(false);
    expect(queuedOpCount()).toBeGreaterThan(0);
    expect(() => flush()).not.toThrow();
    expect(mock.frames).toHaveLength(1);
  });

  it("binds and unbinds events through bind_event / unbind_event ops", () => {
    const mock = makeMockWasm();
    bindWasm(mock.wasm);

    const doc = getNaiveDocument()!;
    const el = doc.createElement("div") as unknown as NaiveElement;
    const handler = () => {};
    el.addEventListener("click", handler);

    flush();
    const bindRecords = decodeFrames(mock.frames).filter((c) => c.kind === "bind_event");
    expect(bindRecords).toHaveLength(1);
    expect(bindRecords[0].node).toBe(el._mirror.id);
    expect(bindRecords[0].name).toBe("0"); // click → EVENT_KINDS.click
    const token = el._handlerIds?.get(handler);
    expect(token).toBe(BigInt(el._mirror.id));

    el.removeEventListener("click", handler);
    flush();
    const unbindRecords = decodeFrames(mock.frames).filter((c) => c.kind === "unbind_event");
    expect(unbindRecords).toHaveLength(1);
    expect(unbindRecords[0].node).toBe(el._mirror.id);
    expect(el._handlerIds?.get(handler)).toBeUndefined();
  });

  it("registers text mirrors so collectTextNodes sees them (plan 040 regression)", () => {
    const mock = makeMockWasm();
    bindWasm(mock.wasm);

    const doc = getNaiveDocument()!;
    const root = doc.createElement("div") as HTMLElement;
    const text = doc.createTextNode("Click Me");
    root.appendChild(text);

    // The frame model registers the mirror immediately (virtual id), so the
    // placeholder collector sees it (font-pending text nodes keep their size).
    const nodes = collectTextNodes();
    expect(nodes.some((n) => n.text === "Click Me")).toBe(true);
    const found = nodes.find((n) => n.text === "Click Me")!;
    expect(found.id).toBeGreaterThan(0);

    // Removing the node must drop it from the registry.
    root.removeChild(text);
    expect(collectTextNodes().some((n) => n.text === "Click Me")).toBe(false);
  });

  it("removeNode does not emit an UnbindEvent op in the same frame (regression)", () => {
    const mock = makeMockWasm();
    bindWasm(mock.wasm);

    const doc = getNaiveDocument()!;
    const root = doc.createElement("div") as HTMLElement;
    const old = doc.createTextNode("Count: 0");
    root.appendChild(old);
    root.addEventListener("click", () => {});

    // Vue-style text re-render: remove the old text node and insert a new one
    // (new virtual id) before the next flush — the old node's binding dies
    // with the node, so no UnbindEvent must follow RemoveNode (it would
    // reference an id invalidated in the same frame and reject it).
    root.removeChild(old);
    const fresh = doc.createTextNode("Count: 1");
    root.appendChild(fresh);
    flush();

    const records = decodeFrames(mock.frames);
    const removes = records.filter((c) => c.kind === "remove_node");
    expect(removes).toHaveLength(1);
    // No unbind op for the removed node.
    expect(records.some((c) => c.kind === "unbind_event")).toBe(false);
    // The fresh text node landed under the root.
    expect(
      records.some((c) => c.kind === "create_text_node" && c.text === "Count: 1"),
    ).toBe(true);
  });
});


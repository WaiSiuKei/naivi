// Shared test harness for the U5 frame protocol (KD1/KD3).
//
// A recording mock that captures every `flush_frame(bytes)` payload plus a
// small decoder that turns frames back into per-op records, so tests can
// assert the exact op stream the facade produced.

import type { WasmExports } from '../../src/wasm-types.js';

export interface CallRecord {
  kind: string;
  tag?: string;
  text?: string;
  name?: string;
  value?: string;
  node?: number;
  child?: number;
  parent?: number;
}

export type EventCb = (
  nodeId: number,
  kind: number,
  x: number,
  y: number,
  key?: string,
  code?: string,
  value?: string,
) => void;

export interface MockBridge {
  wasm: WasmExports;
  frames: Uint8Array[];
  /** Fire a host-dispatched event into the guest's event callback. */
  fireEvent: (nodeId: number, kind: number, value?: string) => void;
  /** Simulate a `frame_rejected(seq, reason)` into the guest's handler. */
  rejectFrame: (seq: number, reason: number) => void;
  rejected: Array<{ seq: number; reason: number }>;
}

/** Build a recording bridge mock for the U5 surface. */
export function makeMockWasm(): MockBridge {
  const frames: Uint8Array[] = [];
  const rejected: Array<{ seq: number; reason: number }> = [];
  let eventCb: EventCb | null = null;
  let rejectCb: ((seq: number, reason: number) => void) | null = null;
  const wasm: WasmExports = {
    flush_frame: (bytes: Uint8Array) => {
      frames.push(bytes);
    },
    set_event_callback: (cb) => {
      eventCb = cb as EventCb;
    },
    set_frame_rejected_callback: (cb) => {
      rejectCb = (seq, reason) => {
        rejected.push({ seq, reason });
        cb(seq, reason);
      };
    },
    tick: () => {},
  };
  return {
    wasm,
    frames,
    fireEvent: (nodeId, kind, value) =>
      eventCb?.(nodeId, kind, 0, 0, '', '', value),
    rejectFrame: (seq, reason) => rejectCb?.(seq, reason),
    rejected,
  };
}

/** Decode every captured frame back into a flat list of per-op records. */
export function decodeFrames(frames: Uint8Array[]): CallRecord[] {
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
        case 0x01: records.push({ kind: 'create_element', tag: str() }); break;
        case 0x02: records.push({ kind: 'create_text_node', text: str() }); break;
        case 0x03: records.push({ kind: 'set_text', node: u32(), text: str() }); break;
        case 0x04: records.push({ kind: 'set_attr', node: u32(), name: str(), value: str() }); break;
        case 0x05: records.push({ kind: 'set_style', node: u32(), name: str(), value: str() }); break;
        case 0x06: records.push({ kind: 'append_child', parent: u32(), child: u32() }); break;
        case 0x07: records.push({ kind: 'attach_document_root', node: u32() }); break;
        case 0x08: records.push({ kind: 'insert_before', node: u32(), child: u32() }); break;
        case 0x09: records.push({ kind: 'insert_after', node: u32(), child: u32() }); break;
        case 0x0a: records.push({ kind: 'replace_node', node: u32(), child: u32() }); break;
        case 0x0b: records.push({ kind: 'remove_node', node: u32() }); break;
        case 0x0c: {
          const node = u32();
          const kind = f[off++];
          records.push({ kind: 'bind_event', node, name: String(kind) });
          break;
        }
        case 0x0d: records.push({ kind: 'unbind_event', node: u32() }); break;
        case 0x0e: {
          const len = view.getUint32(off, true);
          off += 4;
          const s = decoder.decode(f.subarray(off, off + len));
          off += len;
          records.push({ kind: 'add_stylesheet', text: s });
          break;
        }
        case 0x0f: records.push({ kind: 'reset' }); break;
        default: throw new Error(`unexpected opcode ${op}`);
      }
    }
  }
  return records;
}

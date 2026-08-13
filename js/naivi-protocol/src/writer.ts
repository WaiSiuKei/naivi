// Binary frame writer for the naivi DOM-change transport (stage 2, KTD1).
//
// Frame wire format (JS→Rust):
//   [seq: u32 LE][count: u16 LE][op…]
//   each op = [opcode: u8][operands]
//   strings = [len: u16][utf8] — except `AddStylesheet` which uses
//   [len: u32][utf8] (compiled CSS can exceed 64KiB).
// Node operands are JS-assigned virtual ids (u32); `0` is never a node.
//
// The writer enforces the u16 string cap (R14): any over-cap string throws on
// the JS side instead of producing an unencodable frame. `flush()` returns an
// empty buffer when the frame has no ops (caller skips `flush_frame`).

import { MAX_U16_STRING, OP } from './index.js';

/** Bytes reserved for the `[seq u32][count u16]` frame header. */
const HEADER_SIZE = 6;

export class FrameWriter {
  private _buf = new Uint8Array(256);
  private _view = new DataView(this._buf.buffer);
  private _len = HEADER_SIZE;
  private _count = 0;
  private _seq = 0;

  /** Number of ops accumulated in the current frame. */
  get opCount(): number {
    return this._count;
  }

  /** Number of ops accumulated since the last `clear()`. */
  get byteLength(): number {
    return this._len;
  }

  private ensure(extra: number): void {
    if (this._len + extra <= this._buf.byteLength) return;
    let cap = this._buf.byteLength;
    while (cap < this._len + extra) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this._buf.subarray(0, this._len));
    this._buf = next;
    this._view = new DataView(next.buffer);
  }

  private u8(v: number): void {
    this.ensure(1);
    this._view.setUint8(this._len, v);
    this._len += 1;
  }

  private u16(v: number): void {
    this.ensure(2);
    this._view.setUint16(this._len, v, true);
    this._len += 2;
  }

  private u32(v: number): void {
    this.ensure(4);
    this._view.setUint32(this._len, v, true);
    this._len += 4;
  }

  private node(v: number): void {
    this.u32(v);
  }

  /** u16-length-prefixed string; throws on over-cap (R14). */
  private str(v: string): void {
    const bytes = new TextEncoder().encode(v);
    if (bytes.byteLength > MAX_U16_STRING) {
      throw new Error(
        `naivi frame string exceeds u16 cap (${bytes.byteLength} bytes > 65535); ` +
          `string of ${v.length} chars cannot be encoded in a DOM frame`,
      );
    }
    this.u16(bytes.byteLength);
    this.ensure(bytes.byteLength);
    this._buf.set(bytes, this._len);
    this._len += bytes.byteLength;
  }

  /** u32-length-prefixed string (AddStylesheet: CSS can exceed 64KiB). */
  private longStr(v: string): void {
    const bytes = new TextEncoder().encode(v);
    this.u32(bytes.byteLength);
    this.ensure(bytes.byteLength);
    this._buf.set(bytes, this._len);
    this._len += bytes.byteLength;
  }

  private op(code: number): void {
    this.u8(code);
    this._count += 1;
  }

  // ── ops ────────────────────────────────────────────────────────────────────

  createElement(tag: string): void {
    this.op(OP.CreateElement);
    this.str(tag);
  }

  createTextNode(text: string): void {
    this.op(OP.CreateText);
    this.str(text);
  }

  setText(node: number, text: string): void {
    this.op(OP.SetText);
    this.node(node);
    this.str(text);
  }

  setAttr(node: number, name: string, value: string): void {
    this.op(OP.SetAttr);
    this.node(node);
    this.str(name);
    this.str(value);
  }

  setStyle(node: number, key: string, value: string): void {
    this.op(OP.SetStyle);
    this.node(node);
    this.str(key);
    this.str(value);
  }

  appendChild(parent: number, child: number): void {
    this.op(OP.AppendChild);
    this.node(parent);
    this.node(child);
  }

  attachRoot(node: number): void {
    this.op(OP.AttachRoot);
    this.node(node);
  }

  insertBefore(anchor: number, child: number): void {
    this.op(OP.InsertBefore);
    this.node(anchor);
    this.node(child);
  }

  insertAfter(anchor: number, child: number): void {
    this.op(OP.InsertAfter);
    this.node(anchor);
    this.node(child);
  }

  replaceNode(old: number, replacement: number): void {
    this.op(OP.ReplaceNode);
    this.node(old);
    this.node(replacement);
  }

  removeNode(node: number): void {
    this.op(OP.RemoveNode);
    this.node(node);
  }

  bindEvent(node: number, kind: number): void {
    this.op(OP.BindEvent);
    this.node(node);
    this.u8(kind);
  }

  unbindEvent(node: number): void {
    this.op(OP.UnbindEvent);
    this.node(node);
  }

  addStylesheet(css: string): void {
    this.op(OP.AddStylesheet);
    this.longStr(css);
  }

  reset(): void {
    this.op(OP.Reset);
  }

  // ── frame lifecycle ────────────────────────────────────────────────────────

  /**
   * Finalize and return the current frame (with `[seq u32][count u16]` header
   * written at the front), then reset for the next frame. Returns an empty
   * buffer when there were no ops (caller skips the flush).
   */
  flush(): Uint8Array {
    if (this._count === 0) return new Uint8Array(0);
    this._view.setUint32(0, this._seq, true);
    this._view.setUint16(4, this._count, true);
    const out = this._buf.slice(0, this._len);
    this._seq += 1;
    this.clear();
    return out;
  }

  /** Discard the current frame's ops (e.g. on `frame_rejected`). */
  clear(): void {
    this._len = HEADER_SIZE;
    this._count = 0;
  }
}

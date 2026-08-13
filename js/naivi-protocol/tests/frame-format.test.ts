import { describe, expect, it } from 'vitest';
import { EVENT_KINDS, OP, kindToEventType } from '../src/index.js';
import { FrameWriter } from '../src/writer.js';

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

describe('FrameWriter wire format (KTD1)', () => {
  it('encodes a createElement + appendChild frame with exact bytes', () => {
    const w = new FrameWriter();
    w.createElement('div');
    w.appendChild(1, 2);
    const frame = w.flush();
    expect(hex(frame)).toBe('00 00 00 00 02 00 01 03 00 64 69 76 06 01 00 00 00 02 00 00 00');
    // seq 0, count 2, createElement('div'), appendChild(1,2)
  });

  it('increments seq and resets count between flushes', () => {
    const w = new FrameWriter();
    w.reset();
    const first = w.flush();
    w.createElement('a');
    const second = w.flush();
    expect(hex(first)).toBe('00 00 00 00 01 00 0f'); // seq 0, count 1, reset
    expect(hex(second)).toBe('01 00 00 00 01 00 01 01 00 61'); // seq 1, count 1, createElement('a')
  });

  it('returns an empty buffer when there are no ops (caller skips flush)', () => {
    const w = new FrameWriter();
    expect(w.flush().byteLength).toBe(0);
  });

  it('writes u16 length-prefixed strings', () => {
    const w = new FrameWriter();
    w.setText(7, 'hi');
    const frame = w.flush();
    expect(hex(frame)).toBe('00 00 00 00 01 00 03 07 00 00 00 02 00 68 69');
    // seq0 count1 setText node7 len2 'hi'
  });

  it('addStylesheet uses a u32 length prefix', () => {
    const w = new FrameWriter();
    w.addStylesheet('a'.repeat(70000));
    const frame = w.flush();
    const view = new DataView(frame.buffer);
    // header(6) + opcode(1) then u32 LE length 70000
    const len = view.getUint32(7, true);
    expect(len).toBe(70000);
    expect(frame.byteLength).toBe(6 + 1 + 4 + 70000);
  });

  it('throws on a string over the u16 cap (R14 prevention)', () => {
    const w = new FrameWriter();
    expect(() => w.setText(1, 'x'.repeat(65536))).toThrow(/u16 cap/);
    // Recovery contract: the throw leaves the frame broken; the caller clears
    // it so no unencodable frame is ever flushed.
    w.clear();
    expect(w.opCount).toBe(0);
    expect(w.flush().byteLength).toBe(0);
  });
});

describe('SOT op table', () => {
  it('has distinct opcodes and matches the generated Rust op constants', () => {
    const values = Object.values(OP);
    expect(new Set(values).size).toBe(values.length);
    // Spot-check the constants the build.rs emits from this table.
    expect(OP.CreateElement).toBe(0x01);
    expect(OP.AddStylesheet).toBe(0x0e);
    expect(OP.Reset).toBe(0x0f);
  });

  it('exposes the event-kind table consistently (eventTypeToKind/kindToEventType)', () => {
    expect(Object.keys(EVENT_KINDS)).toHaveLength(12);
    expect(kindToEventType(11)).toBe('input');
    expect(kindToEventType(0)).toBe('click');
  });
});

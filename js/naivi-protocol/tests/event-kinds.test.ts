import { describe, expect, it } from 'vitest';
import {
  EVENT_KINDS,
  SYNTHESIZED_EVENT_TYPES,
  eventTypeToKind,
  kindToEventType,
  type EventType,
  type WireEventType,
} from '../src/index.js';

/** The regex the build.rs naive parser uses (kept in sync with it). */
const BARE_LITERAL_ENTRY = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(0x[0-9a-fA-F]+|-?\d+)\s*,?\s*$/;

describe('EVENT_KINDS wire table', () => {
  it('has exactly 12 kinds with explicit authoritative u8 numbers 0..11, no gaps or duplicates', () => {
    const entries = Object.entries(EVENT_KINDS);
    expect(entries).toHaveLength(12);
    const values = entries.map(([, k]) => k);
    // Explicit numbers are the authority; order is only a test-time invariant.
    expect(new Set(values).size).toBe(12);
    for (let i = 0; i < 12; i++) {
      expect(values).toContain(i);
    }
    // The values match the array order too (current table is contiguous).
    expect(values).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('is parseable by the build.rs naive literal-table parser (R2 format contract)', () => {
    for (const [name, value] of Object.entries(EVENT_KINDS)) {
      expect(`${name}: ${value},`).toMatch(BARE_LITERAL_ENTRY);
    }
  });
});

describe('synthesized events', () => {
  it("marks 'change' as synthesized and keeps it out of the wire table", () => {
    expect(SYNTHESIZED_EVENT_TYPES).toEqual(['change']);
    expect(Object.keys(EVENT_KINDS)).not.toContain('change');
  });
});

describe('eventTypeToKind / kindToEventType', () => {
  it('round-trips every wire kind', () => {
    for (const type of Object.keys(EVENT_KINDS) as WireEventType[]) {
      const kind = eventTypeToKind(type);
      expect(kindToEventType(kind)).toBe(type);
    }
  });

  it('falls back to click for unknown kinds (existing semantics)', () => {
    expect(kindToEventType(255)).toBe('click');
  });

  it('maps a synthesized type (change) to click (0) — never bound on the wire', () => {
    expect(eventTypeToKind('change' as EventType)).toBe(0);
  });

  it('explicit u8 values agree with key order in the current table (test-time invariant only)', () => {
    Object.entries(EVENT_KINDS).forEach(([type, kind], index) => {
      expect(kind).toBe(index);
      void type;
    });
  });
});

//! Self-heal path tests (R15/F3, KD4/KD8).
//!
//! On `frame_rejected(seq, reason)` the guest must: clear the writer (drop
//! any pending ops), emit a `reset` op, flush it, and invoke the installed
//! recovery handler (the entry re-creates the facade + re-mounts). The
//! writer must be empty afterwards so the next mutation starts a clean frame.

import { describe, expect, it, beforeEach, vi } from 'vitest';

import {
  bindWasm,
  registerFrameRejectedHandler,
  createElement,
  flushFrame,
  queuedOpCount,
  emitReset,
  clearQueuedOps,
} from '../src/native-tree.js';
import { makeMockWasm, decodeFrames } from './helpers/frame-harness.js';

describe('frame-rejection self-heal (R15/F3)', () => {
  beforeEach(() => {
    // Isolate module-level state between tests.
    emitReset();
    clearQueuedOps();
  });

  it('clears the writer, emits reset, and runs the recovery handler', () => {
    const mock = makeMockWasm();
    bindWasm(mock.wasm);

    const recover = vi.fn();
    registerFrameRejectedHandler(recover);

    // Queue some ops before the rejection (they must be dropped, not flushed).
    createElement('div');
    expect(queuedOpCount()).toBeGreaterThan(0);

    mock.rejectFrame(5, 1);

    // The recovery handler ran.
    expect(recover).toHaveBeenCalledTimes(1);
    // The rejection was surfaced with its (seq, reason).
    expect(mock.rejected).toEqual([{ seq: 5, reason: 1 }]);
    // The reset op was flushed to the host in its own frame.
    const records = decodeFrames(mock.frames);
    expect(records.some((c) => c.kind === 'reset')).toBe(true);
    // The pre-rejection ops were dropped (the only frame is the reset frame).
    expect(records.some((c) => c.kind === 'create_element')).toBe(false);
    // Writer is empty again — the next mutation starts a clean frame.
    expect(queuedOpCount()).toBe(0);
  });

  it('flushes a fresh frame normally after a rejection', () => {
    const mock = makeMockWasm();
    bindWasm(mock.wasm);
    const recover = vi.fn();
    registerFrameRejectedHandler(recover);

    mock.rejectFrame(1, 1);
    expect(queuedOpCount()).toBe(0);

    // Post-recovery mutations build a normal frame.
    createElement('div');
    flushFrame();
    const records = decodeFrames(mock.frames);
    expect(records.some((c) => c.kind === 'create_element' && c.tag === 'div')).toBe(true);
    // The recovery handler is still installed (fires again on the next reject).
    mock.rejectFrame(2, 1);
    expect(recover).toHaveBeenCalledTimes(2);
  });
});

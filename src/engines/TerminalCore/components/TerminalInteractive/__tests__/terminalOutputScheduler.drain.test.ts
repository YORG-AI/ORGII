/**
 * Pane lifecycle, drain priority, and adaptive chunk sizing tests.
 */
import { describe, expect, it, vi } from "vitest";

import {
  ADAPT_GROW_CONSECUTIVE_FRAMES,
  ADAPT_GROW_THRESHOLD_MS,
  ADAPT_SHRINK_THRESHOLD_MS,
  BACKGROUND_DRAIN_INTERVAL_MS,
  BACKGROUND_TIME_BUDGET_MS,
  INITIAL_CHUNK_SIZE,
  MAX_CHUNK_SIZE,
  MIN_CHUNK_SIZE,
  _testApplyRenderMs,
  getBacklogBytes,
  getChunkSize,
  notifyUserInput,
  registerPane,
  scheduleWrite,
  setPaneForeground,
  unregisterPane,
} from "../terminalOutputScheduler";
import {
  SESSION_A,
  SESSION_B,
  flushTimers,
  makeWrite,
} from "./terminalOutputScheduler.testSetup";

vi.mock("@src/util/platform/tauri/init", () => ({
  invokeTauri: vi.fn().mockResolvedValue(undefined),
  isTauriReady: vi.fn().mockReturnValue(true),
  listenTauri: vi.fn().mockResolvedValue(() => undefined),
}));

vi.mock("@src/hooks/logger", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ============================================
// Pane lifecycle
// ============================================

describe("pane lifecycle", () => {
  it("registers and unregisters a pane", () => {
    const { fn } = makeWrite();
    registerPane(SESSION_A, fn);
    expect(getBacklogBytes(SESSION_A)).toBe(0);

    unregisterPane(SESSION_A);
    expect(getBacklogBytes(SESSION_A)).toBe(0);
  });

  it("auto-registers on first scheduleWrite call", async () => {
    const { fn, calls } = makeWrite();
    setPaneForeground(SESSION_A, true);
    scheduleWrite(SESSION_A, "hello", 5, fn);

    await flushTimers();
    expect(calls.some((c) => c === "hello")).toBe(true);
  });
});

// ============================================
// Foreground drain (MessageChannel work loop)
// ============================================

describe("foreground drain via MessageChannel", () => {
  it("drains via MessageChannel turn (not RAF)", async () => {
    const { fn, calls } = makeWrite();
    registerPane(SESSION_A, fn);
    setPaneForeground(SESSION_A, true);

    scheduleWrite(SESSION_A, "data1", 5, fn);

    expect(calls.length).toBe(0); // not written yet

    await flushTimers();
    expect(calls.some((c) => c === "data1")).toBe(true);
  });

  it("continues draining across multiple turns until queue is empty", async () => {
    const { fn, calls } = makeWrite();
    registerPane(SESSION_A, fn);
    setPaneForeground(SESSION_A, true);

    // Queue more entries than writes-per-turn
    const count = 6;
    for (let i = 0; i < count; i++) {
      scheduleWrite(SESSION_A, `item${i}`, 5, fn);
    }

    await flushTimers();
    expect(calls.length).toBe(count);
    expect(getBacklogBytes(SESSION_A)).toBe(0);
  });

  it("switches from background to foreground drain correctly", async () => {
    const { fn, calls } = makeWrite();
    registerPane(SESSION_A, fn);
    setPaneForeground(SESSION_A, false);

    scheduleWrite(SESSION_A, "switch-test", 11, fn);

    // Switch to foreground before background timer fires
    setPaneForeground(SESSION_A, true);

    await flushTimers();
    expect(calls.some((c) => c === "switch-test")).toBe(true);
  });
});

// ============================================
// Background drain
// ============================================

describe("background drain", () => {
  it("does not drain immediately for a background pane", async () => {
    const { fn, calls } = makeWrite();
    registerPane(SESSION_A, fn);
    setPaneForeground(SESSION_A, false);

    scheduleWrite(SESSION_A, "bg-data", 7, fn);

    vi.advanceTimersByTime(BACKGROUND_DRAIN_INTERVAL_MS - 1);
    expect(calls.length).toBe(0);
  });

  it(`drains after ${BACKGROUND_DRAIN_INTERVAL_MS} ms for a background pane`, async () => {
    const { fn, calls } = makeWrite();
    registerPane(SESSION_A, fn);
    setPaneForeground(SESSION_A, false);

    scheduleWrite(SESSION_A, "bg-data", 7, fn);

    vi.advanceTimersByTime(BACKGROUND_DRAIN_INTERVAL_MS);
    expect(calls.some((c) => c === "bg-data")).toBe(true);
  });

  it("BACKGROUND_TIME_BUDGET_MS is positive and less than one frame", () => {
    expect(BACKGROUND_TIME_BUDGET_MS).toBeGreaterThan(0);
    expect(BACKGROUND_TIME_BUDGET_MS).toBeLessThan(16);
  });
});

// ============================================
// Adaptive chunk sizing
// ============================================
//
// These tests use _testApplyRenderMs to inject render-time measurements
// directly into the pane state, bypassing performance.now() timing issues
// in the test environment. This tests the adaptation logic (which is pure
// arithmetic) in isolation from the write timing measurement path.

describe("adaptive chunk sizing", () => {
  it("starts at INITIAL_CHUNK_SIZE", () => {
    const { fn } = makeWrite();
    registerPane(SESSION_A, fn);
    expect(getChunkSize(SESSION_A)).toBe(INITIAL_CHUNK_SIZE);
  });

  it("halves chunk size when renderMs > ADAPT_SHRINK_THRESHOLD_MS", () => {
    const { fn } = makeWrite();
    registerPane(SESSION_A, fn);

    _testApplyRenderMs(SESSION_A, ADAPT_SHRINK_THRESHOLD_MS + 1);

    expect(getChunkSize(SESSION_A)).toBe(INITIAL_CHUNK_SIZE >> 1);
    expect(getChunkSize(SESSION_A)).toBeGreaterThanOrEqual(MIN_CHUNK_SIZE);
  });

  it("doubles chunk size after ADAPT_GROW_CONSECUTIVE_FRAMES fast renders", () => {
    const { fn } = makeWrite();
    registerPane(SESSION_A, fn);

    for (let i = 0; i < ADAPT_GROW_CONSECUTIVE_FRAMES; i++) {
      _testApplyRenderMs(SESSION_A, ADAPT_GROW_THRESHOLD_MS - 1);
    }

    expect(getChunkSize(SESSION_A)).toBe(INITIAL_CHUNK_SIZE << 1);
    expect(getChunkSize(SESSION_A)).toBeLessThanOrEqual(MAX_CHUNK_SIZE);
  });

  it("does not grow before ADAPT_GROW_CONSECUTIVE_FRAMES consecutive fast renders", () => {
    const { fn } = makeWrite();
    registerPane(SESSION_A, fn);

    for (let i = 0; i < ADAPT_GROW_CONSECUTIVE_FRAMES - 1; i++) {
      _testApplyRenderMs(SESSION_A, ADAPT_GROW_THRESHOLD_MS - 1);
    }

    expect(getChunkSize(SESSION_A)).toBe(INITIAL_CHUNK_SIZE);
  });

  it("resets grow streak when a medium-speed render interrupts", () => {
    const { fn } = makeWrite();
    registerPane(SESSION_A, fn);

    // Almost enough to grow
    for (let i = 0; i < ADAPT_GROW_CONSECUTIVE_FRAMES - 1; i++) {
      _testApplyRenderMs(SESSION_A, ADAPT_GROW_THRESHOLD_MS - 1);
    }
    // Medium render resets streak
    _testApplyRenderMs(
      SESSION_A,
      (ADAPT_GROW_THRESHOLD_MS + ADAPT_SHRINK_THRESHOLD_MS) / 2
    );
    // One more fast render — should NOT trigger growth since streak was reset
    _testApplyRenderMs(SESSION_A, ADAPT_GROW_THRESHOLD_MS - 1);

    expect(getChunkSize(SESSION_A)).toBe(INITIAL_CHUNK_SIZE);
  });

  it("chunk size never exceeds MAX_CHUNK_SIZE", () => {
    const { fn } = makeWrite();
    registerPane(SESSION_A, fn);

    for (let i = 0; i < 100; i++) {
      _testApplyRenderMs(SESSION_A, ADAPT_GROW_THRESHOLD_MS - 1);
    }

    expect(getChunkSize(SESSION_A)).toBeLessThanOrEqual(MAX_CHUNK_SIZE);
  });

  it("chunk size never goes below MIN_CHUNK_SIZE", () => {
    const { fn } = makeWrite();
    registerPane(SESSION_A, fn);

    for (let i = 0; i < 30; i++) {
      _testApplyRenderMs(SESSION_A, ADAPT_SHRINK_THRESHOLD_MS * 10);
    }

    expect(getChunkSize(SESSION_A)).toBeGreaterThanOrEqual(MIN_CHUNK_SIZE);
  });

  it("shrink resets after slow render regardless of grow streak", () => {
    const { fn } = makeWrite();
    registerPane(SESSION_A, fn);

    // Build up a grow streak
    for (let i = 0; i < ADAPT_GROW_CONSECUTIVE_FRAMES - 1; i++) {
      _testApplyRenderMs(SESSION_A, ADAPT_GROW_THRESHOLD_MS - 1);
    }
    // Slow render — should shrink AND reset streak
    _testApplyRenderMs(SESSION_A, ADAPT_SHRINK_THRESHOLD_MS + 1);

    expect(getChunkSize(SESSION_A)).toBe(INITIAL_CHUNK_SIZE >> 1);
  });
});

// ============================================
// Multiple panes / priority isolation
// ============================================

describe("multiple panes", () => {
  it("isolates drain state between foreground and background panes", async () => {
    const { fn: fnA, calls: callsA } = makeWrite();
    const { fn: fnB, calls: callsB } = makeWrite();

    registerPane(SESSION_A, fnA);
    registerPane(SESSION_B, fnB);

    setPaneForeground(SESSION_A, true);
    setPaneForeground(SESSION_B, false);

    scheduleWrite(SESSION_A, "fg-data", 7, fnA);
    scheduleWrite(SESSION_B, "bg-data", 7, fnB);

    // Flush all — foreground drains via MC turn, background via timer
    vi.runAllTimers();

    expect(callsA.some((c) => c === "fg-data")).toBe(true);
    void callsB;
  });

  it("foreground drains immediately while background waits its timer", () => {
    const { fn: fnA, calls: callsA } = makeWrite();
    const { fn: fnB, calls: callsB } = makeWrite();

    registerPane(SESSION_A, fnA);
    registerPane(SESSION_B, fnB);

    setPaneForeground(SESSION_A, true);
    setPaneForeground(SESSION_B, false);

    scheduleWrite(SESSION_A, "fg", 2, fnA);
    scheduleWrite(SESSION_B, "bg", 2, fnB);

    // Advance just enough for MC turn (setTimeout 0) but not the bg timer
    vi.advanceTimersByTime(0);

    // Foreground should have drained, background should not
    expect(callsA.some((c) => c === "fg")).toBe(true);
    expect(callsB.length).toBe(0);
  });

  it("does not interfere with another session backlog after unregister", () => {
    const { fn: fnA } = makeWrite();
    const { fn: fnB } = makeWrite();

    registerPane(SESSION_A, fnA);
    registerPane(SESSION_B, fnB);
    setPaneForeground(SESSION_B, false);

    scheduleWrite(SESSION_B, "b-data", 6, fnB);

    unregisterPane(SESSION_A);
    expect(getBacklogBytes(SESSION_B)).toBe(6);
  });
});

// ============================================
// Ordering invariant (interactive bypass vs queue)
// ============================================

describe("ordering invariant", () => {
  it("does not bypass ahead of queued backlog", async () => {
    const { fn, calls } = makeWrite();
    registerPane(SESSION_A, fn);
    setPaneForeground(SESSION_A, false);

    // Backlog queued; background timer has not fired yet.
    scheduleWrite(SESSION_A, "OLD", 3, fn);

    notifyUserInput(SESSION_A);
    scheduleWrite(SESSION_A, "NEW", 3, fn);

    // Nothing may be written out of band while older output is queued.
    expect(calls.length).toBe(0);

    await flushTimers();
    const joined = calls.join("");
    expect(joined.indexOf("OLD")).toBeGreaterThanOrEqual(0);
    expect(joined.indexOf("OLD")).toBeLessThan(joined.indexOf("NEW"));
  });

  it("still bypasses when the queue is empty", () => {
    const { fn, calls } = makeWrite();
    registerPane(SESSION_A, fn);
    setPaneForeground(SESSION_A, false);

    notifyUserInput(SESSION_A);
    scheduleWrite(SESSION_A, "echo", 4, fn);

    expect(calls).toEqual(["echo"]);
  });
});

/**
 * Unit tests for terminalOutputScheduler
 *
 * Covers:
 * - Foreground vs background drain priority
 * - Hidden backlog cap and drop behavior
 * - Interactive bypass threshold
 * - ACK scheduling
 * - Pane lifecycle (register / unregister)
 * - ANSI-aware split boundaries (never mid-sequence)
 * - Adaptive chunk sizing (shrink on slow render, grow on fast)
 * - MessageChannel-based work loop (drains on turn posts)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { invokeTauri, isTauriReady } from "@src/util/platform/tauri/init";

import {
  ADAPT_GROW_CONSECUTIVE_FRAMES,
  ADAPT_GROW_THRESHOLD_MS,
  ADAPT_SHRINK_THRESHOLD_MS,
  BACKGROUND_DRAIN_INTERVAL_MS,
  BACKGROUND_TIME_BUDGET_MS,
  HIDDEN_BACKLOG_CAP,
  INITIAL_CHUNK_SIZE,
  INTERACTIVE_BYPASS_BUDGET,
  INTERACTIVE_BYPASS_SIZE_ANSI,
  INTERACTIVE_BYPASS_SIZE_HARD,
  INTERACTIVE_WINDOW_MS,
  MAX_CHUNK_SIZE,
  MIN_CHUNK_SIZE,
  _testApplyRenderMs,
  ackBytesWithoutWrite,
  ansiSequenceLength,
  findAnsiSafeSplit,
  flushBacklog,
  getBacklogBytes,
  getChunkSize,
  notifyUserInput,
  registerPane,
  resumePane,
  scheduleWrite,
  setPaneForeground,
  suspendPane,
  unregisterPane,
} from "../terminalOutputScheduler";

// ============================================
// MessageChannel polyfill for Node test environment
// ============================================

class FakeMessageChannel {
  port1: FakeMessagePort;
  port2: FakeMessagePort;

  constructor() {
    // Two ports that route messages to each other
    this.port1 = new FakeMessagePort();
    this.port2 = new FakeMessagePort();
    this.port1._peer = this.port2;
    this.port2._peer = this.port1;
  }
}

class FakeMessagePort {
  onmessage: ((evt: { data: unknown }) => void) | null = null;
  _peer!: FakeMessagePort;
  _started = false;

  start() {
    this._started = true;
  }

  close() {
    this.onmessage = null;
  }

  postMessage(data: unknown) {
    // Schedule delivery as a macrotask (setTimeout 0) so fake timers drive it
    const peer = this._peer;
    setTimeout(() => {
      if (peer.onmessage) {
        peer.onmessage({ data });
      }
    }, 0);
  }
}

// ============================================
// Helpers
// ============================================

function makeWrite() {
  const calls: string[] = [];
  const fn = vi.fn((data: string | Uint8Array) => {
    calls.push(
      typeof data === "string" ? data : new TextDecoder().decode(data)
    );
  });
  return { fn, calls };
}

async function flushTimers() {
  await vi.runAllTimersAsync();
}

// ============================================
// Module mocks
// ============================================

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
// Setup / teardown
// ============================================

const SESSION_A = "test-session-a";
const SESSION_B = "test-session-b";

beforeEach(() => {
  vi.useFakeTimers();

  // Re-prime the module mocks: restoreAllMocks in afterEach strips their
  // implementations, and the ACK path checks isTauriReady() before invoking.
  vi.mocked(isTauriReady).mockReturnValue(true);
  vi.mocked(invokeTauri).mockResolvedValue(undefined);

  // Install MessageChannel polyfill
  global.MessageChannel =
    FakeMessageChannel as unknown as typeof MessageChannel;

  // Clean up any leftover pane registrations
  unregisterPane(SESSION_A);
  unregisterPane(SESSION_B);
});

afterEach(() => {
  unregisterPane(SESSION_A);
  unregisterPane(SESSION_B);
  vi.useRealTimers();
  vi.restoreAllMocks();
  // @ts-expect-error - cleaning up polyfill
  delete global.MessageChannel;
});

// ============================================
// ANSI sequence length
// ============================================

describe("ansiSequenceLength", () => {
  it("returns 0 for non-ESC character", () => {
    expect(ansiSequenceLength("hello", 0)).toBe(0);
  });

  it("returns 0 for bare ESC at end of string (incomplete)", () => {
    expect(ansiSequenceLength("\x1b", 0)).toBe(0);
  });

  it("measures CSI sequence ESC[33m (5 chars)", () => {
    const s = "\x1b[33m";
    expect(ansiSequenceLength(s, 0)).toBe(5);
  });

  it("measures CSI sequence ESC[1;32m (7 chars)", () => {
    const s = "\x1b[1;32m";
    expect(ansiSequenceLength(s, 0)).toBe(7);
  });

  it("measures reset ESC[0m (4 chars)", () => {
    expect(ansiSequenceLength("\x1b[0m", 0)).toBe(4);
  });

  it("returns 0 for incomplete CSI (no final byte)", () => {
    expect(ansiSequenceLength("\x1b[33", 0)).toBe(0);
  });

  it("measures OSC sequence terminated by BEL", () => {
    const s = "\x1b]0;title\x07";
    expect(ansiSequenceLength(s, 0)).toBe(s.length);
  });

  it("measures OSC sequence terminated by ST (ESC backslash)", () => {
    const s = "\x1b]0;title\x1b\\";
    expect(ansiSequenceLength(s, 0)).toBe(s.length);
  });

  it("returns 0 for incomplete OSC", () => {
    expect(ansiSequenceLength("\x1b]0;title", 0)).toBe(0);
  });

  it("measures 2-char ESC sequence (ESC c = reset)", () => {
    expect(ansiSequenceLength("\x1bc", 0)).toBe(2);
  });

  it("measures character-set designate ESC ( B (3 chars)", () => {
    expect(ansiSequenceLength("\x1b(B", 0)).toBe(3);
  });

  it("measures from a non-zero offset", () => {
    const s = "abc\x1b[32mdef";
    expect(ansiSequenceLength(s, 3)).toBe(5); // ESC[32m
  });
});

// ============================================
// findAnsiSafeSplit
// ============================================

describe("findAnsiSafeSplit", () => {
  it("returns targetPos for plain ASCII with no sequences", () => {
    const s = "hello world";
    expect(findAnsiSafeSplit(s, 5)).toBe(5);
  });

  it("never splits inside a CSI sequence", () => {
    // "abc\x1b[33mdef" — split target = 4 (inside the ESC sequence)
    const s = "abc\x1b[33mdef";
    const split = findAnsiSafeSplit(s, 4);
    // The CSI starts at index 3 and ends at 8. A safe split must be <=3
    expect(split).toBeLessThanOrEqual(3);
    // Verify: substring up to split does not start an incomplete sequence
    const prefix = s.slice(0, split);
    expect(prefix).not.toContain("\x1b[33");
  });

  it("allows splitting immediately after a complete sequence", () => {
    const s = "\x1b[33mhello";
    // After the 5-char CSI, index 5 is safe
    const split = findAnsiSafeSplit(s, 5);
    expect(split).toBe(5);
  });

  it("returns 0 if sequence at start crosses targetPos", () => {
    // Large OSC that extends beyond targetPos=3
    const s = "\x1b]0;long title\x07rest";
    const split = findAnsiSafeSplit(s, 3);
    expect(split).toBe(0);
  });

  it("handles multiple sequences correctly", () => {
    // "\x1b[1m" = indices 0-4 (5 chars)
    // "hello"   = indices 5-9
    // "\x1b[0m" = indices 9-12 (ESC at 9, [ at 10, 0 at 11, m at 12)
    // "world"   = indices 13-17
    const s = "\x1b[1mhello\x1b[0mworld";
    // targetPos=13 is the first char of "world" — the safe split at or before
    // 13 is 13 (we can include the leading 'w').
    const split = findAnsiSafeSplit(s, 13);
    // The split should be 13: boundary falls after the reset sequence ends at 12
    expect(split).toBe(13);
    // Verify the prefix ends cleanly
    const prefix = s.slice(0, split);
    expect(prefix).toBe("\x1b[1mhello\x1b[0m");
  });

  it("handles surrogate pair boundary", () => {
    // Unicode emoji (U+1F600) encodes as surrogate pair \uD83D\uDE00 in JS strings
    const emoji = "\uD83D\uDE00";
    const s = "ab" + emoji + "cd";
    // targetPos=3 would land inside the surrogate pair — safe split is 2
    const split = findAnsiSafeSplit(s, 3);
    expect(split).toBe(2);
  });

  it("returns s.length when targetPos >= s.length", () => {
    expect(findAnsiSafeSplit("hello", 100)).toBe(5);
  });
});

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
// ANSI-aware chunk splitting
// ============================================

describe("ANSI-aware chunk splitting", () => {
  it("does not split mid-CSI-sequence when data straddles chunk boundary", async () => {
    const { fn, calls } = makeWrite();
    registerPane(SESSION_A, fn);
    setPaneForeground(SESSION_A, true);

    // Build data where an ANSI sequence straddles the default chunk boundary.
    // We override chunkSize by using a very small INITIAL_CHUNK_SIZE equivalent
    // by filling exactly INITIAL_CHUNK_SIZE bytes, then appending an ANSI sequence.
    // Since we can't change the constant externally, we test the helper directly
    // and also verify the integration path never corrupts.

    const plain = "x".repeat(50);
    const seq = "\x1b[1;32mHELLO\x1b[0m";
    const data = plain + seq;
    scheduleWrite(SESSION_A, data, data.length, fn);

    await flushTimers();

    // All written data stitched together must equal the original
    const received = calls.join("");
    expect(received).toBe(data);
  });

  it("each written chunk has no dangling incomplete ESC sequences", async () => {
    const { fn, calls } = makeWrite();
    registerPane(SESSION_A, fn);
    setPaneForeground(SESSION_A, true);

    // Create data larger than MAX_CHUNK_SIZE to force multiple splits,
    // with ANSI sequences scattered throughout
    const parts: string[] = [];
    for (let i = 0; i < 10; i++) {
      parts.push("x".repeat(8192)); // 8 KB plain
      parts.push(`\x1b[${30 + i}m`); // colour sequence
      parts.push("text");
      parts.push("\x1b[0m"); // reset
    }
    const bigData = parts.join("");
    scheduleWrite(SESSION_A, bigData, bigData.length, fn);

    await flushTimers();

    // No chunk should end with a bare ESC followed by [ and then no final byte
    for (const chunk of calls) {
      // A chunk ending with ESC indicates a split mid-sequence
      const endsWithEsc = chunk.endsWith("\x1b");
      expect(endsWithEsc).toBe(false);
      // A chunk ending with ESC[ (no final byte) is also bad
      const endsWithCsiOpen = chunk.endsWith("\x1b[");
      expect(endsWithCsiOpen).toBe(false);
    }

    // Total output must be lossless
    expect(calls.join("")).toBe(bigData);
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
// Backlog cap and drop behavior
// ============================================

describe("backlog cap", () => {
  it(`drops oldest data when backlog exceeds ${HIDDEN_BACKLOG_CAP} bytes`, () => {
    const { fn } = makeWrite();
    registerPane(SESSION_A, fn);
    setPaneForeground(SESSION_A, false);

    const chunkSize = 64 * 1024;
    const chunksNeeded = Math.ceil(HIDDEN_BACKLOG_CAP / chunkSize) + 5;
    const earlyData = "EARLY_" + "a".repeat(chunkSize - 6);
    scheduleWrite(SESSION_A, earlyData, chunkSize, fn);

    for (let i = 0; i < chunksNeeded; i++) {
      const data = "LATE_" + "b".repeat(chunkSize - 5);
      scheduleWrite(SESSION_A, data, chunkSize, fn);
    }

    expect(getBacklogBytes(SESSION_A)).toBeLessThanOrEqual(HIDDEN_BACKLOG_CAP);
  });

  it("shows a warning marker in the terminal when data is dropped", async () => {
    const { fn, calls } = makeWrite();
    registerPane(SESSION_A, fn);
    setPaneForeground(SESSION_A, false);

    const chunkSize = 64 * 1024;
    const chunksNeeded = Math.ceil(HIDDEN_BACKLOG_CAP / chunkSize) + 5;

    for (let i = 0; i < chunksNeeded; i++) {
      scheduleWrite(SESSION_A, "x".repeat(chunkSize), chunkSize, fn);
    }

    // The marker is queued in-stream at the gap (not written out-of-band),
    // so it appears once the queue drains.
    await flushTimers();

    const hasWarning = calls.some((c) => c.includes("backlog limit reached"));
    expect(hasWarning).toBe(true);
  });

  it("does not drop data when backlog is within cap", () => {
    const { fn } = makeWrite();
    registerPane(SESSION_A, fn);
    setPaneForeground(SESSION_A, false);

    const smallData = "hello";
    scheduleWrite(SESSION_A, smallData, smallData.length, fn);

    expect(getBacklogBytes(SESSION_A)).toBe(smallData.length);
  });
});

// ============================================
// Interactive bypass
// ============================================

describe("interactive bypass", () => {
  it("writes immediately if data is within interactive window and size limit", () => {
    const { fn, calls } = makeWrite();
    registerPane(SESSION_A, fn);
    setPaneForeground(SESSION_A, false);

    notifyUserInput(SESSION_A);

    const smallData = "ls\r";
    scheduleWrite(SESSION_A, smallData, smallData.length, fn);

    expect(calls.some((c) => c === smallData)).toBe(true);
  });

  it(`bypasses for data <= ${INTERACTIVE_BYPASS_SIZE_HARD} bytes within interactive window`, () => {
    const { fn, calls } = makeWrite();
    registerPane(SESSION_A, fn);
    setPaneForeground(SESSION_A, false);

    notifyUserInput(SESSION_A);

    const data = "a".repeat(INTERACTIVE_BYPASS_SIZE_HARD);
    scheduleWrite(SESSION_A, data, data.length, fn);

    expect(calls.some((c) => c === data)).toBe(true);
  });

  it(`does not bypass if data > ${INTERACTIVE_BYPASS_SIZE_HARD} bytes without ANSI`, () => {
    const { fn, calls } = makeWrite();
    registerPane(SESSION_A, fn);
    setPaneForeground(SESSION_A, false);

    notifyUserInput(SESSION_A);

    const data = "a".repeat(INTERACTIVE_BYPASS_SIZE_HARD + 1);
    scheduleWrite(SESSION_A, data, data.length, fn);

    expect(calls.length).toBe(0);
  });

  it(`bypasses ANSI packet up to ${INTERACTIVE_BYPASS_SIZE_ANSI} bytes`, () => {
    const { fn, calls } = makeWrite();
    registerPane(SESSION_A, fn);
    setPaneForeground(SESSION_A, false);

    notifyUserInput(SESSION_A);

    const data = "\x1b[32m" + "a".repeat(INTERACTIVE_BYPASS_SIZE_ANSI - 5);
    scheduleWrite(SESSION_A, data, data.length, fn);

    expect(calls.some((c) => c === data)).toBe(true);
  });

  it("does not bypass if outside interactive window", () => {
    const { fn, calls } = makeWrite();
    registerPane(SESSION_A, fn);
    setPaneForeground(SESSION_A, false);

    const inputTime = 1000;
    vi.spyOn(performance, "now").mockReturnValueOnce(inputTime);
    notifyUserInput(SESSION_A);

    vi.spyOn(performance, "now").mockReturnValue(
      inputTime + INTERACTIVE_WINDOW_MS + 10
    );

    const data = "ls\r";
    scheduleWrite(SESSION_A, data, data.length, fn);

    expect(calls.length).toBe(0);
  });

  it(`stops bypassing after consuming ${INTERACTIVE_BYPASS_BUDGET} bytes in window`, () => {
    const { fn, calls } = makeWrite();
    registerPane(SESSION_A, fn);
    setPaneForeground(SESSION_A, false);

    notifyUserInput(SESSION_A);

    const packetSize = INTERACTIVE_BYPASS_SIZE_HARD;
    const packetsToFill = Math.ceil(INTERACTIVE_BYPASS_BUDGET / packetSize) + 1;

    let bypassedCount = 0;
    for (let i = 0; i < packetsToFill; i++) {
      const before = calls.length;
      scheduleWrite(SESSION_A, "a".repeat(packetSize), packetSize, fn);
      if (calls.length > before) bypassedCount++;
    }

    expect(bypassedCount).toBeLessThan(packetsToFill);
  });

  it("does not bypass if no user input was recorded", () => {
    const { fn, calls } = makeWrite();
    registerPane(SESSION_A, fn);
    setPaneForeground(SESSION_A, false);

    scheduleWrite(SESSION_A, "data", 4, fn);

    expect(calls.length).toBe(0);
  });
});

// ============================================
// flushBacklog
// ============================================

describe("flushBacklog", () => {
  it("flushes up to maxBytes immediately", async () => {
    const { fn, calls } = makeWrite();
    registerPane(SESSION_A, fn);
    setPaneForeground(SESSION_A, false);

    const data = "x".repeat(100);
    scheduleWrite(SESSION_A, data, 100, fn);

    const written = flushBacklog(SESSION_A, 200);
    expect(written).toBeGreaterThan(0);
    expect(calls.length).toBeGreaterThan(0);
  });

  it("respects maxBytes limit", () => {
    const { fn } = makeWrite();
    registerPane(SESSION_A, fn);
    setPaneForeground(SESSION_A, false);

    for (let i = 0; i < 3; i++) {
      const data = "y".repeat(INITIAL_CHUNK_SIZE);
      scheduleWrite(SESSION_A, data, INITIAL_CHUNK_SIZE, fn);
    }

    const written = flushBacklog(SESSION_A, INITIAL_CHUNK_SIZE);
    expect(written).toBeLessThanOrEqual(INITIAL_CHUNK_SIZE + 100);
    expect(getBacklogBytes(SESSION_A)).toBeGreaterThan(0);
  });

  it("returns 0 for unregistered session", () => {
    expect(flushBacklog("nonexistent-session", 1024)).toBe(0);
  });
});

// ============================================
// O5: findAnsiSafeSplit fromPos parameter
// ============================================

describe("findAnsiSafeSplit — fromPos (O5)", () => {
  it("fromPos=0 behaves identically to the no-arg form (backward compat)", () => {
    const s = "abc\x1b[33mdef";
    expect(findAnsiSafeSplit(s, 4, 0)).toBe(findAnsiSafeSplit(s, 4));
  });

  it("fast path: fromPos >= targetPos returns targetPos without scanning", () => {
    // Plain ASCII — safe to split anywhere; fromPos already past target.
    const s = "hello world";
    expect(findAnsiSafeSplit(s, 5, 7)).toBe(5);
  });

  it("fast path: fromPos === targetPos returns targetPos", () => {
    const s = "hello world";
    expect(findAnsiSafeSplit(s, 5, 5)).toBe(5);
  });

  it("resumes scan correctly after a known-safe boundary", () => {
    // "\x1b[1m" = ESC [ 1 m = 4 chars (indices 0-3)
    // "x".repeat(10) = indices 4-13
    // "\x1b[0m" = ESC [ 0 m = 4 chars (indices 14-17), total length 18
    const s = "\x1b[1m" + "x".repeat(10) + "\x1b[0m";
    expect(s.length).toBe(18);

    // First split: target=10, fromPos=0 — scans ESC[1m (ends at 4), then plain
    // chars 4..9. At i=10 <= targetPos=10, lastSafe=10. Returns 10.
    const firstSplit = findAnsiSafeSplit(s, 10, 0);
    expect(firstSplit).toBe(10);

    // Second split: fromPos=10, target=14 — the char at index 14 is ESC which
    // starts ESC[0m (crosses target). Last safe before it is 14's boundary = 14.
    // Actually target=14: loop runs while i<14. Chars 10-13 are 'x', after i=14
    // loop exits. lastSafe=14. Returns 14.
    const secondSplit = findAnsiSafeSplit(s, 14, firstSplit);
    expect(secondSplit).toBe(14);

    // Third split: fromPos=14, target=18 (s.length) — ESC[0m is complete and
    // ends exactly at 18. findAnsiSafeSplit returns s.length when targetPos >= s.length.
    const thirdSplit = findAnsiSafeSplit(s, s.length, secondSplit);
    expect(thirdSplit).toBe(s.length);
  });

  it("correctly handles fromPos exactly at an ANSI sequence boundary", () => {
    // fromPos lands right at the end of a complete CSI sequence.
    const seq = "\x1b[32m"; // 5 chars
    const s = seq + "hello" + "\x1b[0m" + "world";
    // fromPos=5 is exactly at the end of ESC[32m — a valid safe boundary.
    const split = findAnsiSafeSplit(s, 10, 5);
    // Range [5..10] is all plain ASCII; safe split is 10.
    expect(split).toBe(10);
  });

  it("does not produce mid-sequence split when fromPos is within plain text", () => {
    // fromPos in the middle of plain text, sequence comes after.
    // "aaaaaa\x1b[33mbb" — fromPos=3, target=8 (inside sequence)
    const s = "aaaaaa\x1b[33mbb";
    const split = findAnsiSafeSplit(s, 8, 3);
    // Safe boundary must be ≤ 6 (before the ESC)
    expect(split).toBeLessThanOrEqual(6);
    // Verify prefix integrity
    // eslint-disable-next-line no-control-regex
    expect(s.slice(0, split)).not.toMatch(/\x1b\[3$/);
  });

  it("returns fromPos (not 0) when no safe position found in the new window", () => {
    // The only content between fromPos and targetPos is an incomplete sequence.
    // "hello\x1b[33" — complete text "hello" (len 5) + incomplete CSI
    const s = "hello\x1b[33";
    // fromPos=5, target=8 — the ESC at 5 starts a sequence that doesn't finish
    const split = findAnsiSafeSplit(s, 8, 5);
    // No safe position found in [5..8]; lastSafe starts at fromPos=5
    expect(split).toBe(5);
  });
});

// ============================================
// O5: lastSafeSplitEnd cache in SchedulerEntry
// ============================================

describe("O5 — lastSafeSplitEnd cache reduces rescanning", () => {
  it("multi-chunk split of a large entry with OSC sequences: scanner resumes correctly", async () => {
    // Verify the O5 optimization via findAnsiSafeSplit's direct behaviour:
    // when fromPos equals the previously returned boundary, subsequent calls
    // produce the same boundaries as full-scan calls (correctness guarantee).
    const oscSeq = "\x1b]0;title\x07"; // 12 chars
    const block = "x".repeat(INITIAL_CHUNK_SIZE - oscSeq.length) + oscSeq;
    const data = block + block + block;

    // Simulate the split sequence that consumeChunk would perform.
    // Each step: full-scan result must equal incremental-scan result.
    const chunkSize = INITIAL_CHUNK_SIZE;
    let incrementalFromPos = 0;
    let start = 0;

    while (start < data.length) {
      const target = Math.min(start + chunkSize, data.length);

      const fullScan = findAnsiSafeSplit(data, target, 0);
      const incrementalScan = findAnsiSafeSplit(
        data,
        target,
        incrementalFromPos
      );

      expect(incrementalScan).toBe(fullScan);

      const splitAt = incrementalScan <= start ? data.length : incrementalScan;
      incrementalFromPos = splitAt;
      start = splitAt;
    }
  });

  it("first split of an entry starts from 0 (fromPos=0 matches no-arg)", () => {
    // The O5 invariant: fromPos=0 must be identical to a fresh scan (no-arg).
    const data = "x".repeat(INITIAL_CHUNK_SIZE) + "\x1b[32m" + "y".repeat(100);
    const target = INITIAL_CHUNK_SIZE + 3; // lands inside the ESC sequence

    expect(findAnsiSafeSplit(data, target, 0)).toBe(
      findAnsiSafeSplit(data, target)
    );
  });

  it("lossless output for large OSC-heavy burst across many chunks", async () => {
    const { fn, calls } = makeWrite();
    registerPane(SESSION_A, fn);
    setPaneForeground(SESSION_A, true);

    // 256 KB worth of OSC + plain text (simulates a real terminal title-update storm)
    const parts: string[] = [];
    const chunkCount = 16;
    const chunkBytes = 16 * 1024;
    for (let i = 0; i < chunkCount; i++) {
      parts.push(`\x1b]0;session-${i}\x07`); // ~18 chars OSC
      parts.push("y".repeat(chunkBytes - 20));
    }
    const data = parts.join("");
    scheduleWrite(SESSION_A, data, data.length, fn);
    await flushTimers();

    expect(calls.join("")).toBe(data);
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

// ============================================
// ACK accounting (flow-control window integrity)
// ============================================

describe("ACK accounting", () => {
  function ackedBytes(sessionId: string): number {
    return vi
      .mocked(invokeTauri)
      .mock.calls.filter(
        ([cmd, args]) =>
          cmd === "ack_pty_data" &&
          (args as { sessionId: string }).sessionId === sessionId
      )
      .reduce(
        (sum, [, args]) => sum + (args as { byteCount: number }).byteCount,
        0
      );
  }

  it("ACKs backlog bytes dropped by the cap even though they are never written", async () => {
    vi.mocked(invokeTauri).mockClear();
    const { fn } = makeWrite();
    registerPane(SESSION_A, fn);
    setPaneForeground(SESSION_A, false);

    const chunkSize = 64 * 1024;
    const chunksNeeded = Math.ceil(HIDDEN_BACKLOG_CAP / chunkSize) + 5;
    for (let i = 0; i < chunksNeeded; i++) {
      scheduleWrite(SESSION_A, "x".repeat(chunkSize), chunkSize, fn);
    }

    // Flush the ACK microtask (no drain has run — only drops can ACK here).
    await Promise.resolve();

    const dropped = chunksNeeded * chunkSize - HIDDEN_BACKLOG_CAP;
    expect(ackedBytes(SESSION_A)).toBeGreaterThanOrEqual(dropped);
  });

  it("ACKs consumed and queued bytes when a pane unregisters", () => {
    vi.mocked(invokeTauri).mockClear();
    const { fn } = makeWrite();
    registerPane(SESSION_A, fn);
    setPaneForeground(SESSION_A, false);

    scheduleWrite(SESSION_A, "abc", 300, fn);
    unregisterPane(SESSION_A);

    expect(ackedBytes(SESSION_A)).toBeGreaterThanOrEqual(300);
  });

  it("ACKs bytes that decoded to nothing via ackBytesWithoutWrite", async () => {
    vi.mocked(invokeTauri).mockClear();
    const { fn } = makeWrite();
    registerPane(SESSION_A, fn);

    ackBytesWithoutWrite(SESSION_A, 2);
    await Promise.resolve();

    expect(ackedBytes(SESSION_A)).toBe(2);
  });
});

// ============================================
// Dangling escape-sequence repair after drops
// ============================================

describe("dangling escape repair", () => {
  it("never renders the orphaned tail of a sequence split across a drop", async () => {
    const { fn, calls } = makeWrite();
    registerPane(SESSION_A, fn);
    setPaneForeground(SESSION_A, false);

    // First chunk ends mid-CSI (ESC[38;2;26 without a final byte) and its
    // byteLength hint fills the whole cap; the second chunk overflows the
    // cap, so the first is dropped, orphaning the sequence tail.
    scheduleWrite(SESSION_A, "before\x1b[38;2;26", HIDDEN_BACKLOG_CAP, fn);
    scheduleWrite(SESSION_A, ";26;26mVISIBLE", 14, fn);

    await flushTimers();

    const joined = calls.join("");
    expect(joined).toContain("VISIBLE");
    expect(joined).not.toContain(";26;26mVISIBLE");
    expect(joined).toContain("backlog limit reached");
  });
});

// ============================================
// Suspend / resume (reconnect protocol)
// ============================================

describe("suspend/resume", () => {
  it("holds all writes while suspended and drops snapshot-covered chunks on resume", async () => {
    const { fn, calls } = makeWrite();
    registerPane(SESSION_A, fn);
    setPaneForeground(SESSION_A, true);
    suspendPane(SESSION_A);

    scheduleWrite(SESSION_A, "A", 10, fn, 0);
    scheduleWrite(SESSION_A, "B", 10, fn, 10);
    scheduleWrite(SESSION_A, "C", 10, fn, 20);

    await flushTimers();
    expect(calls.length).toBe(0);

    // Snapshot covered stream offsets [0, 20) — only C may be written.
    resumePane(SESSION_A, 20);
    await flushTimers();

    expect(calls.join("")).toBe("C");
  });

  it("does not bypass while suspended even within the interactive window", () => {
    const { fn, calls } = makeWrite();
    registerPane(SESSION_A, fn);
    suspendPane(SESSION_A);

    notifyUserInput(SESSION_A);
    scheduleWrite(SESSION_A, "x", 1, fn);

    expect(calls.length).toBe(0);
  });

  it("flushBacklog is a no-op while suspended", () => {
    const { fn, calls } = makeWrite();
    registerPane(SESSION_A, fn);
    setPaneForeground(SESSION_A, false);
    suspendPane(SESSION_A);

    scheduleWrite(SESSION_A, "held", 4, fn);
    expect(flushBacklog(SESSION_A, 1024)).toBe(0);
    expect(calls.length).toBe(0);
  });

  it("keeps chunks without a seq on resume with a coverage offset", async () => {
    const { fn, calls } = makeWrite();
    registerPane(SESSION_A, fn);
    setPaneForeground(SESSION_A, true);
    suspendPane(SESSION_A);

    // Legacy payloads have no seq — they must survive the coverage drop.
    scheduleWrite(SESSION_A, "legacy", 6, fn);

    resumePane(SESSION_A, 1000);
    await flushTimers();

    expect(calls.join("")).toBe("legacy");
  });
});

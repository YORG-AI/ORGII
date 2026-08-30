/**
 * Backlog, interactive bypass, ACK, and suspend/resume tests.
 */
import { describe, expect, it, vi } from "vitest";

import { invokeTauri } from "@src/util/platform/tauri/init";

import {
  HIDDEN_BACKLOG_CAP,
  INITIAL_CHUNK_SIZE,
  INTERACTIVE_BYPASS_BUDGET,
  INTERACTIVE_BYPASS_SIZE_ANSI,
  INTERACTIVE_BYPASS_SIZE_HARD,
  INTERACTIVE_WINDOW_MS,
  ackBytesWithoutWrite,
  flushBacklog,
  getBacklogBytes,
  notifyUserInput,
  registerPane,
  resumePane,
  scheduleWrite,
  setPaneForeground,
  suspendPane,
  unregisterPane,
} from "../terminalOutputScheduler";
import {
  SESSION_A,
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

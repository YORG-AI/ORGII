/**
 * Native-transcript reconcile contract.
 *
 * For CLI agents whose own store is the transcript of record, the in-memory
 * turn events are throwaway. This module decides when the canonical parse
 * replaces them. The invariants: only registered "native" sessions reconcile,
 * a reconcile is never scheduled twice concurrently, a stale session never
 * dispatches, and the retry only re-dispatches when the parse actually grew.
 *
 * Timers are the only thing faked — every code path under test is real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import {
  isNativeTranscriptSession,
  registerSessionTranscriptSource,
  scheduleNativeTranscriptReconcile,
} from "../nativeTranscriptReconcile";

const SETTLE_MS = 600;
const RETRY_MS = 2000;

function makeEvent(id: string, sessionId: string): SessionEvent {
  return {
    id,
    chunk_id: id,
    sessionId,
    createdAt: "2026-08-01T00:00:00.000Z",
    functionName: "assistant_message",
    uiCanonical: "assistant_message",
    actionType: "assistant",
    args: {},
    result: { observation: id },
    source: "assistant",
    displayText: id,
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "agent",
  };
}

interface Harness {
  loadCalls: number;
  loads: SessionEvent[][];
  dispatches: Array<{
    sessionId: string;
    events: SessionEvent[];
    replace?: boolean;
  }>;
  live: boolean;
  deps: Parameters<typeof scheduleNativeTranscriptReconcile>[1];
}

function makeHarness(
  sessionId: string,
  historyByCall: Array<SessionEvent[] | Error>
): Harness {
  const harness: Harness = {
    loadCalls: 0,
    loads: [],
    dispatches: [],
    live: true,
    deps: {
      loadHistory: async () => {
        const next =
          historyByCall[Math.min(harness.loadCalls, historyByCall.length - 1)];
        harness.loadCalls += 1;
        if (next instanceof Error) throw next;
        harness.loads.push(next);
        return next;
      },
      dispatchLoadSession: (payload) => {
        harness.dispatches.push(payload);
      },
      isSessionLive: (id) => harness.live && id === sessionId,
    },
  };
  return harness;
}

describe("native transcript source registry", () => {
  it("only marks a session native for the literal `native` source", () => {
    registerSessionTranscriptSource("s-native", "native");
    registerSessionTranscriptSource("s-chunks", "chunks");

    expect(isNativeTranscriptSession("s-native")).toBe(true);
    expect(isNativeTranscriptSession("s-chunks")).toBe(false);
    expect(isNativeTranscriptSession("s-never-registered")).toBe(false);
  });

  it("ignores an undefined source instead of clearing a known one", () => {
    registerSessionTranscriptSource("s-keep", "native");
    registerSessionTranscriptSource("s-keep", undefined);

    expect(isNativeTranscriptSession("s-keep")).toBe(true);
  });

  it("ignores an empty-string source", () => {
    registerSessionTranscriptSource("s-empty", "");

    expect(isNativeTranscriptSession("s-empty")).toBe(false);
  });
});

describe("scheduleNativeTranscriptReconcile", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does nothing for a session that is not native-transcript", async () => {
    const sessionId = "s-legacy";
    registerSessionTranscriptSource(sessionId, "chunks");
    const harness = makeHarness(sessionId, [[makeEvent("a", sessionId)]]);

    scheduleNativeTranscriptReconcile(sessionId, harness.deps);
    await vi.advanceTimersByTimeAsync(SETTLE_MS + RETRY_MS + 10);

    expect(harness.loadCalls).toBe(0);
    expect(harness.dispatches).toEqual([]);
  });

  it("replaces the on-screen events once the settle delay elapses", async () => {
    const sessionId = "s-replace";
    registerSessionTranscriptSource(sessionId, "native");
    const events = [makeEvent("u1", sessionId), makeEvent("a1", sessionId)];
    const harness = makeHarness(sessionId, [events]);

    scheduleNativeTranscriptReconcile(sessionId, harness.deps);
    expect(harness.loadCalls).toBe(0);

    await vi.advanceTimersByTimeAsync(SETTLE_MS);

    expect(harness.dispatches).toEqual([{ sessionId, events, replace: true }]);
  });

  it("re-dispatches on retry only when the parse grew", async () => {
    const sessionId = "s-grew";
    registerSessionTranscriptSource(sessionId, "native");
    const first = [makeEvent("a", sessionId)];
    const second = [makeEvent("a", sessionId), makeEvent("b", sessionId)];
    const harness = makeHarness(sessionId, [first, second]);

    scheduleNativeTranscriptReconcile(sessionId, harness.deps);
    await vi.advanceTimersByTimeAsync(SETTLE_MS + RETRY_MS);

    expect(harness.loadCalls).toBe(2);
    expect(harness.dispatches).toEqual([
      { sessionId, events: first, replace: true },
      { sessionId, events: second, replace: true },
    ]);
  });

  it("does not re-dispatch when the retry parse is the same size", async () => {
    const sessionId = "s-same";
    registerSessionTranscriptSource(sessionId, "native");
    const events = [makeEvent("a", sessionId)];
    const harness = makeHarness(sessionId, [events, events]);

    scheduleNativeTranscriptReconcile(sessionId, harness.deps);
    await vi.advanceTimersByTimeAsync(SETTLE_MS + RETRY_MS);

    expect(harness.loadCalls).toBe(2);
    expect(harness.dispatches).toHaveLength(1);
  });

  it("does not dispatch an empty parse, but still retries", async () => {
    const sessionId = "s-empty-first";
    registerSessionTranscriptSource(sessionId, "native");
    const late = [makeEvent("late", sessionId)];
    const harness = makeHarness(sessionId, [[], late]);

    scheduleNativeTranscriptReconcile(sessionId, harness.deps);
    await vi.advanceTimersByTimeAsync(SETTLE_MS + RETRY_MS);

    expect(harness.dispatches).toEqual([
      { sessionId, events: late, replace: true },
    ]);
  });

  it("coalesces concurrent schedules for the same session", async () => {
    const sessionId = "s-dedupe";
    registerSessionTranscriptSource(sessionId, "native");
    const events = [makeEvent("a", sessionId)];
    const harness = makeHarness(sessionId, [events, events]);

    scheduleNativeTranscriptReconcile(sessionId, harness.deps);
    scheduleNativeTranscriptReconcile(sessionId, harness.deps);
    scheduleNativeTranscriptReconcile(sessionId, harness.deps);
    await vi.advanceTimersByTimeAsync(SETTLE_MS + RETRY_MS);

    expect(harness.loadCalls).toBe(2);
    expect(harness.dispatches).toHaveLength(1);
  });

  it("releases the pending slot so a later turn can reconcile again", async () => {
    const sessionId = "s-reschedule";
    registerSessionTranscriptSource(sessionId, "native");
    const first = [makeEvent("a", sessionId)];
    const harness = makeHarness(sessionId, [first]);

    scheduleNativeTranscriptReconcile(sessionId, harness.deps);
    await vi.advanceTimersByTimeAsync(SETTLE_MS + RETRY_MS);
    const callsAfterFirst = harness.loadCalls;

    scheduleNativeTranscriptReconcile(sessionId, harness.deps);
    await vi.advanceTimersByTimeAsync(SETTLE_MS + RETRY_MS);

    expect(harness.loadCalls).toBeGreaterThan(callsAfterFirst);
  });

  it("drops the reconcile entirely when the session is no longer on screen", async () => {
    const sessionId = "s-stale";
    registerSessionTranscriptSource(sessionId, "native");
    const harness = makeHarness(sessionId, [[makeEvent("a", sessionId)]]);
    harness.live = false;

    scheduleNativeTranscriptReconcile(sessionId, harness.deps);
    await vi.advanceTimersByTimeAsync(SETTLE_MS + RETRY_MS);

    expect(harness.loadCalls).toBe(0);
    expect(harness.dispatches).toEqual([]);
  });

  it("drops the dispatch when the session goes stale during the read", async () => {
    const sessionId = "s-stale-mid";
    registerSessionTranscriptSource(sessionId, "native");
    const harness = makeHarness(sessionId, [[makeEvent("a", sessionId)]]);
    const originalLoad = harness.deps.loadHistory;
    harness.deps.loadHistory = async (id: string) => {
      const events = await originalLoad(id);
      harness.live = false;
      return events;
    };

    scheduleNativeTranscriptReconcile(sessionId, harness.deps);
    await vi.advanceTimersByTimeAsync(SETTLE_MS + RETRY_MS);

    expect(harness.loadCalls).toBe(1);
    expect(harness.dispatches).toEqual([]);
  });

  it("skips the retry read entirely once the session leaves the screen", async () => {
    const sessionId = "s-stale-before-retry";
    registerSessionTranscriptSource(sessionId, "native");
    const first = [makeEvent("a", sessionId)];
    const harness = makeHarness(sessionId, [first, first]);

    scheduleNativeTranscriptReconcile(sessionId, harness.deps);
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(harness.dispatches).toHaveLength(1);

    harness.live = false;
    await vi.advanceTimersByTimeAsync(RETRY_MS);

    expect(harness.loadCalls).toBe(1);
    expect(harness.dispatches).toHaveLength(1);
  });

  it("swallows a failing history read and frees the pending slot", async () => {
    const sessionId = "s-throws";
    registerSessionTranscriptSource(sessionId, "native");
    const recovered = [makeEvent("a", sessionId)];
    const harness = makeHarness(sessionId, [
      new Error("native store locked"),
      recovered,
    ]);

    scheduleNativeTranscriptReconcile(sessionId, harness.deps);
    await vi.advanceTimersByTimeAsync(SETTLE_MS + RETRY_MS);

    expect(harness.dispatches).toEqual([]);

    // The slot was released, so the next terminal status can retry.
    scheduleNativeTranscriptReconcile(sessionId, harness.deps);
    await vi.advanceTimersByTimeAsync(SETTLE_MS);

    expect(harness.dispatches).toEqual([
      { sessionId, events: recovered, replace: true },
    ]);
  });
});

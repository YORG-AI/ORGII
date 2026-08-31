/**
 * Cursor IDE preload contract.
 *
 * `ensureCursorIdeEventsInStore` is the ingestion boundary for read-only
 * `state.vscdb` history. It is called from render paths (turn expansion,
 * session-switch freshness checks) so its whole reason to exist is the
 * coalescing/debounce state machine: repeated calls must collapse to one
 * `state.vscdb` read, and a force landing mid-flight must schedule exactly one
 * follow-up refresh.
 *
 * Mocked: the Tauri history commands, the Rust event store, and the Rust
 * ingestion RPC. The Jotai store, the session-id dispatch helpers and the
 * debounce machinery itself all run for real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { cursorIdeTurnSummariesAtomFamily } from "@src/store/session/cursorIdeTurnSummariesAtom";
import type { ActivityChunk } from "@src/types/session/session";
import {
  createInstrumentedStore,
  getInstrumentedStore,
} from "@src/util/core/state/instrumentedStore";

import {
  ensureCursorIdeEventsInStore,
  getCursorIdeSnapshotLastUpdatedAt,
} from "../cursorIdeAdapter";

const DEBOUNCE_MS = 250;

const api = vi.hoisted(() => ({
  cursorIdeFullRefresh: vi.fn(),
  cursorIdeInitialWindow: vi.fn(),
  cursorIdeComposerLastUpdatedAt: vi.fn(),
  processChunksRust: vi.fn(),
  set: vi.fn(async () => undefined),
  getLatestSessionSnapshot: vi.fn(() => null),
}));

vi.mock("@src/api/tauri/externalHistory", () => ({
  cursorIdeFullRefresh: api.cursorIdeFullRefresh,
  cursorIdeInitialWindow: api.cursorIdeInitialWindow,
}));

vi.mock("@src/api/tauri/externalHistory/cursorIde", () => ({
  cursorIdeComposerLastUpdatedAt: api.cursorIdeComposerLastUpdatedAt,
}));

vi.mock("@src/engines/SessionCore/core/store/EventStoreProxy", () => ({
  eventStoreProxy: {
    set: api.set,
    getLatestSessionSnapshot: api.getLatestSessionSnapshot,
  },
}));

vi.mock("@src/engines/SessionCore/ingestion/rustBridge", () => ({
  processChunksRust: api.processChunksRust,
}));

function makeChunk(id: string): ActivityChunk {
  return {
    chunk_id: id,
    action_type: "assistant",
    function: "assistant_message",
    args: {},
    result: { content: id },
    created_at: "2026-08-01T00:00:00.000Z",
  };
}

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

function turnSummaries(sessionId: string) {
  return getInstrumentedStore().get(
    cursorIdeTurnSummariesAtomFamily(sessionId)
  );
}

describe("ensureCursorIdeEventsInStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    createInstrumentedStore();
    api.getLatestSessionSnapshot.mockReturnValue(null);
    api.cursorIdeComposerLastUpdatedAt.mockResolvedValue(1_700_000_000_000);
    api.processChunksRust.mockImplementation(
      async (chunks: ActivityChunk[], sessionId: string) =>
        chunks.map((chunk) => makeEvent(chunk.chunk_id, sessionId))
    );
    api.cursorIdeInitialWindow.mockResolvedValue({
      chunks: [makeChunk("bubble-1")],
      turns: [{ userBubbleId: "u1" }],
    });
    api.cursorIdeFullRefresh.mockResolvedValue({
      chunks: [makeChunk("bubble-1"), makeChunk("bubble-2")],
      turns: [{ userBubbleId: "u1" }, { userBubbleId: "u2" }],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refuses to touch any session that is not a Cursor IDE id", async () => {
    await ensureCursorIdeEventsInStore("cliagent-not-cursor");
    await ensureCursorIdeEventsInStore("agent-not-cursor", {
      forceReload: true,
    });

    expect(api.cursorIdeInitialWindow).not.toHaveBeenCalled();
    expect(api.cursorIdeFullRefresh).not.toHaveBeenCalled();
    expect(api.set).not.toHaveBeenCalled();
  });

  it("hydrates the store and the turn-summary atom on a cold read", async () => {
    const sessionId = "cursoride-cold";

    await ensureCursorIdeEventsInStore(sessionId);

    expect(api.cursorIdeInitialWindow).toHaveBeenCalledWith({
      sessionId,
      recentLimit: 100,
    });
    expect(turnSummaries(sessionId)).toEqual([{ userBubbleId: "u1" }]);
    expect(api.set).toHaveBeenCalledWith(
      [makeEvent("bubble-1", sessionId)],
      sessionId
    );
    expect(getCursorIdeSnapshotLastUpdatedAt(sessionId)).toBe(
      1_700_000_000_000
    );
  });

  it("returns without reading when the store already holds this session", async () => {
    const sessionId = "cursoride-warm";
    api.getLatestSessionSnapshot.mockReturnValue({
      eventCount: 12,
    } as unknown as never);

    await ensureCursorIdeEventsInStore(sessionId);

    expect(api.cursorIdeInitialWindow).not.toHaveBeenCalled();
    expect(api.set).not.toHaveBeenCalled();
  });

  it("still reads when the cached snapshot exists but is empty", async () => {
    const sessionId = "cursoride-empty-snapshot";
    api.getLatestSessionSnapshot.mockReturnValue({
      eventCount: 0,
    } as unknown as never);

    await ensureCursorIdeEventsInStore(sessionId);

    expect(api.cursorIdeInitialWindow).toHaveBeenCalledTimes(1);
  });

  it("publishes turn summaries even when the window carries no chunks", async () => {
    const sessionId = "cursoride-no-chunks";
    api.cursorIdeInitialWindow.mockResolvedValue({
      chunks: [],
      turns: [{ userBubbleId: "u1" }],
    });

    await ensureCursorIdeEventsInStore(sessionId);

    expect(turnSummaries(sessionId)).toEqual([{ userBubbleId: "u1" }]);
    expect(api.processChunksRust).not.toHaveBeenCalled();
    expect(api.set).not.toHaveBeenCalled();
    expect(getCursorIdeSnapshotLastUpdatedAt(sessionId)).toBeNull();
  });

  it("tolerates a malformed window whose `chunks` is not an array", async () => {
    const sessionId = "cursoride-malformed";
    api.cursorIdeInitialWindow.mockResolvedValue({
      chunks: null,
      turns: [],
    });

    await expect(
      ensureCursorIdeEventsInStore(sessionId)
    ).resolves.toBeUndefined();
    expect(api.processChunksRust).not.toHaveBeenCalled();
    expect(api.set).not.toHaveBeenCalled();
  });

  it("never writes an empty event array into the store", async () => {
    const sessionId = "cursoride-normalizes-to-nothing";
    api.processChunksRust.mockResolvedValue([]);

    await ensureCursorIdeEventsInStore(sessionId);

    expect(api.set).not.toHaveBeenCalled();
    expect(getCursorIdeSnapshotLastUpdatedAt(sessionId)).toBeNull();
  });

  it("leaves the snapshot timestamp untouched when Cursor reports none", async () => {
    const sessionId = "cursoride-no-timestamp";
    api.cursorIdeComposerLastUpdatedAt.mockResolvedValue(null);

    await ensureCursorIdeEventsInStore(sessionId);

    expect(getCursorIdeSnapshotLastUpdatedAt(sessionId)).toBeNull();
  });

  it("skips the timestamp probe when no composer id can be derived", async () => {
    // A bare prefix is still recognized as a Cursor session, but carries no
    // composer id — the freshness probe must be skipped, not called with "".
    const sessionId = "cursoride-";

    await ensureCursorIdeEventsInStore(sessionId);

    expect(api.cursorIdeInitialWindow).toHaveBeenCalledTimes(1);
    expect(api.cursorIdeComposerLastUpdatedAt).not.toHaveBeenCalled();
    expect(getCursorIdeSnapshotLastUpdatedAt(sessionId)).toBeNull();
  });

  it("coalesces concurrent lazy loads into a single vscdb read", async () => {
    const sessionId = "cursoride-concurrent";

    await Promise.all([
      ensureCursorIdeEventsInStore(sessionId),
      ensureCursorIdeEventsInStore(sessionId),
      ensureCursorIdeEventsInStore(sessionId),
    ]);

    expect(api.cursorIdeInitialWindow).toHaveBeenCalledTimes(1);
    expect(api.set).toHaveBeenCalledTimes(1);
  });

  it("collapses a burst of forced reloads into one full refresh", async () => {
    const sessionId = "cursoride-burst";

    const pending = [
      ensureCursorIdeEventsInStore(sessionId, { forceReload: true }),
      ensureCursorIdeEventsInStore(sessionId, { forceReload: true }),
      ensureCursorIdeEventsInStore(sessionId, { forceReload: true }),
    ];
    // Nothing runs until the debounce window closes.
    expect(api.cursorIdeFullRefresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await Promise.all(pending);

    expect(api.cursorIdeFullRefresh).toHaveBeenCalledTimes(1);
    expect(api.cursorIdeInitialWindow).not.toHaveBeenCalled();
    expect(turnSummaries(sessionId)).toHaveLength(2);
    expect(api.set).toHaveBeenCalledWith(
      [makeEvent("bubble-1", sessionId), makeEvent("bubble-2", sessionId)],
      sessionId
    );
  });

  it("restarts the debounce window on each new forced reload", async () => {
    const sessionId = "cursoride-restart";

    const first = ensureCursorIdeEventsInStore(sessionId, {
      forceReload: true,
    });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 50);
    const second = ensureCursorIdeEventsInStore(sessionId, {
      forceReload: true,
    });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 50);
    expect(api.cursorIdeFullRefresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(50);
    await Promise.all([first, second]);

    expect(api.cursorIdeFullRefresh).toHaveBeenCalledTimes(1);
  });

  it("queues exactly one follow-up refresh when a force lands mid-flight", async () => {
    const sessionId = "cursoride-midflight";
    const gate: { release: () => void } = { release: () => undefined };
    api.cursorIdeInitialWindow.mockImplementation(
      () =>
        new Promise((resolve) => {
          gate.release = () =>
            resolve({ chunks: [makeChunk("bubble-1")], turns: [] });
        })
    );

    const lazy = ensureCursorIdeEventsInStore(sessionId);
    await vi.advanceTimersByTimeAsync(0);

    const forced = ensureCursorIdeEventsInStore(sessionId, {
      forceReload: true,
    });
    const forcedAgain = ensureCursorIdeEventsInStore(sessionId, {
      forceReload: true,
    });

    gate.release();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await Promise.all([lazy, forced, forcedAgain]);

    expect(api.cursorIdeInitialWindow).toHaveBeenCalledTimes(1);
    expect(api.cursorIdeFullRefresh).toHaveBeenCalledTimes(1);
  });

  it("folds a debounced force into a lazy load that started inside the window", async () => {
    const sessionId = "cursoride-force-into-lazy";
    const gate: { release: () => void } = { release: () => undefined };
    api.cursorIdeInitialWindow.mockImplementation(
      () =>
        new Promise((resolve) => {
          gate.release = () =>
            resolve({ chunks: [makeChunk("bubble-1")], turns: [] });
        })
    );

    const forced = ensureCursorIdeEventsInStore(sessionId, {
      forceReload: true,
    });
    // A render path kicks off the lazy read while the force is still debounced.
    const lazy = ensureCursorIdeEventsInStore(sessionId);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    gate.release();
    await Promise.all([forced, lazy]);

    expect(api.cursorIdeInitialWindow).toHaveBeenCalledTimes(1);
    // The pending force is absorbed as exactly one follow-up refresh.
    expect(api.cursorIdeFullRefresh).toHaveBeenCalledTimes(1);
  });

  it("propagates a lazy-load failure to the caller and stays retryable", async () => {
    const sessionId = "cursoride-lazy-fails";
    api.cursorIdeInitialWindow.mockRejectedValueOnce(
      new Error("state.vscdb locked")
    );

    await expect(ensureCursorIdeEventsInStore(sessionId)).rejects.toThrow(
      "state.vscdb locked"
    );

    // The in-flight slot was released, so a later call retries for real.
    await ensureCursorIdeEventsInStore(sessionId);
    expect(api.cursorIdeInitialWindow).toHaveBeenCalledTimes(2);
    expect(api.set).toHaveBeenCalledTimes(1);
  });

  it("rejects every caller awaiting a failed debounced refresh", async () => {
    const sessionId = "cursoride-forced-fails";
    api.cursorIdeFullRefresh.mockRejectedValueOnce(
      new Error("refresh blew up")
    );

    const first = ensureCursorIdeEventsInStore(sessionId, {
      forceReload: true,
    });
    const second = ensureCursorIdeEventsInStore(sessionId, {
      forceReload: true,
    });
    const settled = Promise.allSettled([first, second]);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(await settled).toEqual([
      { status: "rejected", reason: expect.any(Error) },
      { status: "rejected", reason: expect.any(Error) },
    ]);
  });
});

describe("getCursorIdeSnapshotLastUpdatedAt", () => {
  it("returns null for a session that was never loaded", () => {
    expect(getCursorIdeSnapshotLastUpdatedAt("cursoride-unknown")).toBeNull();
  });
});

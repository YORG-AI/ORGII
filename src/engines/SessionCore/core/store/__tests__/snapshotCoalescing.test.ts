import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "../../types";
import { eventStoreProxy } from "../EventStoreProxy";
import type {
  DerivedSnapshot,
  SnapshotDelta,
  SnapshotEnvelope,
} from "../EventStoreProxy";

type DerivedEnvelope = DerivedSnapshot & { sessionId: string };
type DeltaEnvelope = SnapshotDelta & { sessionId: string };

const { rpcMock, listenState } = vi.hoisted(() => ({
  rpcMock: {
    sessionCore: {
      eventStore: {
        getSnapshot: vi.fn(),
        switchSession: vi.fn().mockResolvedValue(true),
        setStreaming: vi.fn().mockResolvedValue(undefined),
      },
    },
  },
  listenState: {
    handler: null as ((event: { payload: unknown }) => void) | null,
  },
}));

vi.mock("@src/api/tauri/rpc", () => ({
  rpc: rpcMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (_name: string, handler: (event: { payload: unknown }) => void) => {
    listenState.handler = handler;
    return Promise.resolve(() => {
      listenState.handler = null;
    });
  },
}));

/** Push an envelope through the proxy's Tauri listener and drain the
 * per-session envelope chain (microtasks only — no frame flush). */
async function deliver(envelope: SnapshotEnvelope): Promise<void> {
  listenState.handler!({ payload: envelope });
  await vi.advanceTimersByTimeAsync(0);
}

/** Fire the coalesced per-frame flush (setTimeout(16) fallback in node). */
async function advanceFrame(): Promise<void> {
  await vi.advanceTimersByTimeAsync(16);
}

describe("EventStoreProxy snapshot coalescing", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    await eventStoreProxy.init();
  });

  afterEach(() => {
    eventStoreProxy.destroy();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("reuses the previous eventIndex, unchanged arrays and preview objects on a single-event delta upsert", async () => {
    const sessionId = "session-reuse";
    const e1 = makeEvent("e1", sessionId);
    const e2 = makeEvent("e2", sessionId);
    const notified: DerivedSnapshot[] = [];
    const unsubscribe = eventStoreProxy.subscribe((snapshot, sid) => {
      if (sid === sessionId) notified.push(snapshot as DerivedSnapshot);
    });

    await deliver(makeDerivedEnvelope(sessionId, 1, [e1, e2]));
    await advanceFrame();
    expect(notified).toHaveLength(1);
    const first = notified[0];

    const e2Updated: SessionEvent = { ...e2, displayStatus: "failed" };
    await deliver(
      makeDeltaEnvelope(sessionId, 1, 2, [e2Updated], {
        eventIds: ["e1", "e2"],
        chatEventIds: ["e1", "e2"],
        messagesEventIds: ["e1"],
        sortedSimulatorEventIds: ["e1", "e2"],
        lastEventId: "e2",
      })
    );
    await advanceFrame();
    expect(notified).toHaveLength(2);
    const second = notified[1];

    // Ordering unchanged → the index object is reused, not rebuilt.
    expect(second.eventIndex).toBe(first.eventIndex);
    // Pointer-copied array: only the changed slot was swapped.
    expect(second.events).not.toBe(first.events);
    expect(second.events[0]).toBe(first.events[0]);
    expect(second.events[1]).toBe(e2Updated);
    // No referenced event changed → the whole array is reused.
    expect(second.messagesEvents).toBe(first.messagesEvents);
    // Unchanged events keep their preview object identity.
    expect(second.eventPreviewById?.e1).toBe(first.eventPreviewById?.e1);
    expect(second.eventPreviewById?.e2).not.toBe(first.eventPreviewById?.e2);
    // Copy-on-write Records: value-identical ones keep their identity.
    expect(second.createdAtById).toBe(first.createdAtById);
    expect(second.displayStatusById).not.toBe(first.displayStatusById);
    expect(second.displayStatusById?.e2).toBe("failed");

    unsubscribe();
  });

  it("applies streaming membership deltas without full-history id vectors", async () => {
    const sessionId = "session-streaming-incremental";
    const e1 = makeEvent("e1", sessionId);
    const e2 = makeEvent("e2", sessionId);
    const listener = vi.fn();
    const unsubscribe = eventStoreProxy.subscribe(listener);

    await deliver(makeDerivedEnvelope(sessionId, 1, [e1, e2]));
    await advanceFrame();
    listener.mockClear();

    const e2Updated: SessionEvent = { ...e2, displayStatus: "failed" };
    const e3: SessionEvent = {
      ...makeEvent("e3", sessionId),
      displayStatus: "running",
    };
    await deliver({
      sessionId,
      snapshotDelta: true,
      version: 2,
      baseVersion: 1,
      eventCount: 3,
      upserts: [e2Updated, e3],
      removedIds: [],
      eventIds: [],
      chatEventIds: [],
      messagesEventIds: [],
      sortedSimulatorEventIds: [],
      lastEventId: "e3",
      chatEventCount: 0,
      hasRunningEvent: false,
      incrementalOrders: true,
      streaming: true,
      memberships: [
        {
          id: "e2",
          eventIndex: 1,
          chat: true,
          messages: false,
          simulator: true,
        },
        {
          id: "e3",
          eventIndex: 2,
          chat: true,
          messages: true,
          simulator: true,
        },
      ],
    });
    await advanceFrame();

    expect(listener).toHaveBeenCalledTimes(1);
    const [snapshot] = listener.mock.calls[0] as [DerivedSnapshot, string];
    expect(snapshot.events.map((event) => event.id)).toEqual([
      "e1",
      "e2",
      "e3",
    ]);
    expect(snapshot.chatEvents.map((event) => event.id)).toEqual([
      "e1",
      "e2",
      "e3",
    ]);
    expect(snapshot.messagesEvents.map((event) => event.id)).toEqual([
      "e1",
      "e3",
    ]);
    expect(snapshot.sortedSimulatorEvents.map((event) => event.id)).toEqual([
      "e1",
      "e2",
      "e3",
    ]);
    expect(snapshot.hasRunningEvent).toBe(true);
    expect(snapshot.streaming).toBe(true);
    expect(rpcMock.sessionCore.eventStore.getSnapshot).not.toHaveBeenCalled();

    // Active materialized deltas remain cached when the session is switched
    // away; dropping them would force a full-history fetch on the next frame.
    eventStoreProxy.releaseSessionSnapshotIfIdle(sessionId);
    expect(eventStoreProxy.getLatestSessionSnapshot(sessionId)).not.toBeNull();

    await deliver({
      sessionId,
      snapshotDelta: true,
      version: 3,
      baseVersion: 2,
      eventCount: 3,
      upserts: [{ ...e3, displayStatus: "completed" }],
      removedIds: [],
      eventIds: ["e1", "e2", "e3"],
      chatEventIds: ["e1", "e2", "e3"],
      messagesEventIds: ["e1", "e3"],
      sortedSimulatorEventIds: ["e1", "e2", "e3"],
      lastEventId: "e3",
      chatEventCount: 3,
      hasRunningEvent: false,
      streaming: false,
    });
    await advanceFrame();
    const settled = eventStoreProxy.getLatestSessionSnapshot(
      sessionId
    ) as DerivedSnapshot;
    expect(settled.streaming).toBe(false);
    expect(settled.hasRunningEvent).toBe(false);
    eventStoreProxy.releaseSessionSnapshotIfIdle(sessionId);
    expect(eventStoreProxy.getLatestSessionSnapshot(sessionId)).toBeNull();

    unsubscribe();
  });

  it("coalesces N same-frame envelopes into exactly one notify carrying the final state", async () => {
    const sessionId = "session-coalesce";
    const e1 = makeEvent("e1", sessionId);
    const listener = vi.fn();
    const unsubscribe = eventStoreProxy.subscribe(listener);

    await deliver(makeDerivedEnvelope(sessionId, 1, [e1]));
    await advanceFrame();
    expect(listener).toHaveBeenCalledTimes(1);
    listener.mockClear();

    const ids = {
      eventIds: ["e1"],
      chatEventIds: ["e1"],
      messagesEventIds: ["e1"],
      sortedSimulatorEventIds: ["e1"],
      lastEventId: "e1",
    };
    await deliver(
      makeDeltaEnvelope(sessionId, 1, 2, [{ ...e1, displayText: "a" }], ids)
    );
    await deliver(
      makeDeltaEnvelope(sessionId, 2, 3, [{ ...e1, displayText: "ab" }], ids)
    );
    await deliver(
      makeDeltaEnvelope(sessionId, 3, 4, [{ ...e1, displayText: "abc" }], ids)
    );
    expect(listener).not.toHaveBeenCalled();

    await advanceFrame();
    expect(listener).toHaveBeenCalledTimes(1);
    const [snapshot] = listener.mock.calls[0] as [DerivedSnapshot, string];
    expect(snapshot.version).toBe(4);
    expect(snapshot.events[0].displayText).toBe("abc");

    unsubscribe();
  });

  it("force-flushes pending deltas on releaseSessionSnapshot", async () => {
    const sessionId = "session-release-flush";
    const e1 = makeEvent("e1", sessionId);
    const listener = vi.fn();
    const unsubscribe = eventStoreProxy.subscribe(listener);

    await deliver(makeDerivedEnvelope(sessionId, 1, [e1]));
    await advanceFrame();
    listener.mockClear();

    await deliver(
      makeDeltaEnvelope(sessionId, 1, 2, [{ ...e1, displayText: "final" }], {
        eventIds: ["e1"],
        chatEventIds: ["e1"],
        messagesEventIds: ["e1"],
        sortedSimulatorEventIds: ["e1"],
        lastEventId: "e1",
      })
    );
    expect(listener).not.toHaveBeenCalled();

    eventStoreProxy.releaseSessionSnapshot(sessionId);
    // The pending delta reached subscribers synchronously, before the drop.
    expect(listener).toHaveBeenCalledTimes(1);
    const [snapshot] = listener.mock.calls[0] as [DerivedSnapshot, string];
    expect(snapshot.version).toBe(2);
    expect(snapshot.events[0].displayText).toBe("final");
    expect(eventStoreProxy.getLatestSessionSnapshot(sessionId)).toBeNull();

    // The cancelled schedule must not fire a second notify.
    await advanceFrame();
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it("getLatestSessionSnapshot never observes the one-frame staleness window", async () => {
    const sessionId = "session-sync-read";
    const e1 = makeEvent("e1", sessionId);
    await deliver(makeDerivedEnvelope(sessionId, 1, [e1]));
    await advanceFrame();

    await deliver(
      makeDeltaEnvelope(sessionId, 1, 2, [{ ...e1, displayText: "fresh" }], {
        eventIds: ["e1"],
        chatEventIds: ["e1"],
        messagesEventIds: ["e1"],
        sortedSimulatorEventIds: ["e1"],
        lastEventId: "e1",
      })
    );

    const snapshot = eventStoreProxy.getLatestSessionSnapshot(
      sessionId
    ) as DerivedSnapshot;
    expect(snapshot.version).toBe(2);
    expect(snapshot.events[0].displayText).toBe("fresh");
  });

  it("evicts oldest sessions when cached events exceed the budget", async () => {
    const bigSession = (sessionId: string) =>
      makeDerivedEnvelope(
        sessionId,
        1,
        Array.from({ length: 6_000 }, (_, i) =>
          makeEvent(`${sessionId}-e${i}`, sessionId)
        )
      );

    await deliver(bigSession("session-a"));
    await deliver(bigSession("session-b"));
    await advanceFrame();
    // 12k events fits the 15k budget: both retained.
    expect(eventStoreProxy.getMemoryStats().cachedSessions).toBe(2);

    await deliver(bigSession("session-c"));
    await advanceFrame();
    // 18k exceeds the budget: oldest (session-a) evicted, newest kept.
    const stats = eventStoreProxy.getMemoryStats();
    expect(stats.cachedSessions).toBe(2);
    expect(stats.cachedEvents).toBeLessThanOrEqual(15_000);
    expect(
      eventStoreProxy.getLatestSessionSnapshot("session-c")
    ).not.toBeNull();
    expect(eventStoreProxy.getLatestSessionSnapshot("session-a")).toBeNull();
  });

  it("falls back to a full snapshot fetch on a delta base-version miss", async () => {
    const sessionId = "session-base-miss";
    const e1 = makeEvent("e1", sessionId);
    const listener = vi.fn();
    const unsubscribe = eventStoreProxy.subscribe(listener);

    rpcMock.sessionCore.eventStore.getSnapshot.mockResolvedValueOnce(
      makeDerivedEnvelopePayload(7, [e1])
    );
    await deliver(
      makeDeltaEnvelope(sessionId, 6, 7, [e1], {
        eventIds: ["e1"],
        chatEventIds: ["e1"],
        messagesEventIds: ["e1"],
        sortedSimulatorEventIds: ["e1"],
        lastEventId: "e1",
      })
    );
    expect(rpcMock.sessionCore.eventStore.getSnapshot).toHaveBeenCalledWith({
      sessionId,
    });

    await advanceFrame();
    expect(listener).toHaveBeenCalledTimes(1);
    const [snapshot] = listener.mock.calls[0] as [DerivedSnapshot, string];
    expect(snapshot.version).toBe(7);

    unsubscribe();
  });
});

function makeDerivedEnvelopePayload(
  version: number,
  events: SessionEvent[]
): DerivedSnapshot {
  return {
    version,
    eventCount: events.length,
    events,
    chatEvents: events,
    messagesEvents: events.slice(0, 1),
    sortedSimulatorEvents: events,
    lastEvent: events[events.length - 1] ?? null,
    eventIndex: {},
    chatEventCount: events.length,
    hasRunningEvent: false,
  };
}

function makeDerivedEnvelope(
  sessionId: string,
  version: number,
  events: SessionEvent[]
): DerivedEnvelope {
  return {
    sessionId,
    ...makeDerivedEnvelopePayload(version, events),
  };
}

function makeDeltaEnvelope(
  sessionId: string,
  baseVersion: number,
  version: number,
  upserts: SessionEvent[],
  ids: {
    eventIds: string[];
    chatEventIds: string[];
    messagesEventIds: string[];
    sortedSimulatorEventIds: string[];
    lastEventId: string | null;
  }
): DeltaEnvelope {
  return {
    sessionId,
    snapshotDelta: true,
    version,
    baseVersion,
    eventCount: ids.eventIds.length,
    upserts,
    removedIds: [],
    eventIds: ids.eventIds,
    chatEventIds: ids.chatEventIds,
    messagesEventIds: ids.messagesEventIds,
    sortedSimulatorEventIds: ids.sortedSimulatorEventIds,
    lastEventId: ids.lastEventId,
    chatEventCount: ids.chatEventIds.length,
    hasRunningEvent: true,
  };
}

function makeEvent(id: string, sessionId: string): SessionEvent {
  return {
    id,
    chunk_id: id,
    sessionId,
    createdAt: "2026-07-16T00:00:00.000Z",
    functionName: "assistant_message",
    uiCanonical: "message",
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

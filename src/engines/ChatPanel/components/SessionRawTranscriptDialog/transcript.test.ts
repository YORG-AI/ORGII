import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import {
  type RawTranscriptSnapshot,
  loadOlderRawSessionTranscript,
  loadRawSessionTranscript,
  mergeRawSessionEvents,
} from "./transcript";

const mocks = vi.hoisted(() => ({
  getImportedHistorySourceBySessionId: vi.fn(),
  resolveSecondaryReplayTarget: vi.fn(),
  externalReplayQueryWindowForTarget: vi.fn(),
  getPersistedEvents: vi.fn(),
  getEvents: vi.fn(),
}));

vi.mock("@src/api/tauri/externalHistory", () => ({
  getImportedHistorySourceBySessionId:
    mocks.getImportedHistorySourceBySessionId,
}));

vi.mock("@src/api/tauri/externalHistory/replay", () => ({
  resolveSecondaryReplayTarget: mocks.resolveSecondaryReplayTarget,
  externalReplayQueryWindowForTarget: mocks.externalReplayQueryWindowForTarget,
}));

vi.mock("@src/engines/SessionCore/core/store/EventStoreProxy", () => ({
  eventStoreProxy: {
    getPersistedEvents: mocks.getPersistedEvents,
    getEvents: mocks.getEvents,
  },
}));

function event(
  id: string,
  sessionId: string,
  createdAt: string,
  displayText: string
): SessionEvent {
  return {
    chunk_id: id,
    id,
    sessionId,
    createdAt,
    functionName: "assistant_message",
    uiCanonical: "assistant_message",
    actionType: "assistant_message",
    args: {},
    result: {},
    source: "assistant",
    displayText,
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "agent",
  };
}

describe("raw session transcript loading", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getImportedHistorySourceBySessionId.mockReturnValue(undefined);
    mocks.resolveSecondaryReplayTarget.mockResolvedValue(null);
  });

  it("keeps durable history, overlays live updates, and excludes other sessions", () => {
    const merged = mergeRawSessionEvents(
      [
        event("1", "session-a", "2026-07-18T00:00:00.000Z", "persisted"),
        event("other", "session-b", "2026-07-18T00:00:01.000Z", "other"),
      ],
      [
        event("1", "session-a", "2026-07-18T00:00:00.000Z", "streamed"),
        event("2", "session-a", "2026-07-18T00:00:02.000Z", "new"),
      ],
      "session-a"
    );

    expect(merged.map((item) => [item.id, item.displayText])).toEqual([
      ["1", "streamed"],
      ["2", "new"],
    ]);
  });

  it("loads only the bounded replay window for an externally imported session", async () => {
    const entries = [
      event("1", "codexapp-session-1", "2026-07-18T00:00:00.000Z", "hello"),
      event("2", "codexapp-session-1", "2026-07-18T00:00:01.000Z", "hi"),
    ];
    const target = {
      sourceId: "codex_app",
      sessionId: "codexapp-session-1",
    } as const;
    mocks.resolveSecondaryReplayTarget.mockResolvedValue(target);
    mocks.getImportedHistorySourceBySessionId.mockReturnValue({
      sourceId: "codex_app",
      displayName: "Codex App",
    });
    mocks.externalReplayQueryWindowForTarget.mockResolvedValue({
      cursor: {
        sourceId: "codex_app",
        sessionId: "codexapp-session-1",
        generation: "g1",
        revision: 1,
        throughSequence: 9,
      },
      events: entries,
      windowStartSequence: 8,
      turnHeaders: [
        {
          turnId: "turn-1",
          turnIndex: 1,
          startSequence: 8,
          endSequence: null,
          startedAt: "2026-07-18T00:00:00.000Z",
          endedAt: null,
          eventCount: 2,
        },
      ],
      totalEventCount: entries.length,
      totalTurnCount: 8,
      hasOlder: true,
      watcherAvailable: false,
      stats: {
        parsedBytes: 0,
        parsedRows: 0,
        normalizedEvents: 2,
        upsertedEvents: 2,
        removedEvents: 0,
        ipcBytes: 2048,
        notReady: false,
      },
    });

    const snapshot = await loadRawSessionTranscript("codexapp-session-1");

    expect(mocks.externalReplayQueryWindowForTarget).toHaveBeenCalledWith({
      target,
    });
    expect(snapshot.source).toEqual({
      kind: "external-history",
      sourceId: "codex_app",
      displayName: "Codex App",
      target,
    });
    expect(snapshot.entries).toBe(entries);
    expect(snapshot.replay?.hasOlder).toBe(true);
    expect(mocks.getPersistedEvents).not.toHaveBeenCalled();
  });

  it("loads a snapshot-backed native fork without hydrating EventStore history", async () => {
    const target = {
      sourceId: "collaboration_snapshot" as const,
      sessionId: "agentsession-cloud-fork",
    };
    const entries = [
      event(
        "fork~assistant",
        target.sessionId,
        "2026-07-18T00:00:01.000Z",
        "bounded fork row"
      ),
    ];
    mocks.resolveSecondaryReplayTarget.mockResolvedValue(target);
    mocks.externalReplayQueryWindowForTarget.mockResolvedValue({
      cursor: {
        ...target,
        generation: "snapshot-g1",
        revision: 2,
        throughSequence: 10,
      },
      events: entries,
      windowStartSequence: 10,
      turnHeaders: [],
      totalEventCount: 5_000,
      totalTurnCount: 200,
      hasOlder: true,
      watcherAvailable: false,
      stats: { ipcBytes: 1_024 },
    });

    const snapshot = await loadRawSessionTranscript(target.sessionId);

    expect(snapshot.source).toEqual({
      kind: "external-history",
      sourceId: "collaboration_snapshot",
      displayName: "collaboration snapshot",
      target,
    });
    expect(snapshot.entries).toBe(entries);
    expect(mocks.externalReplayQueryWindowForTarget).toHaveBeenCalledWith({
      target,
    });
    expect(mocks.getPersistedEvents).not.toHaveBeenCalled();
    expect(mocks.getEvents).not.toHaveBeenCalled();
  });

  it("prepends older replay pages and reopens the latest window on generation or revision changes", async () => {
    const current = event(
      "new",
      "codexapp-session-1",
      "2026-07-18T00:00:02.000Z",
      "new"
    );
    const older = event(
      "old",
      "codexapp-session-1",
      "2026-07-18T00:00:01.000Z",
      "old"
    );
    const snapshot = {
      sessionId: "codexapp-session-1",
      source: {
        kind: "external-history" as const,
        sourceId: "codex_app",
        displayName: "Codex App",
        target: {
          sourceId: "codex_app" as const,
          sessionId: "codexapp-session-1",
        },
      },
      loadedAt: "2026-07-18T00:00:03.000Z",
      entries: [current],
      replay: {
        cursor: {
          sourceId: "codex_app" as const,
          sessionId: "codexapp-session-1",
          generation: "g1",
          revision: 1,
          throughSequence: 2,
        },
        windowStartSequence: 2,
        turnHeaders: [
          {
            turnId: "new-turn",
            turnIndex: 1,
            startSequence: 2,
            endSequence: null,
            startedAt: current.createdAt,
            endedAt: null,
            eventCount: 1,
          },
        ],
        totalEventCount: 1,
        totalTurnCount: 2,
        hasOlder: true,
        ipcBytes: 100,
      },
    };
    mocks.externalReplayQueryWindowForTarget.mockResolvedValueOnce({
      cursor: { ...snapshot.replay.cursor, throughSequence: 1 },
      events: [older],
      windowStartSequence: 1,
      turnHeaders: [
        {
          turnId: "old-turn",
          turnIndex: 0,
          startSequence: 0,
          endSequence: 2,
          startedAt: older.createdAt,
          endedAt: older.createdAt,
          eventCount: 1,
        },
      ],
      totalEventCount: 1,
      totalTurnCount: 2,
      hasOlder: false,
      watcherAvailable: false,
      stats: { ipcBytes: 80 },
    });

    const paged = await loadOlderRawSessionTranscript(snapshot);
    expect(mocks.externalReplayQueryWindowForTarget).toHaveBeenCalledWith({
      target: snapshot.source.target,
      beforeSequence: 2,
    });
    expect(paged.entries.map((item) => item.id)).toEqual(["old", "new"]);
    expect(paged.replay?.ipcBytes).toBe(180);

    mocks.externalReplayQueryWindowForTarget.mockResolvedValueOnce({
      cursor: {
        ...snapshot.replay.cursor,
        generation: "g2",
        throughSequence: 0,
      },
      events: [older],
      windowStartSequence: 0,
      turnHeaders: [],
      totalEventCount: 1,
      totalTurnCount: 1,
      hasOlder: false,
      watcherAvailable: false,
      stats: { ipcBytes: 75 },
    });
    const latestAfterGeneration = event(
      "latest-g2",
      snapshot.sessionId,
      "2026-07-18T00:00:04.000Z",
      "latest generation"
    );
    mocks.externalReplayQueryWindowForTarget.mockResolvedValueOnce({
      cursor: {
        ...snapshot.replay.cursor,
        generation: "g2",
        revision: 1,
        throughSequence: 4,
      },
      events: [latestAfterGeneration],
      windowStartSequence: 4,
      turnHeaders: [],
      totalEventCount: 1,
      totalTurnCount: 1,
      hasOlder: false,
      watcherAvailable: false,
      stats: { ipcBytes: 90 },
    });
    const reset = await loadOlderRawSessionTranscript(snapshot);
    expect(reset.entries.map((item) => item.id)).toEqual(["latest-g2"]);
    expect(reset.replay?.ipcBytes).toBe(90);
    expect(mocks.externalReplayQueryWindowForTarget).toHaveBeenLastCalledWith({
      target: snapshot.source.target,
    });

    mocks.externalReplayQueryWindowForTarget.mockResolvedValueOnce({
      cursor: {
        ...snapshot.replay.cursor,
        revision: 2,
        throughSequence: 1,
      },
      events: [older],
      windowStartSequence: 1,
      turnHeaders: [],
      totalEventCount: 1,
      totalTurnCount: 2,
      hasOlder: false,
      watcherAvailable: false,
      stats: { ipcBytes: 75 },
    });
    const latestAfterRevision = event(
      "latest-r2",
      snapshot.sessionId,
      "2026-07-18T00:00:05.000Z",
      "latest revision"
    );
    mocks.externalReplayQueryWindowForTarget.mockResolvedValueOnce({
      cursor: {
        ...snapshot.replay.cursor,
        revision: 2,
        throughSequence: 5,
      },
      events: [latestAfterRevision],
      windowStartSequence: 5,
      turnHeaders: [],
      totalEventCount: 1,
      totalTurnCount: 2,
      hasOlder: true,
      watcherAvailable: false,
      stats: { ipcBytes: 95 },
    });
    const revisionReset = await loadOlderRawSessionTranscript(snapshot);
    expect(revisionReset.entries.map((item) => item.id)).toEqual(["latest-r2"]);
    expect(revisionReset.replay?.cursor.revision).toBe(2);
  });

  it("pages through one oversized turn from the actual returned sequence", async () => {
    const target = {
      sourceId: "managed_cli" as const,
      sessionId: "cliagent-large-turn",
    };
    const latest = event(
      "event-251",
      target.sessionId,
      "2026-07-18T00:00:02.000Z",
      "latest slice"
    );
    let snapshot: RawTranscriptSnapshot = {
      sessionId: target.sessionId,
      source: {
        kind: "external-history",
        sourceId: target.sourceId,
        displayName: "Managed CLI",
        target,
      },
      loadedAt: "2026-07-18T00:00:03.000Z",
      entries: [latest],
      replay: {
        cursor: {
          ...target,
          generation: "g1",
          revision: 11,
          throughSequence: 450,
        },
        windowStartSequence: 251,
        turnHeaders: [
          {
            turnId: "user-0",
            turnIndex: 0,
            startSequence: 0,
            endSequence: 450,
            startedAt: "2026-07-18T00:00:00.000Z",
            endedAt: "2026-07-18T00:00:02.000Z",
            eventCount: 451,
          },
        ],
        totalTurnCount: 1,
        hasOlder: true,
        ipcBytes: 100,
      },
    };
    const oldest = event(
      "event-0",
      target.sessionId,
      "2026-07-18T00:00:00.000Z",
      "oldest slice"
    );
    const replay = snapshot.replay!;
    mocks.externalReplayQueryWindowForTarget
      .mockResolvedValueOnce({
        cursor: { ...replay.cursor, throughSequence: 250 },
        // This page was scanned but every row was intentionally filtered by
        // normalization. Its source boundary must still advance pagination.
        events: [],
        windowStartSequence: 51,
        turnHeaders: replay.turnHeaders,
        totalEventCount: 451,
        totalTurnCount: 1,
        hasOlder: true,
        watcherAvailable: false,
        stats: { ipcBytes: 100 },
      })
      .mockResolvedValueOnce({
        cursor: { ...replay.cursor, throughSequence: 50 },
        events: [oldest],
        windowStartSequence: 0,
        turnHeaders: replay.turnHeaders,
        totalEventCount: 451,
        totalTurnCount: 1,
        hasOlder: false,
        watcherAvailable: false,
        stats: { ipcBytes: 100 },
      });

    snapshot = await loadOlderRawSessionTranscript(snapshot);
    expect(mocks.externalReplayQueryWindowForTarget).toHaveBeenLastCalledWith({
      target,
      beforeSequence: 251,
    });
    expect(snapshot.replay?.windowStartSequence).toBe(51);

    snapshot = await loadOlderRawSessionTranscript(snapshot);
    expect(mocks.externalReplayQueryWindowForTarget).toHaveBeenLastCalledWith({
      target,
      beforeSequence: 51,
    });
    expect(snapshot.entries.map((entry) => entry.id)).toEqual([
      "event-0",
      "event-251",
    ]);
    expect(snapshot.replay?.hasOlder).toBe(false);
  });

  it("retains only the current backward page headers across many pages", async () => {
    const target = {
      sourceId: "codex_app" as const,
      sessionId: "codexapp-session-many-pages",
    };
    let snapshot: RawTranscriptSnapshot = {
      sessionId: target.sessionId,
      source: {
        kind: "external-history" as const,
        sourceId: target.sourceId,
        displayName: "Codex App",
        target,
      },
      loadedAt: "2026-07-18T00:00:50.000Z",
      entries: [
        event(
          "event-50",
          target.sessionId,
          "2026-07-18T00:00:50.000Z",
          "page 50"
        ),
      ],
      replay: {
        cursor: {
          ...target,
          generation: "g1",
          revision: 1,
          throughSequence: 50,
        },
        windowStartSequence: 50,
        turnHeaders: [
          {
            turnId: "turn-50",
            turnIndex: 50,
            startSequence: 50,
            endSequence: null,
            startedAt: "2026-07-18T00:00:50.000Z",
            endedAt: null,
            eventCount: 1,
          },
        ],
        totalTurnCount: 51,
        hasOlder: true,
        ipcBytes: 100,
      },
    };
    mocks.externalReplayQueryWindowForTarget.mockImplementation(
      async ({ beforeSequence }: { beforeSequence?: number }) => {
        const sequence = (beforeSequence ?? 1) - 1;
        const createdAt = `2026-07-18T00:00:${String(sequence).padStart(2, "0")}.000Z`;
        return {
          cursor: {
            ...snapshot.replay!.cursor,
            throughSequence: sequence,
          },
          events: [
            event(
              `event-${sequence}`,
              target.sessionId,
              createdAt,
              `page ${sequence}`
            ),
          ],
          windowStartSequence: sequence,
          turnHeaders: [
            {
              turnId: `turn-${sequence}`,
              turnIndex: sequence,
              startSequence: sequence,
              endSequence: beforeSequence ?? null,
              startedAt: createdAt,
              endedAt: createdAt,
              eventCount: 1,
            },
          ],
          totalEventCount: 51,
          totalTurnCount: 51,
          hasOlder: sequence > 0,
          watcherAvailable: false,
          stats: { ipcBytes: 100 },
        };
      }
    );

    for (let page = 0; page < 30; page += 1) {
      snapshot = await loadOlderRawSessionTranscript(snapshot);
      expect(snapshot.replay?.turnHeaders).toHaveLength(1);
    }
    expect(snapshot.replay?.turnHeaders[0]?.startSequence).toBe(20);
  });

  it("merges durable and in-memory EventStore data for an ORGII session", async () => {
    mocks.getPersistedEvents.mockResolvedValue([
      event("1", "session-a", "2026-07-18T00:00:00.000Z", "persisted"),
    ]);
    mocks.getEvents.mockResolvedValue([
      event("1", "session-a", "2026-07-18T00:00:00.000Z", "streamed"),
      event("2", "session-a", "2026-07-18T00:00:01.000Z", "new"),
    ]);

    const snapshot = await loadRawSessionTranscript("session-a");

    expect(snapshot.source).toEqual({
      kind: "orgii-event-store",
      displayName: "ORGII EventStore",
    });
    expect(mocks.resolveSecondaryReplayTarget).toHaveBeenCalledWith(
      "session-a"
    );
    expect(mocks.externalReplayQueryWindowForTarget).not.toHaveBeenCalled();
    expect(
      (snapshot.entries as SessionEvent[]).map((item) => [
        item.id,
        item.displayText,
      ])
    ).toEqual([
      ["1", "streamed"],
      ["2", "new"],
    ]);
  });
});

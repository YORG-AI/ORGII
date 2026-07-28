import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import { loadRawSessionTranscript, mergeRawSessionEvents } from "./transcript";

const mocks = vi.hoisted(() => ({
  getImportedHistorySourceBySessionId: vi.fn(),
  getPersistedEvents: vi.fn(),
  getEvents: vi.fn(),
}));

vi.mock("@src/api/tauri/externalHistory", () => ({
  getImportedHistorySourceBySessionId:
    mocks.getImportedHistorySourceBySessionId,
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

  it("loads the original full transcript for an externally imported session", async () => {
    const rawChunks = [
      { type: "user", message: { content: "hello" } },
      { type: "assistant", message: { content: "hi" } },
    ];
    const loadFullTranscriptChunks = vi.fn().mockResolvedValue(rawChunks);
    mocks.getImportedHistorySourceBySessionId.mockReturnValue({
      sourceId: "codex-app",
      displayName: "Codex App",
      loadFullTranscriptChunks,
    });

    const snapshot = await loadRawSessionTranscript("codexapp-session-1");

    expect(loadFullTranscriptChunks).toHaveBeenCalledWith("codexapp-session-1");
    expect(snapshot.source).toEqual({
      kind: "external-history",
      sourceId: "codex-app",
      displayName: "Codex App",
    });
    expect(snapshot.entries).toBe(rawChunks);
    expect(mocks.getPersistedEvents).not.toHaveBeenCalled();
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

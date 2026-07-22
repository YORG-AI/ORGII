import { describe, expect, it } from "vitest";

import type { ExternalReplayWindow } from "@src/api/tauri/externalHistory/replay";

import {
  buildCursorReplayTurnSummaries,
  cursorReplayPlaceholderId,
  cursorReplayTurnIndexFromId,
} from "../cursorIdeAdapter";

function replayWindow(totalTurnCount: number): ExternalReplayWindow {
  const latestIndex = totalTurnCount - 1;
  return {
    cursor: {
      sourceId: "cursor_ide",
      sessionId: "cursoride-composer-1",
      generation: "g1",
      revision: 1,
      throughSequence: 1,
    },
    events: [
      {
        id: "cursoride-user-provider-stable-id",
        sessionId: "cursoride-composer-1",
        source: "user",
        displayText: "latest prompt",
        result: {},
      } as ExternalReplayWindow["events"][number],
    ],
    windowStartSequence: 1,
    turnHeaders: [
      {
        turnId: "cursoride-user-provider-stable-id",
        turnIndex: latestIndex,
        startSequence: 1,
        endSequence: 1,
        startedAt: "2026-07-22T00:00:00Z",
        endedAt: "2026-07-22T00:00:01Z",
        eventCount: 2,
      },
    ],
    totalEventCount: totalTurnCount * 2,
    totalTurnCount,
    hasOlder: totalTurnCount > 1,
    watcherAvailable: false,
    stats: {
      parsedBytes: 0,
      parsedRows: 0,
      normalizedEvents: 0,
      upsertedEvents: 0,
      removedEvents: 0,
      ipcBytes: 0,
      notReady: false,
    },
  };
}

describe("Cursor IDE bounded turn catalog", () => {
  it("keeps the exact turn count without allocating every placeholder", () => {
    const summaries = buildCursorReplayTurnSummaries(replayWindow(100_000));

    expect(summaries).toHaveLength(100_000);
    expect(Object.keys(summaries)).toEqual(["99999"]);
    expect(summaries[0]?.turnId).toBe(cursorReplayPlaceholderId(0));
    expect(summaries[50_000]?.turnIndex).toBe(50_000);
    expect(summaries[99_999]?.turnId).toBe("cursoride-user-provider-stable-id");
    expect(summaries[99_999]?.userPreview).toBe("latest prompt");
  });

  it("round-trips a virtual turn index and rejects unrelated ids", () => {
    const id = cursorReplayPlaceholderId(42);
    expect(cursorReplayTurnIndexFromId(id)).toBe(42);
    expect(cursorReplayTurnIndexFromId("cursoride-user-42")).toBeNull();
    expect(cursorReplayTurnIndexFromId(`${id}.5`)).toBeNull();
  });
});

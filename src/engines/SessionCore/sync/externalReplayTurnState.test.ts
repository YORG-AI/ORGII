import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ExternalReplayTurnSummary,
  ExternalReplayWindow,
} from "@src/api/tauri/externalHistory";

import {
  MAX_LOADED_EXTERNAL_REPLAY_TURN_SUMMARIES,
  deactivateExternalReplayTurnState,
  mergeExternalReplayTurnWindow,
} from "./externalReplayTurnState";

const mocks = vi.hoisted(() => ({
  summaries: [] as ExternalReplayTurnSummary[],
  setAtom: vi.fn(
    (
      _atom: unknown,
      update:
        | ExternalReplayTurnSummary[]
        | ((
            current: ExternalReplayTurnSummary[]
          ) => ExternalReplayTurnSummary[])
    ) => {
      mocks.summaries =
        typeof update === "function" ? update(mocks.summaries) : update;
    }
  ),
}));

vi.mock("@src/util/core/state/instrumentedStore", () => ({
  getInstrumentedStore: () => ({ set: mocks.setAtom }),
}));

function replayWindow(
  generation: string,
  totalTurnCount: number,
  turnIndex: number
): ExternalReplayWindow {
  const turnId = `${generation}-turn-${turnIndex}`;
  return {
    cursor: {
      sourceId: "codex_app",
      sessionId: "codexapp-turn-state",
      generation,
      revision: 1,
      throughSequence: turnIndex,
    },
    events: [
      {
        id: turnId,
        sessionId: "codexapp-turn-state",
        source: "user",
        displayText: turnId,
        result: {},
      } as ExternalReplayWindow["events"][number],
    ],
    windowStartSequence: turnIndex,
    turnHeaders: [
      {
        turnId,
        turnIndex,
        startSequence: turnIndex,
        endSequence: turnIndex,
        startedAt: "2026-07-23T00:00:00Z",
        endedAt: "2026-07-23T00:00:01Z",
        eventCount: 2,
      },
    ],
    totalEventCount: totalTurnCount * 2,
    totalTurnCount,
    hasOlder: turnIndex > 0,
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

describe("external replay virtual turn state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.summaries = [];
  });

  it("merges distinct older pages once within one generation", () => {
    mergeExternalReplayTurnWindow(
      "codexapp-turn-state",
      replayWindow("g1", 3, 2)
    );
    mergeExternalReplayTurnWindow(
      "codexapp-turn-state",
      replayWindow("g1", 3, 1)
    );

    expect(Object.keys(mocks.summaries)).toEqual(["1", "2"]);
    expect(mocks.summaries[1]?.turnId).toBe("g1-turn-1");
    expect(mocks.summaries[2]?.turnId).toBe("g1-turn-2");
  });

  it("drops old headers when the source generation resets", () => {
    mergeExternalReplayTurnWindow(
      "codexapp-turn-state",
      replayWindow("g1", 3, 2)
    );
    mergeExternalReplayTurnWindow(
      "codexapp-turn-state",
      replayWindow("g2", 1, 0)
    );

    expect(mocks.summaries).toHaveLength(1);
    expect(Object.keys(mocks.summaries)).toEqual(["0"]);
    expect(mocks.summaries[0]?.turnId).toBe("g2-turn-0");
  });

  it("keeps visited headers in a small LRU while retaining the current neighbours", () => {
    for (let turnIndex = 0; turnIndex < 50; turnIndex += 1) {
      mergeExternalReplayTurnWindow(
        "codexapp-turn-state",
        replayWindow("g1", 100, turnIndex)
      );
    }

    expect(Object.keys(mocks.summaries)).toHaveLength(
      MAX_LOADED_EXTERNAL_REPLAY_TURN_SUMMARIES
    );
    expect(mocks.summaries[48]?.turnId).toBe("g1-turn-48");
    expect(mocks.summaries[49]?.turnId).toBe("g1-turn-49");
    expect(mocks.summaries[0]?.turnId).toContain(
      "__external_replay_turn_index__"
    );
  });

  it("releases the compact summary window when the foreground session leaves", () => {
    mergeExternalReplayTurnWindow(
      "codexapp-turn-state",
      replayWindow("g1", 3, 2)
    );
    deactivateExternalReplayTurnState("codexapp-turn-state");

    expect(mocks.summaries).toEqual([]);
  });
});

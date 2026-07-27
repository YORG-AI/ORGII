import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ExternalReplayTurnSummary,
  ExternalReplayWindow,
} from "@src/api/tauri/externalHistory";

import {
  MAX_LOADED_EXTERNAL_REPLAY_TURN_SUMMARIES,
  buildExternalReplayTurnIndexByEventId,
  deactivateExternalReplayTurnState,
  mergeExternalReplayTurnWindow,
  previousExternalReplayTurnSliceStart,
  previousExternalReplayWindowStart,
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
  turnIndex: number,
  options: {
    headerTurnId?: string;
    renderedUserEventId?: string;
    turnEndSequence?: number;
    turnStartSequence?: number;
    windowStartSequence?: number;
  } = {}
): ExternalReplayWindow {
  const turnId = options.headerTurnId ?? `${generation}-turn-${turnIndex}`;
  const renderedUserEventId = options.renderedUserEventId ?? turnId;
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
        id: renderedUserEventId,
        sessionId: "codexapp-turn-state",
        source: "user",
        displayText: renderedUserEventId,
        createdAt: "2026-07-23T00:00:00Z",
        result: {},
      } as ExternalReplayWindow["events"][number],
    ],
    windowStartSequence: options.windowStartSequence ?? turnIndex,
    turnHeaders: [
      {
        turnId,
        turnIndex,
        startSequence: options.turnStartSequence ?? turnIndex,
        endSequence: options.turnEndSequence ?? turnIndex,
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
    deactivateExternalReplayTurnState("codexapp-turn-state");
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

  it("assigns sparse resident events to compact provider turn boundaries", () => {
    const summaries: ExternalReplayTurnSummary[] = [];
    summaries[0] = {
      turnId: "codex-turn-0",
      renderedUserEventId: "codex-user-0",
      nextTurnId: "__external_replay_turn_index__:155",
      turnIndex: 0,
      startedAt: "2026-07-11T17:13:49Z",
      endedAt: "2026-07-11T17:14:34Z",
      durationMs: 45_000,
      userPreview: "old prompt",
      eventCount: 7,
      bodyEventCount: 6,
    };
    summaries[155] = {
      turnId: "codex-turn-155",
      renderedUserEventId: null,
      nextTurnId: "__external_replay_turn_index__:156",
      turnIndex: 155,
      startedAt: "2026-07-17T18:28:00Z",
      endedAt: "2026-07-18T02:30:36Z",
      durationMs: 28_356_000,
      userPreview: "recent prompt",
      eventCount: 1_993,
      bodyEventCount: 1_992,
    };
    const events = [
      {
        id: "codex-user-0",
        source: "user",
        createdAt: "2026-07-11T17:13:49Z",
      },
      {
        id: "codex-asst-0",
        source: "assistant",
        createdAt: "2026-07-11T17:13:50Z",
      },
      {
        id: "codex-tail-without-user-anchor",
        source: "assistant",
        createdAt: "2026-07-18T01:00:00Z",
      },
    ] as ExternalReplayWindow["events"];

    expect(buildExternalReplayTurnIndexByEventId(events, summaries)).toEqual(
      new Map([
        ["codex-user-0", 0],
        ["codex-asst-0", 0],
        ["codex-tail-without-user-anchor", 155],
      ])
    );
  });

  it("keeps the backend turn locator separate from the rendered user event id", () => {
    mergeExternalReplayTurnWindow(
      "codexapp-turn-state",
      replayWindow("g1", 165, 163, {
        headerTurnId: "codex-turn-163",
        renderedUserEventId: "codex-user-19216",
      })
    );

    expect(mocks.summaries[163]?.turnId).toBe("codex-turn-163");
    expect(mocks.summaries[163]?.renderedUserEventId).toBe("codex-user-19216");
    expect(mocks.summaries[163]?.userPreview).toBe("codex-user-19216");
  });

  it("resumes older history from the earliest resident event sequence", () => {
    mergeExternalReplayTurnWindow(
      "codexapp-turn-state",
      replayWindow("g1", 165, 164)
    );
    expect(previousExternalReplayWindowStart("codexapp-turn-state")).toBe(164);

    mergeExternalReplayTurnWindow(
      "codexapp-turn-state",
      replayWindow("g1", 165, 163)
    );
    expect(previousExternalReplayWindowStart("codexapp-turn-state")).toBe(163);

    mergeExternalReplayTurnWindow(
      "codexapp-turn-state",
      replayWindow("g1", 165, 0)
    );
    expect(previousExternalReplayWindowStart("codexapp-turn-state")).toBeNull();
  });

  it("tracks only the unread prefix of one partially loaded turn", () => {
    mergeExternalReplayTurnWindow(
      "codexapp-turn-state",
      replayWindow("g1", 1, 0, {
        turnStartSequence: 0,
        turnEndSequence: 450,
        windowStartSequence: 251,
      })
    );
    expect(previousExternalReplayTurnSliceStart("codexapp-turn-state", 0)).toBe(
      251
    );

    mergeExternalReplayTurnWindow(
      "codexapp-turn-state",
      replayWindow("g1", 1, 0, {
        turnStartSequence: 0,
        turnEndSequence: 450,
        windowStartSequence: 51,
      })
    );
    expect(previousExternalReplayTurnSliceStart("codexapp-turn-state", 0)).toBe(
      51
    );

    mergeExternalReplayTurnWindow(
      "codexapp-turn-state",
      replayWindow("g1", 1, 0, {
        turnStartSequence: 0,
        turnEndSequence: 450,
        windowStartSequence: 0,
      })
    );
    expect(
      previousExternalReplayTurnSliceStart("codexapp-turn-state", 0)
    ).toBeNull();
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
    expect(previousExternalReplayWindowStart("codexapp-turn-state")).toBeNull();
  });
});

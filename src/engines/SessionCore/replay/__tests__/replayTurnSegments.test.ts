import { describe, expect, it } from "vitest";

import type { SimulatorEventPreview } from "../../core/types";
import {
  applyReplayTurnSegmentLayout,
  buildReplayTurnSegments,
  findActiveReplayTurnSegment,
  indexToReplaySliderValue,
  isReplayTurnStartPreview,
} from "../replayTurnSegments";

function preview(
  overrides: Partial<SimulatorEventPreview> & Pick<SimulatorEventPreview, "id">
): SimulatorEventPreview {
  return {
    sessionId: "s1",
    createdAt: "2026-08-26T10:00:00.000Z",
    functionName: "read_file",
    uiCanonical: "read_file",
    actionType: "tool_call",
    source: "assistant",
    displayText: "Read file",
    displayStatus: "completed",
    displayVariant: "tool_call",
    activityStatus: "agent",
    filterCategory: "explore",
    ...overrides,
  };
}

describe("isReplayTurnStartPreview", () => {
  it("treats user messages with text as turn starts", () => {
    expect(
      isReplayTurnStartPreview(
        preview({
          id: "u1",
          source: "user",
          functionName: "user_message",
          displayText: "Fix the bug",
        })
      )
    ).toBe(true);
  });

  it("ignores assistant tool events", () => {
    expect(isReplayTurnStartPreview(preview({ id: "t1" }))).toBe(false);
  });
});

describe("buildReplayTurnSegments", () => {
  it("returns empty for no events", () => {
    expect(
      buildReplayTurnSegments({
        eventIds: [],
        previewById: {},
        maxValue: 200,
      })
    ).toEqual([]);
  });

  it("maps three turns onto slider spans", () => {
    const previewById = {
      u1: preview({
        id: "u1",
        source: "user",
        functionName: "user_message",
        displayText: "First",
        createdAt: "2026-08-26T10:00:00.000Z",
      }),
      a1: preview({ id: "a1", createdAt: "2026-08-26T10:01:00.000Z" }),
      u2: preview({
        id: "u2",
        source: "user",
        functionName: "user_message",
        displayText: "Second",
        createdAt: "2026-08-26T10:05:00.000Z",
      }),
      a2: preview({ id: "a2", createdAt: "2026-08-26T10:06:00.000Z" }),
      u3: preview({
        id: "u3",
        source: "user",
        functionName: "user_message",
        displayText: "Third",
        createdAt: "2026-08-26T10:10:00.000Z",
      }),
    };

    const segments = buildReplayTurnSegments({
      eventIds: ["u1", "a1", "u2", "a2", "u3"],
      previewById,
      maxValue: 200,
      minSegmentSpan: 0,
    });

    expect(segments).toHaveLength(3);
    expect(segments[0]).toMatchObject({
      turnId: "u1",
      turnNumber: 1,
      startIndex: 0,
      endIndex: 1,
      startValue: 0,
      colorIndex: 0,
    });
    expect(segments[1]).toMatchObject({
      turnId: "u2",
      turnNumber: 2,
      startIndex: 2,
      endIndex: 3,
    });
    expect(segments[2]).toMatchObject({
      turnId: "u3",
      turnNumber: 3,
      startIndex: 4,
      endIndex: 4,
      endValue: 200,
      leftPercent: 100,
      widthPercent: 0.75,
    });
    expect(segments[0]?.leftPercent).toBe(0);
    expect(segments[0]?.widthPercent).toBeGreaterThan(0);
  });

  it("precomputes band layout percentages", () => {
    const segments = applyReplayTurnSegmentLayout(
      [
        {
          turnId: "u1",
          turnNumber: 1,
          startIndex: 0,
          endIndex: 1,
          startMs: null,
          endMs: null,
          durationMs: 0,
          startValue: 0,
          endValue: 100,
          colorIndex: 0,
          leftPercent: 0,
          widthPercent: 0,
        },
        {
          turnId: "u2",
          turnNumber: 2,
          startIndex: 2,
          endIndex: 3,
          startMs: null,
          endMs: null,
          durationMs: 0,
          startValue: 100,
          endValue: 200,
          colorIndex: 1,
          leftPercent: 0,
          widthPercent: 0,
        },
      ],
      200
    );

    expect(segments[0]).toMatchObject({ leftPercent: 0, widthPercent: 50 });
    expect(segments[1]).toMatchObject({ leftPercent: 50, widthPercent: 50 });
  });

  it("merges tiny trailing segments into the previous band", () => {
    const previewById = {
      u1: preview({
        id: "u1",
        source: "user",
        displayText: "First",
        createdAt: "2026-08-26T10:00:00.000Z",
      }),
      a1: preview({ id: "a1", createdAt: "2026-08-26T10:01:00.000Z" }),
      u2: preview({
        id: "u2",
        source: "user",
        displayText: "Second",
        createdAt: "2026-08-26T10:02:00.000Z",
      }),
    };

    const segments = buildReplayTurnSegments({
      eventIds: ["u1", "a1", "u2"],
      previewById,
      maxValue: 200,
      minSegmentSpan: 50,
    });

    expect(segments).toHaveLength(1);
    expect(segments[0]?.endIndex).toBe(2);
    expect(segments[0]?.turnId).toBe("u1");
  });
});

describe("indexToReplaySliderValue", () => {
  it("maps first and last indices to slider endpoints", () => {
    expect(indexToReplaySliderValue(0, 5, 200)).toBe(0);
    expect(indexToReplaySliderValue(4, 5, 200)).toBe(200);
  });
});

describe("findActiveReplayTurnSegment", () => {
  it("returns the segment covering the current index", () => {
    const segments = buildReplayTurnSegments({
      eventIds: ["u1", "a1", "u2"],
      previewById: {
        u1: preview({
          id: "u1",
          source: "user",
          displayText: "First",
        }),
        a1: preview({ id: "a1" }),
        u2: preview({
          id: "u2",
          source: "user",
          displayText: "Second",
        }),
      },
      maxValue: 200,
      minSegmentSpan: 0,
    });

    expect(findActiveReplayTurnSegment(segments, 1)?.turnId).toBe("u1");
    expect(findActiveReplayTurnSegment(segments, 2)?.turnId).toBe("u2");
    expect(findActiveReplayTurnSegment(segments, -1)).toBeNull();
  });
});

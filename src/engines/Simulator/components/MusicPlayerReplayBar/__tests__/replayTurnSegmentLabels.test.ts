import type { TFunction } from "i18next";
import { describe, expect, it, vi } from "vitest";

import {
  formatReplayTurnSegmentLabels,
  toReplayProgressSegments,
} from "../replayTurnSegmentLabels";

describe("formatReplayTurnSegmentLabels", () => {
  const t = vi.fn((key: string, params?: Record<string, unknown>) => {
    if (key === "tools.replay.segmentTooltip") {
      return `Turn ${params?.number} · ${params?.duration} · ${params?.start}–${params?.end}`;
    }
    if (key === "tools.replay.segmentAria") {
      return `Replay turn ${params?.number}`;
    }
    return key;
  }) as unknown as TFunction<"sessions">;

  it("formats tooltip and aria labels", () => {
    const labels = formatReplayTurnSegmentLabels(
      {
        turnId: "u1",
        turnNumber: 2,
        startIndex: 0,
        endIndex: 1,
        startMs: Date.parse("2026-08-26T14:00:00.000Z"),
        endMs: Date.parse("2026-08-26T14:05:00.000Z"),
        durationMs: 5 * 60 * 1000,
        startValue: 0,
        endValue: 100,
        colorIndex: 1,
        leftPercent: 0,
        widthPercent: 50,
      },
      t
    );

    expect(labels.tooltip).toContain("Turn 2");
    expect(labels.ariaLabel).toBe("Replay turn 2");
  });
});

describe("toReplayProgressSegments", () => {
  it("marks the active turn segment and preserves layout", () => {
    const segments = toReplayProgressSegments(
      [
        {
          turnId: "u1",
          turnNumber: 1,
          startIndex: 0,
          endIndex: 0,
          startMs: null,
          endMs: null,
          durationMs: 0,
          startValue: 0,
          endValue: 0,
          colorIndex: 0,
          leftPercent: 0,
          widthPercent: 50,
        },
        {
          turnId: "u2",
          turnNumber: 2,
          startIndex: 1,
          endIndex: 1,
          startMs: null,
          endMs: null,
          durationMs: 0,
          startValue: 200,
          endValue: 200,
          colorIndex: 1,
          leftPercent: 50,
          widthPercent: 50,
        },
      ],
      "u2",
      ((key: string) => key) as unknown as TFunction<"sessions">
    );

    expect(segments[0]?.isActive).toBe(false);
    expect(segments[1]?.isActive).toBe(true);
    expect(segments[1]?.leftPercent).toBe(50);
  });
});

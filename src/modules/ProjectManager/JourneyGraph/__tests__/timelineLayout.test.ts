import { describe, expect, it } from "vitest";

import {
  LANE_HEIGHT,
  PAD_LEFT,
  PAD_TOP,
  TIMELINE_CAP_MS,
  TIMELINE_FLOOR_MS,
  TIMELINE_IDLE_GAP_MS,
  buildCompressedAxis,
  formatDuration,
  formatTick,
  layoutStoryline,
} from "../timelineLayout";
import type { StorylineViewModel } from "../viewModel";

const MIN = 60 * 1000;

function milestone(
  id: string,
  ts: string | null,
  kind = "turn",
  sequence: number | null = null
) {
  return {
    id,
    title: id.split("/").slice(1).join("/") || id,
    kind,
    evidenceClass: "canonical" as const,
    sourceRef: `src:${id}`,
    displayTimestamp: ts,
    sequence,
    topicTags: [],
  };
}

const base: StorylineViewModel = {
  lanes: [
    {
      id: "session/a",
      label: "a",
      milestones: [
        milestone("session/a", "2026-07-30T08:00:00.000Z", "session"),
        milestone("turn/a/1", "2026-07-30T08:05:00.000Z", "turn", 1),
      ],
      gaps: [],
    },
    {
      id: "session/b",
      label: "b",
      milestones: [
        milestone("session/b", "2026-07-30T12:00:00.000Z", "session"),
      ],
      gaps: [],
    },
  ],
  connectors: [
    {
      from: "session/b",
      to: "session/a",
      kind: "forkedFrom",
      evidenceClass: "canonical",
      sourceRef: "fork:b:a",
    },
    {
      from: "session/a",
      to: "session/missing",
      kind: "resumedFrom",
      evidenceClass: "canonical",
      sourceRef: "resume:a:missing",
    },
    {
      from: "session/a",
      to: "turn/a/1",
      kind: "handoffTo",
      evidenceClass: "canonical",
      sourceRef: "handoff:a:1",
    },
  ],
  unpositioned: [milestone("turn/c/1", null, "turn", 1)],
};

describe("buildCompressedAxis", () => {
  it("clamps short bursts up to the floor and long idle down to the cap", () => {
    const t0 = Date.parse("2026-07-30T08:00:00.000Z");
    const axis = buildCompressedAxis([
      t0,
      t0 + 1000,
      t0 + 1000 + 10 * 60 * MIN,
    ]);
    expect(axis.points[1].comp - axis.points[0].comp).toBe(TIMELINE_FLOOR_MS);
    expect(axis.points[2].comp - axis.points[1].comp).toBe(TIMELINE_CAP_MS);
  });

  it("marks intervals above the idle threshold as idle bands", () => {
    const t0 = Date.parse("2026-07-30T08:00:00.000Z");
    const axis = buildCompressedAxis([t0, t0 + TIMELINE_IDLE_GAP_MS + 1000]);
    expect(axis.idleBands).toHaveLength(1);
    expect(axis.idleBands[0].ms).toBe(TIMELINE_IDLE_GAP_MS + 1000);
  });

  it("handles empty input without throwing", () => {
    const axis = buildCompressedAxis([]);
    expect(axis.compTotal).toBe(0);
    expect(axis.xOf(123)).toBe(0);
  });
});

describe("layoutStoryline", () => {
  it("places timestamped milestones per lane and leaves untimed facts unpositioned", () => {
    const layout = layoutStoryline(base);
    expect(layout.lanes).toHaveLength(2);
    expect(layout.lanes[0].placed.map((p) => p.milestone.id)).toEqual([
      "session/a",
      "turn/a/1",
    ]);
    expect(layout.unpositioned.map((m) => m.id)).toEqual(["turn/c/1"]);
  });

  it("draws curves only for factual edges whose endpoints are placed", () => {
    const layout = layoutStoryline(base);
    expect(layout.curves.map((c) => c.connector.kind)).toEqual(["forkedFrom"]);
    expect(layout.uncurved.map((c) => c.kind)).toEqual([
      "resumedFrom",
      "handoffTo",
    ]);
    expect(layout.curves[0].path.startsWith("M ")).toBe(true);
  });

  it("always labels structural kinds and throttles dense turn labels", () => {
    const t0 = Date.parse("2026-07-30T08:00:00.000Z");
    const dense: StorylineViewModel = {
      lanes: [
        {
          id: "session/a",
          label: "a",
          milestones: [
            milestone("session/a", new Date(t0).toISOString(), "session"),
            milestone(
              "turn/a/1",
              new Date(t0 + 60 * 1000).toISOString(),
              "turn",
              1
            ),
            milestone(
              "turn/a/2",
              new Date(t0 + 60 * 1000).toISOString(),
              "turn",
              2
            ),
            milestone(
              "checkpoint/a/1",
              new Date(t0 + 60 * 1000).toISOString(),
              "checkpoint"
            ),
          ],
          gaps: [],
        },
      ],
      connectors: [],
      unpositioned: [],
    };
    const layout = layoutStoryline(dense);
    const placed = layout.lanes[0].placed;
    const labeled = placed
      .filter((p) => p.showLabel)
      .map((p) => p.milestone.id);
    expect(labeled).toContain("checkpoint/a/1");
    // Session + first turn labeled; dense second turn throttled (all within the floor gap).
    expect(labeled).toContain("session/a");
    expect(labeled).toContain("turn/a/1");
    // Same-timestamp turn after a labeled turn is throttled; checkpoint stays labeled.
    expect(labeled).not.toContain("turn/a/2");
    expect(labeled).toContain("checkpoint/a/1");
  });

  it("flags a stale lane with a fade tail", () => {
    const layout = layoutStoryline(base);
    const b = layout.lanes.find((l) => l.lane.id === "session/b");
    // a's last milestone (08:05) is ~4h before the newest fact (b at 12:00) -> stale.
    expect(layout.lanes[0].fadeTail).toBe(true);
    expect(b?.fadeTail).toBe(false);
  });

  it("positions milestones consistently with the axis mapping", () => {
    const layout = layoutStoryline(base);
    const first = layout.lanes[0].placed[0];
    expect(first.x).toBeGreaterThanOrEqual(PAD_LEFT);
    expect(layout.lanes[1].y - layout.lanes[0].y).toBe(LANE_HEIGHT);
    expect(layout.lanes[0].y).toBe(PAD_TOP);
  });
});

describe("formatting", () => {
  it("formats durations compactly", () => {
    expect(formatDuration(45 * MIN)).toBe("45m");
    expect(formatDuration(3 * 60 * MIN)).toBe("3h");
    expect(formatDuration(26 * 60 * MIN)).toBe("1d 2h");
  });

  it("formats ticks without throwing", () => {
    expect(formatTick(Date.parse("2026-07-30T08:05:00.000Z"))).toMatch(
      /\d+\/\d+ \d+:\d+/
    );
  });
});

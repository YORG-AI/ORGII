import { describe, expect, it } from "vitest";

import type {
  TurnModifiedFile,
  TurnSummary,
} from "@src/engines/SessionCore/storage/sqliteCache";

import {
  MIN_TIMELINE_BAR_RATIO,
  projectSessionChanges,
  projectSessionTimeline,
} from "./sessionViewProjections";

function file(
  path: string,
  overrides: Partial<TurnModifiedFile> = {}
): TurnModifiedFile {
  return {
    path,
    fileName: path.split("/").pop() ?? path,
    status: "modified",
    additions: 0,
    deletions: 0,
    ...overrides,
  };
}

function turn(overrides: Partial<TurnSummary> = {}): TurnSummary {
  return {
    sessionId: "s-1",
    turnId: "t-1",
    startSequence: 0,
    endSequence: 1,
    nextTurnId: null,
    startedAt: "2026-07-28T10:00:00.000Z",
    endedAt: "2026-07-28T10:00:10.000Z",
    durationMs: 10_000,
    userEventIds: [],
    userPreview: "do a thing",
    eventCount: 3,
    bodyEventCount: 2,
    status: "completed",
    interrupted: false,
    modifiedFiles: [],
    resourceInteractions: [],
    gitArtifacts: [],
    ...overrides,
  };
}

describe("projectSessionTimeline", () => {
  it("lays bars out against the session's own wall-clock span", () => {
    const { rows, totalMs } = projectSessionTimeline([
      turn({
        turnId: "a",
        startedAt: "2026-07-28T10:00:00.000Z",
        endedAt: "2026-07-28T10:00:30.000Z",
      }),
      turn({
        turnId: "b",
        startedAt: "2026-07-28T10:00:30.000Z",
        endedAt: "2026-07-28T10:01:00.000Z",
      }),
    ]);

    expect(totalMs).toBe(60_000);
    expect(rows[0].offsetRatio).toBe(0);
    expect(rows[0].widthRatio).toBeCloseTo(0.5);
    expect(rows[1].offsetRatio).toBeCloseTo(0.5);
    expect(rows[1].widthRatio).toBeCloseTo(0.5);
  });

  it("floors a zero-length turn to a still-visible bar", () => {
    const { rows } = projectSessionTimeline([
      turn({
        turnId: "a",
        startedAt: "2026-07-28T10:00:00.000Z",
        endedAt: "2026-07-28T10:00:00.000Z",
        durationMs: 0,
      }),
      turn({
        turnId: "b",
        startedAt: "2026-07-28T10:00:00.000Z",
        endedAt: "2026-07-28T10:10:00.000Z",
      }),
    ]);

    expect(rows[0].widthRatio).toBe(MIN_TIMELINE_BAR_RATIO);
  });

  it("never lets a floored bar overflow the track", () => {
    // A zero-length turn at the very end would otherwise start at ratio 1.0
    // and still claim the minimum width, painting past the right edge.
    const { rows } = projectSessionTimeline([
      turn({
        turnId: "a",
        startedAt: "2026-07-28T10:00:00.000Z",
        endedAt: "2026-07-28T10:10:00.000Z",
      }),
      turn({
        turnId: "b",
        startedAt: "2026-07-28T10:10:00.000Z",
        endedAt: "2026-07-28T10:10:00.000Z",
        durationMs: 0,
      }),
    ]);

    const last = rows[rows.length - 1];
    expect(last.offsetRatio + last.widthRatio).toBeLessThanOrEqual(1);
  });

  it("derives an open turn's end from its duration", () => {
    const { rows } = projectSessionTimeline([
      turn({
        turnId: "a",
        startedAt: "2026-07-28T10:00:00.000Z",
        endedAt: null,
        durationMs: 5_000,
        status: "working",
      }),
    ]);

    expect(rows[0].durationMs).toBe(5_000);
    expect(rows[0].endedAtMs).toBe(Date.parse("2026-07-28T10:00:05.000Z"));
    expect(rows[0].endInferred).toBe(false);
  });

  it("keeps a known zero-length turn instead of presenting its duration as missing", () => {
    const { rows } = projectSessionTimeline([
      turn({
        endedAt: "2026-07-28T10:00:00.000Z",
        durationMs: null,
      }),
    ]);

    expect(rows[0].durationMs).toBe(0);
    expect(rows[0].endedAtMs).toBe(rows[0].startedAtMs);
  });

  it("bounds a closed historical turn by the next turn when its end metadata is absent", () => {
    const { rows } = projectSessionTimeline([
      turn({
        turnId: "missing-end",
        endedAt: null,
        durationMs: null,
      }),
      turn({
        turnId: "next",
        startedAt: "2026-07-28T10:00:35.000Z",
        endedAt: null,
        durationMs: null,
      }),
    ]);

    expect(rows[0].durationMs).toBe(35_000);
    expect(rows[0].endedAtMs).toBe(Date.parse("2026-07-28T10:00:35.000Z"));
    expect(rows[0].endInferred).toBe(true);
    expect(rows[1].durationMs).toBeNull();
    expect(rows[1].endedAtMs).toBeNull();
  });

  it("skips turns with an unparseable start rather than collapsing the span", () => {
    const { rows, totalMs } = projectSessionTimeline([
      turn({ turnId: "bad", startedAt: "not-a-date" }),
      turn({
        turnId: "good",
        startedAt: "2026-07-28T10:00:00.000Z",
        endedAt: "2026-07-28T10:00:20.000Z",
      }),
    ]);

    expect(rows.map((row) => row.turnId)).toEqual(["good"]);
    expect(totalMs).toBe(20_000);
  });

  it("returns an empty timeline for a session with no timed turns", () => {
    expect(projectSessionTimeline([])).toEqual({ rows: [], totalMs: 0 });
  });
});

describe("projectSessionChanges", () => {
  it("sums a path's line stats across every turn that touched it", () => {
    const { files, totalAdditions, totalDeletions } = projectSessionChanges([
      turn({
        turnId: "a",
        modifiedFiles: [file("src/a.ts", { additions: 10, deletions: 2 })],
      }),
      turn({
        turnId: "b",
        modifiedFiles: [file("src/a.ts", { additions: 5, deletions: 1 })],
      }),
    ]);

    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      path: "src/a.ts",
      additions: 15,
      deletions: 3,
      turnCount: 2,
      firstTurnId: "a",
    });
    expect(totalAdditions).toBe(15);
    expect(totalDeletions).toBe(3);
  });

  it("orders by total churn so the busiest files lead", () => {
    const { files } = projectSessionChanges([
      turn({
        modifiedFiles: [
          file("small.ts", { additions: 1 }),
          file("big.ts", { additions: 40, deletions: 10 }),
          file("mid.ts", { additions: 12 }),
        ],
      }),
    ]);

    expect(files.map((entry) => entry.path)).toEqual([
      "big.ts",
      "mid.ts",
      "small.ts",
    ]);
  });

  it("keeps the session-level status when a path is created then modified", () => {
    const { files } = projectSessionChanges([
      turn({ modifiedFiles: [file("new.ts", { status: "created" })] }),
      turn({ modifiedFiles: [file("new.ts", { status: "modified" })] }),
    ]);

    expect(files[0].status).toBe("created");
  });

  it("lets a delete anywhere in the session win", () => {
    const { files } = projectSessionChanges([
      turn({ modifiedFiles: [file("gone.ts", { status: "created" })] }),
      turn({ modifiedFiles: [file("gone.ts", { status: "deleted" })] }),
      turn({ modifiedFiles: [file("gone.ts", { status: "modified" })] }),
    ]);

    expect(files[0].status).toBe("deleted");
  });

  it("returns nothing for a session that wrote no files", () => {
    expect(projectSessionChanges([turn()])).toEqual({
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
    });
  });
});

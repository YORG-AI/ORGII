import { describe, expect, it } from "vitest";

import { projectCloudTurnSummaries } from "../cloudTurnSummaryProjection";

describe("projectCloudTurnSummaries", () => {
  it("maps cloud turn rows into TurnSummary metadata", () => {
    const turns = projectCloudTurnSummaries("session-1", [
      {
        turnId: "turn-a",
        prompt: "Fix the bug",
        eventCount: 4,
        bodyEventCount: 3,
        startedAt: "2026-01-01T00:00:00.000Z",
        endedAt: "2026-01-01T00:01:00.000Z",
        durationMs: 60_000,
        nextTurnId: "turn-b",
      },
    ]);

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      sessionId: "session-1",
      turnId: "turn-a",
      userPreview: "Fix the bug",
      eventCount: 4,
      bodyEventCount: 3,
      status: "completed",
      modifiedFiles: [],
    });
  });

  it("returns an empty list for no cloud turns", () => {
    expect(projectCloudTurnSummaries("session-1", [])).toEqual([]);
  });
});

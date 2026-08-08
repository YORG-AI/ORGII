import { describe, expect, it } from "vitest";

import type { Session } from "@src/store/session";

import {
  continuationLineagesForRevealedSessions,
  isRosterSiblingOfRevealedContinuation,
} from "../continuationVisibility";

function session(sessionId: string, continuationLineageId?: string): Session {
  return {
    session_id: sessionId,
    status: "completed",
    created_at: "2026-08-05T00:00:00.000Z",
    updated_at: "2026-08-05T00:00:00.000Z",
    continuationLineageId,
  };
}

describe("continuationLineagesForRevealedSessions", () => {
  it("returns only lineages owned by explicitly revealed rows", () => {
    expect(
      continuationLineagesForRevealedSessions(
        [
          session("active-old", "lineage-a"),
          session("roster-new", "lineage-a"),
          session("unrelated", "lineage-b"),
          session("legacy-without-lineage"),
        ],
        new Set(["active-old", "legacy-without-lineage"])
      )
    ).toEqual(new Set(["lineage-a"]));
  });

  it("hides the roster winner but keeps the explicitly revealed sibling", () => {
    const revealedIds = new Set(["active-old"]);
    const revealedLineages = new Set(["lineage-a"]);

    expect(
      isRosterSiblingOfRevealedContinuation(
        session("roster-new", "lineage-a"),
        revealedIds,
        revealedLineages
      )
    ).toBe(true);
    expect(
      isRosterSiblingOfRevealedContinuation(
        session("active-old", "lineage-a"),
        revealedIds,
        revealedLineages
      )
    ).toBe(false);
    expect(
      isRosterSiblingOfRevealedContinuation(
        session("unrelated", "lineage-b"),
        revealedIds,
        revealedLineages
      )
    ).toBe(false);
  });
});

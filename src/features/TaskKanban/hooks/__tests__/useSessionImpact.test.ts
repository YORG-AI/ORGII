import { describe, expect, it } from "vitest";

import type { CoreSessionSummary } from "@src/api/tauri/lineage";
import type { Session } from "@src/store/session";

import {
  impactFromSummaries,
  sessionImpactRosterKey,
} from "../useSessionImpact";

function summary(
  sessionId: string,
  overrides: Partial<CoreSessionSummary> = {}
): CoreSessionSummary {
  return {
    sessionId,
    filesChanged: 4,
    linesAdded: 40,
    linesRemoved: 10,
    relatedCommits: 2,
    committedRatePercent: 50,
    ...overrides,
  } as CoreSessionSummary;
}

function session(sessionId: string): Session {
  return { session_id: sessionId } as Session;
}

describe("impactFromSummaries", () => {
  it("keeps only the sessions the board can render", () => {
    const impact = impactFromSummaries(
      [summary("visible"), summary("archived-1"), summary("archived-2")],
      new Set(["visible"])
    );
    expect([...impact.keys()]).toEqual(["visible"]);
  });

  it("derives committed files from the committed rate", () => {
    const impact = impactFromSummaries(
      [summary("visible", { filesChanged: 10, committedRatePercent: 45 })],
      new Set(["visible"])
    );
    expect(impact.get("visible")).toMatchObject({
      filesChanged: 10,
      linesAdded: 40,
      linesRemoved: 10,
      relatedCommits: 2,
      committedFiles: 5,
      committedRatePercent: 45,
    });
  });

  it("returns an empty map when nothing is visible", () => {
    expect(impactFromSummaries([summary("archived")], new Set()).size).toBe(0);
  });
});

describe("sessionImpactRosterKey", () => {
  it("is stable across reordering so a re-render does not refetch", () => {
    expect(sessionImpactRosterKey([session("b"), session("a")])).toBe(
      sessionImpactRosterKey([session("a"), session("b")])
    );
  });

  it("changes when membership swaps at the same roster size", () => {
    expect(sessionImpactRosterKey([session("a"), session("b")])).not.toBe(
      sessionImpactRosterKey([session("a"), session("c")])
    );
  });

  it("is empty for an empty roster", () => {
    expect(sessionImpactRosterKey([])).toBe("");
  });
});

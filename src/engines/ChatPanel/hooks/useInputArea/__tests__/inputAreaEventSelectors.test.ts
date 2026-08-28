import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import { extractPlanMentionSource } from "../inputAreaEventSelectors";

function createPlanEvent(
  planPath: string,
  title: string,
  id = planPath
): SessionEvent {
  return {
    id,
    chunk_id: id,
    sessionId: "session-1",
    createdAt: "2026-06-18T00:00:00.000Z",
    functionName: "plan_approval",
    uiCanonical: "plan_approval",
    actionType: "plan_approval",
    args: {
      title,
      content: "plan body",
      planPath,
      planId: `plan-${id}`,
      planRevisionId: id,
    },
    result: { status: "pending", planRevisionId: id },
    source: "assistant",
    displayText: title,
    displayStatus: "awaiting_user",
    displayVariant: "tool_call",
    activityStatus: "agent",
    callId: id,
  } as SessionEvent;
}

describe("extractPlanMentionSource", () => {
  it("returns empty array when there are no plan events", () => {
    expect(extractPlanMentionSource([])).toEqual([]);
  });

  it("returns the most recent unique plan paths up to four entries", () => {
    const events = [
      createPlanEvent("/a/plan-1.md", "Plan 1", "e1"),
      createPlanEvent("/a/plan-2.md", "Plan 2", "e2"),
      createPlanEvent("/a/plan-1.md", "Plan 1 duplicate", "e3"),
      createPlanEvent("/a/plan-3.md", "Plan 3", "e4"),
      createPlanEvent("/a/plan-4.md", "Plan 4", "e5"),
      createPlanEvent("/a/plan-5.md", "Plan 5", "e6"),
    ];

    expect(extractPlanMentionSource(events)).toEqual([
      { planPath: "/a/plan-5.md", title: "Plan 5" },
      { planPath: "/a/plan-4.md", title: "Plan 4" },
      { planPath: "/a/plan-3.md", title: "Plan 3" },
      { planPath: "/a/plan-1.md", title: "Plan 1 duplicate" },
    ]);
  });
});

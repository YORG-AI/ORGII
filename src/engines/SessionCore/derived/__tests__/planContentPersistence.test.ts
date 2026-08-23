import { describe, expect, it, vi } from "vitest";

import type {
  PendingPlanApproval,
  PlanApprovalStateMap,
} from "@src/store/session/planApprovalAtom";

import type { SessionEvent } from "../../core/types";
import {
  applyEditedContentToPlanArgs,
  buildPlanContentPatches,
  persistEditedPlanContent,
  resolvePlanMarkdownContent,
  updatePendingPlanContent,
} from "../planContentPersistence";

function createPlanEvent(overrides: Partial<SessionEvent> = {}): SessionEvent {
  return {
    id: "rev-1",
    chunk_id: "rev-1",
    sessionId: "s1",
    createdAt: "2026-06-18T00:00:00.000Z",
    functionName: "plan_approval",
    uiCanonical: "plan_approval",
    actionType: "plan_approval",
    args: {
      title: "My Plan",
      content: "original",
      planPath: "/tmp/plan.md",
      planId: "plan-s1-plan",
      planRevisionId: "rev-1",
    },
    result: { status: "pending", planRevisionId: "rev-1" },
    source: "assistant",
    displayText: "My Plan",
    displayStatus: "awaiting_user",
    displayVariant: "tool_call",
    activityStatus: "agent",
    callId: "rev-1",
    ...overrides,
  } as SessionEvent;
}

function createPendingState(
  overrides: Partial<PendingPlanApproval> = {}
): PlanApprovalStateMap {
  const pending: PendingPlanApproval = {
    sessionId: "s1",
    planPath: "/tmp/plan.md",
    planTitle: "My Plan",
    planContent: "original",
    toolCallId: "rev-1",
    planId: "plan-s1-plan",
    planRevisionId: "rev-1",
    ...overrides,
  };
  return new Map([["s1", { current: pending }]]);
}

describe("resolvePlanMarkdownContent", () => {
  it("prefers the pending snapshot when the event matches the active approval", () => {
    const event = createPlanEvent({
      args: { content: "stale event body", streamContent: "stale event body" },
    });
    const pending = createPendingState({
      planContent: "edited via save",
    }).get("s1")?.current;
    expect(resolvePlanMarkdownContent(event, pending)).toBe("edited via save");
  });

  it("falls back to event args when there is no matching pending plan", () => {
    const event = createPlanEvent({
      args: { streamContent: "from stream", content: "from content" },
    });
    expect(resolvePlanMarkdownContent(event, null)).toBe("from stream");
  });

  it("falls back to event args when the pending plan is for a different revision", () => {
    const event = createPlanEvent({
      id: "rev-2",
      chunk_id: "rev-2",
      args: {
        content: "event body",
        planId: "plan-s1-other",
        planRevisionId: "rev-2",
      },
      result: {
        status: "pending",
        planRevisionId: "rev-2",
        planId: "plan-s1-other",
      },
      callId: "rev-2",
    });
    const pending = createPendingState({
      planRevisionId: "rev-1",
      toolCallId: "rev-1",
      planId: "plan-s1-plan",
      planContent: "other plan",
    }).get("s1")?.current;
    expect(resolvePlanMarkdownContent(event, pending)).toBe("event body");
  });
});

describe("applyEditedContentToPlanArgs", () => {
  it("sets both content and streamContent while preserving identity fields", () => {
    const merged = applyEditedContentToPlanArgs(
      { title: "T", planPath: "/p.md", content: "old", streamContent: "old" },
      "new body"
    );
    expect(merged).toEqual({
      title: "T",
      planPath: "/p.md",
      content: "new body",
      streamContent: "new body",
    });
  });

  it("tolerates null / non-object args", () => {
    expect(applyEditedContentToPlanArgs(null, "x")).toEqual({
      content: "x",
      streamContent: "x",
    });
    expect(applyEditedContentToPlanArgs(undefined, "y")).toEqual({
      content: "y",
      streamContent: "y",
    });
  });
});

describe("buildPlanContentPatches", () => {
  it("returns an empty list when there are no pending aliases", () => {
    const events = [createPlanEvent()];
    expect(buildPlanContentPatches(events, [], "new")).toEqual([]);
  });

  it("patches only plan display events whose aliases intersect the pending plan", () => {
    const matching = createPlanEvent({ id: "rev-1" });
    const otherPlan = createPlanEvent({
      id: "rev-2",
      chunk_id: "rev-2",
      args: { content: "x", planRevisionId: "rev-2" },
      result: { status: "pending", planRevisionId: "rev-2" },
      callId: "rev-2",
    });
    const nonPlan = {
      ...createPlanEvent({ id: "msg-1", chunk_id: "msg-1" }),
      functionName: "message",
      uiCanonical: "message",
      actionType: "message",
    } as SessionEvent;

    const patches = buildPlanContentPatches(
      [matching, otherPlan, nonPlan],
      ["rev-1"],
      "edited"
    );

    expect(patches).toHaveLength(1);
    expect(patches[0].id).toBe("rev-1");
    expect(patches[0].args.content).toBe("edited");
    expect(patches[0].args.streamContent).toBe("edited");
    // Identity fields are preserved.
    expect(patches[0].args.planPath).toBe("/tmp/plan.md");
  });

  it("matches a create_plan event via its revision alias", () => {
    const createPlan = createPlanEvent({
      id: "tool-call-rev-9",
      functionName: "create_plan",
      uiCanonical: "create_plan",
      actionType: "tool_call",
      args: {
        title: "P",
        streamContent: "draft",
        planRevisionId: "rev-9",
        planId: "plan-s1-p",
      },
      result: { status: "pending", planRevisionId: "rev-9" },
      callId: "rev-9",
    });
    const patches = buildPlanContentPatches([createPlan], ["rev-9"], "edited");
    expect(patches).toHaveLength(1);
    expect(patches[0].args.streamContent).toBe("edited");
  });
});

describe("updatePendingPlanContent", () => {
  it("updates the pending snapshot content immutably", () => {
    const prev = createPendingState();
    const next = updatePendingPlanContent(prev, "s1", "edited");
    expect(next).not.toBe(prev);
    expect(next.get("s1")?.current?.planContent).toBe("edited");
    // Original map is untouched.
    expect(prev.get("s1")?.current?.planContent).toBe("original");
  });

  it("returns the same map when nothing is pending for the session", () => {
    const prev: PlanApprovalStateMap = new Map();
    expect(updatePendingPlanContent(prev, "s1", "edited")).toBe(prev);
  });

  it("returns the same map when content is unchanged", () => {
    const prev = createPendingState({ planContent: "same" });
    expect(updatePendingPlanContent(prev, "s1", "same")).toBe(prev);
  });
});

describe("persistEditedPlanContent", () => {
  function createIO(events: SessionEvent[]) {
    return {
      persistPendingContent: vi.fn().mockResolvedValue(true),
      getEvents: vi.fn().mockResolvedValue(events),
      patchEvent: vi.fn().mockResolvedValue(undefined),
      saveCache: vi.fn().mockResolvedValue(0),
    };
  }

  it("persists the backend snapshot before patching matching events and cache", async () => {
    const io = createIO([createPlanEvent()]);
    const order: string[] = [];
    io.persistPendingContent.mockImplementation(async () => {
      order.push("backend");
    });
    io.patchEvent.mockImplementation(async () => {
      order.push("patch");
    });
    io.saveCache.mockImplementation(async () => {
      order.push("cache");
    });

    await persistEditedPlanContent({
      sessionId: "s1",
      planRevisionId: "rev-1",
      pendingAliases: ["rev-1"],
      content: "edited body",
      io,
    });

    expect(io.persistPendingContent).toHaveBeenCalledWith(
      "s1",
      "edited body",
      "rev-1"
    );
    expect(io.patchEvent).toHaveBeenCalledTimes(1);
    expect(io.patchEvent).toHaveBeenCalledWith(
      "rev-1",
      expect.objectContaining({ content: "edited body" }),
      "s1"
    );
    expect(order).toEqual(["backend", "patch", "cache"]);
  });

  it("persists through the backend even when no revision id is available", async () => {
    const io = createIO([createPlanEvent()]);
    await persistEditedPlanContent({
      sessionId: "s1",
      pendingAliases: ["rev-1"],
      content: "edited",
      io,
    });
    expect(io.persistPendingContent).toHaveBeenCalledWith(
      "s1",
      "edited",
      undefined
    );
    expect(io.patchEvent).toHaveBeenCalledTimes(1);
  });

  it("does not flush cache when no events matched", async () => {
    const io = createIO([createPlanEvent()]);
    await persistEditedPlanContent({
      sessionId: "s1",
      planRevisionId: "rev-1",
      pendingAliases: ["does-not-match"],
      content: "edited",
      io,
    });
    expect(io.patchEvent).not.toHaveBeenCalled();
    expect(io.saveCache).not.toHaveBeenCalled();
  });

  it("swallows cache flush failures (durability nicety only)", async () => {
    const io = createIO([createPlanEvent()]);
    io.saveCache.mockRejectedValue(new Error("disk full"));
    await expect(
      persistEditedPlanContent({
        sessionId: "s1",
        planRevisionId: "rev-1",
        pendingAliases: ["rev-1"],
        content: "edited",
        io,
      })
    ).resolves.toBeUndefined();
  });
});

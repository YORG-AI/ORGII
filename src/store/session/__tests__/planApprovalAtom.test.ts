import { describe, expect, it } from "vitest";

import type {
  PendingPlanApproval,
  PlanApprovalStateMap,
} from "../planApprovalAtom";
import {
  clearPendingPlanApproval,
  normalizePlanCallId,
  rehydratePendingPlanApprovalIfNewer,
  upsertPendingPlanApproval,
} from "../planApprovalAtom";

function makePlan(
  overrides: Partial<PendingPlanApproval> = {}
): PendingPlanApproval {
  return {
    sessionId: "session-1",
    planPath: "/tmp/plan.md",
    planTitle: "Plan",
    planContent: "body",
    toolCallId: "call_1",
    planRevisionId: "call_1",
    originToolCallId: "call_1",
    planId: "plan-1",
    autoApproveAt: null,
    ...overrides,
  };
}

function emptyMap(): PlanApprovalStateMap {
  return new Map();
}

function mapWithPlan(plan: PendingPlanApproval): PlanApprovalStateMap {
  return upsertPendingPlanApproval(emptyMap(), plan);
}

// ─── normalizePlanCallId ─────────────────────────────────────────────────────

describe("normalizePlanCallId", () => {
  it("strips the tool-call- prefix", () => {
    expect(normalizePlanCallId("tool-call-abc")).toBe("abc");
  });

  it("returns the value unchanged when there is no prefix", () => {
    expect(normalizePlanCallId("abc")).toBe("abc");
  });

  it("returns empty string for undefined", () => {
    expect(normalizePlanCallId(undefined)).toBe("");
  });

  it("returns empty string for empty string", () => {
    expect(normalizePlanCallId("")).toBe("");
  });
});

// ─── upsertPendingPlanApproval ───────────────────────────────────────────────

describe("upsertPendingPlanApproval", () => {
  it("inserts into an empty map", () => {
    const plan = makePlan();
    const next = upsertPendingPlanApproval(emptyMap(), plan);
    expect(next.get("session-1")?.current).toBe(plan);
  });

  it("always overwrites an existing revision (live push supersedes)", () => {
    const old = makePlan({ planRevisionId: "call_1", toolCallId: "call_1" });
    const newer = makePlan({ planRevisionId: "call_2", toolCallId: "call_2" });
    const prev = mapWithPlan(old);
    const next = upsertPendingPlanApproval(prev, newer);
    expect(next.get("session-1")?.current?.planRevisionId).toBe("call_2");
  });

  it("returns a new Map instance (immutability)", () => {
    const plan = makePlan();
    const prev = emptyMap();
    const next = upsertPendingPlanApproval(prev, plan);
    expect(next).not.toBe(prev);
  });
});

// ─── rehydratePendingPlanApprovalIfNewer ─────────────────────────────────────

describe("rehydratePendingPlanApprovalIfNewer", () => {
  it("inserts when the slot is empty", () => {
    const plan = makePlan();
    const next = rehydratePendingPlanApprovalIfNewer(emptyMap(), plan);
    expect(next.get("session-1")?.current).toBe(plan);
  });

  it("updates when the existing revision matches the incoming revision", () => {
    const existing = makePlan({
      planRevisionId: "call_1",
      planContent: "old body",
    });
    const incoming = makePlan({
      planRevisionId: "call_1",
      planContent: "refreshed body",
    });
    const prev = mapWithPlan(existing);
    const next = rehydratePendingPlanApprovalIfNewer(prev, incoming);
    expect(next.get("session-1")?.current?.planContent).toBe("refreshed body");
  });

  it("does NOT overwrite a live push with a stale rehydrate (different revision)", () => {
    // Simulate: live WS push set R2, then stale cold-start RPC resolves with R1
    const livePush = makePlan({
      planRevisionId: "call_2",
      toolCallId: "call_2",
      planTitle: "Newer plan",
      planContent: "newer body",
    });
    const staleSnapshot = makePlan({
      planRevisionId: "call_1",
      toolCallId: "call_1",
      planTitle: "Old plan",
      planContent: "old body",
    });
    const prev = mapWithPlan(livePush);
    const next = rehydratePendingPlanApprovalIfNewer(prev, staleSnapshot);
    // Must preserve the live push, not downgrade to the stale snapshot
    expect(next).toBe(prev);
    expect(next.get("session-1")?.current?.planRevisionId).toBe("call_2");
    expect(next.get("session-1")?.current?.planTitle).toBe("Newer plan");
  });

  it("does NOT overwrite when ids differ only by tool-call- prefix", () => {
    const livePush = makePlan({
      planRevisionId: "call_2",
      toolCallId: "call_2",
    });
    const staleSnapshot = makePlan({
      planRevisionId: "tool-call-call_1",
      toolCallId: "tool-call-call_1",
    });
    const prev = mapWithPlan(livePush);
    const next = rehydratePendingPlanApprovalIfNewer(prev, staleSnapshot);
    expect(next).toBe(prev);
  });

  it("writes when existing slot has no revision id (degenerate snapshot)", () => {
    const noId = makePlan({ planRevisionId: undefined, toolCallId: undefined });
    const incoming = makePlan({ planRevisionId: "call_1" });
    const prev = mapWithPlan(noId);
    const next = rehydratePendingPlanApprovalIfNewer(prev, incoming);
    expect(next.get("session-1")?.current?.planRevisionId).toBe("call_1");
  });

  it("does not affect other sessions", () => {
    const s1Plan = makePlan({
      sessionId: "session-1",
      planRevisionId: "call_2",
    });
    const s2IncomingPlan = makePlan({
      sessionId: "session-2",
      planRevisionId: "call_s2",
    });
    const prev = mapWithPlan(s1Plan);
    const next = rehydratePendingPlanApprovalIfNewer(prev, s2IncomingPlan);
    expect(next.get("session-1")?.current?.planRevisionId).toBe("call_2");
    expect(next.get("session-2")?.current?.planRevisionId).toBe("call_s2");
  });
});

// ─── clearPendingPlanApproval ────────────────────────────────────────────────

describe("clearPendingPlanApproval", () => {
  it("clears the current plan when toolCallId matches planRevisionId", () => {
    const plan = makePlan({ planRevisionId: "call_1", toolCallId: "call_1" });
    const prev = mapWithPlan(plan);
    const next = clearPendingPlanApproval(prev, "session-1", "call_1");
    expect(next.get("session-1")?.current).toBeNull();
  });

  it("clears the current plan when toolCallId matches with tool-call- prefix", () => {
    const plan = makePlan({ planRevisionId: "call_1", toolCallId: "call_1" });
    const prev = mapWithPlan(plan);
    const next = clearPendingPlanApproval(
      prev,
      "session-1",
      "tool-call-call_1"
    );
    expect(next.get("session-1")?.current).toBeNull();
  });

  it("does NOT clear when a newer revision (R2) is live and an old id (R1) arrives", () => {
    // Simulate: R2 is pending, plan_approval_archived for R1 arrives
    const livePlan = makePlan({
      planRevisionId: "call_2",
      toolCallId: "call_2",
      originToolCallId: "call_2",
    });
    const prev = mapWithPlan(livePlan);
    const next = clearPendingPlanApproval(prev, "session-1", "call_1");
    // R1's archive must NOT clear R2
    expect(next).toBe(prev);
    expect(next.get("session-1")?.current?.planRevisionId).toBe("call_2");
  });

  it("clears unconditionally when toolCallId is omitted", () => {
    const plan = makePlan();
    const prev = mapWithPlan(plan);
    const next = clearPendingPlanApproval(prev, "session-1");
    expect(next.get("session-1")?.current).toBeNull();
  });

  it("returns prev unchanged for an unknown session", () => {
    const plan = makePlan({ sessionId: "session-1" });
    const prev = mapWithPlan(plan);
    const next = clearPendingPlanApproval(prev, "session-99", "call_1");
    expect(next).toBe(prev);
  });

  it("returns prev unchanged when session has no current plan", () => {
    const prev = new Map([["session-1", { current: null }]]);
    const next = clearPendingPlanApproval(prev, "session-1", "call_1");
    expect(next).toBe(prev);
  });
});

// ─── Rehydrate-vs-live integration scenario ──────────────────────────────────

describe("rehydrate race: live push then stale cold-start snapshot", () => {
  it("preserves the live R2 revision when stale R1 snapshot arrives later", () => {
    const r2 = makePlan({
      planRevisionId: "call_2",
      toolCallId: "call_2",
      planTitle: "Revised plan",
      planContent: "revised body",
    });
    const r1Snapshot = makePlan({
      planRevisionId: "call_1",
      toolCallId: "call_1",
      planTitle: "Original plan",
      planContent: "original body",
    });

    // Step 1: live WS push sets R2
    let state = upsertPendingPlanApproval(emptyMap(), r2);
    expect(state.get("session-1")?.current?.planRevisionId).toBe("call_2");

    // Step 2: stale cold-start RPC resolves with R1 — must be ignored
    state = rehydratePendingPlanApprovalIfNewer(state, r1Snapshot);
    expect(state.get("session-1")?.current?.planRevisionId).toBe("call_2");
    expect(state.get("session-1")?.current?.planTitle).toBe("Revised plan");
  });

  it("accepts the snapshot when no live push arrived first (empty slot)", () => {
    const r1Snapshot = makePlan({
      planRevisionId: "call_1",
      toolCallId: "call_1",
    });

    // No live push — slot is empty, rehydrate should populate it
    const state = rehydratePendingPlanApprovalIfNewer(emptyMap(), r1Snapshot);
    expect(state.get("session-1")?.current?.planRevisionId).toBe("call_1");
  });

  it("accepts the snapshot when it matches the live revision (content refresh)", () => {
    const initial = makePlan({
      planRevisionId: "call_1",
      planContent: "original",
    });
    const refreshed = makePlan({
      planRevisionId: "call_1",
      planContent: "refreshed",
    });

    let state = upsertPendingPlanApproval(emptyMap(), initial);
    state = rehydratePendingPlanApprovalIfNewer(state, refreshed);
    expect(state.get("session-1")?.current?.planContent).toBe("refreshed");
  });
});

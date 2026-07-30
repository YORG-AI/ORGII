import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type AgentOrgPlanApproval,
  type AgentOrgPlanApprovalSummary,
  getAgentOrgPlanApprovalDetail,
} from "@src/api/tauri/agent";

import { agentOrgPlanApprovalDetailCacheTestApi } from "./useAgentOrgPlanApprovalDetail";

vi.mock("@src/api/tauri/agent", () => ({
  getAgentOrgPlanApprovalDetail: vi.fn(),
}));

const mockedGetDetail = vi.mocked(getAgentOrgPlanApprovalDetail);

function approvalSummary(): AgentOrgPlanApprovalSummary {
  return {
    approvalId: "approval-1",
    planRevisionId: "revision-1",
    requestId: "request-1",
    orgRunId: "run-1",
    sourceTaskId: "task-1",
    sourceMemberId: "planner",
    sourceSessionId: "planner-session",
    rootSessionId: "root-session",
    policy: "user",
    status: "pending",
    planTitle: "Implementation plan",
    planContentBytes: 17,
    createdAt: "2026-07-16T00:00:00Z",
  };
}

function approvalDetail(): AgentOrgPlanApproval {
  const summary = approvalSummary();
  return {
    ...summary,
    planPath: "/tmp/plan.md",
    planContent: "Build the feature.",
  };
}

describe("Agent Org plan approval detail cache", () => {
  beforeEach(() => {
    agentOrgPlanApprovalDetailCacheTestApi.reset();
    mockedGetDetail.mockReset();
  });

  afterEach(() => {
    agentOrgPlanApprovalDetailCacheTestApi.reset();
  });

  it("coalesces concurrent loads for the same immutable revision", async () => {
    let resolveRequest: ((detail: AgentOrgPlanApproval) => void) | undefined;
    mockedGetDetail.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve;
        })
    );
    const approval = approvalSummary();

    const firstLoad = agentOrgPlanApprovalDetailCacheTestApi.load(
      "root-session",
      approval
    );
    const secondLoad = agentOrgPlanApprovalDetailCacheTestApi.load(
      "root-session",
      { ...approval }
    );

    expect(mockedGetDetail).toHaveBeenCalledTimes(1);
    resolveRequest?.(approvalDetail());
    await Promise.all([firstLoad, secondLoad]);
    expect(
      agentOrgPlanApprovalDetailCacheTestApi.getSnapshot(approval).detail
        ?.planContent
    ).toBe("Build the feature.");
  });

  it("reuses a cached revision without refetching on rerender", async () => {
    mockedGetDetail.mockResolvedValue(approvalDetail());
    const approval = approvalSummary();

    await agentOrgPlanApprovalDetailCacheTestApi.load("root-session", approval);
    await agentOrgPlanApprovalDetailCacheTestApi.load("root-session", {
      ...approval,
    });

    expect(mockedGetDetail).toHaveBeenCalledTimes(1);
    expect(
      agentOrgPlanApprovalDetailCacheTestApi.getSnapshot(approval)
    ).toMatchObject({ loading: false, error: null });
  });

  it("exposes a failed load and lets retry issue a fresh request", async () => {
    mockedGetDetail
      .mockRejectedValueOnce(new Error("detail unavailable"))
      .mockResolvedValueOnce(approvalDetail());
    const approval = approvalSummary();

    await agentOrgPlanApprovalDetailCacheTestApi.load("root-session", approval);
    expect(
      agentOrgPlanApprovalDetailCacheTestApi.getSnapshot(approval)
    ).toMatchObject({
      detail: null,
      error: "detail unavailable",
      loading: false,
    });

    await agentOrgPlanApprovalDetailCacheTestApi.load(
      "root-session",
      approval,
      true
    );
    expect(mockedGetDetail).toHaveBeenCalledTimes(2);
    expect(
      agentOrgPlanApprovalDetailCacheTestApi.getSnapshot(approval)
    ).toMatchObject({ detail: approvalDetail(), error: null, loading: false });
  });

  it("evicts inactive immutable revisions at the hard entry bound", async () => {
    mockedGetDetail.mockImplementation(
      async ({ approvalId, planRevisionId }) => ({
        ...approvalDetail(),
        approvalId,
        planRevisionId,
      })
    );

    for (
      let index = 0;
      index < agentOrgPlanApprovalDetailCacheTestApi.limits.entries + 20;
      index += 1
    ) {
      await agentOrgPlanApprovalDetailCacheTestApi.load("root-session", {
        ...approvalSummary(),
        approvalId: `approval-${index}`,
        planRevisionId: `revision-${index}`,
      });
    }

    const stats = agentOrgPlanApprovalDetailCacheTestApi.stats();
    expect(stats.entries).toBeLessThanOrEqual(
      agentOrgPlanApprovalDetailCacheTestApi.limits.entries
    );
    expect(stats.bytes).toBeLessThanOrEqual(
      agentOrgPlanApprovalDetailCacheTestApi.limits.bytes
    );
  });
});

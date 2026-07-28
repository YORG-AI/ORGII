import { describe, expect, it } from "vitest";

import type { AgentOrgRunView } from "@src/api/tauri/agent";

import { interventionForSession } from "./useAgentOrgIntervention";

function runView(): AgentOrgRunView {
  return {
    context: {
      runId: "run-1",
      orgId: "org-1",
      orgName: "Test org",
      orgRole: "Test",
      coordinatorAgentId: "agent-coordinator",
      coordinatorName: "Coordinator",
      coordinatorRole: "Lead",
      members: [],
      hierarchyMode: "flat",
      planApprovalPolicy: "coordinator",
      rootSessionId: "session-root",
    },
    runStatus: "running",
    runPhase: "coordinating",
    currentMemberId: "coordinator",
    members: [
      {
        memberId: "coordinator",
        name: "Coordinator",
        role: "Lead",
        agentId: "agent-coordinator",
        isCoordinator: true,
        sessionRuntime: {
          sessionId: "session-root",
          status: "running",
          updatedAt: "2026-07-18T00:00:00Z",
        },
        intervention: null,
        unreadInboxCount: 0,
        inboxActivityCount: 0,
        activeTaskCount: 0,
        pendingTaskCount: 0,
        inProgressTaskCount: 0,
        completedTaskCount: 0,
      },
      {
        memberId: "worker",
        name: "Worker",
        role: "Build",
        agentId: "agent-worker",
        isCoordinator: false,
        sessionRuntime: {
          sessionId: "session-worker",
          status: "idle",
          updatedAt: "2026-07-18T00:00:00Z",
        },
        intervention: {
          orgRunId: "run-1",
          memberId: "worker",
          agentId: "agent-worker",
          sessionId: "session-worker",
          status: "user_intervention",
          reason: "direct message",
          enteredAt: "2026-07-18T00:00:00Z",
          lastUserActivityAt: "2026-07-18T00:00:00Z",
          resumeAfter: "2026-07-18T00:03:00Z",
        },
        unreadInboxCount: 0,
        inboxActivityCount: 0,
        activeTaskCount: 0,
        pendingTaskCount: 0,
        inProgressTaskCount: 0,
        completedTaskCount: 0,
      },
    ],
    tasks: [],
    taskOverview: {
      total: 0,
      pending: 0,
      inProgress: 0,
      completed: 0,
      corrupt: 0,
      visible: 0,
      truncated: false,
    },
    inbox: [],
    unreadInboxCount: 0,
    pendingPlanApprovals: [],
  };
}

describe("Agent Org intervention projection", () => {
  it("uses the matching run-view member instead of a second endpoint read", () => {
    const view = runView();
    expect(interventionForSession(view, "session-worker")).toEqual(
      view.members[1].intervention
    );
    expect(interventionForSession(view, "session-root")).toBeNull();
    expect(interventionForSession(view, "unrelated-session")).toBeNull();
  });
});

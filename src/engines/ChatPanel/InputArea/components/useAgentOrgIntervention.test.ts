// @vitest-environment jsdom
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentOrgRunView, ReturnToWorkResult } from "@src/api/tauri/agent";

import {
  interventionForSession,
  useAgentOrgIntervention,
} from "./useAgentOrgIntervention";

const agentMocks = vi.hoisted(() => ({
  cancelSession: vi.fn(),
  returnAgentOrgSessionToWork: vi.fn(),
}));

vi.mock("@src/api/tauri/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@src/api/tauri/agent")>()),
  ...agentMocks,
}));

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
        writerCapable: true,
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
        queuedUserDirectedCount: 0,
      },
      {
        memberId: "worker",
        name: "Worker",
        role: "Build",
        agentId: "agent-worker",
        isCoordinator: false,
        writerCapable: false,
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
          interventionReceiptId: "intervention-1",
          status: "active",
          sourceEventId: "event-1",
          queuedUserDirectedCount: 0,
          enteredAt: "2026-07-18T00:00:00Z",
          lastUserActivityAt: "2026-07-18T00:00:00Z",
        },
        unreadInboxCount: 0,
        inboxActivityCount: 0,
        activeTaskCount: 0,
        pendingTaskCount: 0,
        inProgressTaskCount: 0,
        completedTaskCount: 0,
        queuedUserDirectedCount: 0,
      },
    ],
    tasks: [],
    taskOverview: {
      total: 0,
      pending: 0,
      inProgress: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      corrupt: 0,
      visible: 0,
      truncated: false,
    },
    inbox: [],
    unreadInboxCount: 0,
    pendingPlanApprovals: [],
  };
}

type HookResult = ReturnType<typeof useAgentOrgIntervention>;

function HookProbe({
  refreshRunView,
  onResult,
}: {
  refreshRunView: () => Promise<void>;
  onResult: (result: HookResult) => void;
}) {
  const result = useAgentOrgIntervention(
    "session-worker",
    runView(),
    refreshRunView
  );
  useEffect(() => onResult(result), [onResult, result]);
  return null;
}

afterEach(() => {
  vi.clearAllMocks();
  document.body.replaceChildren();
});

describe("Agent Org intervention projection", () => {
  it("uses the matching run-view member instead of a second endpoint read", () => {
    const view = runView();
    expect(interventionForSession(view, "session-worker")).toEqual(
      view.members[1].intervention
    );
    expect(interventionForSession(view, "session-root")).toBeNull();
    expect(interventionForSession(view, "unrelated-session")).toBeNull();
  });

  it("returns the durable outcome without waiting for projection refresh", async () => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    let finishRefresh: (() => void) | undefined;
    const refreshRunView = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRefresh = resolve;
        })
    );
    const durableResult: ReturnToWorkResult = {
      outcome: "restored_task",
      appliedOutcome: "restored_task",
      hadOriginalFormalWork: true,
      interventionReceiptId: "intervention-1",
      requestId: "return-request-1",
      clearedRevision: 1,
      clearedAt: "2026-07-18T00:01:00Z",
      continuationTurnIntentId: "continuation-1",
    };
    agentMocks.returnAgentOrgSessionToWork.mockResolvedValue(durableResult);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let hookResult: HookResult | null = null;
    const onResult = (result: HookResult) => {
      hookResult = result;
    };
    await act(async () => {
      root.render(
        createElement(HookProbe, {
          refreshRunView,
          onResult,
        })
      );
    });

    let result: ReturnToWorkResult | null = null;
    await act(async () => {
      result = (await hookResult?.returnToWork()) ?? null;
    });

    expect(result).toEqual(durableResult);
    expect(refreshRunView).toHaveBeenCalledTimes(1);
    expect(finishRefresh).toBeTypeOf("function");

    finishRefresh?.();
    await act(async () => {
      await Promise.resolve();
      root.unmount();
    });
  });
});

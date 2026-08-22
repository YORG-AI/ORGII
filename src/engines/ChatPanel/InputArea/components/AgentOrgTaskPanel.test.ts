// @vitest-environment jsdom
import React, { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type {
  AgentOrgRunView,
  AgentOrgTask,
  AgentOrgTaskAnnotationPage,
  AgentOrgTaskStatus,
} from "@src/api/tauri/agent";

import AgentOrgOverviewPanel from "./AgentOrgOverviewPanel";
import { AgentOrgTaskList } from "./AgentOrgTaskList";

const mocks = vi.hoisted(() => ({
  getPage: vi.fn(),
  getDetail: vi.fn(),
  getAnnotations: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("jotai", () => ({ useSetAtom: () => vi.fn() }));
vi.mock("@src/store/session", () => ({ activeSessionIdAtom: {} }));
vi.mock("@src/hooks/logger", () => ({
  createLogger: () => ({ error: vi.fn() }),
}));
vi.mock("@src/hooks/ui", () => ({
  useRefreshSpin: (callback: () => Promise<void>) => ({
    spinClass: "",
    handleClick: callback,
  }),
}));

vi.mock("@src/api/tauri/agent", () => ({
  AGENT_ORG_RUN_PHASE: {
    COORDINATING: "coordinating",
    FINALIZING: "finalizing",
    DRAINING: "draining",
  },
  AGENT_ORG_TASK_STATUS: {
    PENDING: "pending",
    IN_PROGRESS: "in_progress",
    COMPLETED: "completed",
    FAILED: "failed",
    CANCELLED: "cancelled",
  },
  isAgentOrgTaskTerminalStatus: (status: string) =>
    status === "completed" || status === "failed" || status === "cancelled",
  agentOrgTaskStatusSatisfiesDependency: (status: string) =>
    status === "completed",
  getAgentOrgTaskPage: mocks.getPage,
  getAgentOrgTaskDetail: mocks.getDetail,
  getAgentOrgTaskAnnotationPage: mocks.getAnnotations,
  pauseAgentOrgRun: mocks.pause,
  resumeAgentOrgRun: mocks.resume,
}));

vi.mock("@src/components/Button", () => ({
  default: (props: Record<string, unknown>) =>
    createElement(
      "button",
      {
        type: "button",
        disabled: props.disabled as boolean | undefined,
        onClick: props.onClick as (() => void) | undefined,
        "aria-label": props["aria-label"] as string | undefined,
        "data-testid": props["data-testid"] as string | undefined,
      },
      props.children as React.ReactNode
    ),
}));

vi.mock("./ComposerStackHeader", () => ({
  default: ({
    label,
    onToggle,
    actions,
    badges,
  }: {
    label: string;
    onToggle: () => void;
    actions?: React.ReactNode;
    badges?: React.ReactNode;
  }) =>
    createElement(
      "div",
      null,
      createElement("button", { type: "button", onClick: onToggle }, label),
      badges,
      actions
    ),
  ComposerStackHeaderCountBadge: ({
    children,
  }: {
    children: React.ReactNode;
  }) => createElement("span", null, children),
}));

vi.mock("./AgentOrgPlanApprovalCard", () => ({ default: () => null }));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

function task(id: string, status: AgentOrgTaskStatus): AgentOrgTask {
  return {
    id,
    orgRunId: "run-task-panel",
    subject: `Task ${id}`,
    description: `Description ${id}`,
    owner: "member-a",
    status,
    blocks: [],
    blockedBy: [],
    executionMode: "build",
    createdAt: "2026-08-20T00:00:00Z",
    updatedAt: "2026-08-20T00:01:00Z",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function runView(): AgentOrgRunView {
  return {
    context: {
      runId: "run-task-panel",
      orgId: "org-task-panel",
      orgName: "Task Panel Team",
      orgRole: "lead",
      coordinatorAgentId: "coordinator-agent",
      coordinatorName: "Coordinator",
      coordinatorRole: "lead",
      members: [],
      planApprovalPolicy: "coordinator",
      rootSessionId: "root-session",
    },
    runStatus: "running",
    runPhase: "coordinating",
    members: [],
    tasks: [task("pending", "pending"), task("active", "in_progress")],
    taskOverview: {
      total: 5,
      pending: 1,
      inProgress: 1,
      completed: 1,
      failed: 1,
      cancelled: 1,
      corrupt: 0,
      visible: 2,
      truncated: false,
    },
    inbox: [],
    unreadInboxCount: 0,
    pendingPlanApprovals: [],
  };
}

describe("Agent Org Task panel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.getPage.mockReset();
    mocks.getDetail.mockReset();
    mocks.getAnnotations.mockReset();
    mocks.pause.mockReset();
    mocks.resume.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("does not read History until expansion and requests one filtered page at a time", async () => {
    mocks.getPage
      .mockResolvedValueOnce({
        bucket: "history",
        status: "completed",
        tasks: [task("done", "completed")],
        hasMore: false,
      })
      .mockResolvedValueOnce({
        bucket: "history",
        status: "failed",
        tasks: [
          {
            ...task("failed", "failed"),
            failureReason: {
              code: "execution.failed",
              message: "provider failed",
            },
          },
        ],
        hasMore: false,
      });

    await act(async () => {
      root.render(
        createElement(AgentOrgOverviewPanel, {
          view: runView(),
          error: null,
          currentSessionId: "root-session",
          onRefresh: vi.fn().mockResolvedValue(undefined),
        })
      );
    });
    expect(mocks.getPage).not.toHaveBeenCalled();
    expect(
      container.querySelectorAll('[data-testid="agent-org-overview-task-row"]')
    ).toHaveLength(2);

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="agent-org-task-history-toggle"]'
        )
        ?.click();
    });
    expect(mocks.getPage).toHaveBeenNthCalledWith(1, {
      sessionId: "root-session",
      bucket: "history",
      status: "completed",
      cursor: undefined,
      direction: "forward",
    });
    expect(
      container.querySelector(
        '[data-task-id="done"][data-task-status="completed"]'
      )
    ).not.toBeNull();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="agent-org-task-history-filter-failed"]'
        )
        ?.click();
    });
    expect(mocks.getPage).toHaveBeenCalledTimes(2);
    expect(mocks.getPage).toHaveBeenLastCalledWith({
      sessionId: "root-session",
      bucket: "history",
      status: "failed",
      cursor: undefined,
      direction: "forward",
    });
  });

  it("shows Paused draining immediately and keeps Resume enabled", async () => {
    mocks.resume.mockResolvedValue({
      requestId: "resume-request",
      runId: "run-task-panel",
      episodeId: "episode-a",
      transitioned: true,
      resumeGeneration: 3,
      continuationCount: 2,
      skippedCount: 0,
    });
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const view: AgentOrgRunView = {
      ...runView(),
      runStatus: "paused",
      runPhase: "draining",
      pauseHandoff: {
        episodeId: "episode-a",
        pauseGeneration: 2,
        totalCount: 2,
        drainingCount: 2,
        timedOutCount: 0,
      },
    };
    await act(async () => {
      root.render(
        createElement(AgentOrgOverviewPanel, {
          view,
          error: null,
          currentSessionId: "root-session",
          onRefresh,
        })
      );
    });
    const phase = container.querySelector<HTMLElement>(
      '[data-testid="agent-org-overview-run-phase"]'
    );
    expect(phase?.dataset.runPhase).toBe("draining");
    expect(phase?.textContent).toContain(
      "planner.agentOrgOverview.phase.draining"
    );
    const resume = container.querySelector<HTMLButtonElement>(
      '[data-testid="agent-org-overview-resume-button"]'
    );
    expect(resume?.disabled).toBe(false);
    await act(async () => {
      resume?.click();
    });
    expect(mocks.resume).toHaveBeenCalledWith("root-session");
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("discards a late History response after switching teams", async () => {
    const oldPage = deferred<{
      bucket: "history";
      status: "completed";
      tasks: AgentOrgTask[];
      hasMore: boolean;
    }>();
    mocks.getPage.mockReturnValueOnce(oldPage.promise).mockResolvedValueOnce({
      bucket: "history",
      status: "completed",
      tasks: [task("new-team-done", "completed")],
      hasMore: false,
    });

    await act(async () => {
      root.render(
        createElement(AgentOrgOverviewPanel, {
          view: runView(),
          error: null,
          currentSessionId: "old-session",
          onRefresh: vi.fn().mockResolvedValue(undefined),
        })
      );
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="agent-org-task-history-toggle"]'
        )
        ?.click();
    });

    await act(async () => {
      root.render(
        createElement(AgentOrgOverviewPanel, {
          view: runView(),
          error: null,
          currentSessionId: "new-session",
          onRefresh: vi.fn().mockResolvedValue(undefined),
        })
      );
    });
    await act(async () => {
      oldPage.resolve({
        bucket: "history",
        status: "completed",
        tasks: [task("old-team-done", "completed")],
        hasMore: false,
      });
      await oldPage.promise;
    });
    expect(
      container.querySelector('[data-task-id="old-team-done"]')
    ).toBeNull();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="agent-org-task-history-toggle"]'
        )
        ?.click();
    });
    expect(mocks.getPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: "new-session" })
    );
    expect(
      container.querySelector('[data-task-id="new-team-done"]')
    ).not.toBeNull();
  });

  it("renders all five states and loads output plus annotations only on detail expansion", async () => {
    const completed = {
      ...task("done", "completed"),
      outputSummary: {
        summary: "bounded summary",
        artifactIds: [],
        artifactIdsTruncated: false,
        hasContent: true,
      },
    };
    mocks.getDetail.mockResolvedValue({
      ...completed,
      output: {
        summary: "bounded summary",
        content: "full output body",
        artifactIds: [],
        producedByMemberId: "member-a",
        producedAt: "2026-08-20T00:01:00Z",
      },
    });
    mocks.getAnnotations
      .mockResolvedValueOnce({
        annotations: [
          {
            id: "note-1",
            orgRunId: "run-task-panel",
            taskId: "done",
            kind: "audit_note",
            body: "reviewed after completion",
            actorKind: "graph_writer",
            actorParticipantId: "coordinator",
            createdAt: "2026-08-20T00:02:00Z",
          },
        ],
        hasMore: true,
        nextCursor: "note-cursor-1",
      })
      .mockResolvedValueOnce({
        annotations: [
          {
            id: "note-2",
            orgRunId: "run-task-panel",
            taskId: "done",
            kind: "evidence",
            body: "second annotation page",
            actorKind: "owner_execution",
            actorParticipantId: "member-a",
            createdAt: "2026-08-20T00:03:00Z",
          },
        ],
        hasMore: false,
      });

    await act(async () => {
      root.render(
        createElement(AgentOrgTaskList, {
          tasks: [
            {
              ...task("pending", "pending"),
              blockedBy: ["completed-outside-page"],
              dependenciesSatisfied: true,
            },
            task("active", "in_progress"),
            completed,
            {
              ...task("failed", "failed"),
              failureReason: {
                code: "execution.failed",
                message: "failed reason",
              },
            },
            {
              ...task("cancelled", "cancelled"),
              cancelReason: { code: "scope.changed", message: "cancel reason" },
            },
          ],
          listTestId: "task-list",
          rowTestId: "task-row",
          currentSessionId: "root-session",
        })
      );
    });
    expect(
      Array.from(container.querySelectorAll('[data-testid="task-row"]')).map(
        (row) => row.getAttribute("data-task-status")
      )
    ).toEqual(["pending", "in_progress", "completed", "failed", "cancelled"]);
    expect(
      container
        .querySelector('[data-task-id="pending"]')
        ?.getAttribute("data-task-blocked")
    ).toBe("false");
    expect(mocks.getDetail).not.toHaveBeenCalled();
    expect(mocks.getAnnotations).not.toHaveBeenCalled();

    const doneRow = container.querySelector<HTMLElement>(
      '[data-task-id="done"]'
    );
    await act(async () => {
      doneRow
        ?.querySelector<HTMLButtonElement>(
          '[data-testid="agent-org-task-detail-toggle"]'
        )
        ?.click();
    });
    expect(mocks.getDetail).toHaveBeenCalledTimes(1);
    expect(mocks.getAnnotations).toHaveBeenCalledTimes(1);
    expect(doneRow?.textContent).toContain("full output body");
    expect(doneRow?.textContent).toContain("reviewed after completion");

    await act(async () => {
      doneRow
        ?.querySelector<HTMLButtonElement>(
          '[data-testid="agent-org-task-annotations-load-more"]'
        )
        ?.click();
    });
    expect(mocks.getAnnotations).toHaveBeenLastCalledWith({
      sessionId: "root-session",
      taskId: "done",
      cursor: "note-cursor-1",
    });
    expect(doneRow?.textContent).toContain("second annotation page");
  });

  it("discards late detail and annotation responses after switching teams", async () => {
    const oldDetail = deferred<AgentOrgTask>();
    const oldAnnotations = deferred<AgentOrgTaskAnnotationPage>();
    const completed = task("shared-task-id", "completed");
    mocks.getDetail
      .mockReturnValueOnce(oldDetail.promise)
      .mockResolvedValueOnce({
        ...completed,
        output: {
          summary: "new team output",
          artifactIds: [],
          producedByMemberId: "member-a",
          producedAt: "2026-08-20T00:04:00Z",
        },
      });
    mocks.getAnnotations
      .mockReturnValueOnce(oldAnnotations.promise)
      .mockResolvedValueOnce({ annotations: [], hasMore: false });

    await act(async () => {
      root.render(
        createElement(AgentOrgTaskList, {
          tasks: [completed],
          listTestId: "task-list",
          rowTestId: "task-row",
          currentSessionId: "old-session",
        })
      );
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="agent-org-task-detail-toggle"]'
        )
        ?.click();
    });

    await act(async () => {
      root.render(
        createElement(AgentOrgTaskList, {
          tasks: [completed],
          listTestId: "task-list",
          rowTestId: "task-row",
          currentSessionId: "new-session",
        })
      );
    });
    await act(async () => {
      oldDetail.resolve({
        ...completed,
        output: {
          summary: "old team output",
          artifactIds: [],
          producedByMemberId: "member-a",
          producedAt: "2026-08-20T00:02:00Z",
        },
      });
      oldAnnotations.resolve({ annotations: [], hasMore: false });
      await Promise.all([oldDetail.promise, oldAnnotations.promise]);
    });
    expect(container.textContent).not.toContain("old team output");

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="agent-org-task-detail-toggle"]'
        )
        ?.click();
    });
    expect(mocks.getDetail).toHaveBeenLastCalledWith({
      sessionId: "new-session",
      taskId: "shared-task-id",
    });
    expect(container.textContent).toContain("new team output");
  });
});

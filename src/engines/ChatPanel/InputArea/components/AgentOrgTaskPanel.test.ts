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
  AgentOrgTaskExecutionHandoffReceipt,
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
  archive: vi.fn(),
  deleteTeam: vi.fn(),
  requestHandoff: vi.fn(),
  resolveHandoff: vi.fn(),
  confirmDestructive: vi.fn(),
  applyDeleteReceipt: vi.fn(),
  evictSession: vi.fn(),
  goToNewSession: vi.fn(),
  removeSession: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("jotai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("jotai")>()),
  useSetAtom: () => vi.fn(),
}));
vi.mock("@src/store/session", () => ({
  activeSessionIdAtom: {},
  removeSession: mocks.removeSession,
}));
vi.mock("@src/hooks/navigation/useAppNavigation", () => ({
  useAppNavigation: () => ({ goToNewSession: mocks.goToNewSession }),
}));
vi.mock("@src/store/workstation/tabs", () => ({
  clearPendingFileOpensForSession: vi.fn(),
  disposeWorkstationWorkspaceAtom: {},
}));
vi.mock("@src/store/workstation/tabs/pendingCodeEditorTab", () => ({
  clearPendingCodeEditorTabForSession: vi.fn(),
}));
vi.mock("@src/features/TeamCollaboration/forkSession", () => ({
  removeForkRelayEntry: vi.fn(),
}));
vi.mock("@src/engines/SessionCore/core/store/EventStoreProxy", () => ({
  eventStoreProxy: { evictSession: mocks.evictSession },
}));
vi.mock(
  "@src/scaffold/NavigationSidebar/connectors/rustSessionDeleteReceipt",
  () => ({ applyRustSessionDeleteReceipt: mocks.applyDeleteReceipt })
);
vi.mock("@src/util/dialogs/confirmDestructiveAction", () => ({
  confirmDestructiveAction: mocks.confirmDestructive,
}));
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
  archiveAgentOrgRun: mocks.archive,
  deleteAgentOrgTeam: mocks.deleteTeam,
  requestAgentOrgTaskHandoff: mocks.requestHandoff,
  resolveAgentOrgTaskHandoff: mocks.resolveHandoff,
}));

vi.mock("@src/components/Checkbox", () => ({
  default: ({
    checked,
    disabled,
    onCheckedChange,
    children,
  }: {
    checked?: boolean;
    disabled?: boolean;
    onCheckedChange?: (checked: boolean) => void;
    children?: React.ReactNode;
  }) =>
    createElement(
      "label",
      null,
      createElement("input", {
        type: "checkbox",
        checked,
        disabled,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
          onCheckedChange?.(event.target.checked),
      }),
      children
    ),
}));

vi.mock("@src/components/Select", () => ({
  default: ({
    value,
    disabled,
    onChange,
    options = [],
    dataTestId,
    ariaLabel,
  }: {
    value?: string | number;
    disabled?: boolean;
    onChange?: (value: string | number) => void;
    options?: Array<{ value: string | number; label: React.ReactNode }>;
    dataTestId?: string;
    ariaLabel?: string;
  }) =>
    createElement(
      "select",
      {
        value,
        disabled,
        "data-testid": dataTestId,
        "aria-label": ariaLabel,
        onChange: (event: React.ChangeEvent<HTMLSelectElement>) =>
          onChange?.(event.target.value),
      },
      options.map((option) =>
        createElement(
          "option",
          { key: String(option.value), value: option.value },
          option.label
        )
      )
    ),
}));

vi.mock("@src/scaffold/ModalSystem", () => ({
  default: ({
    visible,
    children,
    footer,
  }: {
    visible: boolean;
    children?: React.ReactNode;
    footer?: React.ReactNode;
  }) =>
    visible ? createElement("div", { role: "dialog" }, children, footer) : null,
}));

vi.mock("@src/components/Message", () => ({
  default: { error: vi.fn() },
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
    coordinatorWorkState: "inactive",
    completion: { state: "none" },
    executionHandoffs: [],
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
    blockingUnreadInboxCount: 0,
    planRevisions: [],
    formalActivity: {
      pendingCount: 0,
      materializedCount: 0,
      pendingReceiptIds: [],
      coordinatorObserving: false,
    },
  };
}

function handoffReceipt(
  overrides: Partial<AgentOrgTaskExecutionHandoffReceipt> = {}
): AgentOrgTaskExecutionHandoffReceipt {
  return {
    id: "handoff-receipt",
    orgRunId: "run-task-panel",
    activationGeneration: 1,
    requestId: "handoff-request",
    requestDigest: "a".repeat(64),
    oldTaskId: "active",
    oldOwnerMemberId: "member-a",
    oldSessionId: "member-session",
    oldTurnIntentId: "member-turn",
    runtimeLeaseId: "runtime-lease",
    dialogTurnGeneration: "dialog-generation",
    replacementTaskId: "replacement",
    state: "unknown",
    sloMissed: true,
    externalEffectUnknown: true,
    localEffectCount: 0,
    resolutionAttempt: 0,
    requestedAt: "2026-08-20T00:00:00Z",
    updatedAt: "2026-08-20T00:00:10Z",
    ...overrides,
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
    mocks.archive.mockReset();
    mocks.deleteTeam.mockReset();
    mocks.requestHandoff.mockReset();
    mocks.resolveHandoff.mockReset();
    mocks.confirmDestructive.mockReset();
    mocks.applyDeleteReceipt.mockReset();
    mocks.evictSession.mockReset();
    mocks.goToNewSession.mockReset();
    mocks.removeSession.mockReset();
    mocks.applyDeleteReceipt.mockResolvedValue(true);
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

  it("confirms a running Task cancellation through the trusted handoff command", async () => {
    mocks.requestHandoff.mockResolvedValue({
      task: task("active", "cancelled"),
      executionHandoff: handoffReceipt(),
    });
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    await act(async () => {
      root.render(
        createElement(AgentOrgOverviewPanel, {
          view: runView(),
          error: null,
          currentSessionId: "root-session",
          onRefresh,
        })
      );
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="agent-org-task-cancel-button"]'
        )
        ?.click();
    });
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="agent-org-task-handoff-confirm-button"]'
        )
        ?.click();
      await Promise.resolve();
    });
    expect(mocks.requestHandoff).toHaveBeenCalledWith({
      sessionId: "root-session",
      requestId: expect.any(String),
      taskId: "active",
      action: "cancel",
      replacementOwnerMemberId: null,
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("closes Cancel after durable acceptance while execution shutdown remains slow", async () => {
    const slowRefresh = deferred<void>();
    const receipt = handoffReceipt({ state: "yielding" });
    mocks.requestHandoff.mockResolvedValue({
      task: task("active", "cancelled"),
      executionHandoff: receipt,
    });
    const onRefresh = vi.fn(() => slowRefresh.promise);
    await act(async () => {
      root.render(
        createElement(AgentOrgOverviewPanel, {
          view: runView(),
          error: null,
          currentSessionId: "root-session",
          onRefresh,
        })
      );
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="agent-org-task-cancel-button"]'
        )
        ?.click();
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="agent-org-task-handoff-confirm-button"]'
        )
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    await act(async () => {
      root.render(
        createElement(AgentOrgOverviewPanel, {
          view: {
            ...runView(),
            tasks: [task("pending", "pending")],
            executionHandoffs: [receipt],
          },
          error: null,
          currentSessionId: "root-session",
          onRefresh,
        })
      );
    });
    expect(
      container
        .querySelector('[data-testid="agent-org-task-handoff-status"]')
        ?.getAttribute("data-handoff-state")
    ).toBe("yielding");
    expect(container.textContent).toContain(
      "planner.agentOrgTasks.handoffStopping"
    );
    await act(async () => slowRefresh.resolve(undefined));
  });

  it("reassigns only to a canonical non-Coordinator Member selected in the dialog", async () => {
    mocks.requestHandoff.mockResolvedValue({
      task: task("active", "cancelled"),
      replacement: task("replacement", "pending"),
      executionHandoff: handoffReceipt(),
    });
    const view: AgentOrgRunView = {
      ...runView(),
      context: {
        ...runView().context,
        members: [
          {
            memberId: "member-a",
            name: "Builder",
            role: "Build",
            agentId: "agent-a",
          },
          {
            memberId: "member-b",
            name: "Tester",
            role: "Test",
            agentId: "agent-b",
          },
        ],
      },
    };
    await act(async () => {
      root.render(
        createElement(AgentOrgOverviewPanel, {
          view,
          error: null,
          currentSessionId: "root-session",
          onRefresh: vi.fn().mockResolvedValue(undefined),
        })
      );
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="agent-org-task-reassign-button"]'
        )
        ?.click();
    });
    const owner = container.querySelector<HTMLSelectElement>(
      '[data-testid="agent-org-task-reassign-owner-select"]'
    );
    expect(
      Array.from(owner?.options ?? []).map((option) => option.value)
    ).toEqual(["member-a", "member-b"]);
    await act(async () => {
      if (owner) {
        owner.value = "member-b";
        owner.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="agent-org-task-handoff-confirm-button"]'
        )
        ?.click();
      await Promise.resolve();
    });
    expect(mocks.requestHandoff).toHaveBeenCalledWith({
      sessionId: "root-session",
      requestId: expect.any(String),
      taskId: "active",
      action: "reassign",
      replacementOwnerMemberId: "member-b",
    });
  });

  it("routes all three uncertain handoff decisions through the receipt command", async () => {
    const receipt = handoffReceipt();
    mocks.resolveHandoff.mockResolvedValue(receipt);
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    await act(async () => {
      root.render(
        createElement(AgentOrgOverviewPanel, {
          view: { ...runView(), executionHandoffs: [receipt] },
          error: null,
          currentSessionId: "root-session",
          onRefresh,
        })
      );
    });

    for (const [testId, resolution] of [
      ["agent-org-handoff-continue-button", "continue_replacement"],
      ["agent-org-handoff-keep-stopped-button", "keep_stopped"],
      ["agent-org-handoff-abandon-button", "abandon_episode"],
    ] as const) {
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)
          ?.click();
      });
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="agent-org-handoff-resolution-confirm-button"]'
          )
          ?.click();
        await Promise.resolve();
      });
      expect(mocks.resolveHandoff).toHaveBeenLastCalledWith({
        sessionId: "root-session",
        requestId: expect.any(String),
        receiptId: receipt.id,
        resolution,
      });
    }
    expect(mocks.resolveHandoff).toHaveBeenCalledTimes(3);
    expect(onRefresh).toHaveBeenCalledTimes(3);
  });

  it.each([
    [
      "Continue replacement",
      "agent-org-handoff-continue-button",
      "continue_replacement",
    ],
    ["Keep stopped", "agent-org-handoff-keep-stopped-button", "keep_stopped"],
    ["Abandon episode", "agent-org-handoff-abandon-button", "abandon_episode"],
  ] as const)(
    "closes %s after durable acceptance while cleanup remains slow",
    async (_label, buttonTestId, resolution) => {
      const slowRefresh = deferred<void>();
      const unresolved = handoffReceipt({ state: "timeout" });
      const accepted = handoffReceipt({
        state: "timeout",
        resolutionRequestId: `request-${resolution}`,
        resolutionSessionId: "root-session",
        requestedResolution: resolution,
        resolutionAttempt: 1,
        resolutionRequestedAt: "2026-08-20T00:00:11Z",
      });
      mocks.resolveHandoff.mockResolvedValue(accepted);
      const onRefresh = vi.fn(() => slowRefresh.promise);
      await act(async () => {
        root.render(
          createElement(AgentOrgOverviewPanel, {
            view: { ...runView(), executionHandoffs: [unresolved] },
            error: null,
            currentSessionId: "root-session",
            onRefresh,
          })
        );
      });
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(`[data-testid="${buttonTestId}"]`)
          ?.click();
      });
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="agent-org-handoff-resolution-confirm-button"]'
          )
          ?.click();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(container.querySelector('[role="dialog"]')).toBeNull();

      await act(async () => {
        root.render(
          createElement(AgentOrgOverviewPanel, {
            view: { ...runView(), executionHandoffs: [accepted] },
            error: null,
            currentSessionId: "root-session",
            onRefresh,
          })
        );
      });
      const status = container.querySelector(
        '[data-testid="agent-org-task-handoff-status"]'
      );
      expect(status?.getAttribute("data-requested-resolution")).toBe(
        resolution
      );
      expect(status?.getAttribute("data-resolution-attempt")).toBe("1");
      expect(container.textContent).toContain(
        "planner.agentOrgTasks.handoffApplyingDecision"
      );
      expect(
        container.querySelector(
          '[data-testid="agent-org-handoff-continue-button"]'
        )
      ).toBeNull();
      expect(
        container.querySelector(
          '[data-testid="agent-org-handoff-keep-stopped-button"]'
        )
      ).toBeNull();
      expect(
        container.querySelector(
          '[data-testid="agent-org-handoff-abandon-button"]'
        )
      ).toBeNull();
      await act(async () => slowRefresh.resolve(undefined));
    }
  );

  it("blocks Continue while a local writer remains but leaves stop decisions available", async () => {
    const receipt = handoffReceipt({ localEffectCount: 1 });
    await act(async () => {
      root.render(
        createElement(AgentOrgOverviewPanel, {
          view: { ...runView(), executionHandoffs: [receipt] },
          error: null,
          currentSessionId: "root-session",
          onRefresh: vi.fn().mockResolvedValue(undefined),
        })
      );
    });
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="agent-org-handoff-continue-button"]'
      )?.disabled
    ).toBe(true);
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="agent-org-handoff-keep-stopped-button"]'
      )?.disabled
    ).toBe(false);
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="agent-org-handoff-abandon-button"]'
      )?.disabled
    ).toBe(false);
  });

  it("offers only the accepted decision when background cleanup needs a retry", async () => {
    const receipt = handoffReceipt({
      state: "failed",
      requestedResolution: "keep_stopped",
      resolutionRequestId: "resolution-request",
      resolutionSessionId: "root-session",
      resolutionAttempt: 1,
      resolutionRequestedAt: "2026-08-20T00:00:11Z",
    });
    await act(async () => {
      root.render(
        createElement(AgentOrgOverviewPanel, {
          view: { ...runView(), executionHandoffs: [receipt] },
          error: null,
          currentSessionId: "root-session",
          onRefresh: vi.fn().mockResolvedValue(undefined),
        })
      );
    });
    expect(container.textContent).toContain(
      "planner.agentOrgTasks.handoffDecisionFailed"
    );
    expect(
      container.querySelector(
        '[data-testid="agent-org-handoff-retry-decision-button"]'
      )
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="agent-org-handoff-keep-stopped-button"]'
      )
    ).toBeNull();
  });

  it("never labels all-terminal work Delivered without a certificate", async () => {
    const base = {
      ...runView(),
      runPhase: "finalizing" as const,
      tasks: [],
    };
    await act(async () => {
      root.render(
        createElement(AgentOrgOverviewPanel, {
          view: { ...base, completion: { state: "needs_attention" } },
          error: null,
          currentSessionId: "root-session",
          onRefresh: vi.fn().mockResolvedValue(undefined),
        })
      );
    });
    expect(
      container.querySelector('[data-testid="agent-org-overview-run-phase"]')
        ?.textContent
    ).toContain("planner.agentOrgOverview.needsAttention");
    expect(
      container
        .querySelector('[data-testid="agent-org-overview-run-phase"]')
        ?.getAttribute("data-completion-state")
    ).toBe("needs_attention");
    expect(
      container.querySelector('[data-testid="agent-org-overview-run-phase"]')
        ?.className
    ).toContain("text-warning-6");
    expect(container.textContent).not.toContain(
      "planner.agentOrgOverview.outcome.delivered"
    );

    await act(async () => {
      root.render(
        createElement(AgentOrgOverviewPanel, {
          view: {
            ...base,
            completion: {
              state: "certified",
              outcome: "delivered",
              certificateId: "certificate",
              workRevision: 7,
            },
          },
          error: null,
          currentSessionId: "root-session",
          onRefresh: vi.fn().mockResolvedValue(undefined),
        })
      );
    });
    expect(
      container.querySelector('[data-testid="agent-org-overview-run-phase"]')
        ?.textContent
    ).toContain("planner.agentOrgOverview.outcome.delivered");
    expect(
      container
        .querySelector('[data-testid="agent-org-overview-run-phase"]')
        ?.getAttribute("data-completion-outcome")
    ).toBe("delivered");
    expect(
      container.querySelector('[data-testid="agent-org-overview-run-phase"]')
        ?.className
    ).toContain("text-success-6");
    expect(
      container
        .querySelector('[data-testid="agent-org-coordinator-work-state"]')
        ?.getAttribute("data-coordinator-work-state")
    ).toBe("inactive");
  });

  it("shows Idle separately from the latest cancelled episode outcome", async () => {
    await act(async () => {
      root.render(
        createElement(AgentOrgOverviewPanel, {
          view: {
            ...runView(),
            runStatus: "idle",
            runPhase: "idle",
            completion: {
              state: "certified",
              outcome: "cancelled",
              certificateId: "cancelled-certificate",
              workRevision: 29,
            },
          },
          error: null,
          currentSessionId: "root-session",
          onRefresh: vi.fn().mockResolvedValue(undefined),
        })
      );
    });

    const badge = container.querySelector(
      '[data-testid="agent-org-overview-run-phase"]'
    );
    expect(badge?.textContent).toContain(
      "planner.agentOrgOverview.idleWithLatestOutcome"
    );
    expect(badge?.getAttribute("data-run-phase")).toBe("idle");
    expect(badge?.getAttribute("data-completion-outcome")).toBe("cancelled");
  });

  it("shows only actionable Inbox work instead of historical unread lifecycle rows", async () => {
    await act(async () => {
      root.render(
        createElement(AgentOrgOverviewPanel, {
          view: {
            ...runView(),
            unreadInboxCount: 8,
            blockingUnreadInboxCount: 0,
          },
          error: null,
          currentSessionId: "root-session",
          onRefresh: vi.fn().mockResolvedValue(undefined),
        })
      );
    });

    const inboxCount = container.querySelector(
      '[data-testid="agent-org-overview-inbox-count"]'
    );
    expect(inboxCount?.getAttribute("data-pending-inbox-count")).toBe("0");
    expect(inboxCount?.textContent).toContain(
      "planner.agentOrgOverview.pendingInboxCount"
    );
    expect(container.textContent).not.toContain(
      "planner.agentOrgOverview.unreadCount"
    );
  });

  it("projects only current direct activity without changing the Team phase", async () => {
    const view: AgentOrgRunView = {
      ...runView(),
      runStatus: "idle",
      runPhase: "idle",
      members: [
        {
          memberId: "member-active",
          name: "Active Member",
          role: "Build",
          agentId: "agent-active",
          isCoordinator: false,
          writerCapable: true,
          sessionRuntime: null,
          unreadInboxCount: 0,
          inboxActivityCount: 0,
          activeTaskCount: 0,
          pendingTaskCount: 0,
          inProgressTaskCount: 0,
          completedTaskCount: 0,
          queuedUserDirectedCount: 2,
          activity: {
            kind: "side_quest",
            source: "direct_member",
            interventionReceiptId: "receipt-active",
          },
          intervention: null,
        },
        {
          memberId: "member-cleared",
          name: "Cleared Member",
          role: "Review",
          agentId: "agent-returned",
          isCoordinator: false,
          writerCapable: false,
          sessionRuntime: null,
          unreadInboxCount: 0,
          inboxActivityCount: 0,
          activeTaskCount: 0,
          pendingTaskCount: 0,
          inProgressTaskCount: 0,
          completedTaskCount: 0,
          queuedUserDirectedCount: 0,
          activity: null,
          intervention: null,
        },
      ],
    };

    await act(async () => {
      root.render(
        createElement(AgentOrgOverviewPanel, {
          view,
          error: null,
          currentSessionId: "root-session",
          onRefresh: vi.fn().mockResolvedValue(undefined),
        })
      );
    });

    expect(
      container
        .querySelector('[data-testid="agent-org-overview-run-phase"]')
        ?.getAttribute("data-run-phase")
    ).toBe("idle");
    expect(
      container
        .querySelector(
          '[data-testid="agent-org-overview-member-activity-member-active"]'
        )
        ?.getAttribute("data-activity-kind")
    ).toBe("side_quest");
    expect(
      container.querySelector(
        '[data-testid="agent-org-overview-member-activity-member-cleared"]'
      )
    ).toBeNull();
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

  it("keeps the inverse Pause control locked through a Resume double-click", async () => {
    vi.useFakeTimers();
    try {
      mocks.resume.mockResolvedValue({
        requestId: "resume-request",
        runId: "run-task-panel",
        episodeId: "episode-a",
        transitioned: true,
        resumeGeneration: 3,
        continuationCount: 2,
        skippedCount: 0,
      });
      mocks.pause.mockResolvedValue({
        requestId: "pause-request",
        runId: "run-task-panel",
        episodeId: "episode-b",
        transitioned: true,
        pauseGeneration: 4,
        capturedCount: 0,
      });
      const onRefresh = vi.fn().mockResolvedValue(undefined);
      const render = (runStatus: AgentOrgRunView["runStatus"]) =>
        root.render(
          createElement(AgentOrgOverviewPanel, {
            view: { ...runView(), runStatus },
            error: null,
            currentSessionId: "root-session",
            onRefresh,
          })
        );

      await act(async () => render("paused"));
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="agent-org-overview-resume-button"]'
          )
          ?.click();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mocks.resume).toHaveBeenCalledTimes(1);

      await act(async () => render("running"));
      const pause = container.querySelector<HTMLButtonElement>(
        '[data-testid="agent-org-overview-pause-button"]'
      );
      expect(pause?.disabled).toBe(true);
      pause?.click();
      expect(mocks.pause).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(pause?.disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("warns that Working tasks are cancelled before Archive", async () => {
    mocks.confirmDestructive.mockResolvedValue(true);
    mocks.archive.mockResolvedValue({
      requestId: "archive-request",
      runId: "run-task-panel",
      receiptId: "archive-receipt",
      transitioned: true,
      archiveGeneration: 2,
      archivedAt: "2026-08-23T00:00:00Z",
      cancellations: {
        tasks: 1,
        turns: 1,
        inboxDeliveries: 0,
        planApprovals: 0,
        interventions: 0,
        pauseContinuations: 0,
      },
      teardown: {
        receiptId: "archive-receipt",
        status: "pending",
        attemptCount: 0,
        retainedRuntimeCount: 0,
        deadlineAt: "2026-08-23T00:01:00Z",
      },
    });
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    await act(async () => {
      root.render(
        createElement(AgentOrgOverviewPanel, {
          view: runView(),
          error: null,
          currentSessionId: "root-session",
          onRefresh,
        })
      );
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="agent-org-overview-archive-button"]'
        )
        ?.click();
    });
    expect(mocks.confirmDestructive).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "planner.agentOrgOverview.archiveWorkingWarning",
      })
    );
    expect(mocks.archive).toHaveBeenCalledWith("root-session");
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("shows Archive only for Idle, Working, Paused, and Failed Teams", async () => {
    mocks.getPage.mockResolvedValue({
      bucket: "history",
      status: "cancelled",
      tasks: [],
      hasMore: false,
    });
    for (const status of ["idle", "running", "paused", "failed"] as const) {
      await act(async () => {
        root.render(
          createElement(AgentOrgOverviewPanel, {
            view: { ...runView(), runStatus: status },
            error: null,
            currentSessionId: "root-session",
            onRefresh: vi.fn().mockResolvedValue(undefined),
          })
        );
      });
      expect(
        container.querySelector(
          '[data-testid="agent-org-overview-archive-button"]'
        )
      ).not.toBeNull();
    }
    for (const status of ["starting", "archived"] as const) {
      await act(async () => {
        root.render(
          createElement(AgentOrgOverviewPanel, {
            view: {
              ...runView(),
              runStatus: status,
              runPhase: status,
              archiveTeardown:
                status === "archived"
                  ? {
                      receiptId: "archive-receipt",
                      status: "retained_runtime",
                      attemptCount: 3,
                      retainedRuntimeCount: 1,
                      deadlineAt: "2026-08-23T00:01:00Z",
                    }
                  : undefined,
            },
            error: null,
            currentSessionId: "root-session",
            onRefresh: vi.fn().mockResolvedValue(undefined),
          })
        );
      });
      expect(
        container.querySelector(
          '[data-testid="agent-org-overview-archive-button"]'
        )
      ).toBeNull();
    }
  });

  it("keeps Team Delete blocked when Archive retained a runtime", async () => {
    mocks.getPage.mockResolvedValue({
      bucket: "history",
      status: "cancelled",
      tasks: [],
      hasMore: false,
    });
    await act(async () => {
      root.render(
        createElement(AgentOrgOverviewPanel, {
          view: {
            ...runView(),
            runStatus: "archived",
            runPhase: "archived",
            archiveTeardown: {
              receiptId: "archive-receipt",
              status: "retained_runtime",
              attemptCount: 3,
              retainedRuntimeCount: 2,
              deadlineAt: "2026-08-23T00:01:00Z",
            },
          },
          error: null,
          currentSessionId: "root-session",
          onRefresh: vi.fn().mockResolvedValue(undefined),
        })
      );
    });
    expect(
      container
        .querySelector('[data-testid="agent-org-archive-teardown-status"]')
        ?.getAttribute("data-teardown-status")
    ).toBe("retained_runtime");
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="agent-org-overview-delete-button"]'
      )?.disabled
    ).toBe(true);
  });

  it("opens Archived history by default and requires checkbox confirmation for Team Delete", async () => {
    mocks.getPage.mockResolvedValue({
      bucket: "history",
      status: "cancelled",
      tasks: [task("archived-cancelled", "cancelled")],
      hasMore: false,
    });
    mocks.deleteTeam.mockResolvedValue({
      deletedSessionIds: ["member-session", "root-session"],
    });
    mocks.applyDeleteReceipt.mockResolvedValue(false);
    const view: AgentOrgRunView = {
      ...runView(),
      runStatus: "archived",
      runPhase: "archived",
      archiveTeardown: {
        receiptId: "archive-receipt",
        status: "quiesced",
        attemptCount: 1,
        retainedRuntimeCount: 0,
        deadlineAt: "2026-08-23T00:01:00Z",
      },
    };
    await act(async () => {
      root.render(
        createElement(AgentOrgOverviewPanel, {
          view,
          error: null,
          currentSessionId: "root-session",
          onRefresh: vi.fn().mockResolvedValue(undefined),
        })
      );
    });
    expect(mocks.getPage).toHaveBeenCalledWith(
      expect.objectContaining({ status: "cancelled" })
    );
    expect(
      container.querySelector(
        '[data-testid="agent-org-overview-resume-button"]'
      )
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-testid="agent-org-overview-archive-button"]'
      )
    ).toBeNull();
    const openDelete = container.querySelector<HTMLButtonElement>(
      '[data-testid="agent-org-overview-delete-button"]'
    );
    expect(openDelete?.disabled).toBe(false);
    await act(async () => openDelete?.click());
    const confirmDelete = document.querySelector<HTMLButtonElement>(
      '[data-testid="agent-org-delete-confirm-button"]'
    );
    expect(confirmDelete?.disabled).toBe(true);
    await act(async () => {
      document
        .querySelector<HTMLInputElement>(
          'div[role="dialog"] input[type="checkbox"]'
        )
        ?.click();
    });
    expect(confirmDelete?.disabled).toBe(false);
    await act(async () => confirmDelete?.click());
    expect(mocks.deleteTeam).toHaveBeenCalledWith("root-session");
    expect(mocks.applyDeleteReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedSessionId: "root-session",
        receipt: {
          deletedSessionIds: ["member-session", "root-session"],
        },
      })
    );
    expect(mocks.goToNewSession).not.toHaveBeenCalled();
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

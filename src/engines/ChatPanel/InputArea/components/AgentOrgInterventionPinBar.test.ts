// @vitest-environment jsdom
import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
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
  AgentOrgMemberIntervention,
  AgentOrgRunMemberView,
  ReturnToWorkResult,
} from "@src/api/tauri/agent";

import AgentOrgInterventionPinBar from "./AgentOrgInterventionPinBar";

const mocks = vi.hoisted(() => ({
  messageSuccess: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: { count?: number; member?: string }) =>
      `${key}${params?.count == null ? "" : `:${params.count}`}${params?.member == null ? "" : `:${params.member}`}`,
  }),
}));

vi.mock("@src/components/Button", () => ({
  default: (props: Record<string, unknown>) =>
    createElement(
      "button",
      {
        type: "button",
        disabled: props.disabled as boolean | undefined,
        onClick: props.onClick as (() => void) | undefined,
        "data-testid": props["data-testid"] as string | undefined,
      },
      props.children as React.ReactNode
    ),
}));

vi.mock("@src/components/Message", () => ({
  Message: { success: mocks.messageSuccess },
}));

vi.mock("@src/engines/ChatPanel/components/ChatStatusBanners", () => ({
  ChatStatusSegmentedBar: (props: Record<string, unknown>) =>
    createElement(
      "div",
      {
        "data-testid": props.testId as string,
        "data-member-id": props["data-member-id"] as string | undefined,
        "data-writer-capable": props["data-writer-capable"] as
          | boolean
          | undefined,
        "data-activity-kind": props["data-activity-kind"] as string | undefined,
        "data-user-directed-queue-count": props[
          "data-user-directed-queue-count"
        ] as number,
      },
      ...(props.segments as Array<{ content: React.ReactNode }>).map(
        (segment) => segment.content
      )
    ),
  ChatStatusTwoLineContent: (props: Record<string, unknown>) =>
    createElement(
      "div",
      null,
      props.title as React.ReactNode,
      props.description as React.ReactNode
    ),
}));

function member(overrides: Partial<AgentOrgRunMemberView> = {}) {
  return {
    memberId: "member-direct",
    name: "Direct Member",
    role: "Build",
    agentId: "agent-direct",
    isCoordinator: false,
    writerCapable: true,
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
    ...overrides,
  } satisfies AgentOrgRunMemberView;
}

function intervention(
  overrides: Partial<AgentOrgMemberIntervention> = {}
): AgentOrgMemberIntervention {
  return {
    interventionReceiptId: "receipt-direct",
    orgRunId: "run-direct",
    memberId: "member-direct",
    agentId: "agent-direct",
    sessionId: "session-direct",
    status: "active",
    sourceEventId: "event-direct",
    queuedUserDirectedCount: 0,
    enteredAt: "2026-08-25T00:00:00Z",
    lastUserActivityAt: "2026-08-25T00:00:00Z",
    ...overrides,
  };
}

function returnResult(
  overrides: Partial<ReturnToWorkResult> = {}
): ReturnToWorkResult {
  return {
    outcome: "no_longer_needed",
    appliedOutcome: "no_longer_needed",
    hadOriginalFormalWork: false,
    interventionReceiptId: "receipt-direct",
    requestId: "request-direct",
    clearedRevision: 1,
    clearedAt: "2026-08-25T00:01:00Z",
    continuationTurnIntentId: null,
    ...overrides,
  };
}

describe("AgentOrgInterventionPinBar", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    mocks.messageSuccess.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("explains Paused direct work and Writer authority without a receipt", async () => {
    await act(async () => {
      root.render(
        createElement(AgentOrgInterventionPinBar, {
          intervention: null,
          member: member(),
          runStatus: "paused",
          error: null,
          returning: false,
          stopping: false,
          onReturnToWork: vi.fn(),
          onStopUserDirectedWork: vi.fn(),
        })
      );
    });

    expect(container.textContent).toContain(
      "planner.agentOrgIntervention.directPaused"
    );
    expect(container.textContent).toContain(
      "planner.agentOrgIntervention.writerBadge"
    );
    expect(
      container.querySelector('[data-testid="agent-org-return-to-work-button"]')
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-testid="agent-org-end-direct-work-button"]'
      )
    ).toBeNull();
  });

  it("offers Stop while nonbusy direct work runs and enables End after terminal", async () => {
    const activeMember = member({
      queuedUserDirectedCount: 1,
      activity: {
        kind: "side_quest",
        source: "direct_member",
        interventionReceiptId: "receipt-direct",
      },
    });
    await act(async () => {
      root.render(
        createElement(AgentOrgInterventionPinBar, {
          intervention: intervention(),
          member: activeMember,
          runStatus: "running",
          error: null,
          returning: false,
          stopping: false,
          onReturnToWork: vi.fn(),
          onStopUserDirectedWork: vi.fn(),
        })
      );
    });
    expect(
      container.querySelector(
        '[data-testid="agent-org-stop-user-directed-work-button"]'
      )
    ).not.toBeNull();
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="agent-org-end-direct-work-button"]'
      )?.disabled
    ).toBe(true);

    await act(async () => {
      root.render(
        createElement(AgentOrgInterventionPinBar, {
          intervention: {
            ...intervention(),
            failureReason: "user_directed_turn_abandoned_after_restart",
          },
          member: member(),
          runStatus: "idle",
          error: null,
          returning: false,
          stopping: false,
          onReturnToWork: vi.fn(),
          onStopUserDirectedWork: vi.fn(),
        })
      );
    });
    expect(container.textContent).toContain(
      "planner.agentOrgIntervention.directUnknown"
    );

    await act(async () => {
      root.render(
        createElement(AgentOrgInterventionPinBar, {
          intervention: { ...intervention(), status: "yield_requested" },
          member: member(),
          runStatus: "running",
          error: null,
          returning: false,
          stopping: false,
          onReturnToWork: vi.fn(),
          onStopUserDirectedWork: vi.fn(),
        })
      );
    });
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="agent-org-end-direct-work-button"]'
      )?.disabled
    ).toBe(true);

    const onReturnToWork = vi
      .fn<() => Promise<ReturnToWorkResult | null>>()
      .mockResolvedValue(returnResult());
    await act(async () => {
      root.render(
        createElement(AgentOrgInterventionPinBar, {
          intervention: intervention(),
          member: member({
            activity: {
              kind: "side_quest",
              source: "direct_member",
              interventionReceiptId: "receipt-direct",
            },
          }),
          runStatus: "idle",
          error: null,
          returning: false,
          stopping: false,
          onReturnToWork,
          onStopUserDirectedWork: vi.fn(),
        })
      );
    });
    expect(container.textContent).toContain(
      "planner.agentOrgIntervention.directReady"
    );
    const endButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="agent-org-end-direct-work-button"]'
    );
    expect(endButton?.disabled).toBe(false);
    expect(endButton?.textContent).toContain(
      "planner.agentOrgIntervention.endDirectWork"
    );

    await act(async () => {
      endButton?.click();
      await Promise.resolve();
    });
    expect(mocks.messageSuccess).toHaveBeenCalledWith(
      "planner.agentOrgIntervention.outcome.directEnded",
      { duration: 4000 }
    );

    await act(async () => {
      endButton?.click();
      await Promise.resolve();
    });
    expect(onReturnToWork).toHaveBeenCalledTimes(2);
    expect(mocks.messageSuccess).toHaveBeenCalledTimes(1);
  });

  it("uses Return only for a resumable formal handoff and toasts the durable outcome", async () => {
    const formalIntervention = intervention({
      originalTaskId: "task-formal",
      originalTurnIntentId: "turn-formal",
    });
    const onReturnToWork = vi.fn().mockResolvedValue(
      returnResult({
        outcome: "restored_task",
        appliedOutcome: "restored_task",
        hadOriginalFormalWork: true,
        continuationTurnIntentId: "turn-continuation",
      })
    );
    await act(async () => {
      root.render(
        createElement(AgentOrgInterventionPinBar, {
          intervention: formalIntervention,
          member: member({
            activity: {
              kind: "user_intervention",
              source: "direct_member",
              interventionReceiptId: "receipt-direct",
            },
          }),
          runStatus: "running",
          error: null,
          returning: false,
          stopping: false,
          onReturnToWork,
          onStopUserDirectedWork: vi.fn(),
        })
      );
    });

    const returnButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="agent-org-return-to-work-button"]'
    );
    expect(returnButton?.textContent).toContain(
      "planner.agentOrgIntervention.returnToWork"
    );
    expect(
      container.querySelector(
        '[data-testid="agent-org-end-direct-work-button"]'
      )
    ).toBeNull();
    await act(async () => {
      returnButton?.click();
      await Promise.resolve();
    });
    expect(mocks.messageSuccess).toHaveBeenCalledWith(
      "planner.agentOrgIntervention.outcome.restoredTask",
      { duration: 4000 }
    );
  });

  it.each([
    {
      name: "keeps an Idle Team idle",
      runStatus: "idle" as const,
      intervention: intervention(),
      result: returnResult({
        outcome: "cleared_idle",
        appliedOutcome: "cleared_idle",
      }),
      expectedKey: "planner.agentOrgIntervention.outcome.clearedIdle",
      buttonTestId: "agent-org-end-direct-work-button",
    },
    {
      name: "reports formal work that ended or was reassigned",
      runStatus: "running" as const,
      intervention: intervention({
        originalTaskId: "task-formal",
        originalTurnIntentId: "turn-formal",
      }),
      result: returnResult({
        outcome: "no_longer_needed",
        appliedOutcome: "no_longer_needed",
        hadOriginalFormalWork: true,
      }),
      expectedKey: "planner.agentOrgIntervention.outcome.noLongerNeeded",
      buttonTestId: "agent-org-return-to-work-button",
    },
  ])("toasts the exact outcome when $name", async (scenario) => {
    const onReturnToWork = vi.fn().mockResolvedValue(scenario.result);
    await act(async () => {
      root.render(
        createElement(AgentOrgInterventionPinBar, {
          intervention: scenario.intervention,
          member: member(),
          runStatus: scenario.runStatus,
          error: null,
          returning: false,
          stopping: false,
          onReturnToWork,
          onStopUserDirectedWork: vi.fn(),
        })
      );
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          `[data-testid="${scenario.buttonTestId}"]`
        )
        ?.click();
      await Promise.resolve();
    });
    expect(mocks.messageSuccess).toHaveBeenCalledWith(scenario.expectedKey, {
      duration: 4000,
    });
  });

  it("ends a formal handoff without claiming resume while the Team is paused", async () => {
    const onReturnToWork = vi.fn().mockResolvedValue(
      returnResult({
        outcome: "already_applied",
        appliedOutcome: "cleared_paused",
        hadOriginalFormalWork: true,
      })
    );
    await act(async () => {
      root.render(
        createElement(AgentOrgInterventionPinBar, {
          intervention: intervention({
            originalTaskId: "task-formal",
            originalTurnIntentId: "turn-formal",
          }),
          member: member(),
          runStatus: "paused",
          error: null,
          returning: false,
          stopping: false,
          onReturnToWork,
          onStopUserDirectedWork: vi.fn(),
        })
      );
    });

    const endButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="agent-org-end-direct-work-button"]'
    );
    await act(async () => {
      endButton?.click();
      await Promise.resolve();
    });
    expect(mocks.messageSuccess).toHaveBeenCalledWith(
      "planner.agentOrgIntervention.outcome.clearedPaused",
      { duration: 4000 }
    );
  });
});

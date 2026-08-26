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
} from "@src/api/tauri/agent";

import AgentOrgInterventionPinBar from "./AgentOrgInterventionPinBar";

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

function intervention(): AgentOrgMemberIntervention {
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
          returnOutcome: null,
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
  });

  it("offers exact Stop while queued and enables Return only after terminal", async () => {
    const activeMember = member({
      queuedUserDirectedCount: 1,
      activity: {
        kind: "user_intervention",
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
          returnOutcome: null,
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
        '[data-testid="agent-org-return-to-work-button"]'
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
          returnOutcome: null,
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
          returnOutcome: null,
          onReturnToWork: vi.fn(),
          onStopUserDirectedWork: vi.fn(),
        })
      );
    });
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="agent-org-return-to-work-button"]'
      )?.disabled
    ).toBe(true);

    await act(async () => {
      root.render(
        createElement(AgentOrgInterventionPinBar, {
          intervention: intervention(),
          member: member(),
          runStatus: "idle",
          error: null,
          returning: false,
          stopping: false,
          returnOutcome: "cleared_idle",
          onReturnToWork: vi.fn(),
          onStopUserDirectedWork: vi.fn(),
        })
      );
    });
    expect(container.textContent).toContain(
      "planner.agentOrgIntervention.outcome.clearedIdle"
    );
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="agent-org-return-to-work-button"]'
      )?.disabled
    ).toBe(false);
  });
});

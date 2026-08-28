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

import type { AgentOrgTask } from "@src/api/tauri/agent";

import { AgentOrgTaskList } from "./AgentOrgTaskList";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? key,
  }),
}));
vi.mock("@src/api/tauri/agent", () => ({
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
  getAgentOrgTaskDetail: vi.fn(),
  getAgentOrgTaskAnnotationPage: vi.fn(),
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

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

function planningTask(): AgentOrgTask {
  return {
    id: "planning-task",
    orgRunId: "run-1",
    subject: "Plan the implementation",
    description: "Create an immutable implementation plan",
    owner: "planner-member",
    status: "in_progress",
    blocks: [],
    blockedBy: [],
    executionMode: "plan",
    createdAt: "2026-08-28T00:00:00Z",
    updatedAt: "2026-08-28T00:00:01Z",
  };
}

describe("Agent Org Planning Task approval activity", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
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
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("keeps the Task In Progress and projects Awaiting approval separately", async () => {
    await act(async () => {
      root.render(
        createElement(AgentOrgTaskList, {
          tasks: [planningTask()],
          listTestId: "planning-list",
          rowTestId: "planning-row",
          awaitingApprovalTaskIds: ["planning-task"],
        })
      );
    });

    const row = container.querySelector('[data-testid="planning-row"]');
    expect(row?.getAttribute("data-task-status")).toBe("in_progress");
    expect(
      row?.querySelector('[data-testid="agent-org-task-status-chip"]')
        ?.textContent
    ).toContain("statusInProgress");
    expect(
      row?.querySelector(
        '[data-testid="agent-org-task-awaiting-approval-chip"]'
      )?.textContent
    ).toBe("Awaiting approval");
  });

  it("does not infer Awaiting approval from In Progress alone", async () => {
    await act(async () => {
      root.render(
        createElement(AgentOrgTaskList, {
          tasks: [planningTask()],
          listTestId: "planning-list",
          rowTestId: "planning-row",
          awaitingApprovalTaskIds: [],
        })
      );
    });

    expect(
      container.querySelector(
        '[data-testid="agent-org-task-awaiting-approval-chip"]'
      )
    ).toBeNull();
  });
});

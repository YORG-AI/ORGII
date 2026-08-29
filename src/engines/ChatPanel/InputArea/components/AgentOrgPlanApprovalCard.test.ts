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
  AgentOrgPlanApproval,
  AgentOrgPlanApprovalSummary,
} from "@src/api/tauri/agent";

import AgentOrgPlanApprovalCard from "./AgentOrgPlanApprovalCard";

const mocks = vi.hoisted(() => ({
  respond: vi.fn(),
  onResolved: vi.fn(),
  detail: null as AgentOrgPlanApproval | null,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? key,
  }),
}));
vi.mock("@src/api/tauri/agent", () => ({
  respondAgentOrgPlanApproval: mocks.respond,
}));
vi.mock("@src/hooks/logger", () => ({
  createLogger: () => ({ error: vi.fn() }),
}));
vi.mock("./useAgentOrgPlanApprovalDetail", () => ({
  useAgentOrgPlanApprovalDetail: () => ({
    detail: mocks.detail,
    error: null,
    loading: false,
    retry: vi.fn(),
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
vi.mock("@src/components/Textarea", () => ({
  default: (props: Record<string, unknown>) =>
    createElement("textarea", {
      value: props.value as string,
      disabled: props.disabled as boolean | undefined,
      "aria-label": props["aria-label"] as string | undefined,
      "data-testid": props["data-testid"] as string | undefined,
      onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) =>
        (props.onChange as (value: string) => void)(event.target.value),
    }),
}));
vi.mock("@src/components/MarkDown", () => ({
  default: ({ textContent }: { textContent: string }) =>
    createElement("div", { "data-testid": "plan-content" }, textContent),
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

function pendingRevision(): AgentOrgPlanApprovalSummary {
  return {
    approvalId: "approval-1",
    planRevisionId: "revision-2",
    revisionNumber: 2,
    previousPlanRevisionId: "revision-1",
    requestId: "request-2",
    orgRunId: "run-1",
    sourceTaskId: "planning-task",
    sourceMemberId: "planner-member",
    sourceSessionId: "planner-session",
    sourceTurnIntentId: "planner-turn-2",
    rootSessionId: "root-session",
    policy: "user",
    status: "pending",
    planTitle: "Implementation plan",
    planContentBytes: 32,
    contentDigest: "a".repeat(64),
    createdAt: "2026-08-28T00:00:00Z",
  };
}

function revisionDetail(
  summary: AgentOrgPlanApprovalSummary
): AgentOrgPlanApproval {
  return {
    ...summary,
    planPath: ".orgii/plans/revision-2.md",
    planContent: "# Exact immutable plan",
  };
}

describe("Agent Org immutable plan decision card", () => {
  let container: HTMLDivElement;
  let root: Root;
  const approval = pendingRevision();

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.respond.mockReset().mockResolvedValue(revisionDetail(approval));
    mocks.onResolved.mockReset().mockResolvedValue(undefined);
    mocks.detail = revisionDetail(approval);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  async function renderCard() {
    await act(async () => {
      root.render(
        createElement(AgentOrgPlanApprovalCard, {
          approval,
          sourceMemberName: "Planner",
          disabled: false,
          onResolved: mocks.onResolved,
        })
      );
    });
  }

  it("approves the exact revision without an edited-content field", async () => {
    await renderCard();

    expect(container.querySelector("textarea")).toBeNull();
    expect(container.textContent).toContain("# Exact immutable plan");
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="agent-org-plan-approve-button"]'
        )
        ?.click();
      await Promise.resolve();
    });

    expect(mocks.respond).toHaveBeenCalledWith({
      sessionId: "root-session",
      approvalId: "approval-1",
      planRevisionId: "revision-2",
      sourceTaskId: "planning-task",
      sourceTurnIntentId: "planner-turn-2",
      decision: "approve",
      feedback: null,
    });
    expect(mocks.respond.mock.calls[0]?.[0]).not.toHaveProperty(
      "editedContent"
    );
    expect(mocks.onResolved).toHaveBeenCalledTimes(1);
  });

  it("sends feedback as request_changes instead of mutating the revision", async () => {
    await renderCard();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="agent-org-plan-request-changes-button"]'
        )
        ?.click();
    });

    const feedback = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="agent-org-plan-approval-feedback"]'
    );
    expect(feedback).not.toBeNull();
    await act(async () => {
      if (!feedback) return;
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      )?.set;
      valueSetter?.call(feedback, "Split the rollout into two steps");
      feedback.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="agent-org-plan-send-feedback-button"]'
        )
        ?.click();
      await Promise.resolve();
    });

    expect(mocks.respond).toHaveBeenCalledWith({
      sessionId: "root-session",
      approvalId: "approval-1",
      planRevisionId: "revision-2",
      sourceTaskId: "planning-task",
      sourceTurnIntentId: "planner-turn-2",
      decision: "request_changes",
      feedback: "Split the rollout into two steps",
    });
  });
});

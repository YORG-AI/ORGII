import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AgentOrgPlanApprovalSummary } from "@src/api/tauri/agent";

import AgentOrgPlanApprovalCard from "./AgentOrgPlanApprovalCard";

const mocks = vi.hoisted(() => ({
  retry: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? key,
  }),
}));

vi.mock("@src/api/tauri/agent", () => ({
  respondAgentOrgPlanApproval: vi.fn(),
}));

vi.mock("./useAgentOrgPlanApprovalDetail", () => ({
  useAgentOrgPlanApprovalDetail: () => ({
    detail: null,
    error: "Plan details unavailable",
    loading: false,
    retry: mocks.retry,
  }),
}));

const APPROVAL: AgentOrgPlanApprovalSummary = {
  approvalId: "approval-1",
  planRevisionId: "revision-1",
  requestId: "request-1",
  orgRunId: "run-1",
  sourceTaskId: "task-1",
  sourceMemberId: "member-1",
  sourceSessionId: "session-1",
  rootSessionId: "root-1",
  policy: "user",
  status: "pending",
  planTitle: "Review implementation plan",
  planContentBytes: 128,
  createdAt: "2026-09-03T00:00:00.000Z",
};

describe("AgentOrgPlanApprovalCard", () => {
  it("renders detail-load failures as a compact danger InlineAlert with retry", () => {
    const markup = renderToStaticMarkup(
      createElement(AgentOrgPlanApprovalCard, {
        approval: APPROVAL,
        sourceMemberName: "Researcher",
        sessionId: "session-1",
        disabled: false,
        onResolved: vi.fn(),
      })
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('data-icon="triangle-alert"');
    expect(markup).toContain("shadow-dropdown-soft");
    expect(markup).toContain("Plan details unavailable");
    expect(markup).toContain('data-testid="agent-org-plan-approval-retry"');
    expect(markup).toContain("Retry");
  });
});

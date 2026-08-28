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

import type { AgentOrgFinalSummaryReceipt } from "@src/api/tauri/agent";

import AgentOrgFinalSummaryCard from "./AgentOrgFinalSummaryCard";

const mocks = vi.hoisted(() => ({
  retry: vi.fn(),
  onRetried: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? key,
  }),
}));
vi.mock("@src/api/tauri/agent", () => ({
  retryAgentOrgFinalSummary: mocks.retry,
}));
vi.mock("@src/hooks/logger", () => ({
  createLogger: () => ({ error: vi.fn() }),
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

function failedReceipt(): AgentOrgFinalSummaryReceipt {
  return {
    receiptId: "summary-receipt-1",
    orgRunId: "run-1",
    activationGeneration: 1,
    certificateId: "certificate-1",
    evidenceDigest: "b".repeat(64),
    attempt: 3,
    status: "failed",
    coordinatorSessionId: "root-session",
    turnIntentId: "summary-turn-3",
    terminalAt: "2026-08-28T00:00:10Z",
    typedError: "provider_timeout",
    canRetry: true,
    createdAt: "2026-08-28T00:00:00Z",
    updatedAt: "2026-08-28T00:00:10Z",
  };
}

describe("Agent Org failed final summary card", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.retry.mockReset().mockResolvedValue({});
    mocks.onRetried.mockReset().mockResolvedValue(undefined);
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
        createElement(AgentOrgFinalSummaryCard, {
          receipt: failedReceipt(),
          sessionId: "root-session",
          onRetried: mocks.onRetried,
        })
      );
    });
  }

  it("does not retry automatically and uses the rendered Retry button", async () => {
    await renderCard();
    expect(mocks.retry).not.toHaveBeenCalled();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="agent-org-final-summary-retry"]'
        )
        ?.click();
      await Promise.resolve();
    });

    expect(mocks.retry).toHaveBeenCalledWith({
      sessionId: "root-session",
      certificateId: "certificate-1",
      failedAttempt: 3,
      requestId: expect.any(String),
    });
    expect(mocks.onRetried).toHaveBeenCalledTimes(1);
  });

  it("keeps the failure visible when starting a retry fails", async () => {
    mocks.retry.mockRejectedValue(new Error("offline"));
    await renderCard();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="agent-org-final-summary-retry"]'
        )
        ?.click();
      await Promise.resolve();
    });

    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(mocks.onRetried).not.toHaveBeenCalled();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="agent-org-final-summary-retry"]'
        )
        ?.click();
      await Promise.resolve();
    });
    expect(mocks.retry).toHaveBeenCalledTimes(2);
    expect(mocks.retry.mock.calls[1]?.[0]?.requestId).toBe(
      mocks.retry.mock.calls[0]?.[0]?.requestId
    );
  });
});

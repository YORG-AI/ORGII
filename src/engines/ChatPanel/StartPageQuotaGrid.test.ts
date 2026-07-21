import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { StartPageQuotaGrid } from "./StartPageQuotaGrid";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      if (key === "chat.startPage.quota.refresh") return "Refresh";
      return key;
    },
  }),
}));

vi.mock("@src/hooks/keyVault", () => ({
  useKeyVault: () => ({
    accounts: [],
    getAccount: vi.fn(),
    refresh: vi.fn(),
    refreshAccount: vi.fn(),
  }),
}));

vi.mock("@src/components/ModelIcon", () => ({
  default: () => createElement("span", { "data-testid": "model-icon" }),
}));

vi.mock("@src/hooks/keyVault/accountQuotaDisplay", () => ({
  collectAccountQuotaCards: () =>
    Array.from({ length: 5 }, (_, index) => ({
      id: `account-${index + 1}`,
      accountName: index === 0 ? "Codex account" : `Account ${index + 1}`,
      accountPlan: "Plus",
      modelType: "codex",
      metrics: [
        {
          key: "weekly",
          label: "Weekly",
          remainingPercent: 75,
          resetTime: null,
        },
      ],
    })),
  formatQuotaResetHint: () => null,
}));

describe("StartPageQuotaGrid", () => {
  it("renders a flat quota grid with a labeled refresh action", () => {
    const markup = renderToStaticMarkup(createElement(StartPageQuotaGrid));

    const refreshIndex = markup.indexOf('aria-label="Refresh"');
    const quotaCardIndex = markup.indexOf("Codex account");

    expect(markup).not.toContain("Quota Usage");
    expect(markup).not.toContain("chat-panel-start-page-quota-toggle");
    expect(refreshIndex).toBeGreaterThanOrEqual(0);
    expect(quotaCardIndex).toBeGreaterThan(refreshIndex);
    expect(markup).toContain('data-testid="quota-refresh-controls"');
    expect(markup).toContain(
      'class="sticky top-0 z-20 -mx-4 bg-chat-pane px-4 pb-1"'
    );
    expect(markup).toContain("flex flex-col gap-3");
    expect(markup).toContain("kanban.dataSource.views.quota");
    expect(markup).toContain("flex min-h-9 items-center justify-end");
    expect(markup).toContain("border-0 bg-transparent text-text-2");
  });

  it("renders every quota card without pagination", () => {
    const markup = renderToStaticMarkup(createElement(StartPageQuotaGrid));

    expect(markup).toContain("Account 5");
    expect(markup).not.toContain("chat.startPage.hints.previous");
    expect(markup).not.toContain("chat.startPage.hints.next");
    expect(markup).not.toContain("1 / 2");
  });
});

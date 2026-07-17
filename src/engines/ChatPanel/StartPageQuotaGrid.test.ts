import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { StartPageQuotaGrid } from "./StartPageQuotaGrid";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      if (key === "keyVault.quota.quotaUsage") return "Quota Usage";
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
  collectAccountQuotaCards: () => [
    {
      id: "codex-account",
      accountName: "Codex account",
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
    },
  ],
  formatQuotaResetHint: () => null,
}));

describe("StartPageQuotaGrid", () => {
  it("renders quota usage as a collapsible section with refresh in its header", () => {
    const markup = renderToStaticMarkup(createElement(StartPageQuotaGrid));

    const toggleIndex = markup.indexOf(
      'data-testid="chat-panel-start-page-quota-toggle"'
    );
    const refreshIndex = markup.indexOf('aria-label="Refresh"');
    const quotaCardIndex = markup.indexOf("Codex account");

    expect(markup).toContain("Quota Usage");
    expect(toggleIndex).toBeGreaterThanOrEqual(0);
    expect(refreshIndex).toBeGreaterThan(toggleIndex);
    expect(quotaCardIndex).toBeGreaterThan(refreshIndex);
  });
});

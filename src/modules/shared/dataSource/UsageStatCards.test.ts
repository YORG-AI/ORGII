import { type ReactNode, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { UsageSummary } from "@src/api/tauri/usageDashboard";

import UsageStatCards from "./UsageStatCards";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@src/components/Tooltip", () => ({
  default: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("./UsagePricingHint", () => ({ default: () => null }));

const summary: UsageSummary = {
  sessionCount: 10,
  requestCount: 884,
  inputTokens: 3_510_000,
  outputTokens: 443_800,
  cacheReadTokens: 100_630_000,
  cacheWriteTokens: 230_200,
  realTotalTokens: 104_816_660,
  totalTokens: 104_816_660,
  costUsd: 82.321,
  estimatedCostUsd: 82.321,
  recordedCostUsd: 0,
  cacheHitRate: 0.964,
  byBucket: [],
};

describe("UsageStatCards", () => {
  it("shows sessions and requests together without redundant detail lines", () => {
    const markup = renderToStaticMarkup(
      createElement(UsageStatCards, { summary, language: "en" })
    );

    expect(markup).toContain("usage.cards.sessions &amp; usage.cards.requests");
    expect(markup).toMatch(/>10<\/span><span[^>]*>884<\/span>/);
    expect(markup).toContain(">104.82M</span>");
    expect(markup).toContain(">$82.32</span>");
    expect(markup).not.toContain("104,816,660");
    expect(markup).not.toContain("$82.3210");
    expect(markup).not.toContain("usage.cards.requests: 884");
    expect(markup).toContain("text-xs text-text-2");
    expect(markup).toContain("text-xl font-semibold text-text-1");
    expect(markup).toContain("text-base font-semibold text-text-1");
    expect(markup).toContain("text-xs font-medium text-text-3");
  });
});

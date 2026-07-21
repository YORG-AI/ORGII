import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import SessionUsagePanel from "./SessionUsagePanel";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", resolvedLanguage: "en" },
  }),
}));

vi.mock("./UsageRoundsTable", () => ({
  default: () => null,
  USAGE_ROUNDS_DEFAULT_PAGE_SIZE: 10,
}));

vi.mock("./UsageStatCards", () => ({ default: () => null }));
vi.mock("./UsageTrendChart", () => ({ default: () => null }));

describe("SessionUsagePanel", () => {
  it("pins the source and range controls above the scrolling usage content", () => {
    const markup = renderToStaticMarkup(createElement(SessionUsagePanel));

    expect(markup).toContain('data-testid="usage-source-controls"');
    expect(markup).toContain(
      'class="sticky top-0 z-20 -mx-4 bg-chat-pane px-4 pb-1"'
    );
    expect(markup).toContain("flex flex-col gap-3");
    expect(markup).toContain("flex min-h-9 flex-wrap items-center");
    expect(markup).toContain("bg-fill-1 font-semibold text-primary-6");
    expect(markup).toContain("border-0 bg-transparent text-text-2");
  });
});

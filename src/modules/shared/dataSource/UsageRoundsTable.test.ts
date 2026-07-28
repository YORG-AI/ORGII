import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import UsageRoundsTable from "./UsageRoundsTable";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", resolvedLanguage: "en" },
  }),
}));

describe("UsageRoundsTable", () => {
  it("keeps the request toolbar unmounted while default-collapsed", () => {
    const markup = renderToStaticMarkup(
      createElement(UsageRoundsTable, {
        rows: [],
        total: 0,
        availableModels: [],
        hasUnknownModel: false,
        modelFilter: undefined,
        onModelFilterChange: vi.fn(),
        searchQuery: "",
        onSearchQueryChange: vi.fn(),
        sort: "recent",
        onSortChange: vi.fn(),
        pageIndex: 0,
        pageSize: 10,
        onPageChange: vi.fn(),
        onPageSizeChange: vi.fn(),
        loaded: false,
        error: null,
        onOpenChange: vi.fn(),
        onRefresh: vi.fn(),
        onSelectSession: vi.fn(),
      })
    );

    expect(markup).toContain('data-testid="usage-rounds-toggle"');
    expect(markup).not.toContain('data-testid="usage-rounds-refresh"');
  });
});

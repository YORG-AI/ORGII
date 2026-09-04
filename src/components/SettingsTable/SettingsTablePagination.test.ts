import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SettingsTablePagination } from "./SettingsTablePagination";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (
      key: string,
      values?: { count?: number; current?: number; total?: number }
    ) => {
      if (key === "pagination.totalItems") return `${values?.count} items`;
      if (key === "pagination.pageOf") {
        return `Page ${values?.current} of ${values?.total}`;
      }
      if (key === "pagination.perPage") return "per page";
      return key;
    },
  }),
}));

describe("SettingsTablePagination", () => {
  it("keeps selectors, removes the item count, and places page size first", () => {
    const markup = renderToStaticMarkup(
      React.createElement(SettingsTablePagination, {
        pageIndex: 0,
        pageSize: 25,
        total: 75,
        pageCount: 3,
        canPreviousPage: false,
        canNextPage: true,
        onPageChange: vi.fn(),
        onPageSizeChange: vi.fn(),
        pageSizeOptions: [10, 25, 50],
      })
    );

    expect(markup).toContain("25 per page");
    expect(markup).toContain("Page 1 of 3");
    expect(markup).not.toContain("75 items");
    expect(markup.indexOf("25 per page")).toBeLessThan(
      markup.indexOf("Page 1 of 3")
    );
  });
});

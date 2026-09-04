import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CircleDotIcon, HugeiconsIcon } from "@src/icons";

import {
  WORK_MANAGEMENT_TITLE_COLUMN_MAX_WIDTH,
  WorkManagementTable,
} from "./WorkManagementTable";

describe("WorkManagementTable", () => {
  const rows = Array.from({ length: 26 }, (_, index) => ({
    key: `row-${index + 1}`,
    id: `WI-${index + 1}`,
    title: `Shared row ${index + 1}`,
    contextLeading: "2 links",
    metadata: ["ORGII", "Ada"],
    tags: ["maintenance"],
    assignee: "Ada",
    status: "Open",
    updated: "1h",
  }));

  it("renders as a full-bleed page list without a card container", () => {
    expect(WORK_MANAGEMENT_TITLE_COLUMN_MAX_WIDTH).toBe(550);

    const markup = renderToStaticMarkup(
      createElement(WorkManagementTable, {
        rows: rows.slice(0, 1),
      })
    );

    expect(markup).toContain('data-testid="work-management-table"');
    expect(markup).toContain('class="h-full min-h-0 w-full"');
    expect(markup).toContain("settings-table-root");
    expect(markup).toContain("settings-table-root-transparent");
    expect(markup).toContain("table-settings-page-list-hover");
    expect(markup).not.toContain("rounded-xl");
    expect(markup).not.toContain("max-w-[1232px]");
    expect(markup).toContain("[&amp;_.table-fixed-header]:scrollbar-hide");
    expect(markup).toContain("[&amp;_.table-scroll]:scrollbar-hide");
    expect(markup).not.toContain("table-settings-header-border");
    expect(markup).toContain(">ID<");
    expect(markup).toContain("table-th-sortable");
    expect(markup).toContain("Title / Context");
    expect(markup).toContain('style="width:550px"');
    expect(markup).toContain('style="max-width:550px"');
    expect(markup).toContain("Assignee");
    expect(markup).toContain("flex w-full justify-start");
    expect(markup).toContain(">Status<");
    expect(markup).toContain(">Updated<");
    expect(markup).toContain("maintenance");
    expect(markup).toContain("text-[11px] text-text-1");
    expect(markup).toContain("leading-none font-normal text-text-1");
    expect(markup).toContain("mt-0.5");
    expect(markup).toContain("py-px");
    expect(markup).toContain("[&amp;_.table-td]:py-1.5!");
    expect(markup).not.toContain("[&amp;_.table-td]:py-2!");
    expect(markup.indexOf("2 links")).toBeLessThan(
      markup.indexOf("maintenance")
    );
    expect(markup.indexOf("2 links")).toBeLessThan(markup.indexOf("ORGII"));
    expect(markup).toContain('<span class="max-w-40 truncate">ORGII</span>');
    expect(markup).not.toContain('title="ORGII"');
    expect(markup).not.toContain("background-color");
    expect(markup).not.toContain("border-b!");
    expect(markup).not.toContain("border-border-1!");
    expect(markup).toContain("Shared row 1");
    expect(markup).toContain(
      "[&amp;_.table-row_.table-td:first-child]:align-top!"
    );
  });

  it("renders the complete title and lets the title column fill available width", () => {
    const title =
      "A title that is deliberately longer than fifty characters for truncation";

    const markup = renderToStaticMarkup(
      createElement(WorkManagementTable, {
        rows: [{ ...rows[0], title }],
      })
    );

    expect(markup).toContain(`title="${title}"`);
    expect(markup).toContain(`>${title}</div>`);
    expect(markup).not.toContain(`${title.slice(0, 49)}…`);
  });

  it("exposes clickable row titles as keyboard-accessible actions", () => {
    const markup = renderToStaticMarkup(
      createElement(WorkManagementTable, {
        rows: [{ ...rows[0], onClick: () => undefined }],
      })
    );

    expect(markup).toContain(
      "block w-full truncate text-left font-semibold text-text-1"
    );
    expect(markup).toContain('title="Shared row 1"');
  });

  it("renders row selection in a separate leading column", () => {
    const markup = renderToStaticMarkup(
      createElement(WorkManagementTable, {
        rows: [
          {
            ...rows[0],
            selection: createElement("input", {
              type: "checkbox",
              "aria-label": "Select WI-1",
            }),
          },
        ],
      })
    );

    expect(markup).toContain("data-work-management-selection");
    expect(markup).toContain(
      'class="flex h-6 w-full items-center justify-center"'
    );
    expect(markup).toContain('aria-label="Select WI-1"');
    expect(markup.indexOf('aria-label="Select WI-1"')).toBeLessThan(
      markup.indexOf(">WI-1<")
    );
    expect(markup).toContain("table-td-align-center");
    expect(markup).toContain(
      "[&amp;_.table-row_.table-td:nth-child(2)]:align-top!"
    );
    expect(markup).toContain(
      "[&amp;_.table-row_.table-td:first-child]:align-top!"
    );
  });

  it("renders status selects through the shared row contract", () => {
    const markup = renderToStaticMarkup(
      createElement(WorkManagementTable, {
        rows: [
          {
            ...rows[0],
            status: undefined,
            statusSelect: {
              value: "open",
              label: "Open",
              icon: createElement(HugeiconsIcon, {
                icon: CircleDotIcon,
                size: 14,
              }),
              options: [
                {
                  value: "open",
                  label: "Open",
                  icon: createElement(HugeiconsIcon, {
                    icon: CircleDotIcon,
                    size: 14,
                  }),
                },
              ],
              onChange: () => undefined,
              dataTestId: "shared-status-select",
            },
          },
        ],
      })
    );

    expect(markup).toContain('data-testid="shared-status-select"');
    expect(markup).toContain("px-2!");
    expect(markup).toContain("bg-fill-1!");
    expect(markup).toContain("enabled:hover:bg-fill-2!");
    expect(markup).toContain("enabled:hover:border-border-3!");
    expect(markup).toContain('data-value="open"');
    expect(markup).toContain(
      'class="inline-flex max-w-full min-w-0 items-center gap-1"'
    );
    expect(markup).toContain('data-icon="chevron-down"');
  });

  it("uses SettingsTable client pagination to bound rendered work-item rows", () => {
    const markup = renderToStaticMarkup(
      createElement(WorkManagementTable, {
        rows,
        pageSize: 25,
      })
    );

    expect(markup).toContain("Shared row 25");
    expect(markup).not.toContain("Shared row 26");
  });

  it("supports remote pagination without a duplicate page-size selector", () => {
    const markup = renderToStaticMarkup(
      createElement(WorkManagementTable, {
        rows: rows.slice(0, 1),
        pagination: {
          pageIndex: 0,
          pageSize: 25,
          total: 1,
          pageCount: 2,
          canPreviousPage: false,
          canNextPage: true,
          onPageChange: () => undefined,
          pageLabel: "Page 1 of 2+",
        },
      })
    );

    expect(markup).toContain("Page 1 of 2+");
    expect(markup).not.toContain("select-selector");
  });

  it("renders controlled ID and updated-time sort headers", () => {
    const markup = renderToStaticMarkup(
      createElement(WorkManagementTable, {
        rows: [
          {
            ...rows[0],
            idSortValue: 1,
          },
        ],
        sort: { column: "updated", order: "descend" },
        onSortChange: () => undefined,
      })
    );

    expect(markup).toContain('data-sort-column="id"');
    expect(markup).toContain('data-sort-column="updated"');
    expect(markup).toContain('aria-label="ID" aria-pressed="false"');
    expect(markup).toContain('aria-label="Updated" aria-pressed="true"');
  });
});

import type { TFunction } from "i18next";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import WorkItemsPageHeader from "..";
import { WorkItemsHeaderContent } from "../WorkItemsHeaderContent";

vi.mock("@src/components/KeyboardShortcut/ToolbarTooltip", () => ({
  ToolbarTooltip: ({ children }: { children: React.ReactNode }) => children,
}));

describe("WorkItemsHeaderContent", () => {
  it("renders aggregate controls directly without an empty breadcrumb title", () => {
    const markup = renderToStaticMarkup(
      React.createElement(WorkItemsHeaderContent, {
        section: "content",
        activeTab: "List",
        breadcrumbSegments: [],
        leadingControls: React.createElement(
          "span",
          { "data-testid": "status-filter" },
          "All"
        ),
        statusCounts: {
          all: 0,
          backlog: 0,
          todo: 0,
          inProgress: 0,
          inReview: 0,
          done: 0,
          cancelled: 0,
          duplicate: 0,
          open: 0,
          closed: 0,
        },
        t: ((key: string) => key) as unknown as TFunction<"projects">,
      })
    );

    expect(markup).toContain('data-testid="status-filter"');
    expect(markup).toContain('class="contents"');
    expect(markup).not.toContain('data-icon="chevron-right"');
    expect(markup).not.toContain('data-icon="box"');
  });

  it("orders the status filter before the inline search", () => {
    const markup = renderToStaticMarkup(
      React.createElement(WorkItemsHeaderContent, {
        section: "trailing",
        activeTab: "List",
        breadcrumbSegments: [],
        statusFilter: "all",
        onStatusFilterChange: vi.fn(),
        statusFilterKeys: ["all"],
        statusCounts: {
          all: 2,
          backlog: 0,
          todo: 0,
          inProgress: 0,
          inReview: 0,
          done: 0,
          cancelled: 0,
          duplicate: 0,
          open: 0,
          closed: 0,
        },
        trailingControls: React.createElement(
          "span",
          { "data-testid": "inline-search" },
          "Search"
        ),
        t: ((key: string) => key) as unknown as TFunction<"projects">,
      })
    );

    expect(markup.indexOf('data-icon="list"')).toBeLessThan(
      markup.indexOf('data-testid="inline-search"')
    );
  });

  it("keeps the create action to the right of refresh", () => {
    const markup = renderToStaticMarkup(
      React.createElement(WorkItemsHeaderContent, {
        section: "trailing",
        activeTab: "List",
        breadcrumbSegments: [],
        statusCounts: {
          all: 0,
          backlog: 0,
          todo: 0,
          inProgress: 0,
          inReview: 0,
          done: 0,
          cancelled: 0,
          duplicate: 0,
          open: 0,
          closed: 0,
        },
        onRefresh: vi.fn(),
        onAddWorkItem: vi.fn(),
        t: ((key: string) => key) as unknown as TFunction<"projects">,
      })
    );

    expect(markup.indexOf('data-icon="refresh-cw"')).toBeLessThan(
      markup.indexOf('data-icon="square-pen"')
    );
  });

  it("leaves the page header to selectors when split controls move left", () => {
    const markup = renderToStaticMarkup(
      React.createElement(WorkItemsPageHeader, {
        projectName: "Project",
        activeTab: "List",
        hideTrailingControls: true,
        trailingControls: React.createElement(
          "span",
          { "data-testid": "inline-search" },
          "Search"
        ),
        onRefresh: vi.fn(),
        onAddWorkItem: vi.fn(),
        statusCounts: {
          all: 0,
          backlog: 0,
          todo: 0,
          inProgress: 0,
          inReview: 0,
          done: 0,
          cancelled: 0,
          duplicate: 0,
          open: 0,
          closed: 0,
        },
      })
    );

    expect(markup).not.toContain('data-testid="inline-search"');
    expect(markup).not.toContain('data-icon="refresh-cw"');
    expect(markup).not.toContain('data-icon="square-pen"');
  });
});

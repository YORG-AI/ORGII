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

  it("keeps presentation controls last without a decorative separator", () => {
    const markup = renderToStaticMarkup(
      React.createElement(WorkItemsHeaderContent, {
        section: "trailing",
        activeTab: "List",
        breadcrumbSegments: [],
        trailingControls: React.createElement(
          "span",
          { "data-testid": "inline-search" },
          "Search"
        ),
        endControls: React.createElement(
          "span",
          { "data-testid": "maximize" },
          "Maximize"
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
        t: ((key: string) => key) as unknown as TFunction<"projects">,
      })
    );

    expect(markup.indexOf('data-testid="inline-search"')).toBeLessThan(
      markup.indexOf('data-icon="refresh-cw"')
    );
    expect(markup.indexOf('data-icon="refresh-cw"')).toBeLessThan(
      markup.indexOf('data-icon="square-pen"')
    );
    expect(markup.indexOf('data-icon="square-pen"')).toBeLessThan(
      markup.indexOf('data-testid="maximize"')
    );
    expect(markup).not.toContain("bg-border-2");
  });

  it("keeps search and actions in the page header during split view", () => {
    const markup = renderToStaticMarkup(
      React.createElement(WorkItemsPageHeader, {
        projectName: "Project",
        activeTab: "List",
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

    expect(markup).toContain('data-testid="inline-search"');
    expect(markup).toContain('data-icon="refresh-cw"');
    expect(markup).toContain('data-icon="square-pen"');
    expect(markup).toContain("h-9");
    expect(markup).not.toContain("h-[40px]");
  });

  it("renders tab-bar split controls as two left-list header rows", () => {
    const markup = renderToStaticMarkup(
      React.createElement(WorkItemsPageHeader, {
        projectName: "Project",
        activeTab: "List",
        splitListHeader: true,
        splitHeaderLeading: React.createElement(
          "span",
          { "data-testid": "work-dataset-work-items" },
          "Work Items"
        ),
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

    expect(markup).toContain('data-split-list-header="true"');
    expect(markup).toContain('data-split-list-header-row="primary"');
    expect(markup).toContain('data-split-list-header-row="secondary"');
    expect(markup).toContain('data-testid="work-dataset-work-items"');
    expect(markup).toContain('data-testid="inline-search"');
    expect(markup).toContain('class="flex min-w-0 items-center gap-px flex-1"');
  });
});

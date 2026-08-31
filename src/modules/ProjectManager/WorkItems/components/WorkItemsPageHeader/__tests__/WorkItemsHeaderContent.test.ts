import type { TFunction } from "i18next";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { WorkItemsHeaderContent } from "../WorkItemsHeaderContent";

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
        onRefreshClick: vi.fn(),
        t: ((key: string) => key) as unknown as TFunction<"projects">,
      })
    );

    expect(markup).toContain('data-testid="status-filter"');
    expect(markup).toContain('class="contents"');
    expect(markup).not.toContain('data-icon="chevron-right"');
    expect(markup).not.toContain('data-icon="box"');
  });
});

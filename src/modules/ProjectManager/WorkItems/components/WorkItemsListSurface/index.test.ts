import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { WorkItem } from "@src/types/core/workItem";

import WorkItemsListSurface from ".";

vi.mock("../WorkItemsListContent", () => ({
  default: () => createElement("div", { "data-testid": "work-items-list" }),
}));

const workItem = {
  session_id: "work-item-1",
  name: "Keep the list visible",
  status: "planned",
} as WorkItem;

describe("WorkItemsListSurface", () => {
  it("uses the compact Inbox list to the left of a selected detail", () => {
    const markup = renderToStaticMarkup(
      createElement(WorkItemsListSurface, {
        groupedWorkItems: [],
        filteredWorkItems: [workItem],
        selectedWorkItem: workItem,
        selectedWorkItemId: workItem.session_id,
        workItems: [workItem],
        availableMembers: [],
        onSelectWorkItem: vi.fn(),
        detailContent: createElement("div", {
          "data-testid": "work-item-detail",
        }),
      })
    );

    expect(markup).toContain(
      'data-testid="project-work-items-list-detail-layout"'
    );
    expect(markup).toContain('data-layout-mode="split"');
    expect(markup).toContain('data-testid="project-work-items-compact-list"');
    expect(markup).toContain('data-testid="work-item-compact-row"');
    expect(markup).not.toContain('data-compact-list-header="true"');
    expect(markup).not.toContain('data-testid="work-items-list"');
    expect(markup).toContain('data-testid="work-item-detail"');
    expect(markup).toContain('aria-orientation="vertical"');
  });

  it("keeps the compact list and an empty right holder before selection", () => {
    const markup = renderToStaticMarkup(
      createElement(WorkItemsListSurface, {
        groupedWorkItems: [],
        filteredWorkItems: [workItem],
        selectedWorkItem: null,
        selectedWorkItemId: null,
        workItems: [workItem],
        availableMembers: [],
        onSelectWorkItem: vi.fn(),
      })
    );

    expect(markup).toContain('data-layout-mode="split"');
    expect(markup).toContain('data-testid="project-work-items-compact-list"');
    expect(markup).toContain('data-testid="work-item-compact-row"');
    expect(markup).not.toContain('data-compact-list-header="true"');
    expect(markup).toContain('data-testid="work-items-detail-placeholder"');
    expect(markup).not.toContain('data-testid="work-items-list"');
    expect(markup).toContain('aria-orientation="vertical"');
  });

  it("restores the full list surface when expanded", () => {
    const markup = renderToStaticMarkup(
      createElement(WorkItemsListSurface, {
        groupedWorkItems: [],
        filteredWorkItems: [workItem],
        selectedWorkItem: null,
        selectedWorkItemId: null,
        workItems: [workItem],
        availableMembers: [],
        onSelectWorkItem: vi.fn(),
        listFullscreen: true,
      })
    );

    expect(markup).toContain('data-layout-mode="single"');
    expect(markup).toContain('data-testid="work-items-list"');
    expect(markup).not.toContain(
      'data-testid="project-work-items-compact-list"'
    );
    expect(markup).not.toContain('data-testid="work-item-compact-row"');
    expect(markup).not.toContain('data-testid="work-items-detail-placeholder"');
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { WorkItem } from "@src/types/core/workItem";

import EmbeddedWorkItemDetail from ".";

vi.mock("@src/components/Placeholder", () => ({
  Placeholder: ({
    variant,
    placement,
    fillParentHeight,
  }: {
    variant: string;
    placement?: string;
    fillParentHeight?: boolean;
  }) =>
    createElement("div", {
      "data-placeholder-variant": variant,
      "data-placeholder-placement": placement,
      "data-fill-parent-height": String(fillParentHeight),
    }),
}));

vi.mock("@src/modules/shared/components/DetailHeaderIconAction", () => ({
  default: ({ label, testId }: { label: string; testId?: string }) =>
    createElement("button", {
      type: "button",
      "aria-label": label,
      "data-testid": testId,
    }),
}));

vi.mock("../WorkItemDetail", () => ({
  WORK_ITEM_DETAIL_SURFACE: { nested: "nested" },
  default: () => null,
}));

describe("EmbeddedWorkItemDetail", () => {
  it("keeps its loading placeholder in the right detail pane", () => {
    const markup = renderToStaticMarkup(
      createElement(EmbeddedWorkItemDetail, {
        workItem: {
          session_id: "work-item-1",
          name: "Align loading state",
          status: "planned",
        } as WorkItem,
        onClose: vi.fn(),
        onNavigate: vi.fn(),
        hasPrev: false,
        hasNext: false,
        onUpdateWorkItem: vi.fn(),
        onDeleteWorkItem: vi.fn(async () => undefined),
        availableMembers: [],
        availableProjects: [],
        availableMilestones: [],
        availableLabels: [],
        onPendingChangesChange: vi.fn(),
        repoPath: null,
        projectSlug: null,
        shortId: null,
        onRefreshWorkItem: vi.fn(async () => undefined),
        breadcrumbProjectName: "Project",
        titleEditable: true,
        propertiesOpen: false,
        onToggleProperties: vi.fn(),
        publishHeaderToWorkstation: false,
      })
    );

    expect(markup).toContain('data-placeholder-variant="loading"');
    expect(markup).toContain('data-placeholder-placement="detail-panel"');
    expect(markup).toContain('data-fill-parent-height="true"');
    expect(markup).toContain('data-testid="work-item-close-detail"');
  });

  it("keeps an empty right detail holder mounted before a work item is selected", () => {
    const markup = renderToStaticMarkup(
      createElement(EmbeddedWorkItemDetail, {
        workItem: null,
        onClose: vi.fn(),
        onNavigate: vi.fn(),
        hasPrev: false,
        hasNext: false,
        onUpdateWorkItem: vi.fn(),
        onDeleteWorkItem: vi.fn(async () => undefined),
        availableMembers: [],
        availableProjects: [],
        availableMilestones: [],
        availableLabels: [],
        onPendingChangesChange: vi.fn(),
        repoPath: null,
        projectSlug: null,
        shortId: null,
        onRefreshWorkItem: vi.fn(async () => undefined),
        breadcrumbProjectName: "Project",
        titleEditable: true,
        propertiesOpen: false,
        onToggleProperties: vi.fn(),
        publishHeaderToWorkstation: false,
      })
    );

    expect(markup).toContain('data-testid="work-item-detail-placeholder"');
    expect(markup).toContain('data-placeholder-variant="empty"');
    expect(markup).toContain('data-placeholder-placement="detail-panel"');
  });
});

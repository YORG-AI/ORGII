import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { WorkItem } from "@src/types/core/workItem";

import {
  WorkItemDetailHeaderActions,
  WorkItemDetailHeaderBreadcrumb,
} from "./WorkItemDetailHeader";

vi.mock("@src/components/IntegrationIcon", () => ({
  default: ({ type, size }: { type: string; size: number }) =>
    React.createElement("span", {
      "data-integration-icon": type,
      "data-icon-size": size,
    }),
}));

vi.mock("@src/components/KeyboardShortcut/ToolbarTooltip", () => ({
  ToolbarTooltip: ({ children }: { children: React.ReactNode }) => children,
}));

describe("WorkItemDetailHeaderBreadcrumb", () => {
  it("shares GitHub identity, number formatting, full title, and back behavior", () => {
    const title =
      "community: Join our Discord / WeChat channels and share feedback";
    const workItem = {
      session_id: "issue-128",
      name: title,
      status: "open",
      workItemStatus: "open",
    } as WorkItem;

    const markup = renderToStaticMarkup(
      React.createElement(WorkItemDetailHeaderBreadcrumb, {
        workItem,
        breadcrumbProjectName: "ORGII issues",
        shortId: "128",
        onClose: vi.fn(),
        t: (key: string) => key,
      })
    );

    expect(markup).toContain('data-integration-icon="github"');
    expect(markup).toContain("ORG #128 ·");
    expect(markup).toContain(title);
    expect(markup).toContain('role="button"');
    expect(markup).toContain("flex-1 whitespace-nowrap");
  });

  it("preserves the full clickable parent hierarchy in detail views", () => {
    const workItem = {
      session_id: "work-item-1",
      name: "Ship unified breadcrumbs",
      status: "planned",
      workItemStatus: "planned",
    } as WorkItem;

    const markup = renderToStaticMarkup(
      React.createElement(WorkItemDetailHeaderBreadcrumb, {
        workItem,
        breadcrumbSegments: [
          { label: "Projects", onClick: vi.fn() },
          { label: "Navigation cleanup" },
        ],
        breadcrumbProjectName: "Navigation cleanup",
        shortId: "ORG #42",
        onClose: vi.fn(),
        t: (key: string) => key,
      })
    );

    expect(markup.indexOf("Projects")).toBeLessThan(
      markup.indexOf("Navigation cleanup")
    );
    expect(markup.indexOf("Navigation cleanup")).toBeLessThan(
      markup.indexOf("Ship unified breadcrumbs")
    );
    expect(markup.match(/role="button"/g)).toHaveLength(2);
  });
});

describe("WorkItemDetailHeaderActions", () => {
  it("omits the redundant open-in-new-tab action", () => {
    const workItem = {
      session_id: "work-item-1",
      name: "Ship dedicated tabs",
      status: "planned",
    } as WorkItem;
    const markup = renderToStaticMarkup(
      React.createElement(WorkItemDetailHeaderActions, {
        workItem,
        propertiesOpen: true,
        hasPrev: false,
        hasNext: false,
        onNavigate: vi.fn(),
        onDeleteWorkItem: vi.fn(),
        t: (key: string) => key,
      })
    );

    expect(markup).toContain('data-icon="trash-2"');
    expect(markup).not.toContain('data-icon="square-arrow-out-up-right"');
    expect(markup).not.toContain("common:actions.openInNewTab");
  });
});

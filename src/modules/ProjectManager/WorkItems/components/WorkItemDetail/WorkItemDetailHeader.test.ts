import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { WorkItem } from "@src/types/core/workItem";

import { WorkItemDetailHeaderBreadcrumb } from "./WorkItemDetailHeader";

vi.mock("@src/components/IntegrationIcon", () => ({
  default: ({ type, size }: { type: string; size: number }) =>
    React.createElement("span", {
      "data-integration-icon": type,
      "data-icon-size": size,
    }),
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
    expect(markup).toContain("ORG#128 ·");
    expect(markup).toContain(title);
    expect(markup).toContain('role="button"');
    expect(markup).toContain("flex-1 whitespace-nowrap");
  });
});

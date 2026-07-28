import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { WorkItem } from "@src/types/core/workItem";

import WorkItemThreadSurface from "../index";

vi.mock("../../WorkItemContent", () => ({
  default: ({
    presentation,
    headerProperties,
  }: {
    presentation?: string;
    headerProperties?: React.ReactNode;
  }) =>
    createElement(
      "div",
      {
        "data-testid": "work-item-content",
        "data-presentation": presentation,
      },
      headerProperties
    ),
}));

vi.mock("../../WorkItemProperties", () => ({
  WORK_ITEM_THREAD_PROPERTY_FIELDS: [
    "project",
    "status",
    "priority",
    "assignee",
    "reviewer",
    "date",
  ],
  default: ({
    fieldVariant,
    pillLayout,
    visibleFields,
    showMoreMenu,
  }: {
    fieldVariant?: string;
    pillLayout?: string;
    visibleFields?: string[];
    showMoreMenu?: boolean;
  }) =>
    createElement("div", {
      "data-testid": "work-item-properties",
      "data-field-variant": fieldVariant,
      "data-pill-layout": pillLayout,
      "data-visible-fields": visibleFields?.join(","),
      "data-show-more": String(showMoreMenu),
    }),
}));

const workItem = {
  session_id: "work-item-1",
  user_id: "member-1",
  name: "Unify Work Item surfaces",
  status: "backlog",
  star: false,
  target_date: null,
  created_time: "2026-07-28T00:00:00.000Z",
  updated_time: "2026-07-28T00:00:00.000Z",
} as WorkItem;

describe("WorkItemThreadSurface", () => {
  it("enforces the canonical thread presentation and responsive metadata", () => {
    const markup = renderToStaticMarkup(
      createElement(WorkItemThreadSurface, {
        workItem,
        propertyProps: {
          onUpdate: vi.fn(),
        },
      })
    );

    expect(markup).toContain('data-presentation="thread"');
    expect(markup).toContain('data-field-variant="pill"');
    expect(markup).toContain('data-pill-layout="wrap"');
    expect(markup).toContain(
      'data-visible-fields="project,status,priority,assignee,reviewer,date"'
    );
    expect(markup).toContain('data-show-more="true"');
  });

  it("keeps read-only threads usable when no property source exists", () => {
    const markup = renderToStaticMarkup(
      createElement(WorkItemThreadSurface, { workItem })
    );

    expect(markup).toContain('data-presentation="thread"');
    expect(markup).not.toContain('data-testid="work-item-properties"');
  });
});

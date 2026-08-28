import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { WorkItemData } from "@src/api/http/project";

import {
  getSubItemProgress,
  getSubItemStageNumbers,
  getSubItemVisualState,
  groupSubItemsByStage,
} from "./WorkItemSubItems";
import WorkItemSubItems from "./WorkItemSubItems";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (
      key: string,
      options?: { defaultValue?: string; [key: string]: unknown }
    ) => {
      const template = options?.defaultValue ?? key;
      return Object.entries(options ?? {}).reduce(
        (value, [optionKey, optionValue]) =>
          value.split(`{{${optionKey}}}`).join(String(optionValue)),
        template
      );
    },
  }),
}));

function child(
  shortId: string,
  stage?: number,
  status = "planned",
  title = shortId
): WorkItemData {
  return {
    body: "",
    filename: `${shortId}.md`,
    frontmatter: {
      id: shortId,
      short_id: shortId,
      title,
      status,
      priority: "none",
      labels: [],
      stage,
      created_at: "2026-08-08T00:00:00.000Z",
      updated_at: "2026-08-08T00:00:00.000Z",
      starred: false,
      todos: [],
    },
  };
}

describe("WorkItemSubItems stage model", () => {
  it("offers stage 1 for a parent without staged children", () => {
    expect(getSubItemStageNumbers([])).toEqual([1]);
    expect(getSubItemStageNumbers([child("WI-0002")])).toEqual([1]);
  });

  it("offers every existing stage plus the next sequential stage", () => {
    expect(
      getSubItemStageNumbers([
        child("WI-0002", 1),
        child("WI-0003", 3),
        child("WI-0004"),
      ])
    ).toEqual([1, 2, 3, 4]);
  });

  it("keeps unstaged children after ordered stage groups", () => {
    expect(
      groupSubItemsByStage([
        child("WI-0002"),
        child("WI-0003", 2),
        child("WI-0004", 1),
      ]).map((group) => group.label)
    ).toEqual(["Stage 1", "Stage 2", "No stage"]);
  });

  it("maps issue statuses to open, completed, and cancelled presentation states", () => {
    expect(getSubItemVisualState("in_progress")).toBe("open");
    expect(getSubItemVisualState("completed")).toBe("completed");
    expect(getSubItemVisualState("closed")).toBe("completed");
    expect(getSubItemVisualState("cancelled")).toBe("cancelled");
  });

  it("reports closed children as completion progress", () => {
    expect(
      getSubItemProgress([
        child("WI-0002", undefined, "planned"),
        child("WI-0003", undefined, "completed"),
        child("WI-0004", undefined, "cancelled"),
      ])
    ).toEqual({ completed: 2, total: 3 });
  });
});

describe("WorkItemSubItems hierarchy UI", () => {
  it("renders the completion summary, semantic rows, and the parent title without a progress bar", () => {
    const markup = renderToStaticMarkup(
      React.createElement(WorkItemSubItems, {
        family: {
          parent: child(
            "WI-0001",
            undefined,
            "in_progress",
            "Parent issue title"
          ),
          children: [
            child("WI-0002", undefined, "planned", "Open child"),
            child("WI-0003", undefined, "completed", "Finished child"),
            child("WI-0004", undefined, "cancelled", "Cancelled child"),
          ],
        },
        parentShortId: "WI-0001",
        onOpenWorkItem: vi.fn(),
      })
    );

    expect(markup).toContain("2 of 3 completed");
    expect(markup).not.toContain('role="progressbar"');
    expect(markup).not.toContain("work-item-sub-items-progress");
    expect(markup).toContain('data-sub-item-state="open"');
    expect(markup).toContain('data-sub-item-state="completed"');
    expect(markup).toContain('data-sub-item-state="cancelled"');
    expect(markup).toContain("Parent issue title");
    expect(markup).toContain("Finished child");
  });

  it("does not show a gray progress track for zero completed sub-items", () => {
    const markup = renderToStaticMarkup(
      React.createElement(WorkItemSubItems, {
        family: {
          parent: null,
          children: [child("WI-0002", undefined, "planned", "Open child")],
        },
        parentShortId: "WI-0001",
      })
    );

    expect(markup).toContain("0 of 1 completed");
    expect(markup).not.toContain('role="progressbar"');
    expect(markup).not.toContain("work-item-sub-items-progress");
  });

  it("uses the shared card padding and todo row rhythm", () => {
    const markup = renderToStaticMarkup(
      React.createElement(WorkItemSubItems, {
        family: {
          parent: null,
          children: [child("WI-0002", 1, "planned", "Open child")],
        },
        parentShortId: "WI-0001",
        onOpenWorkItem: vi.fn(),
      })
    );

    expect(markup).toContain("bg-chat-pane px-3 py-2");
    expect(markup).toContain("flex flex-col gap-0.5");
    expect(markup).toContain("min-h-8 w-full");
    expect(markup).toContain("px-0 py-1");
    expect(markup).toContain("max-h-64 overflow-y-auto");
    expect(markup).not.toContain("!p-0");
    expect(markup).not.toContain("min-h-9");
    expect(markup).not.toContain("px-3 pb-3");
  });

  it("uses aligned icon-only add actions in headers and empty states", () => {
    const markup = renderToStaticMarkup(
      React.createElement(WorkItemSubItems, {
        family: { parent: null, children: [] },
        parentShortId: "WI-0001",
      })
    );
    const headerButton = markup.match(
      /<button[^>]*data-testid="work-item-sub-item-add"[^>]*>(.*?)<\/button>/
    )?.[1];
    const emptyButton = markup.match(
      /<button[^>]*data-testid="work-item-sub-items-empty-add"[^>]*>(.*?)<\/button>/
    )?.[1];

    expect(headerButton).toContain('data-icon="plus"');
    expect(headerButton).not.toContain("Add sub-item");
    expect(emptyButton).toContain('data-icon="plus"');
    expect(emptyButton).not.toContain("Add the first sub-item");
    expect(markup).toContain('aria-label="Add sub-item"');
    expect(markup).toContain('title="Add sub-item"');
  });
});

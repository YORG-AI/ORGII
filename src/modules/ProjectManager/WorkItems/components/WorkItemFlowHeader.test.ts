// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { WorkItem } from "@src/types/core/workItem";

import WorkItemFlowHeader from "./WorkItemFlowHeader";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) => {
      if (typeof fallback === "string") return fallback;
      if (typeof fallback?.defaultValue !== "string") return key;
      const count = Number(fallback.count ?? 0);
      const template =
        count === 1 || typeof fallback.defaultValue_other !== "string"
          ? fallback.defaultValue
          : fallback.defaultValue_other;
      return template.replace("{{count}}", String(count));
    },
    i18n: { resolvedLanguage: "en" },
  }),
}));

const workItem = {
  session_id: "work-item-1",
  shortId: "ORG-047",
  user_id: "harry19081",
  name: "Use the complete Work Item title without truncating the text in any detail surface",
  status: "in_progress",
  spec: "",
  star: false,
  target_date: null,
  created_time: "2026-09-03T08:00:00.000Z",
  updated_time: "2026-09-03T08:00:00.000Z",
  comments: [{ id: "comment-1" }, { id: "comment-2" }],
  createdBy: {
    id: "harry19081",
    name: "Harry",
    avatar: "https://example.com/harry.png",
  },
} as unknown as WorkItem;

describe("WorkItemFlowHeader", () => {
  it("uses the PR title hierarchy and keeps the full title wrapping", () => {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(
      createElement(WorkItemFlowHeader, { workItem })
    );

    const title = container.querySelector(
      "[data-testid='work-item-flow-title']"
    );
    expect(title?.tagName).toBe("H2");
    expect(title?.textContent).toContain(workItem.name);
    expect(title?.textContent).toContain("ORG-047");
    expect(title?.className).toContain("text-[20px]");
    expect(title?.className).not.toContain("truncate");
    expect(title?.className).not.toContain("line-clamp");

    const subline = container.querySelector(
      "[data-testid='work-item-flow-subline']"
    );
    expect(subline?.textContent).toContain("Harry");
    expect(subline?.textContent).toContain("opened this work item");
    expect(subline?.textContent).toContain("2 comments");
  });
});

// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { GitHubIssue } from "@src/api/tauri/github";

import { GitHubIssueFlowHeader } from "./GitHubIssueFlowHeader";

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

const issue = {
  id: 1,
  number: 1002,
  title: "fix(chat): preserve reader position during streaming updates",
  body: "",
  state: "open",
  state_reason: null,
  html_url: "https://github.com/org2AI/ORG2/issues/1002",
  created_at: "2026-08-26T14:39:00.000Z",
  updated_at: "2026-08-26T14:39:00.000Z",
  closed_at: null,
  user: {
    login: "ShiboSheng",
    avatar_url: "https://example.com/shibo.png",
  },
  labels: [],
  assignees: [],
  comments: 3,
  milestone: null,
} as unknown as GitHubIssue;

describe("GitHubIssueFlowHeader", () => {
  it("uses the pull-request flow-title format for an open issue", () => {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(
      createElement(GitHubIssueFlowHeader, { issue })
    );

    const title = container.querySelector("[data-testid='issue-flow-title']");
    expect(title?.tagName).toBe("H2");
    expect(title?.className).toContain("text-[20px]");
    expect(title?.textContent).toContain(
      "fix(chat): preserve reader position during streaming updates"
    );
    expect(title?.textContent).toContain("#1002");

    const status = container.querySelector("[data-testid='issue-flow-status']");
    expect(status?.textContent).toContain("Open");
    expect(status?.firstElementChild?.className).toContain("bg-success-1");
    expect(status?.querySelector('[data-icon="circle-dot"]')).not.toBeNull();

    const subline = container.querySelector(
      "[data-testid='issue-flow-subline']"
    );
    expect(subline?.textContent).toContain("ShiboSheng");
    expect(subline?.querySelector("img")?.getAttribute("src")).toBe(
      "https://example.com/shibo.png"
    );
    expect(subline?.textContent).toContain("opened this issue");
    expect(subline?.textContent).toContain("3 comments");
    expect(subline?.querySelector("time")?.getAttribute("datetime")).toBe(
      "2026-08-26T14:39:00.000Z"
    );
  });

  it("switches the status pill to the closed treatment", () => {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(
      createElement(GitHubIssueFlowHeader, {
        issue: { ...issue, state: "closed", comments: 1 },
      })
    );

    const status = container.querySelector("[data-testid='issue-flow-status']");
    expect(status?.textContent).toContain("Closed");
    expect(status?.firstElementChild?.className).toContain("bg-purple-1");
    expect(
      status?.querySelector('[data-icon="check-circle-2"]')
    ).not.toBeNull();
    expect(
      container.querySelector("[data-testid='issue-flow-subline']")?.textContent
    ).toContain("1 comment");
  });
});

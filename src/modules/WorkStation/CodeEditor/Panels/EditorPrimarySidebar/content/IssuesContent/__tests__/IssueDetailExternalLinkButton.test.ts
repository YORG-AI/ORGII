import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { GitHubIssue } from "@src/api/tauri/github";

import {
  IssueDetailExternalLinkButton,
  IssueDetailPanel,
  IssueTimelineItems,
} from "../IssueDetailPanel";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | Record<string, unknown>) => {
      if (typeof fallback === "string") return fallback;
      if (typeof fallback?.defaultValue !== "string") return key;

      const template =
        fallback.count === 1 || typeof fallback.defaultValue_other !== "string"
          ? fallback.defaultValue
          : fallback.defaultValue_other;
      return template.replace(/{{(\w+)}}/g, (_, name: string) =>
        String(fallback[name] ?? "")
      );
    },
  }),
}));

const issue: GitHubIssue = {
  number: 42,
  title: "Match the comment composer",
  body: "Issue body",
  state: "open",
  state_reason: null,
  html_url: "https://github.com/openai/example/issues/42",
  created_at: "2026-07-21T12:00:00.000Z",
  updated_at: "2026-07-21T12:00:00.000Z",
  closed_at: null,
  user: { login: "octocat", avatar_url: "" },
  labels: [],
  assignees: [],
  comments: 0,
  milestone: null,
};

describe("IssueDetailExternalLinkButton", () => {
  it("renders a tertiary globe action for the specific GitHub issue", () => {
    const markup = renderToStaticMarkup(
      createElement(IssueDetailExternalLinkButton, { issue })
    );

    expect(markup).toContain(
      'href="https://github.com/openai/example/issues/42"'
    );
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('aria-label="Open on GitHub"');
    expect(markup).toContain('class="lucide lucide-globe');
    expect(markup).toContain("enabled:hover:bg-surface-hover");
  });

  it("uses the shared textarea and session-creator button dimensions", () => {
    const markup = renderToStaticMarkup(
      createElement(IssueDetailPanel, {
        issue,
        timeline: [],
        timelineLoading: false,
        submittingComment: false,
        showHeader: false,
        onClose: vi.fn(),
        onCloseIssue: vi.fn(),
        onReopenIssue: vi.fn(),
        onAddComment: vi.fn().mockResolvedValue(undefined),
      })
    );

    expect(markup).toContain('<textarea placeholder="Leave a comment…"');
    expect(markup).toContain('data-testid="issue-comment-editor"');
    expect(markup).toContain("textarea-size-default");
    expect(markup).not.toContain("rich-markdown-editor");
    expect(markup).toContain(
      "flex min-h-9 items-center justify-between gap-1 px-1"
    );
    expect(markup.match(/border-radius:100px/g)).toHaveLength(2);
    expect(markup.match(/height:28px/g)).toHaveLength(2);
    expect(markup.match(/padding:0 12px/g)).toHaveLength(2);
  });

  it("shares GitHub comments and activity events as one timeline block", () => {
    const markup = renderToStaticMarkup(
      createElement(IssueTimelineItems, {
        timelineLoading: false,
        timeline: [
          {
            id: 1,
            event: "commented",
            created_at: "2026-07-21T13:00:00.000Z",
            actor: { login: "ada", avatar_url: "" },
            body: "A GitHub comment",
            html_url: null,
            assignee: null,
            label: null,
            milestone: null,
            rename: null,
            source: null,
            commit_id: null,
            lock_reason: null,
          },
          {
            id: 2,
            event: "assigned",
            created_at: "2026-07-21T14:00:00.000Z",
            actor: { login: "grace", avatar_url: "" },
            body: null,
            html_url: null,
            assignee: null,
            label: null,
            milestone: null,
            rename: null,
            source: null,
            commit_id: null,
            lock_reason: null,
          },
        ],
      })
    );

    expect(markup).toContain("ada");
    expect(markup).toContain("commented");
    expect(markup).toContain("grace");
    expect(markup).toContain("assigned this issue");
  });
});

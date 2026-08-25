// @vitest-environment jsdom
import { type ReactNode, createElement, forwardRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { GitHubIssue } from "@src/api/tauri/github";
import { buildCloudSessionReference } from "@src/features/Org2Cloud/cloudSessionReference";
import type { GitHubIssueInteractionConfig } from "@src/modules/ProjectManager/WorkItems/components/WorkItemContent/types";

import {
  IssueDetailExternalLinkButton,
  IssueDetailPanel,
} from "../IssueDetailPanel";
import { IssueTimelineItems } from "../IssueTimelineItems";

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

vi.mock("@src/components/IntegrationIcon", () => ({
  default: ({ type }: { type: string }) =>
    createElement("span", { "data-integration-icon": type }),
}));

vi.mock("@src/components/Tooltip", () => ({
  default: ({ children }: { children: ReactNode }) => children,
}));

// The product renderer is lazy-loaded behind Suspense. These server-rendered
// structure tests need a synchronous leaf so React 19 does not abort static
// markup generation while the dynamic Markdown chunk is loading.
vi.mock("@src/components/MarkDown", () => ({
  default: ({ textContent }: { textContent: string }) =>
    createElement("div", { "data-testid": "markdown" }, textContent),
}));

vi.mock("@src/modules/shared/components/MarkdownTextareaEditor", () => ({
  default: forwardRef(function MockMarkdownTextareaEditor(
    {
      appearance,
      dataTestId,
      placeholder,
    }: {
      appearance?: string;
      dataTestId?: string;
      placeholder?: string;
    },
    _ref
  ) {
    return createElement("div", {
      className: "markdown-textarea-editor",
      "data-testid": dataTestId,
      "data-appearance": appearance,
      "data-placeholder": placeholder,
      "data-editor-kind": "write-preview",
    });
  }),
}));

const issue: GitHubIssue = {
  id: 100_042,
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
  assignees: [{ login: "reviewer", avatar_url: "" }],
  comments: 0,
  milestone: null,
};

function createInteraction(): GitHubIssueInteractionConfig {
  return {
    viewer: issue.user,
    issueState: issue.state,
    duplicateCandidates: [],
    duplicateCandidatesLoaded: false,
    loadingDuplicateCandidates: false,
    duplicateCandidatesError: false,
    loading: false,
    canComment: true,
    canEditBody: true,
    canManageStatus: true,
    submittingComment: false,
    updatingBody: false,
    updatingStatus: false,
    error: null,
    onAddComment: vi.fn().mockResolvedValue(undefined),
    onUpdateBody: vi.fn().mockResolvedValue(undefined),
    onLoadDuplicateCandidates: vi.fn().mockResolvedValue(undefined),
    onStatusChange: vi.fn().mockResolvedValue(undefined),
  };
}

describe("IssueDetailExternalLinkButton", () => {
  it("renders a Chrome external-browser action for the specific GitHub issue", () => {
    const markup = renderToStaticMarkup(
      createElement(IssueDetailExternalLinkButton, { issue })
    );

    expect(markup).toContain('<button type="button"');
    expect(markup).toContain('aria-label="Open in external browser"');
    expect(markup).toContain('class="lucide lucide-chromium');
    expect(markup).toContain("enabled:hover:bg-surface-hover");
    expect(markup).toContain("enabled:active:bg-surface-selected");
    expect(markup).not.toContain("<a ");
  });

  it("uses the same inline Markdown issue UI as Inbox", () => {
    const markup = renderToStaticMarkup(
      createElement(IssueDetailPanel, {
        issue,
        timeline: [],
        timelineLoading: false,
        interaction: createInteraction(),
        showHeader: false,
      })
    );

    expect(markup).toContain('data-testid="github-issue-inline-composer"');
    expect(markup).toContain('data-testid="github-issue-comment-editor"');
    expect(markup).toContain('data-testid="work-item-thread-section"');
    expect(markup).toContain('data-testid="work-item-property-pills"');
    expect(markup).not.toContain("example issues");
    expect(markup).toContain("reviewer");
    expect(markup).toContain('data-appearance="plain"');
    expect(markup).toContain('data-editor-kind="write-preview"');
    expect(markup).toContain("markdown-textarea-editor");
    expect(markup).not.toContain('data-testid="issue-comment-editor"');
    expect(markup).not.toContain(
      'data-testid="work-item-thread-secondary-navigation"'
    );
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

  it("labels a session-only timeline entry as an appended session", () => {
    const body = buildCloudSessionReference({
      orgId: "org-1",
      ownerUserId: "owner-1",
      sourceSessionId: "session-1",
    });
    const markup = renderToStaticMarkup(
      createElement(IssueTimelineItems, {
        timelineLoading: false,
        timeline: [
          {
            id: 3,
            event: "commented",
            created_at: "2026-07-21T15:00:00.000Z",
            actor: { login: "lin", avatar_url: "" },
            body,
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

    expect(markup).toContain("appended a session");
    expect(markup).not.toContain(">commented<");
  });
});

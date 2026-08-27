import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { GitHubIssue } from "@src/api/tauri/github";

import GitHubIssueThreadSurface, {
  mapGitHubIssueToThreadWorkItem,
} from "./GitHubIssueThreadSurface";
import type { GitHubIssueInteractionConfig } from "./WorkItemContent/types";
import { toggleExternalAssigneeIds } from "./WorkItemProperties/AssigneePropertyField";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@src/components/IntegrationIcon", () => ({
  default: ({ type }: { type: string }) =>
    React.createElement("span", { "data-integration-icon": type }),
}));

// The product renderer is lazy-loaded behind Suspense. These server-rendered
// structure tests need a synchronous leaf so React 19 does not abort static
// markup generation while the dynamic Markdown chunk is loading.
vi.mock("@src/components/MarkDown", () => ({
  default: ({ textContent }: { textContent: string }) =>
    React.createElement("div", { "data-testid": "markdown" }, textContent),
}));

vi.mock("@src/modules/shared/components/MarkdownTextareaEditor", () => ({
  default: ({ dataTestId }: { dataTestId?: string }) =>
    React.createElement("div", { "data-testid": dataTestId }),
}));

const issue: GitHubIssue = {
  id: 100_042,
  number: 42,
  title: "Use one issue detail surface",
  body: "Share the Inbox thread composition.",
  state: "open",
  state_reason: null,
  html_url: "https://github.com/org2AI/ORG2/issues/42",
  created_at: "2026-08-04T10:00:00.000Z",
  updated_at: "2026-08-04T11:00:00.000Z",
  closed_at: null,
  user: {
    login: "octocat",
    avatar_url: "https://example.com/octocat.png",
  },
  labels: [
    {
      id: 7,
      name: "ui",
      color: "1d76db",
      description: null,
    },
  ],
  assignees: [
    {
      login: "reviewer",
      avatar_url: "https://example.com/reviewer.png",
    },
  ],
  comments: 1,
  milestone: "v1",
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

describe("mapGitHubIssueToThreadWorkItem", () => {
  it("preserves GitHub identity and metadata for the canonical thread", () => {
    expect(mapGitHubIssueToThreadWorkItem(issue)).toMatchObject({
      session_id: issue.html_url,
      shortId: "#42",
      name: issue.title,
      spec: issue.body,
      status: "open",
      workItemStatus: "open",
      createdBy: {
        id: "octocat",
        name: "octocat",
        avatar: "https://example.com/octocat.png",
      },
      assignee: {
        id: "reviewer",
        name: "reviewer",
        avatar: "https://example.com/reviewer.png",
      },
      labels: [{ id: "7", name: "ui", color: "#1d76db" }],
      milestone: { id: "v1", name: "v1" },
    });
  });

  it("keeps the thread usable without optional assignee and milestone data", () => {
    expect(
      mapGitHubIssueToThreadWorkItem({
        ...issue,
        assignees: [],
        milestone: null,
      })
    ).toMatchObject({
      assignee: undefined,
      milestone: undefined,
    });
  });

  it("renders the external GitHub assignee control as editable", () => {
    const markup = renderToStaticMarkup(
      React.createElement(GitHubIssueThreadSurface, {
        issue,
        timeline: [],
        timelineLoading: false,
        interaction: createInteraction(),
        assigneeConfig: {
          currentAssigneeIds: ["reviewer"],
          options: [
            {
              id: "reviewer",
              label: "reviewer",
              avatar: "https://example.com/reviewer.png",
            },
          ],
          onChangeAssigneeIds: vi.fn(),
        },
      })
    );
    const assigneeStart = markup.indexOf(
      `data-testid="work-item-property-assignee-${issue.html_url}"`
    );
    const assigneeButton = markup.slice(
      assigneeStart,
      markup.indexOf("</button>", assigneeStart)
    );

    expect(assigneeStart).toBeGreaterThan(-1);
    expect(assigneeButton).toContain("reviewer");
    expect(assigneeButton).toContain("https://example.com/reviewer.png");
    expect(assigneeButton).not.toContain("disabled");
  });

  it("omits the redundant repository field from GitHub issue metadata", () => {
    const markup = renderToStaticMarkup(
      React.createElement(GitHubIssueThreadSurface, {
        issue,
        timeline: [],
        timelineLoading: false,
        interaction: createInteraction(),
      })
    );

    expect(markup).not.toContain("ORG2 issues");
    expect(markup).toContain(
      `data-testid="work-item-property-status-${issue.html_url}"`
    );
    expect(markup).toContain('data-testid="github-issue-inline-composer"');
    expect(markup).toContain('data-testid="work-item-thread-floating-footer"');
    expect(markup).toContain("padding-bottom:240px");
    expect(markup).not.toContain(
      'data-testid="work-item-thread-secondary-navigation"'
    );
  });

  it("contributes semantic stops to the shared issue and work-item trail", () => {
    const markup = renderToStaticMarkup(
      React.createElement(GitHubIssueThreadSurface, {
        issue,
        timeline: [],
        timelineLoading: false,
        interaction: createInteraction(),
      })
    );

    expect(markup).toContain("data-scroll-trail-target");
    expect(markup).toContain(
      'data-scroll-trail-label="Use one issue detail surface"'
    );
    // Description and sub-items are the semantic stops a GitHub issue thread
    // contributes; the To-Do stop was removed with the To-Do section itself.
    expect(
      markup.match(/data-scroll-trail-target/g)?.length
    ).toBeGreaterThanOrEqual(2);
  });

  it("toggles external assignees without duplicating login casing", () => {
    expect(toggleExternalAssigneeIds(["Ada", "Grace"], "ada")).toEqual([
      "Grace",
    ]);
    expect(toggleExternalAssigneeIds(["Ada"], "Linus")).toEqual([
      "Ada",
      "Linus",
    ]);
  });
});

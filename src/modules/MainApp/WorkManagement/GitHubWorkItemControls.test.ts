import { type ReactNode, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  IssuePersonalFilterDropdown,
  ManagedIssueActionsCell,
  ManagedIssueAssigneeCell,
  ManagedIssueContextMeta,
  ManagedPrActionsCell,
  toggleIssueAssigneeLogins,
} from "./GitHubWorkItemControls";
import {
  GITHUB_ITEM_KIND,
  type ManagedIssueItem,
  type ManagedPrItem,
} from "./githubManagedItemModel";

vi.mock("@src/components/KeyboardShortcut/ToolbarTooltip", () => ({
  ToolbarTooltip: ({
    children,
    label,
  }: {
    children: ReactNode;
    label: string;
  }) => createElement("span", { "data-tooltip-label": label }, children),
}));

const linkedIssue: ManagedIssueItem = {
  kind: GITHUB_ITEM_KIND.ISSUE,
  id: 42,
  title: "Fix linked pull request visibility",
  repo: "org2ai/ORG2",
  repoPath: "/workspace/ORG2",
  remoteUrl: "https://github.com/org2ai/ORG2.git",
  viewerLogin: "viewer",
  rawIssue: {
    id: 100_042,
    number: 42,
    title: "Fix linked pull request visibility",
    body: null,
    state: "open",
    state_reason: null,
    html_url: "https://github.com/org2ai/ORG2/issues/42",
    created_at: "2026-07-21T08:00:00Z",
    updated_at: "2026-07-21T08:10:00Z",
    closed_at: null,
    user: { login: "junyu", avatar_url: "https://example.com/avatar.png" },
    labels: [],
    assignees: [],
    comments: 4,
    linked_pull_requests_count: 2,
    milestone: null,
  },
  author: "junyu",
  timeAgo: "10m",
  state: "open",
  labels: [],
  comments: 4,
  linkedPullRequests: 2,
  updatedAt: "2026-07-21T08:10:00Z",
};

const draftPr: ManagedPrItem = {
  kind: GITHUB_ITEM_KIND.PR,
  id: 465,
  title: "Consolidate audited workspace refactors",
  repo: "org2ai/ORG2",
  repoId: "repo-1",
  repoPath: "/workspace/ORG2",
  remoteUrl: "https://github.com/org2ai/ORG2.git",
  viewerLogin: "viewer",
  rawPr: {
    number: 465,
    url: "https://github.com/org2ai/ORG2/pull/465",
    title: "Consolidate audited workspace refactors",
    state: "open",
    author_login: "junyu",
    author_avatar_url: "https://example.com/avatar.png",
    requested_reviewer_logins: [],
    head_branch: "audit-workspace",
    base_branch: "develop",
    draft: true,
    ci_status: "pending",
    created_at: "2026-07-21T08:00:00Z",
    updated_at: "2026-07-21T08:10:00Z",
  },
  author: "junyu",
  authoredByViewer: false,
  reviewRequestedFromViewer: false,
  timeAgo: "10m",
  state: "open",
  sourceBranch: "audit-workspace",
  targetBranch: "develop",
  updatedAt: "2026-07-21T08:10:00Z",
};

describe("ManagedIssueContextMeta", () => {
  it("shows linked pull requests and comments before context tags", () => {
    const markup = renderToStaticMarkup(
      createElement(ManagedIssueContextMeta, {
        issue: linkedIssue,
      })
    );

    expect(markup).toContain('data-icon="git-pull-request"');
    expect(markup).toContain('data-icon="message-circle"');
    expect(markup).toContain("text-text-1");
    expect(markup).toContain(">2<");
    expect(markup).toContain(">4<");
  });
});

describe("ManagedIssueAssigneeCell", () => {
  it("toggles one assignee without dropping the others", () => {
    const assignees = [
      { login: "ada", avatar_url: "ada.png" },
      { login: "grace", avatar_url: "grace.png" },
    ];

    expect(toggleIssueAssigneeLogins(assignees, "GRACE")).toEqual(["ada"]);
    expect(toggleIssueAssigneeLogins(assignees, "linus")).toEqual([
      "ada",
      "grace",
      "linus",
    ]);
  });

  it("renders a larger avatar-only issue-assignee trigger", () => {
    const markup = renderToStaticMarkup(
      createElement(ManagedIssueAssigneeCell, {
        issue: {
          ...linkedIssue,
          rawIssue: {
            ...linkedIssue.rawIssue,
            assignees: [
              { login: "octocat", avatar_url: "https://example.com/o.png" },
            ],
          },
        },
        assignableUsers: [],
        canManage: true,
        loading: false,
        loadError: null,
        updating: false,
        noneLabel: "None",
        loadingLabel: "Loading...",
        searchPlaceholder: "Search...",
        readonlyReason: "No permission",
        onOpen: vi.fn(),
        onChange: vi.fn(),
      })
    );

    expect(markup).toContain('aria-label="octocat"');
    expect(markup).toContain("width:24px;height:24px");
    expect(markup).toContain("https://example.com/o.png");
    expect(markup).toContain('data-icon="chevron-down"');
    expect(markup).toContain("bg-fill-1");
    expect(markup).toContain("enabled:hover:bg-fill-2");
    expect(markup).toContain("hover:border-border-3");
    expect(markup).toContain("w-12");
    expect(markup).toContain("px-px");
  });

  it("keeps the full assignee pill styling while an update is pending", () => {
    const markup = renderToStaticMarkup(
      createElement(ManagedIssueAssigneeCell, {
        issue: {
          ...linkedIssue,
          rawIssue: {
            ...linkedIssue.rawIssue,
            assignees: [
              { login: "octocat", avatar_url: "https://example.com/o.png" },
            ],
          },
        },
        assignableUsers: [],
        canManage: true,
        loading: false,
        loadError: null,
        updating: true,
        noneLabel: "None",
        loadingLabel: "Loading...",
        searchPlaceholder: "Search...",
        readonlyReason: "No permission",
        onOpen: vi.fn(),
        onChange: vi.fn(),
      })
    );

    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toContain('data-icon="chevron-down"');
    expect(markup).toContain("bg-fill-1");
    expect(markup).toContain("w-12");
    expect(markup).toContain("px-px");
    expect(markup).not.toContain("opacity-80");
  });

  it("keeps the assignee selector inert without repository permission", () => {
    const markup = renderToStaticMarkup(
      createElement(ManagedIssueAssigneeCell, {
        issue: linkedIssue,
        assignableUsers: [],
        canManage: false,
        loading: false,
        loadError: null,
        updating: false,
        noneLabel: "None",
        loadingLabel: "Loading...",
        searchPlaceholder: "Search...",
        readonlyReason: "No permission",
        onOpen: vi.fn(),
        onChange: vi.fn(),
      })
    );

    expect(markup).toContain('title="No permission"');
    expect(markup).toContain("disabled");
    expect(markup).toContain("bg-fill-1");
    expect(markup).not.toContain('data-icon="chevron-down"');
  });
});

describe("GitHub work-item row actions", () => {
  it("keeps issue Add and More actions visible", () => {
    const markup = renderToStaticMarkup(
      createElement(ManagedIssueActionsCell, {
        issue: linkedIssue,
        addLabel: "Add",
        openInBrowserLabel: "Open in browser",
        moreActionsLabel: "More actions",
        onOpenIssueInBrowser: vi.fn(),
        onAddIssue: vi.fn(),
      })
    );

    expect(markup).toContain(">Add</span>");
    expect(markup).toContain('aria-label="More actions"');
    expect(markup).not.toContain("Open in My Station");
    expect(markup).not.toContain("opacity-0");
  });

  it("keeps pull-request Add actions visible", () => {
    const markup = renderToStaticMarkup(
      createElement(ManagedPrActionsCell, {
        pr: draftPr,
        addLabel: "Add",
        onAddPr: vi.fn(),
      })
    );

    expect(markup).toContain(">Add</span>");
    expect(markup).not.toContain("opacity-0");
  });
});

describe("GitHub work-item header controls", () => {
  it("renders Filter as a tertiary icon-only header button without a tooltip", () => {
    const markup = renderToStaticMarkup(
      createElement(IssuePersonalFilterDropdown, {
        options: [{ value: "byMe", label: "Created by me" }],
        selectedFilters: ["byMe"],
        filterLabel: "Filter",
        onSelect: vi.fn(),
      })
    );

    expect(markup).toContain('data-icon="funnel"');
    expect(markup).toContain('aria-label="Filter (1)"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain("bg-fill-1! text-primary-6!");
    expect(markup).not.toContain('data-tooltip-label="Filter (1)"');
    expect(markup).not.toContain(">Filter<");
    expect(markup).toContain("height:28px");
  });

  it("keeps Filter unhighlighted when no filters are selected", () => {
    const markup = renderToStaticMarkup(
      createElement(IssuePersonalFilterDropdown, {
        options: [{ value: "byMe", label: "Created by me" }],
        selectedFilters: [],
        filterLabel: "Filter",
        onSelect: vi.fn(),
      })
    );

    expect(markup).toContain('aria-label="Filter"');
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).not.toContain("bg-fill-1! text-primary-6!");
    expect(markup).not.toContain("data-tooltip-label");
  });
});

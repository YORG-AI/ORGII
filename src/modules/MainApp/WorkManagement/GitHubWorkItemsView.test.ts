import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  GitHubWorkItemsView,
  getManagedIssueStatusAccent,
} from "./GitHubWorkItemsView";
import { GITHUB_ITEM_KIND, type ManagedPrItem } from "./githubManagedItemModel";
import { parseGitHubSearchQuery } from "./githubWorkItemsSearchQuery";
import { DEFAULT_GITHUB_ISSUES_SORT } from "./githubWorkItemsSort";

vi.mock("@src/components/IntegrationIcon", () => ({
  default: ({ type }: { type: string }) =>
    React.createElement("span", { "data-integration-icon": type }),
}));

describe("GitHub issue status accents", () => {
  it("uses purple for close-as-completed while keeping other closed reasons neutral", () => {
    expect(getManagedIssueStatusAccent("closed_completed")).toEqual({
      iconColor: "var(--color-purple-6)",
      valueClassName: "text-purple-6",
    });
    expect(getManagedIssueStatusAccent("closed_not_planned")).toEqual({
      iconColor: "var(--color-text-3)",
      valueClassName: "text-text-2",
    });
  });
});

function createPullRequest(
  id: number,
  overrides: Partial<ManagedPrItem> = {}
): ManagedPrItem {
  return {
    kind: GITHUB_ITEM_KIND.PR,
    id,
    title: `Pull request ${id}`,
    repo: "org2ai/ORG2",
    repoId: "repo-1",
    repoPath: "/workspace/ORG2",
    remoteUrl: "https://github.com/org2ai/ORG2.git",
    viewerLogin: "viewer",
    rawPr: {
      number: id,
      url: `https://github.com/org2ai/ORG2/pull/${id}`,
      title: `Pull request ${id}`,
      state: "open",
      author_login: "teammate",
      author_avatar_url: "https://example.com/avatar.png",
      requested_reviewer_logins: [],
      head_branch: `feature-${id}`,
      base_branch: "develop",
      draft: false,
      ci_status: "success",
      created_at: "2026-08-04T10:00:00Z",
      updated_at: "2026-08-04T11:00:00Z",
    },
    author: "teammate",
    authoredByViewer: false,
    reviewRequestedFromViewer: false,
    timeAgo: "1h",
    state: "open",
    sourceBranch: `feature-${id}`,
    targetBranch: "develop",
    updatedAt: "2026-08-04T11:00:00Z",
    ...overrides,
  };
}

describe("GitHubWorkItemsView pull requests", () => {
  it("renders one continuous PR list without todo section headers", () => {
    const pullRequests = [
      createPullRequest(1, { reviewRequestedFromViewer: true }),
      createPullRequest(2, { authoredByViewer: true }),
      createPullRequest(3),
    ];
    const markup = renderToStaticMarkup(
      React.createElement(GitHubWorkItemsView, {
        scope: "pr",
        loading: false,
        loadError: null,
        loadingMore: false,
        allItemsCount: pullRequests.length,
        filteredItems: pullRequests,
        pagedItems: pullRequests,
        repoSources: [
          {
            repoId: "repo-1",
            repoPath: "/workspace/ORG2",
            label: "ORG2",
            remoteUrl: "https://github.com/org2ai/ORG2.git",
            repoFullName: "org2ai/ORG2",
            viewerLogin: "viewer",
            permissions: {
              role_name: "write",
              can_manage_issues: true,
              can_manage_pull_requests: true,
            },
          },
        ],
        repoOptions: [{ key: "org2ai/ORG2", label: "org2ai/ORG2" }],
        effectiveSelectedRepo: "org2ai/ORG2",
        selectedRepoSourceForCreate: null,
        searchQuery: "is:pr is:open",
        parsedSearchQuery: parseGitHubSearchQuery("is:pr is:open"),
        issuePersonalFilterOptions: [],
        selectedIssuePersonalFilters: [],
        currentPage: 1,
        totalLoadedPages: 1,
        hasMoreFilteredIssues: false,
        sort: DEFAULT_GITHUB_ISSUES_SORT,
        createFormOpen: false,
        creatingIssue: false,
        updateSearchQuery: vi.fn(),
        onSearchQueryChange: vi.fn(),
        onRepoSelect: vi.fn(),
        onIssuePersonalFiltersSelect: vi.fn(),
        onRefresh: vi.fn(),
        onGoToPage: vi.fn(),
        onNextPage: vi.fn().mockResolvedValue(undefined),
        onSortChange: vi.fn(),
        onOpenIssue: vi.fn(),
        onOpenIssueInBrowser: vi.fn(),
        onAddIssue: vi.fn(),
        onIssueStatusChange: vi.fn().mockResolvedValue(undefined),
        getIssueAssigneeControlState: vi.fn(() => ({
          users: [],
          loading: false,
          error: null,
          updating: false,
        })),
        onLoadIssueAssignees: vi.fn(),
        onIssueAssigneesChange: vi.fn(),
        onOpenPr: vi.fn(),
        onAddPr: vi.fn(),
        onPrStatusChange: vi.fn().mockResolvedValue(undefined),
        onSetCreateFormOpen: vi.fn(),
        onCreateIssue: vi.fn(),
      })
    );

    expect(markup).toContain('data-testid="github-pr-table"');
    expect(markup).toContain('data-testid="github-work-items-state-open"');
    expect(markup).toContain('data-testid="github-work-items-state-closed"');
    expect(markup).toContain("settings-table-root");
    expect(markup).toContain("bg-bg-0");
    expect(markup).not.toContain("bg-chat-pane");
    expect(markup).toContain("Title / Context");
    expect(markup).toContain(">Status<");
    expect(markup).toContain(">CI<");
    expect(markup).toContain(">Updated<");
    expect(markup).toContain('data-sort-column="id"');
    expect(markup).toContain('data-sort-column="updated"');
    expect(markup).toContain('aria-label="ID" aria-pressed="true"');
    expect(markup).toContain('aria-label="Updated" aria-pressed="false"');
    expect(markup).toContain("feature-1 → develop");
    expect(markup).toContain("flex-1");
    expect(markup).toContain("select-size-default");
    expect(markup).not.toContain("select-ghost");
    expect(markup).toContain("border border-solid border-border-2 bg-bg-2");
    expect(markup).toContain('data-icon="refresh-cw"');
    expect(markup).toContain("Pull request 1");
    expect(markup).toContain("group/title");
    expect(markup).toContain("group-hover/title:text-primary-6");
    expect(markup).toContain("group-hover/title:underline");
    expect(markup).not.toContain("group-hover:text-primary-6");
    expect(markup).toContain("Pull request 2");
    expect(markup).toContain("Pull request 3");
    expect(markup).not.toContain("https://example.com/avatar.png");
    expect(markup).toContain('data-testid="github-pr-status-1"');
    expect(markup).toContain('data-testid="github-pr-ci-1"');
    expect(markup).toContain('data-icon="check-circle-2"');
    expect(markup).toContain("text-success-6");
    expect(markup).toContain('data-icon="circle-dot"');
    expect(markup).not.toContain("github-pr-review-requested");
    expect(markup).not.toContain("github-pr-authored");
    expect(markup).not.toContain("github-pr-other-todos");
  });

  it("renders draft PR status with neutral text-2 styling", () => {
    const basePr = createPullRequest(4);
    const draftPr = createPullRequest(4, {
      rawPr: { ...basePr.rawPr, draft: true },
    });
    const markup = renderToStaticMarkup(
      React.createElement(GitHubWorkItemsView, {
        scope: "pr",
        loading: false,
        loadError: null,
        loadingMore: false,
        allItemsCount: 1,
        filteredItems: [draftPr],
        pagedItems: [draftPr],
        repoSources: [],
        repoOptions: [{ key: "all", label: "All repositories" }],
        effectiveSelectedRepo: "all",
        selectedRepoSourceForCreate: null,
        searchQuery: "is:pr is:open",
        parsedSearchQuery: parseGitHubSearchQuery("is:pr is:open"),
        issuePersonalFilterOptions: [],
        selectedIssuePersonalFilters: [],
        currentPage: 1,
        totalLoadedPages: 1,
        hasMoreFilteredIssues: false,
        sort: DEFAULT_GITHUB_ISSUES_SORT,
        createFormOpen: false,
        creatingIssue: false,
        updateSearchQuery: vi.fn(),
        onSearchQueryChange: vi.fn(),
        onRepoSelect: vi.fn(),
        onIssuePersonalFiltersSelect: vi.fn(),
        onRefresh: vi.fn(),
        onGoToPage: vi.fn(),
        onNextPage: vi.fn().mockResolvedValue(undefined),
        onSortChange: vi.fn(),
        onOpenIssue: vi.fn(),
        onOpenIssueInBrowser: vi.fn(),
        onAddIssue: vi.fn(),
        onIssueStatusChange: vi.fn().mockResolvedValue(undefined),
        getIssueAssigneeControlState: vi.fn(() => ({
          users: [],
          loading: false,
          error: null,
          updating: false,
        })),
        onLoadIssueAssignees: vi.fn(),
        onIssueAssigneesChange: vi.fn(),
        onOpenPr: vi.fn(),
        onAddPr: vi.fn(),
        onPrStatusChange: vi.fn().mockResolvedValue(undefined),
        onSetCreateFormOpen: vi.fn(),
        onCreateIssue: vi.fn(),
      })
    );

    expect(markup).toContain('data-testid="github-pr-status-4"');
    expect(markup).toContain('data-icon="git-pull-request-draft"');
    expect(markup).toContain('style="color:var(--color-text-2)"');
    expect(markup).toContain("text-text-2");
  });
});

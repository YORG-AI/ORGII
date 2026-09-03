// @vitest-environment jsdom
import { Provider, createStore, useAtomValue } from "jotai";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { workstationTabHeaderAtomByHost } from "@src/store/workstation";

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

vi.mock("./GitHubWorkItemDetailPane", () => ({
  default: ({ onClose }: { onClose: () => void }) =>
    React.createElement(
      "button",
      { "data-testid": "mock-github-detail", onClick: onClose },
      "Detail"
    ),
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

function createEmptyViewProps(): React.ComponentProps<
  typeof GitHubWorkItemsView
> {
  return {
    scope: "issue",
    loading: false,
    loadError: null,
    loadingMore: false,
    allItemsCount: 0,
    filteredItems: [],
    pagedItems: [],
    selectedItem: null,
    repoSources: [],
    repoOptions: [{ key: "all", label: "All repositories" }],
    effectiveSelectedRepo: "all",
    selectedRepoSourceForCreate: null,
    searchQuery: "is:issue is:open",
    parsedSearchQuery: parseGitHubSearchQuery("is:issue is:open"),
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
    onLoadMore: vi.fn(),
    onSortChange: vi.fn(),
    onSelectItem: vi.fn(),
    onCloseItem: vi.fn(),
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
  };
}

describe("GitHubWorkItemsView pull requests", () => {
  it("publishes a stable header contribution to its subscribing shell", async () => {
    const actEnvironment = globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    };
    const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    const store = createStore();
    const props = createEmptyViewProps();
    const container = document.createElement("div");
    const root = createRoot(container);

    const Harness = () => {
      useAtomValue(workstationTabHeaderAtomByHost.workManagement);
      return React.createElement(GitHubWorkItemsView, props);
    };
    const renderHarness = () =>
      React.createElement(Provider, { store }, React.createElement(Harness));

    try {
      await act(async () => root.render(renderHarness()));
      const firstContribution = store.get(
        workstationTabHeaderAtomByHost.workManagement
      );

      await act(async () => root.render(renderHarness()));

      expect(firstContribution).not.toBeNull();
      const contentMarkup = renderToStaticMarkup(
        React.createElement(React.Fragment, null, firstContribution?.content)
      );
      const trailingMarkup = renderToStaticMarkup(
        React.createElement(React.Fragment, null, firstContribution?.trailing)
      );
      expect(contentMarkup).toContain(
        'data-testid="github-work-items-repository"'
      );
      expect(trailingMarkup).not.toContain(
        'data-testid="github-work-items-repository"'
      );
      expect(trailingMarkup).toContain(
        'data-testid="github-work-items-state-open"'
      );
      expect(store.get(workstationTabHeaderAtomByHost.workManagement)).toBe(
        firstContribution
      );
    } finally {
      await act(async () => root.unmount());
      if (previousActEnvironment === undefined) {
        Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
      } else {
        actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
      }
    }
  });

  it("keeps the continuous PR table as the full one-pane view", () => {
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
        selectedItem: null,
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
        onLoadMore: vi.fn(),
        onSortChange: vi.fn(),
        onSelectItem: vi.fn(),
        onCloseItem: vi.fn(),
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
    expect(markup).toContain("settings-table-root");
    expect(markup).toContain("settings-table-root-transparent");
    expect(markup).not.toContain("work-management-github-panel");
    expect(markup).toContain('data-testid="github-pr-list-detail-layout"');
    expect(markup).toContain('data-layout-mode="single"');
    expect(markup).not.toContain('data-testid="github-pr-compact-list"');
    expect(markup).not.toContain('aria-orientation="vertical"');
    expect(markup).not.toContain("teamInbox.empty.selectTitle");
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
    expect(markup).not.toContain('placeholder="Search GitHub');
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

  it("switches to the Inbox compact list when a PR detail is open", () => {
    const pullRequests = [createPullRequest(1), createPullRequest(2)];
    const markup = renderToStaticMarkup(
      React.createElement(GitHubWorkItemsView, {
        ...createEmptyViewProps(),
        scope: "pr",
        allItemsCount: pullRequests.length,
        filteredItems: pullRequests,
        pagedItems: pullRequests,
        selectedItem: pullRequests[0],
        searchQuery: "is:pr is:open",
        parsedSearchQuery: parseGitHubSearchQuery("is:pr is:open"),
      })
    );

    expect(markup).toContain('data-layout-mode="split"');
    expect(markup).toContain('data-testid="github-pr-compact-list"');
    expect(markup).toContain('data-compact-list-header="true"');
    expect(markup).toContain('data-testid="github-work-items-search"');
    expect(markup).toContain("w-full min-w-0");
    expect(markup).toContain('data-testid="github-compact-row"');
    expect(markup).toContain('data-list-panel-item="true"');
    expect(markup).toContain('aria-orientation="vertical"');
    expect(markup).toContain("bg-chat-pane");
    expect(markup).not.toContain('data-testid="github-pr-table"');
  });

  it("keeps repository scope at the top while moving list controls into the left pane", async () => {
    const actEnvironment = globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    };
    const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    const pullRequest = createPullRequest(7);
    const store = createStore();
    const container = document.createElement("div");
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          React.createElement(
            Provider,
            { store },
            React.createElement(GitHubWorkItemsView, {
              ...createEmptyViewProps(),
              scope: "pr",
              allItemsCount: 1,
              filteredItems: [pullRequest],
              pagedItems: [pullRequest],
              selectedItem: pullRequest,
              searchQuery: "is:pr is:open",
              parsedSearchQuery: parseGitHubSearchQuery("is:pr is:open"),
            })
          )
        );
      });

      const header = store.get(workstationTabHeaderAtomByHost.workManagement);
      expect(
        renderToStaticMarkup(
          React.createElement(React.Fragment, null, header?.content)
        )
      ).toContain('data-testid="github-work-items-repository"');
      expect(header?.trailing).toBeNull();
      expect(
        container.querySelector('[data-compact-list-header="true"]')
      ).not.toBeNull();
      expect(
        container.querySelector('[data-testid="github-work-items-search"]')
      ).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
      if (previousActEnvironment === undefined) {
        Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
      } else {
        actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
      }
    }
  });

  it("selects a PR into the adjacent pane instead of opening a tab", async () => {
    const actEnvironment = globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    };
    const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    const pullRequest = createPullRequest(8);
    const onSelectItem = vi.fn();
    const onOpenPr = vi.fn();
    const container = document.createElement("div");
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          React.createElement(GitHubWorkItemsView, {
            ...createEmptyViewProps(),
            scope: "pr",
            allItemsCount: 1,
            filteredItems: [pullRequest],
            pagedItems: [pullRequest],
            searchQuery: "is:pr is:open",
            parsedSearchQuery: parseGitHubSearchQuery("is:pr is:open"),
            onSelectItem,
            onOpenPr,
          })
        );
      });

      const titleAction = container.querySelector<HTMLButtonElement>(
        'button[title="Pull request 8"]'
      );
      expect(titleAction).not.toBeNull();
      await act(async () => titleAction?.click());

      expect(onSelectItem).toHaveBeenCalledWith(pullRequest);
      expect(onOpenPr).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      if (previousActEnvironment === undefined) {
        Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
      } else {
        actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
      }
    }
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
        selectedItem: null,
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
        onLoadMore: vi.fn(),
        onSortChange: vi.fn(),
        onSelectItem: vi.fn(),
        onCloseItem: vi.fn(),
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

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
import { WorkManagementSplitHeaderContext } from "./workManagementSplitHeaderContext";

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
    repoOptions: [{ key: "org/repo", label: "org/repo" }],
    effectiveSelectedRepo: "org/repo",
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

function withSplitHeaderHost(child: React.ReactNode): React.ReactElement {
  return React.createElement(
    WorkManagementSplitHeaderContext.Provider,
    {
      value: {
        splitDatasetControl: React.createElement(
          "button",
          { "data-testid": "work-dataset-github" },
          "GitHub"
        ),
      },
    },
    child
  );
}

describe("GitHubWorkItemsView pull requests", () => {
  it("publishes a stable hidden contribution while owning its split header", async () => {
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
      return withSplitHeaderHost(
        React.createElement(GitHubWorkItemsView, props)
      );
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
      expect(firstContribution?.hidden).toBe(true);
      expect(firstContribution?.content).toBeUndefined();
      expect(firstContribution?.trailing).toBeUndefined();
      expect(
        container.querySelector('[data-split-list-header="true"]')
      ).not.toBeNull();
      expect(
        container.querySelector('[data-testid="github-work-items-repository"]')
      ).not.toBeNull();
      expect(
        container.querySelector('[data-testid="github-work-items-search"]')
      ).not.toBeNull();
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

  it("uses the compact list and adjacent detail holder by default for PRs", () => {
    const pullRequests = [
      createPullRequest(1, { reviewRequestedFromViewer: true }),
      createPullRequest(2, { authoredByViewer: true }),
      createPullRequest(3),
    ];
    const markup = renderToStaticMarkup(
      withSplitHeaderHost(
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
      )
    );

    expect(markup).toContain('data-testid="github-pr-list-detail-layout"');
    expect(markup).toContain('data-layout-mode="split"');
    expect(markup).toContain('data-testid="github-pr-compact-list"');
    expect(markup).not.toContain('data-compact-list-header="true"');
    expect(markup).toContain('data-split-list-header="true"');
    expect(markup).toContain('data-testid="github-work-items-search"');
    expect(markup).toContain('data-testid="mock-github-detail"');
    expect(markup).toContain('aria-orientation="vertical"');
    expect(markup).toContain("bg-chat-pane");
    expect(markup).toContain("Pull request 1");
    expect(markup).toContain("Pull request 2");
    expect(markup).toContain("Pull request 3");
    expect(markup).not.toContain('data-testid="github-pr-table"');
  });

  it("uses the same default split for GitHub issues", () => {
    const markup = renderToStaticMarkup(
      React.createElement(GitHubWorkItemsView, createEmptyViewProps())
    );

    expect(markup).toContain('data-testid="github-issue-list-detail-layout"');
    expect(markup).toContain('data-layout-mode="split"');
    expect(markup).toContain('data-testid="github-issue-compact-list"');
    expect(markup).toContain('data-testid="mock-github-detail"');
    expect(markup).not.toContain('data-testid="github-issue-table"');
  });

  it("switches to the Inbox compact list when a PR detail is open", () => {
    const pullRequests = [createPullRequest(1), createPullRequest(2)];
    const markup = renderToStaticMarkup(
      withSplitHeaderHost(
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
      )
    );

    expect(markup).toContain('data-layout-mode="split"');
    expect(markup).toContain('data-testid="github-pr-compact-list"');
    expect(markup).not.toContain('data-compact-list-header="true"');
    expect(markup).toContain('data-split-list-header="true"');
    expect(markup).toContain('data-testid="github-work-items-search"');
    expect(markup).toContain('data-testid="github-compact-row"');
    expect(markup).toContain('data-list-panel-item="true"');
    expect(markup).toContain('aria-orientation="vertical"');
    expect(markup).toContain("bg-chat-pane");
    expect(markup).not.toContain('data-testid="github-pr-table"');
  });

  it("keeps GitHub controls in its local split header", async () => {
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
            withSplitHeaderHost(
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
          )
        );
      });

      const header = store.get(workstationTabHeaderAtomByHost.workManagement);
      expect(header?.hidden).toBe(true);
      expect(
        container.querySelector('[data-compact-list-header="true"]')
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="github-work-items-search"]')
      ).not.toBeNull();
      expect(
        container.querySelector('[data-testid="github-work-items-repository"]')
      ).not.toBeNull();
      expect(
        container.querySelector('[data-testid="split-list-fullscreen-toggle"]')
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

  it("keeps full-width GitHub controls in a dedicated 36px row", async () => {
    const actEnvironment = globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    };
    const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    const store = createStore();
    const container = document.createElement("div");
    const root = createRoot(container);
    const pullRequest = createPullRequest(12);
    const onSelectItem = vi.fn();

    try {
      await act(async () => {
        root.render(
          React.createElement(
            Provider,
            { store },
            React.createElement(
              WorkManagementSplitHeaderContext.Provider,
              {
                value: {
                  splitDatasetControl: React.createElement(
                    "button",
                    { "data-testid": "work-dataset-github-compact" },
                    "GitHub"
                  ),
                  surfaceDatasetControl: React.createElement(
                    "button",
                    { "data-testid": "work-dataset-github-full" },
                    "GitHub pull requests"
                  ),
                },
              },
              React.createElement(GitHubWorkItemsView, {
                ...createEmptyViewProps(),
                scope: "pr",
                allItemsCount: 1,
                filteredItems: [pullRequest],
                pagedItems: [pullRequest],
                searchQuery: "is:pr is:open",
                parsedSearchQuery: parseGitHubSearchQuery("is:pr is:open"),
                onSelectItem,
              })
            )
          )
        );
      });

      await act(async () =>
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="split-list-fullscreen-toggle"]'
          )
          ?.click()
      );

      expect(
        container
          .querySelector('[data-testid="github-pr-list-detail-layout"]')
          ?.getAttribute("data-layout-mode")
      ).toBe("single");
      const fullHeaderRow = container.querySelector(
        '[data-split-list-header-row="primary"]'
      );
      expect(fullHeaderRow).not.toBeNull();
      expect(fullHeaderRow?.classList.contains("h-9")).toBe(true);
      expect(
        container.querySelector('[data-testid="work-dataset-github-full"]')
      ).not.toBeNull();
      expect(
        container.querySelector('[data-testid="github-work-items-repository"]')
      ).not.toBeNull();
      expect(
        container.querySelector('[data-testid="github-work-items-search"]')
      ).not.toBeNull();
      expect(container.innerHTML).toContain('data-icon="minimize-2"');
      expect(store.get(workstationTabHeaderAtomByHost.workManagement)).toEqual({
        hidden: true,
      });

      await act(async () =>
        container
          .querySelector<HTMLButtonElement>('[title="Pull request 12"]')
          ?.click()
      );

      expect(onSelectItem).toHaveBeenCalledWith(pullRequest);
      expect(
        container
          .querySelector('[data-testid="github-pr-list-detail-layout"]')
          ?.getAttribute("data-layout-mode")
      ).toBe("split");
    } finally {
      await act(async () => root.unmount());
      if (previousActEnvironment === undefined) {
        Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
      } else {
        actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
      }
    }
  });

  it("keeps split controls in the left-column header rows", () => {
    const markup = renderToStaticMarkup(
      React.createElement(
        WorkManagementSplitHeaderContext.Provider,
        {
          value: {
            splitDatasetControl: React.createElement(
              "button",
              { "data-testid": "work-dataset-reviews" },
              "GitHub PRs"
            ),
          },
        },
        React.createElement(GitHubWorkItemsView, {
          ...createEmptyViewProps(),
          scope: "pr",
        })
      )
    );

    expect(markup).toContain('data-split-list-header="true"');
    expect(markup).toContain('data-split-list-header-row="primary"');
    expect(markup).toContain('data-split-list-header-row="secondary"');
    expect(markup).toContain('data-testid="work-dataset-reviews"');
    expect(markup).toContain('data-testid="github-work-items-repository"');
    expect(
      markup.match(/data-testid="github-work-items-state-open"/g)
    ).toHaveLength(1);
    expect(markup).toContain('data-testid="github-work-items-search"');
    expect(markup).toMatch(
      /class="min-w-0 flex-1" data-testid="github-work-items-search"/
    );
    expect(markup).toContain('data-testid="split-list-fullscreen-toggle"');
    expect(markup).not.toContain('data-compact-list-header="true"');
  });

  it("keeps split controls local without a tab-bar dependency", async () => {
    const actEnvironment = globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    };
    const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    const store = createStore();
    const container = document.createElement("div");
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          React.createElement(
            Provider,
            { store },
            React.createElement(
              WorkManagementSplitHeaderContext.Provider,
              {
                value: {
                  splitDatasetControl: null,
                },
              },
              React.createElement(GitHubWorkItemsView, {
                ...createEmptyViewProps(),
                scope: "pr",
              })
            )
          )
        );
      });

      expect(
        container.querySelector('[data-split-list-header="true"]')
      ).not.toBeNull();
      expect(
        container.querySelector('[data-testid="github-work-items-search"]')
      ).not.toBeNull();
      const header = store.get(workstationTabHeaderAtomByHost.workManagement);
      expect(header).toEqual({ hidden: true });
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
        '[data-testid="github-compact-row"][data-item-id="8"]'
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

  it("keeps draft PR status styling in the compact left list", () => {
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
        repoOptions: [{ key: "org/repo", label: "org/repo" }],
        effectiveSelectedRepo: "org/repo",
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

    expect(markup).toContain('data-item-id="4"');
    expect(markup).toContain('data-pr-status="draft"');
    expect(markup).toContain(
      "flex h-4 w-5 shrink-0 items-center justify-center text-text-2"
    );
    expect(markup).not.toContain('data-testid="github-pr-status-4"');
  });
});

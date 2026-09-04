import { useMemo } from "react";

import {
  managedItemMatchesQuery,
  managedItemMatchesRepo,
  mapIssueToManagedItem,
  mapPrToManagedItem,
} from "./githubManagedItemModel";
import {
  getGitHubWorkItemsPage,
  getGitHubWorkItemsPageCount,
} from "./githubWorkItemsPagination";
import {
  GITHUB_QUERY_SCOPE,
  GITHUB_QUERY_STATE,
  getIssuePageStatesForQuery,
} from "./githubWorkItemsSearchQuery";
import type { ParsedGitHubSearchQuery } from "./githubWorkItemsSearchQuery";
import {
  DEFAULT_GITHUB_ISSUES_SORT,
  DEFAULT_GITHUB_PULL_REQUESTS_SORT,
  type GitHubWorkItemsSort,
  sortManagedGitHubItems,
} from "./githubWorkItemsSort";
import {
  type GitHubRepoSource,
  resolveSingleGitHubRepoSource,
} from "./githubWorkItemsTypes";
import {
  EMPTY_REPO_ISSUES,
  EMPTY_REPO_PRS,
  getRepoIssueMapKey,
} from "./useGitHubWorkItemsLoadLifecycle";
import type {
  RepoIssueState,
  RepoPrState,
} from "./useGitHubWorkItemsLoadLifecycle";

export interface GitHubWorkItemsDerivedStateInput {
  repoSources: GitHubRepoSource[];
  repoIssueMap: Record<string, RepoIssueState>;
  repoPrMap: Record<string, RepoPrState>;
  parsedSearchQuery: ParsedGitHubSearchQuery;
  selectedRepo: string;
  selectedRepoPath: string | null;
  currentPage: number;
  sort?: GitHubWorkItemsSort;
}

export function deriveGitHubWorkItemsState({
  repoSources,
  repoIssueMap,
  repoPrMap,
  parsedSearchQuery,
  selectedRepo,
  selectedRepoPath,
  currentPage,
  sort,
}: GitHubWorkItemsDerivedStateInput) {
  const selectedRepoSource = resolveSingleGitHubRepoSource(
    repoSources,
    selectedRepo,
    selectedRepoPath
  );
  const effectiveSelectedRepo = selectedRepoSource?.repoFullName ?? "";
  const selectedRepoSourceForCreate = selectedRepoSource;
  const issues = repoSources.flatMap((source) => {
    const sourceIssues =
      repoIssueMap[getRepoIssueMapKey(source)] ?? EMPTY_REPO_ISSUES;
    return [...sourceIssues.openIssues, ...sourceIssues.closedIssues].map(
      (issue) => mapIssueToManagedItem(issue, source)
    );
  });
  const pullRequests = repoSources.flatMap((source) => {
    const sourcePrs = repoPrMap[getRepoIssueMapKey(source)] ?? EMPTY_REPO_PRS;
    return [...sourcePrs.openPrs, ...sourcePrs.closedPrs].map((pr) =>
      mapPrToManagedItem(pr, source)
    );
  });
  const resolvedSort =
    sort ??
    (parsedSearchQuery.scope === GITHUB_QUERY_SCOPE.PR
      ? DEFAULT_GITHUB_PULL_REQUESTS_SORT
      : DEFAULT_GITHUB_ISSUES_SORT);
  const allItems = sortManagedGitHubItems(
    [...issues, ...pullRequests],
    resolvedSort
  );
  const queryFilteredItems = allItems.filter(
    (item) =>
      managedItemMatchesRepo(item, effectiveSelectedRepo) &&
      managedItemMatchesQuery(item, parsedSearchQuery)
  );
  const filteredItems = queryFilteredItems;
  const pageStates = getIssuePageStatesForQuery(parsedSearchQuery);
  const paginatedSources = selectedRepoSource ? [selectedRepoSource] : [];
  const hasMoreFilteredIssues = paginatedSources.some((source) => {
    const state = repoIssueMap[getRepoIssueMapKey(source)];
    return Boolean(
      state &&
      pageStates.some((pageState) =>
        pageState === "open" ? state.openHasMore : state.closedHasMore
      )
    );
  });
  const totalLoadedPages = getGitHubWorkItemsPageCount(filteredItems.length);
  const pagedItems = getGitHubWorkItemsPage(filteredItems, currentPage);
  const issueStateCounts = issues.reduce(
    (counts, issue) => {
      if (managedItemMatchesRepo(issue, effectiveSelectedRepo)) {
        counts[issue.state] += 1;
      }
      return counts;
    },
    { open: 0, closed: 0 }
  );
  const hasPaginatedSources = paginatedSources.length > 0;
  const openIssuesLoaded =
    hasPaginatedSources &&
    paginatedSources.every(
      (source) => repoIssueMap[getRepoIssueMapKey(source)]?.openLoaded === true
    );
  const closedIssuesLoaded =
    hasPaginatedSources &&
    paginatedSources.every(
      (source) =>
        repoIssueMap[getRepoIssueMapKey(source)]?.closedLoaded === true
    );
  const openPrCount = pullRequests.filter(
    (pr) =>
      pr.state === GITHUB_QUERY_STATE.OPEN &&
      managedItemMatchesRepo(pr, effectiveSelectedRepo)
  ).length;
  const closedPrCount = pullRequests.filter(
    (pr) =>
      (pr.state === GITHUB_QUERY_STATE.CLOSED ||
        pr.state === GITHUB_QUERY_STATE.MERGED) &&
      managedItemMatchesRepo(pr, effectiveSelectedRepo)
  ).length;
  const openPrLoaded =
    hasPaginatedSources &&
    paginatedSources.every(
      (source) => repoPrMap[getRepoIssueMapKey(source)]?.openLoaded === true
    );
  const closedPrLoaded =
    hasPaginatedSources &&
    paginatedSources.every(
      (source) => repoPrMap[getRepoIssueMapKey(source)]?.closedLoaded === true
    );

  return {
    selectedRepoSourceForCreate,
    effectiveSelectedRepo,
    allItems,
    filteredItems,
    pageStates,
    paginatedSources,
    hasMoreFilteredIssues,
    totalLoadedPages,
    pagedItems,
    issueStateCounts,
    openIssuesLoaded,
    closedIssuesLoaded,
    openPrCount,
    closedPrCount,
    openPrLoaded,
    closedPrLoaded,
  };
}

export function useGitHubWorkItemsDerivedState({
  repoSources,
  repoIssueMap,
  repoPrMap,
  parsedSearchQuery,
  selectedRepo,
  selectedRepoPath,
  currentPage,
  sort,
}: GitHubWorkItemsDerivedStateInput) {
  return useMemo(
    () =>
      deriveGitHubWorkItemsState({
        repoSources,
        repoIssueMap,
        repoPrMap,
        parsedSearchQuery,
        selectedRepo,
        selectedRepoPath,
        currentPage,
        sort,
      }),
    [
      currentPage,
      parsedSearchQuery,
      repoIssueMap,
      repoPrMap,
      repoSources,
      selectedRepo,
      selectedRepoPath,
      sort,
    ]
  );
}

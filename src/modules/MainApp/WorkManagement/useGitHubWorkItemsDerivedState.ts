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
  GITHUB_QUERY_STATE,
  getIssuePageStatesForQuery,
} from "./githubWorkItemsSearchQuery";
import type { ParsedGitHubSearchQuery } from "./githubWorkItemsSearchQuery";
import type { GitHubRepoSource } from "./githubWorkItemsTypes";
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
  allReposValue: string;
  currentWorkstationValue: string;
}

export function deriveGitHubWorkItemsState({
  repoSources,
  repoIssueMap,
  repoPrMap,
  parsedSearchQuery,
  selectedRepo,
  selectedRepoPath,
  currentPage,
  allReposValue,
  currentWorkstationValue,
}: GitHubWorkItemsDerivedStateInput) {
  const selectedWorkstationRepoSource =
    repoSources.find((source) => source.repoPath === selectedRepoPath) ?? null;
  const effectiveSelectedRepo =
    selectedRepo === currentWorkstationValue
      ? (selectedWorkstationRepoSource?.repoFullName ?? allReposValue)
      : selectedRepo === allReposValue ||
          repoSources.some((source) => source.repoFullName === selectedRepo)
        ? selectedRepo
        : (selectedWorkstationRepoSource?.repoFullName ?? allReposValue);
  const selectedRepoSourceForCreate =
    effectiveSelectedRepo === allReposValue
      ? selectedWorkstationRepoSource
      : (repoSources.find(
          (source) => source.repoFullName === effectiveSelectedRepo
        ) ?? null);
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
  const allItems = [...issues, ...pullRequests].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt)
  );
  const filteredItems = allItems.filter(
    (item) =>
      managedItemMatchesRepo(item, effectiveSelectedRepo, allReposValue) &&
      managedItemMatchesQuery(item, parsedSearchQuery)
  );
  const pageStates = getIssuePageStatesForQuery(parsedSearchQuery);
  const paginatedSources =
    effectiveSelectedRepo === allReposValue
      ? repoSources
      : repoSources.filter(
          (source) => source.repoFullName === effectiveSelectedRepo
        );
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
      if (managedItemMatchesRepo(issue, effectiveSelectedRepo, allReposValue)) {
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
      managedItemMatchesRepo(pr, effectiveSelectedRepo, allReposValue)
  ).length;
  const closedPrCount = pullRequests.filter(
    (pr) =>
      (pr.state === GITHUB_QUERY_STATE.CLOSED ||
        pr.state === GITHUB_QUERY_STATE.MERGED) &&
      managedItemMatchesRepo(pr, effectiveSelectedRepo, allReposValue)
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
  allReposValue,
  currentWorkstationValue,
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
        allReposValue,
        currentWorkstationValue,
      }),
    [
      allReposValue,
      currentPage,
      currentWorkstationValue,
      parsedSearchQuery,
      repoIssueMap,
      repoPrMap,
      repoSources,
      selectedRepo,
      selectedRepoPath,
    ]
  );
}

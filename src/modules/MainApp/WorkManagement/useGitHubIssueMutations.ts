import { useCallback, useState } from "react";

import type { GitHubIssue } from "@src/api/tauri/github";
import Message from "@src/components/Message";
import {
  updateCachedClosedIssues,
  updateCachedOpenIssues,
} from "@src/services/git/githubListCache";
import {
  createIssue,
  fetchIssues,
} from "@src/services/git/operations/githubIssues";
import { mapWithConcurrency } from "@src/util/collections/mapWithConcurrency";

import type { GitHubIssuePageState } from "./githubWorkItemsSearchQuery";
import {
  type GitHubRepoSource,
  getGitHubListCacheKey,
} from "./githubWorkItemsTypes";
import {
  EMPTY_REPO_ISSUES,
  ISSUE_PAGE_SIZE,
  getRepoIssueMapKey,
  mergeUniqueIssues,
} from "./useGitHubWorkItemsLoadLifecycle";
import type { RepoIssueState } from "./useGitHubWorkItemsLoadLifecycle";

type UpdateIssueMap = (
  update: (
    current: Record<string, RepoIssueState>
  ) => Record<string, RepoIssueState>
) => void;

export function useGitHubIssueMutations({
  repoIssueMap,
  paginatedSources,
  pageStates,
  hasMoreFilteredIssues,
  updateIssueMap,
  setListError,
  addCreatedIssue,
  onCreated,
  createErrorMessage,
}: {
  repoIssueMap: Record<string, RepoIssueState>;
  paginatedSources: GitHubRepoSource[];
  pageStates: GitHubIssuePageState[];
  hasMoreFilteredIssues: boolean;
  updateIssueMap: UpdateIssueMap;
  setListError: (error: string | null) => void;
  addCreatedIssue: (issue: GitHubIssue) => void;
  onCreated: () => void;
  createErrorMessage: string;
}) {
  const [loadingMore, setLoadingMore] = useState(false);
  const [creatingIssue, setCreatingIssue] = useState(false);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMoreFilteredIssues) return;
    setLoadingMore(true);
    const requests = paginatedSources.flatMap((source) => {
      const repoIssueState = repoIssueMap[getRepoIssueMapKey(source)];
      if (!repoIssueState) return [];
      return pageStates.flatMap((pageState) => {
        const hasMore =
          pageState === "open"
            ? repoIssueState.openHasMore
            : repoIssueState.closedHasMore;
        const nextPage =
          pageState === "open"
            ? repoIssueState.openNextPage
            : repoIssueState.closedNextPage;
        return hasMore && nextPage ? [{ source, pageState, nextPage }] : [];
      });
    });
    const results = await mapWithConcurrency(
      requests,
      4,
      async ({ source, pageState, nextPage }) => ({
        source,
        pageState,
        result: await fetchIssues(source.remoteUrl, {
          state: pageState,
          page: nextPage,
          perPage: ISSUE_PAGE_SIZE,
        }),
      })
    );
    updateIssueMap((current) => {
      const next = { ...current };
      for (const { source, pageState, result } of results) {
        if (!result.data) continue;
        const key = getRepoIssueMapKey(source);
        const currentState = next[key] ?? EMPTY_REPO_ISSUES;
        if (pageState === "open") {
          const openIssues = mergeUniqueIssues(
            currentState.openIssues,
            result.data.issues
          );
          next[key] = {
            ...currentState,
            openIssues,
            openHasMore: result.data.has_more,
            openNextPage: result.data.next_page,
          };
          updateCachedOpenIssues(getGitHubListCacheKey(source), openIssues);
        } else {
          const closedIssues = mergeUniqueIssues(
            currentState.closedIssues,
            result.data.issues
          );
          next[key] = {
            ...currentState,
            closedIssues,
            closedHasMore: result.data.has_more,
            closedNextPage: result.data.next_page,
          };
          updateCachedClosedIssues(getGitHubListCacheKey(source), closedIssues);
        }
      }
      return next;
    });
    setListError(
      results.find(({ result }) => result.error)?.result.error ?? null
    );
    setLoadingMore(false);
  }, [
    hasMoreFilteredIssues,
    loadingMore,
    pageStates,
    paginatedSources,
    repoIssueMap,
    setListError,
    updateIssueMap,
  ]);

  const create = useCallback(
    async (source: GitHubRepoSource, title: string, body: string) => {
      setCreatingIssue(true);
      const result = await createIssue({
        remoteUrl: source.remoteUrl,
        title,
        body: body || undefined,
      });
      setCreatingIssue(false);
      if (result.error || !result.data) {
        Message.error(result.error ?? createErrorMessage);
        return;
      }
      const createdIssue = result.data;
      updateIssueMap((current) => {
        const key = getRepoIssueMapKey(source);
        const currentState = current[key] ?? EMPTY_REPO_ISSUES;
        const openIssues = mergeUniqueIssues(
          [createdIssue],
          currentState.openIssues
        );
        updateCachedOpenIssues(getGitHubListCacheKey(source), openIssues);
        return {
          ...current,
          [key]: { ...currentState, openIssues },
        };
      });
      onCreated();
      addCreatedIssue(createdIssue);
    },
    [addCreatedIssue, createErrorMessage, onCreated, updateIssueMap]
  );

  return { loadingMore, creatingIssue, loadMore, createIssue: create };
}

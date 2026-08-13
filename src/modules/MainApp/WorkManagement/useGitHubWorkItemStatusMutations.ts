import { useCallback } from "react";

import { updatePRStateLocal } from "@src/api/tauri/github";
import Message from "@src/components/Message";
import {
  setCachedPrs,
  updateCachedClosedIssues,
  updateCachedOpenIssues,
} from "@src/services/git/githubListCache";
import {
  closeIssue,
  reopenIssue,
} from "@src/services/git/operations/githubIssues";

import type { ManagedIssueItem, ManagedPrItem } from "./githubManagedItemModel";
import {
  canManageIssueStatus,
  canManagePrStatus,
  findGitHubRepoSource,
} from "./githubWorkItemPermissions";
import {
  replaceIssueInRepoState,
  replacePrInRepoState,
} from "./githubWorkItemStateUpdates";
import {
  type GitHubRepoSource,
  getGitHubListCacheKey,
} from "./githubWorkItemsTypes";
import {
  EMPTY_REPO_ISSUES,
  EMPTY_REPO_PRS,
  type RepoIssueState,
  type RepoPrState,
  getRepoIssueMapKey,
} from "./useGitHubWorkItemsLoadLifecycle";

export type ManagedIssueStatusValue =
  | "open"
  | "closed_completed"
  | "closed_not_planned"
  | "closed_duplicate";
export type ManagedPrStatusValue = "open" | "closed";

type UpdateIssueMap = (
  update: (
    current: Record<string, RepoIssueState>
  ) => Record<string, RepoIssueState>
) => void;
type UpdatePrMap = (
  update: (current: Record<string, RepoPrState>) => Record<string, RepoPrState>
) => void;

export { replaceIssueInRepoState, replacePrInRepoState };

export function useGitHubWorkItemStatusMutations({
  repoSources,
  updateIssueMap,
  updatePrMap,
  setListError,
  updateErrorMessage,
  permissionErrorMessage,
}: {
  repoSources: GitHubRepoSource[];
  updateIssueMap: UpdateIssueMap;
  updatePrMap: UpdatePrMap;
  setListError: (error: string | null) => void;
  updateErrorMessage: string;
  permissionErrorMessage: string;
}) {
  const updateIssueStatus = useCallback(
    async (item: ManagedIssueItem, value: ManagedIssueStatusValue) => {
      if (
        (value === "open" && item.state === "open") ||
        (value === "closed_completed" &&
          item.state === "closed" &&
          item.rawIssue.state_reason !== "not_planned" &&
          item.rawIssue.state_reason !== "duplicate") ||
        (value === "closed_not_planned" &&
          item.state === "closed" &&
          item.rawIssue.state_reason === "not_planned") ||
        (value === "closed_duplicate" &&
          item.state === "closed" &&
          item.rawIssue.state_reason === "duplicate")
      ) {
        return;
      }
      // The canonical target is selected from the issue detail's nested
      // duplicate picker. The list only displays this state for an issue that
      // is already marked duplicate; it never initiates the mutation itself.
      if (value === "closed_duplicate") return;
      const source = findGitHubRepoSource(
        repoSources,
        item.repo,
        item.repoPath
      );
      if (!source) return;
      if (!canManageIssueStatus(item, source)) {
        setListError(permissionErrorMessage);
        Message.error(permissionErrorMessage);
        return;
      }
      const result =
        value === "open"
          ? await reopenIssue({
              remoteUrl: source.remoteUrl,
              issueNumber: item.id,
            })
          : await closeIssue({
              remoteUrl: source.remoteUrl,
              issueNumber: item.id,
              reason:
                value === "closed_not_planned" ? "not_planned" : "completed",
            });
      if (!result.data) {
        const error = result.error ?? updateErrorMessage;
        setListError(error);
        Message.error(error);
        return;
      }
      updateIssueMap((current) => {
        const key = getRepoIssueMapKey(source);
        const nextState = replaceIssueInRepoState(
          current[key] ?? EMPTY_REPO_ISSUES,
          result.data
        );
        const cacheKey = getGitHubListCacheKey(source);
        if (nextState.openLoaded) {
          updateCachedOpenIssues(cacheKey, nextState.openIssues);
        }
        if (nextState.closedLoaded) {
          updateCachedClosedIssues(cacheKey, nextState.closedIssues);
        }
        return { ...current, [key]: nextState };
      });
      setListError(null);
    },
    [
      permissionErrorMessage,
      repoSources,
      setListError,
      updateErrorMessage,
      updateIssueMap,
    ]
  );

  const updatePrStatus = useCallback(
    async (item: ManagedPrItem, value: ManagedPrStatusValue) => {
      const source = findGitHubRepoSource(
        repoSources,
        item.repo,
        item.repoPath
      );
      if (!source || item.state === "merged" || item.state === value) return;
      if (!canManagePrStatus(item, source)) {
        setListError(permissionErrorMessage);
        Message.error(permissionErrorMessage);
        return;
      }
      try {
        const pullRequest = {
          ...(await updatePRStateLocal(item.repo, item.id, value)),
          // State mutation responses do not run the list's batched CI
          // enrichment. Preserve the authoritative status already shown.
          ci_status: item.rawPr.ci_status,
        };
        updatePrMap((current) => {
          const key = getRepoIssueMapKey(source);
          const nextState = replacePrInRepoState(
            current[key] ?? EMPTY_REPO_PRS,
            pullRequest
          );
          const cacheKey = getGitHubListCacheKey(source);
          if (nextState.openLoaded) {
            setCachedPrs(cacheKey, nextState.openPrs, "open");
          }
          if (nextState.closedLoaded) {
            setCachedPrs(cacheKey, nextState.closedPrs, "closed");
          }
          return { ...current, [key]: nextState };
        });
        setListError(null);
      } catch (error: unknown) {
        const message = String(error) || updateErrorMessage;
        setListError(message);
        Message.error(message);
      }
    },
    [
      permissionErrorMessage,
      repoSources,
      setListError,
      updateErrorMessage,
      updatePrMap,
    ]
  );

  return { updateIssueStatus, updatePrStatus };
}

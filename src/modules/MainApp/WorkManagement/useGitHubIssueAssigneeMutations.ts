import { useCallback, useRef, useState } from "react";

import type { GitHubIssue, GitHubIssueUser } from "@src/api/tauri/github";
import Message from "@src/components/Message";
import {
  issueHasAssigneeLogins,
  resolveGitHubAssigneeUsers,
} from "@src/modules/shared/githubIssueAssignees";
import {
  updateCachedClosedIssues,
  updateCachedOpenIssues,
} from "@src/services/git/githubListCache";
import {
  fetchRepoAssignees,
  updateIssue,
} from "@src/services/git/operations/githubIssues";

import type { ManagedIssueItem } from "./githubManagedItemModel";
import {
  canManageIssueAssignees,
  findGitHubRepoSource,
} from "./githubWorkItemPermissions";
import { replaceIssueInRepoState } from "./githubWorkItemStateUpdates";
import {
  type GitHubRepoSource,
  getGitHubListCacheKey,
} from "./githubWorkItemsTypes";
import {
  EMPTY_REPO_ISSUES,
  type RepoIssueState,
  getRepoIssueMapKey,
} from "./useGitHubWorkItemsLoadLifecycle";

type UpdateIssueMap = (
  update: (
    current: Record<string, RepoIssueState>
  ) => Record<string, RepoIssueState>
) => void;

interface RepoAssigneeState {
  users: GitHubIssueUser[];
  loading: boolean;
  error: string | null;
}

export interface IssueAssigneeControlState extends RepoAssigneeState {
  updating: boolean;
}

function getIssueMutationKey(
  item: ManagedIssueItem,
  source: GitHubRepoSource
): string {
  return `${getGitHubListCacheKey(source)}:${item.id}`;
}

function getViewerPrefix(source: GitHubRepoSource): string {
  return `${source.viewerLogin?.trim().toLowerCase() || "unknown-viewer"}:`;
}

export function resolveIssueAssigneeUsers(
  item: ManagedIssueItem,
  assignableUsers: GitHubIssueUser[],
  assigneeLogins: string[]
): GitHubIssueUser[] {
  return resolveGitHubAssigneeUsers(
    item.rawIssue.assignees,
    assignableUsers,
    assigneeLogins
  );
}

export { issueHasAssigneeLogins };

export function useGitHubIssueAssigneeMutations({
  repoSources,
  updateIssueMap,
  setListError,
  updateErrorMessage,
  updateNotAppliedMessage,
  updateSuccessMessage,
  permissionErrorMessage,
}: {
  repoSources: GitHubRepoSource[];
  updateIssueMap: UpdateIssueMap;
  setListError: (error: string | null) => void;
  updateErrorMessage: string;
  updateNotAppliedMessage: string;
  updateSuccessMessage: string;
  permissionErrorMessage: string;
}) {
  const [assigneesByRepo, setAssigneesByRepo] = useState<
    Record<string, RepoAssigneeState>
  >({});
  const [updatingIssueKeys, setUpdatingIssueKeys] = useState<Set<string>>(
    () => new Set()
  );
  const attemptedReposRef = useRef(new Set<string>());
  const updatingIssueKeysRef = useRef(new Set<string>());
  const activeViewerRef = useRef<string | null>(null);
  activeViewerRef.current =
    repoSources
      .find((source) => source.viewerLogin)
      ?.viewerLogin?.trim()
      .toLowerCase() ?? null;

  const applyIssueUpdate = useCallback(
    (source: GitHubRepoSource, issue: GitHubIssue) => {
      updateIssueMap((current) => {
        const key = getRepoIssueMapKey(source);
        const nextState = replaceIssueInRepoState(
          current[key] ?? EMPTY_REPO_ISSUES,
          issue
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
    },
    [updateIssueMap]
  );

  const loadAssignableUsers = useCallback(
    async (item: ManagedIssueItem) => {
      const source = findGitHubRepoSource(
        repoSources,
        item.repo,
        item.repoPath
      );
      if (!canManageIssueAssignees(source) || !source) return;
      const key = getGitHubListCacheKey(source);
      const viewerPrefix = getViewerPrefix(source);
      for (const attemptedKey of attemptedReposRef.current) {
        if (!attemptedKey.startsWith(viewerPrefix)) {
          attemptedReposRef.current.delete(attemptedKey);
        }
      }
      if (attemptedReposRef.current.has(key)) return;
      attemptedReposRef.current.add(key);
      setAssigneesByRepo((current) => ({
        ...Object.fromEntries(
          Object.entries(current).filter(([entryKey]) =>
            entryKey.startsWith(viewerPrefix)
          )
        ),
        [key]: { users: current[key]?.users ?? [], loading: true, error: null },
      }));
      const viewerAtStart = source.viewerLogin?.trim().toLowerCase() ?? null;
      const result = await fetchRepoAssignees(source.remoteUrl);
      if (activeViewerRef.current !== viewerAtStart) return;
      setAssigneesByRepo((current) => ({
        ...current,
        [key]: result.data
          ? { users: result.data, loading: false, error: null }
          : {
              users: current[key]?.users ?? [],
              loading: false,
              error: result.error ?? updateErrorMessage,
            },
      }));
      if (result.error) {
        setListError(result.error);
        Message.error(result.error);
      }
    },
    [repoSources, setListError, updateErrorMessage]
  );

  const updateIssueAssignees = useCallback(
    async (
      item: ManagedIssueItem,
      assignees: string[]
    ): Promise<GitHubIssue | null> => {
      const source = findGitHubRepoSource(
        repoSources,
        item.repo,
        item.repoPath
      );
      if (!source || !canManageIssueAssignees(source)) {
        setListError(permissionErrorMessage);
        Message.error(permissionErrorMessage);
        return null;
      }
      const mutationKey = getIssueMutationKey(item, source);
      if (updatingIssueKeysRef.current.has(mutationKey)) return null;
      updatingIssueKeysRef.current.add(mutationKey);
      setUpdatingIssueKeys(new Set(updatingIssueKeysRef.current));
      const viewerAtStart = source.viewerLogin?.trim().toLowerCase() ?? null;
      const previousIssue = item.rawIssue;
      const optimisticIssue: GitHubIssue = {
        ...previousIssue,
        assignees: resolveIssueAssigneeUsers(
          item,
          assigneesByRepo[getGitHubListCacheKey(source)]?.users ?? [],
          assignees
        ),
      };
      applyIssueUpdate(source, optimisticIssue);
      try {
        const result = await updateIssue({
          remoteUrl: source.remoteUrl,
          issueNumber: item.id,
          updates: { assignees },
        });
        if (!result.data) {
          applyIssueUpdate(source, previousIssue);
          const error = result.error ?? updateErrorMessage;
          setListError(error);
          Message.error(error);
          return null;
        }
        if (activeViewerRef.current !== viewerAtStart) {
          applyIssueUpdate(source, previousIssue);
          return null;
        }
        if (!issueHasAssigneeLogins(result.data, assignees)) {
          applyIssueUpdate(source, previousIssue);
          setListError(updateNotAppliedMessage);
          Message.error(updateNotAppliedMessage);
          return null;
        }
        applyIssueUpdate(source, result.data);
        setListError(null);
        Message.success(updateSuccessMessage);
        return result.data;
      } finally {
        updatingIssueKeysRef.current.delete(mutationKey);
        if (activeViewerRef.current === viewerAtStart) {
          setUpdatingIssueKeys(new Set(updatingIssueKeysRef.current));
        }
      }
    },
    [
      applyIssueUpdate,
      assigneesByRepo,
      permissionErrorMessage,
      repoSources,
      setListError,
      updateErrorMessage,
      updateNotAppliedMessage,
      updateSuccessMessage,
    ]
  );

  const getIssueAssigneeControlState = useCallback(
    (item: ManagedIssueItem): IssueAssigneeControlState => {
      const source = findGitHubRepoSource(
        repoSources,
        item.repo,
        item.repoPath
      );
      const state = source
        ? assigneesByRepo[getGitHubListCacheKey(source)]
        : undefined;
      return {
        users: state?.users ?? [],
        loading: state?.loading ?? false,
        error: state?.error ?? null,
        updating: source
          ? updatingIssueKeys.has(getIssueMutationKey(item, source)) &&
            updatingIssueKeysRef.current.has(getIssueMutationKey(item, source))
          : false,
      };
    },
    [assigneesByRepo, repoSources, updatingIssueKeys]
  );

  return {
    getIssueAssigneeControlState,
    loadAssignableUsers,
    updateIssueAssignees,
  };
}

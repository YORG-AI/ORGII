/**
 * Repo Adapter
 *
 * Converts RepoItem domain objects into SpotlightItem format.
 * Shared across RepoSelector, SessionSourceSelector, and the main spotlight.
 */
import type { ReactNode } from "react";

import {
  isSystemHomeRepoItem,
  isSystemPathRepoItem,
} from "@src/features/SessionCreator/utils/systemPathSource";
import { REPO_KIND } from "@src/store/repo";
import { compactRepoPathForDisplay } from "@src/util/file/repoPathDisplay";

import { ICONS } from "../../config";
import type { RepoItem, SpotlightItem, SpotlightItemData } from "../../types";

export interface BuildRepoItemOptions {
  currentRepoId?: string;
  onAction: (repo: RepoItem) => void;
  /** Prefix for item IDs (avoids collisions in combined lists) */
  idPrefix?: string;
  /** Optional manage-mode action rendered on the right of each row. */
  manageAction?: (repo: RepoItem) => ReactNode;
  /** Optional manage-mode multi-select state for the row's leading checkbox. */
  getSelectionState?: (
    repo: RepoItem
  ) => SpotlightItemData["selectionState"] | undefined;
  /** Renders the repo's filesystem path under its name. Driven by the
   *  spotlight footer's "Show path" toggle; off by default. */
  showPath?: boolean;
}

/**
 * Converts a single RepoItem to a SpotlightItem.
 */
export function buildRepoSpotlightItem(
  repo: RepoItem,
  options: BuildRepoItemOptions
): SpotlightItem {
  const {
    currentRepoId,
    onAction,
    idPrefix = "",
    manageAction,
    getSelectionState,
    showPath = false,
  } = options;
  const inManageMode = !!manageAction;
  const copyPath = repo.fs_uri?.replace(/^file:\/\//, "").replace(/\/+$/, "");
  const displayPath = copyPath
    ? compactRepoPathForDisplay({ path: copyPath })
    : "";
  return {
    id: `${idPrefix}${repo.id}`,
    label: repo.name,
    desc: showPath && displayPath ? displayPath : undefined,
    icon: isSystemHomeRepoItem(repo)
      ? ICONS.home
      : isSystemPathRepoItem(repo) || repo.kind === REPO_KIND.FOLDER
        ? ICONS.folder
        : ICONS.repo,
    type: "repo" as const,
    data: {
      ...repo,
      isSelector: true,
      isCurrentSelection: repo.id === currentRepoId,
      contextMenuCopy: {
        name: repo.name,
        path: copyPath || undefined,
      },
      gitStatus: inManageMode ? undefined : repo.gitStatus,
      rightContent: inManageMode ? manageAction(repo) : undefined,
      selectionState: getSelectionState?.(repo),
    },
    action: () => onAction(repo),
  };
}

/**
 * Converts an array of RepoItems to SpotlightItems.
 */
export function buildRepoSpotlightItems(
  repos: RepoItem[],
  options: BuildRepoItemOptions
): SpotlightItem[] {
  return repos.map((repo) => buildRepoSpotlightItem(repo, options));
}

/**
 * Sorts repo items so the currently-selected repo appears first.
 */
export function sortRepoItemsSelectedFirst(
  items: SpotlightItem[]
): SpotlightItem[] {
  return [...items].sort((itemA, itemB) => {
    if (itemA.data?.isCurrentSelection) return -1;
    if (itemB.data?.isCurrentSelection) return 1;
    return 0;
  });
}

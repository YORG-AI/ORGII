/**
 * Workspace group header affordances for the sidebar's Organize-by-workspace
 * view: the hover `…` (pin / hide) and `+` (start a session sourced at that
 * workspace) actions on each group separator.
 *
 * `+` also adopts the group. Groups are keyed by the cwd their sessions ran
 * in, so one can be headed by a directory that was never added as a workspace
 * — every session imported from an external CLI's history lands in such a
 * group. Starting a session there registers the directory as a workspace and
 * resolves its checked-out branch first, so the launch carries a real repo id
 * instead of a bare path and the composer reads like any regular workspace.
 *
 * Pinning and hiding are the two ends of one ordering preference — pinned
 * groups sort above everything, hidden ones below — so they are mutually
 * exclusive: applying one clears the other rather than leaving a key in a
 * state whose rendered position depends on which check runs first.
 *
 * Neither is a filter. A hidden group keeps rendering, sorted last and
 * collapsed, so nothing becomes unreachable and the state is reversible from
 * the same menu. The persisted hidden set is mirrored into the sidebar's
 * collapsed-section ids, which is what actually folds the group: a workspace
 * group's section id IS its workspace key.
 */
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useAtom, useAtomValue, useSetAtom, useStore } from "jotai";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { gitApi } from "@src/api/http/git";
import { repoApi } from "@src/api/tauri/repo";
import { createLogger } from "@src/hooks/logger";
import {
  REPO_KIND,
  type Repo,
  reposAtom,
  validRepoIdsAtom,
} from "@src/store/repo";
import {
  matchRepoByPath,
  normalizeRepoPath,
} from "@src/store/repo/matchRepoByPath";
import {
  SESSION_SOURCE_TYPE,
  sessionSourceAtom,
} from "@src/store/session/creatorStateAtom";
import { showNativeMessageSafely } from "@src/util/dialogs/nativeDialog";
import {
  type NativeMenuItemOptions,
  popupNativeMenu,
} from "@src/util/platform/tauri/nativeMenuPopup";

import {
  sidebarHiddenWorkspacesAtom,
  sidebarPinnedWorkspacesAtom,
} from "../sidebarGroupByAtom";
import { NO_WORKSPACE_KEY } from "../types";
import type { WorkspaceGroupActions } from "../useSessionMenuItems/types";
import { importWorkspaceRepo } from "./importWorkspaceRepo";

const logger = createLogger("WorkspaceGroupActions");

interface UseWorkspaceGroupActionsParams {
  /** Labels are resolved by the connector so this hook stays i18n-free. */
  createSessionLabel: string;
  moreActionsLabel: string;
  pinLabel: string;
  unpinLabel: string;
  hideLabel: string;
  unhideLabel: string;
  revealLabel: string;
  unavailableTitle: string;
  unavailableMessage: string;
  /** The sidebar's own "new session" entry point (`openNewChatFromSidebar`). */
  openNewSession: () => void;
  setCollapsedSectionIds: (
    updater: (previous: Set<string>) => Set<string>
  ) => void;
}

async function showWorkspaceUnavailableDialog(
  workspaceKey: string,
  title: string,
  dialogMessage: string
): Promise<void> {
  try {
    await showNativeMessageSafely(`${dialogMessage}\n\n${workspaceKey}`, {
      title,
      kind: "warning",
    });
  } catch (error) {
    logger.warn("failed to show workspace unavailable dialog:", error);
  }
}

async function revealWorkspaceInFileManager(
  workspaceKey: string,
  unavailableTitle: string,
  unavailableMessage: string
): Promise<void> {
  let validatedWorkspacePath: string;
  try {
    // Backend validation is authoritative for workspace paths. Unlike the
    // frontend fs plugin, it can inspect valid folders outside $HOME (common
    // on Windows) without mistaking a missing runtime scope for a missing path.
    validatedWorkspacePath = await repoApi.validateWorkspacePath(workspaceKey);
  } catch (error) {
    logger.warn("workspace is unavailable:", error);
    await showWorkspaceUnavailableDialog(
      workspaceKey,
      unavailableTitle,
      unavailableMessage
    );
    return;
  }

  try {
    await revealItemInDir(validatedWorkspacePath);
  } catch (error) {
    logger.warn("failed to reveal workspace in file manager:", error);
    // Cover the narrow race where the folder disappears after the first
    // availability check but before the file manager handles the request.
    try {
      await repoApi.validateWorkspacePath(workspaceKey);
    } catch {
      await showWorkspaceUnavailableDialog(
        workspaceKey,
        unavailableTitle,
        unavailableMessage
      );
    }
  }
}

export function useWorkspaceGroupActions({
  createSessionLabel,
  moreActionsLabel,
  pinLabel,
  unpinLabel,
  hideLabel,
  unhideLabel,
  revealLabel,
  unavailableTitle,
  unavailableMessage,
  openNewSession,
  setCollapsedSectionIds,
}: UseWorkspaceGroupActionsParams): WorkspaceGroupActions {
  const [hiddenWorkspaces, setHiddenWorkspaces] = useAtom(
    sidebarHiddenWorkspacesAtom
  );
  const [pinnedWorkspaces, setPinnedWorkspaces] = useAtom(
    sidebarPinnedWorkspacesAtom
  );
  const repos = useAtomValue(reposAtom);
  const setRepos = useSetAtom(reposAtom);
  const setValidRepoIds = useSetAtom(validRepoIdsAtom);
  const setSessionSource = useSetAtom(sessionSourceAtom);
  const store = useStore();

  const hiddenWorkspaceKeys = useMemo(
    () => new Set(hiddenWorkspaces),
    [hiddenWorkspaces]
  );
  const pinnedWorkspaceKeys = useMemo(
    () => new Set(pinnedWorkspaces),
    [pinnedWorkspaces]
  );

  // Seed the collapsed set from the persisted hidden set once per mount, so a
  // workspace hidden in an earlier run comes back folded. Later toggles are
  // driven by the menu handler below, not by this effect — re-running it would
  // fight a viewer who deliberately expanded a hidden group.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || hiddenWorkspaceKeys.size === 0) return;
    seededRef.current = true;
    setCollapsedSectionIds((previous) => {
      const next = new Set(previous);
      for (const key of hiddenWorkspaceKeys) next.add(key);
      return next;
    });
  }, [hiddenWorkspaceKeys, setCollapsedSectionIds]);

  /**
   * Register a group's directory as a workspace and publish it to the repo
   * store, so the rest of the app treats it like any other workspace.
   *
   * Both atoms matter: `reposAtom` is what surfaces read a repo's name, path,
   * and kind from, while `validRepoIdsAtom` is what gates the branch fetch
   * (`useBranches`) — an id missing from it resolves no branches at all.
   * Resolves `null` when the directory can no longer be imported; the caller
   * keeps the path-only source rather than blocking the session on it.
   */
  const adoptWorkspaceRepo = useCallback(
    async (workspaceKey: string): Promise<Repo | null> => {
      try {
        const repo = await importWorkspaceRepo(workspaceKey);
        setRepos((previous) =>
          previous.some((candidate) => candidate.id === repo.id)
            ? previous
            : [...previous, repo]
        );
        setValidRepoIds((previous) =>
          previous.has(repo.id) ? previous : new Set(previous).add(repo.id)
        );
        return repo;
      } catch (error) {
        logger.warn("failed to add workspace group as a workspace:", error);
        return null;
      }
    },
    [setRepos, setValidRepoIds]
  );

  /**
   * Upgrade the creator's source in place once the workspace resolved.
   *
   * Guarded on the path because the import and the branch read are async: by
   * the time they land the viewer may have picked another repo in the
   * composer or hit `+` on a different group, and neither should be dragged
   * back to this workspace.
   */
  const applyResolvedWorkspaceSource = useCallback(
    (workspaceKey: string, repo: Repo, branch: string | undefined) => {
      const current = store.get(sessionSourceAtom);
      if (!current || current.type !== SESSION_SOURCE_TYPE.LOCAL) return;
      if (
        normalizeRepoPath(current.repoPath) !== normalizeRepoPath(workspaceKey)
      ) {
        return;
      }
      setSessionSource({
        ...current,
        repoId: repo.id,
        repoName: repo.name || current.repoName,
        branch: branch ?? current.branch,
      });
    },
    [setSessionSource, store]
  );

  /**
   * Resolve everything a "regular" workspace source carries: a repo id, and
   * the branch the directory is actually on.
   *
   * The branch is read from git rather than left to the creator's own sync,
   * which only mirrors the *selected* repo's checked-out branch — and this
   * source deliberately diverges from that selection, so the branch pill
   * would otherwise stay blank for every group but the active one.
   */
  const resolveWorkspaceSource = useCallback(
    async (workspaceKey: string, knownRepo: Repo | undefined) => {
      const repo = knownRepo ?? (await adoptWorkspaceRepo(workspaceKey));
      if (!repo) return;
      const branch =
        repo.kind === REPO_KIND.FOLDER
          ? undefined
          : await gitApi.getGitCurrentBranchName({
              repo_id: repo.id,
              repo_path: workspaceKey,
            });
      applyResolvedWorkspaceSource(workspaceKey, repo, branch);
    },
    [adoptWorkspaceRepo, applyResolvedWorkspaceSource]
  );

  const onCreateSession = useCallback(
    (workspaceKey: string) => {
      if (workspaceKey === NO_WORKSPACE_KEY) return;
      const repo = matchRepoByPath(repos, workspaceKey);
      // Writes the creator's source divergence only — never the global repo
      // selection, which stays the user's own explicit choice (see the
      // `sessionSourceAtom` contract in `useSessionCreator`).
      //
      // Written synchronously with what is already known so the composer
      // opens on the right workspace immediately; `resolveWorkspaceSource`
      // fills in the repo id and branch once the group's directory has been
      // added as a workspace, which is what every repo-keyed surface needs.
      setSessionSource({
        type: SESSION_SOURCE_TYPE.LOCAL,
        repoId: repo?.id,
        repoName: repo?.name ?? workspaceKey.split("/").pop() ?? workspaceKey,
        repoPath: workspaceKey,
      });
      openNewSession();
      void resolveWorkspaceSource(workspaceKey, repo);
    },
    [openNewSession, repos, resolveWorkspaceSource, setSessionSource]
  );

  /** Add or drop `key` in a persisted key list, without duplicating it. */
  const toggleKey = useCallback(
    (
      setKeys: (updater: (previous: string[]) => string[]) => void,
      key: string,
      present: boolean
    ) => {
      setKeys((previous) =>
        present
          ? previous.filter((candidate) => candidate !== key)
          : [...previous.filter((candidate) => candidate !== key), key]
      );
    },
    []
  );

  const setSectionCollapsed = useCallback(
    (key: string, collapsed: boolean) => {
      setCollapsedSectionIds((previous) => {
        const next = new Set(previous);
        if (collapsed) {
          next.add(key);
        } else {
          next.delete(key);
        }
        return next;
      });
    },
    [setCollapsedSectionIds]
  );

  const onOpenMenu = useCallback(
    (workspaceKey: string) => {
      const isPinned = pinnedWorkspaceKeys.has(workspaceKey);
      const isHidden = hiddenWorkspaceKeys.has(workspaceKey);
      void popupNativeMenu({
        source: "sidebar-workspace-group",
        buildItems: () => {
          const items: NativeMenuItemOptions[] = [];
          if (workspaceKey !== NO_WORKSPACE_KEY) {
            items.push(
              {
                text: revealLabel,
                action: () => {
                  void revealWorkspaceInFileManager(
                    workspaceKey,
                    unavailableTitle,
                    unavailableMessage
                  );
                },
              },
              { item: "Separator" }
            );
          }
          items.push({
            text: isPinned ? unpinLabel : pinLabel,
            action: () => {
              toggleKey(setPinnedWorkspaces, workspaceKey, isPinned);
              if (isPinned) return;
              // Pinning a hidden group lifts it out of hiding, and a group
              // the viewer just pinned should be readable, not folded.
              toggleKey(setHiddenWorkspaces, workspaceKey, true);
              setSectionCollapsed(workspaceKey, false);
            },
          });
          items.push({
            text: isHidden ? unhideLabel : hideLabel,
            action: () => {
              toggleKey(setHiddenWorkspaces, workspaceKey, isHidden);
              setSectionCollapsed(workspaceKey, !isHidden);
              if (!isHidden) toggleKey(setPinnedWorkspaces, workspaceKey, true);
            },
          });
          return items;
        },
      }).catch((error: unknown) => {
        logger.warn("workspace group menu failed to open:", error);
      });
    },
    [
      hiddenWorkspaceKeys,
      hideLabel,
      pinLabel,
      pinnedWorkspaceKeys,
      revealLabel,
      setHiddenWorkspaces,
      setPinnedWorkspaces,
      setSectionCollapsed,
      toggleKey,
      unavailableMessage,
      unavailableTitle,
      unhideLabel,
      unpinLabel,
    ]
  );

  return useMemo(
    () => ({
      pinnedWorkspaceKeys,
      hiddenWorkspaceKeys,
      onCreateSession,
      onOpenMenu,
      createSessionLabel,
      moreActionsLabel,
    }),
    [
      createSessionLabel,
      hiddenWorkspaceKeys,
      moreActionsLabel,
      onCreateSession,
      onOpenMenu,
      pinnedWorkspaceKeys,
    ]
  );
}

/**
 * Workspace management logic for WorkspacePalette.
 *
 * Handles:
 *   - Saved workspaces atom reads/writes
 *   - Workspace selection, edit, delete, and bulk-delete handlers
 *   - Derivation of workspace SpotlightItems (including manage-mode JSX)
 *
 * Extracted to keep WorkspacePalette/index.tsx under the UI component line limit.
 */
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { repoApi } from "@src/api/tauri/repo";
import {
  type WorkspaceRecord,
  deleteWorkspace,
  listWorkspaces,
} from "@src/api/tauri/workspace";
import Message from "@src/components/Message";
import { workspaceMatchesRepoFilter } from "@src/features/TeamCollaboration/orgScopeRepoFilter";
import { createLogger } from "@src/hooks/logger";
import { useFilteredItems } from "@src/hooks/search";
import { CodeXmlIcon, HugeiconsIcon } from "@src/icons";
import {
  activeWorkspaceIdAtom,
  activeWorkspaceNameAtom,
  savedWorkspacesAtom,
  setWorkspaceFoldersAtom,
} from "@src/store/ui/workspaceFoldersAtom";
import type { WorkspaceFolder } from "@src/types/workspace";
import { confirmDestructiveAction } from "@src/util/dialogs/confirmDestructiveAction";

import { ICONS } from "../../config";
import type { AddWorkspaceModalStage } from "../../hooks";
import type { RepoItem, SpotlightItem } from "../../types";

const log = createLogger("WorkspacePalette");

// ============================================================================
// Types
// ============================================================================

export interface UseWorkspacePaletteWorkspaceOptions {
  repos: RepoItem[];
  isManageMode: boolean;
  selectedIds: Set<string>;
  toggleSelection: (id: string) => void;
  clearSelection: () => void;
  setModalStage: (stage: AddWorkspaceModalStage) => void;
  onClose: () => void;
  refreshReposForce: () => Promise<void>;
  /** Free-text search query used to filter workspace items by name + member repos. */
  searchQuery: string;
  /** multiRepoWorkspaceForm from useAddWorkspaceFlow — only `setEditingWorkspace` is needed */
  setEditingWorkspace: (ws: WorkspaceRecord) => void;
  /**
   * Org-scope membership predicate (e.g. active cloud org repo scope).
   * Non-matching workspaces are not hidden; their items carry an
   * `outsideOrgScope` data flag so the section builder can group them
   * under "Outside this org".
   */
  repoFilter?: (repo: { fs_uri?: string | null }) => boolean;
}

export interface UseWorkspacePaletteWorkspaceReturn {
  workspaceItems: SpotlightItem[];
  handleBulkDelete: () => Promise<void>;
}

function normalizeFsPath(path: string | undefined): string {
  if (!path) return "";
  const stripped = path.startsWith("file://")
    ? path.replace("file://", "")
    : path;
  return stripped.replace(/\/+$/, "");
}

function buildWorkspaceRepoNameResolver(repos: RepoItem[]) {
  const byId = new Map<string, string>(
    repos.map((repo) => [repo.id, String(repo.name ?? "")])
  );
  const byPath = new Map<string, string>(
    repos
      .map((repo): [string, string] => [
        normalizeFsPath(repo.fs_uri),
        String(repo.name ?? ""),
      ])
      .filter(([path]) => Boolean(path))
  );

  return (folder: WorkspaceRecord["folders"][number]): string => {
    if (folder.repoId) {
      const name = byId.get(folder.repoId);
      if (name) return name;
    }

    const name = byPath.get(normalizeFsPath(folder.folderPath));
    return name ?? folder.folderName;
  };
}

// ============================================================================
// Hook
// ============================================================================

export function useWorkspacePaletteWorkspace({
  repos,
  isManageMode,
  selectedIds,
  toggleSelection,
  clearSelection,
  setModalStage,
  onClose,
  refreshReposForce,
  searchQuery,
  setEditingWorkspace,
  repoFilter,
}: UseWorkspacePaletteWorkspaceOptions): UseWorkspacePaletteWorkspaceReturn {
  const { t } = useTranslation();
  const [savedWorkspaces, setSavedWorkspaces] = useAtom(savedWorkspacesAtom);
  const activeWorkspaceId = useAtomValue(activeWorkspaceIdAtom);
  const dispatchSetFolders = useSetAtom(setWorkspaceFoldersAtom);
  const setActiveWorkspaceName = useSetAtom(activeWorkspaceNameAtom);

  const resolveWorkspaceRepoName = useMemo(
    () => buildWorkspaceRepoNameResolver(repos),
    [repos]
  );

  const handleWorkspaceSelect = useCallback(
    (ws: WorkspaceRecord) => {
      const folders: WorkspaceFolder[] = ws.folders.map((folder) => ({
        id: crypto.randomUUID(),
        name: resolveWorkspaceRepoName(folder),
        path: folder.folderPath,
        uri: `file://${folder.folderPath}`,
        isPrimary: folder.isPrimary,
        repoId: folder.repoId ?? undefined,
        kind: folder.kind === "folder" ? ("folder" as const) : ("git" as const),
      }));
      dispatchSetFolders(folders, ws.workspaceId);
      setActiveWorkspaceName(ws.name);
      onClose();
    },
    [
      dispatchSetFolders,
      resolveWorkspaceRepoName,
      setActiveWorkspaceName,
      onClose,
    ]
  );

  const handleEditWorkspace = useCallback(
    (ws: WorkspaceRecord) => {
      setEditingWorkspace(ws);
      setModalStage("create-workspace");
    },
    [setEditingWorkspace, setModalStage]
  );

  const handleDeleteWorkspace = useCallback(
    async (ws: WorkspaceRecord) => {
      const confirmed = await confirmDestructiveAction({
        title: t("confirmation.deleteWorkspaceTitle", { name: ws.name }),
        message: t("confirmation.deleteWorkspaceMessage"),
        okLabel: t("actions.delete"),
        cancelLabel: t("actions.cancel"),
      });
      if (!confirmed) return;
      try {
        await deleteWorkspace(ws.workspaceId);
        if (ws.workspaceId === activeWorkspaceId) {
          dispatchSetFolders([], null);
          setActiveWorkspaceName(null);
        }
        const refreshed = await listWorkspaces();
        setSavedWorkspaces(refreshed);
        Message.success(
          t("selectors.spotlight.toast.workspaceRemoved", "Workspace deleted")
        );
      } catch (error) {
        log.error("Error deleting workspace:", error);
        Message.error(
          error instanceof Error
            ? error.message
            : t(
                "selectors.spotlight.toast.workspaceRemoveFailed",
                "Failed to delete workspace"
              )
        );
      }
    },
    [
      t,
      activeWorkspaceId,
      dispatchSetFolders,
      setActiveWorkspaceName,
      setSavedWorkspaces,
    ]
  );

  const handleBulkDelete = useCallback(async () => {
    if (selectedIds.size === 0) return;

    const workspaceTargets: WorkspaceRecord[] = [];
    const repoTargetIds: string[] = [];
    for (const id of selectedIds) {
      if (id.startsWith("workspace-")) {
        const wsId = id.slice("workspace-".length);
        const ws = savedWorkspaces.find((w) => w.workspaceId === wsId);
        if (ws) workspaceTargets.push(ws);
      } else {
        repoTargetIds.push(id);
      }
    }

    const total = workspaceTargets.length + repoTargetIds.length;
    if (total === 0) return;

    const confirmed = await confirmDestructiveAction({
      title: t("confirmation.deleteSelectedTitle", {
        count: total,
      }),
      message: t(
        "confirmation.deleteSelectedMessage",
        "This only removes their linkage to ORGII. Nothing will be removed from disk."
      ),
      okLabel: t("actions.removeFromOrgii"),
      cancelLabel: t("actions.cancel"),
    });
    if (!confirmed) return;

    const workspaceResults = await Promise.allSettled(
      workspaceTargets.map(async (ws) => {
        await deleteWorkspace(ws.workspaceId);
        return ws;
      })
    );
    const repoResults = await Promise.allSettled(
      repoTargetIds.map(async (repoId) => {
        await repoApi.deleteRepo(repoId);
        return repoId;
      })
    );

    let deletedCount = 0;
    let failedCount = 0;
    let activeWorkspaceWasDeleted = false;

    for (let idx = 0; idx < workspaceResults.length; idx += 1) {
      const result = workspaceResults[idx];
      const target = workspaceTargets[idx];
      if (result.status === "fulfilled") {
        deletedCount += 1;
        if (target.workspaceId === activeWorkspaceId) {
          activeWorkspaceWasDeleted = true;
        }
      } else {
        log.error("Error deleting workspace:", result.reason);
        failedCount += 1;
      }
    }
    for (const result of repoResults) {
      if (result.status === "fulfilled") {
        deletedCount += 1;
      } else {
        log.error("Error removing repo:", result.reason);
        failedCount += 1;
      }
    }

    if (activeWorkspaceWasDeleted) dispatchSetFolders([], null);

    if (workspaceTargets.length > 0) {
      try {
        setSavedWorkspaces(await listWorkspaces());
      } catch (error) {
        log.error("Error refreshing workspaces:", error);
      }
    }
    if (repoTargetIds.length > 0) {
      try {
        await refreshReposForce();
      } catch (error) {
        log.error("Error refreshing repos:", error);
      }
    }

    clearSelection();

    if (failedCount === 0) {
      Message.success(
        t("selectors.spotlight.toast.bulkDeleted", {
          count: deletedCount,
        })
      );
    } else {
      Message.error(
        t("selectors.spotlight.toast.bulkDeleteFailed", {
          count: failedCount,
        })
      );
    }
  }, [
    selectedIds,
    savedWorkspaces,
    activeWorkspaceId,
    dispatchSetFolders,
    setSavedWorkspaces,
    refreshReposForce,
    clearSelection,
    t,
  ]);

  const getWorkspaceSearchText = useCallback(
    (ws: WorkspaceRecord): string => {
      const memberNames = ws.folders.map(resolveWorkspaceRepoName);
      const memberPaths = ws.folders.map((folder) => folder.folderPath ?? "");
      return [ws.name, ...memberNames, ...memberPaths]
        .filter(Boolean)
        .join(" ");
    },
    [resolveWorkspaceRepoName]
  );

  const { filteredItems: filteredWorkspaces } = useFilteredItems({
    items: savedWorkspaces,
    searchQuery,
    getSearchText: getWorkspaceSearchText,
  });

  const workspaceItems = useMemo((): SpotlightItem[] => {
    const isOutsideOrgScope = (ws: WorkspaceRecord): boolean =>
      !!repoFilter &&
      !workspaceMatchesRepoFilter(
        ws.folders.map((folder) => folder.folderPath),
        repoFilter
      );
    const orderedWorkspaces = [...filteredWorkspaces].sort(
      (workspaceA, workspaceB) => {
        if (workspaceA.workspaceId === activeWorkspaceId) return -1;
        if (workspaceB.workspaceId === activeWorkspaceId) return 1;
        return 0;
      }
    );

    return orderedWorkspaces.map((ws: WorkspaceRecord) => {
      const names = ws.folders.map(resolveWorkspaceRepoName);
      const workspacePath =
        ws.folders.find((folder) => folder.isPrimary)?.folderPath ??
        ws.folders[0]?.folderPath;
      const isActive = ws.workspaceId === activeWorkspaceId;
      const repoCount = ws.folders.length;
      const itemId = `workspace-${ws.workspaceId}`;
      const isChecked = selectedIds.has(itemId);
      const repoCountBadge = (
        <span
          className="flex items-center gap-1 text-[12px] text-text-2"
          title={`${repoCount} repo${repoCount !== 1 ? "s" : ""}: ${names.join(", ")}`}
        >
          {repoCount}
          <HugeiconsIcon icon={CodeXmlIcon} data-icon="code" size={12} />
        </span>
      );
      const manageActions = (
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              handleEditWorkspace(ws);
            }}
            className="flex items-center justify-center rounded-md p-1 text-text-2 transition-colors hover:bg-fill-3 hover:text-text-1"
            title={t("actions.edit", "Edit")}
          >
            <HugeiconsIcon icon={ICONS.editRepo} size={14} />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void handleDeleteWorkspace(ws);
            }}
            className="hover:text-error-6 flex items-center justify-center rounded-md p-1 text-text-2 transition-colors hover:bg-fill-3"
            title={t("actions.delete", "Delete")}
          >
            <HugeiconsIcon icon={ICONS.removeRepo} size={14} />
          </button>
        </div>
      );
      return {
        id: itemId,
        label: ws.name,
        icon: ICONS.workspace,
        type: "repo" as const,
        data: {
          isCurrentSelection: isActive,
          outsideOrgScope: isOutsideOrgScope(ws),
          updatedAt: ws.updatedAt,
          contextMenuCopy: {
            name: ws.name,
            path: workspacePath || undefined,
          },
          rightContent: isManageMode ? manageActions : repoCountBadge,
          selectionState: isManageMode
            ? { checked: isChecked, onToggle: () => toggleSelection(itemId) }
            : undefined,
        },
        action: () => {
          if (isManageMode) {
            toggleSelection(itemId);
          } else {
            handleWorkspaceSelect(ws);
          }
        },
      };
    });
  }, [
    filteredWorkspaces,
    repoFilter,
    activeWorkspaceId,
    handleWorkspaceSelect,
    handleEditWorkspace,
    handleDeleteWorkspace,
    resolveWorkspaceRepoName,
    isManageMode,
    selectedIds,
    toggleSelection,
    t,
  ]);

  return { workspaceItems, handleBulkDelete };
}

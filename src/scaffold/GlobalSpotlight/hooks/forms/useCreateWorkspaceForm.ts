/**
 * useCreateWorkspaceForm Hook
 *
 * Manages the state for creating or editing a Multi-repo Workspace from
 * the repo selector palette. Reads the repo catalog, on submit either
 * creates a new DB-backed workspace or updates an existing one via the
 * Tauri API, and activates it.
 */
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useState } from "react";

import {
  type WorkspaceFolderRecord,
  type WorkspaceRecord,
  createWorkspace,
  updateWorkspace,
} from "@src/api/tauri/workspace";
import { listWorkspaces } from "@src/api/tauri/workspace";
import { reposAtom } from "@src/store/repo";
import {
  activeWorkspaceNameAtom,
  savedWorkspacesAtom,
  setWorkspaceFoldersAtom,
} from "@src/store/ui/workspaceFoldersAtom";
import type { WorkspaceFolder } from "@src/types/workspace";

import type { RepoItem } from "../../types";

const MAX_WORKSPACE_REPOS = 5;

interface UseCreateWorkspaceFormOptions {
  onSuccess?: () => void;
  onClose?: () => void;
}

export interface UseCreateWorkspaceFormReturn {
  repos: RepoItem[];
  loading: boolean;
  /** Pre-populated workspace for edit mode (null = create mode). */
  editingWorkspace: WorkspaceRecord | null;
  setEditingWorkspace: (ws: WorkspaceRecord | null) => void;
  /** Submit handler. Creates a new workspace when editingWorkspace is null,
   *  otherwise updates the existing record. */
  handleSubmit: (
    selectedRepoIds: string[],
    workspaceName: string
  ) => Promise<void> | void;
  resetForm: () => void;
}

export function useCreateWorkspaceForm(
  options: UseCreateWorkspaceFormOptions
): UseCreateWorkspaceFormReturn {
  const { onSuccess, onClose } = options;

  const centralRepos = useAtomValue(reposAtom);
  const dispatchSetFolders = useSetAtom(setWorkspaceFoldersAtom);
  const setSavedWorkspaces = useSetAtom(savedWorkspacesAtom);
  const setActiveWorkspaceName = useSetAtom(activeWorkspaceNameAtom);
  const [loading, setLoading] = useState(false);
  const [editingWorkspace, setEditingWorkspace] =
    useState<WorkspaceRecord | null>(null);

  const repos: RepoItem[] = centralRepos.map((repo) => ({
    id: repo.id,
    name: repo.name,
    description: repo.description,
    repo_url: repo.repo_url,
    branch: repo.branch,
    fs_uri: repo.fs_uri,
    workspace_uuid: repo.workspace_uuid,
    kind: repo.kind,
  }));

  const handleSubmit = useCallback(
    async (selectedRepoIds: string[], workspaceName: string) => {
      if (
        selectedRepoIds.length < 2 ||
        selectedRepoIds.length > MAX_WORKSPACE_REPOS
      )
        return;

      setLoading(true);
      try {
        const repoMap = new Map(centralRepos.map((repo) => [repo.id, repo]));

        const apiFolders: WorkspaceFolderRecord[] = selectedRepoIds
          .map((repoId, index) => {
            const repo = repoMap.get(repoId);
            if (!repo) return null;

            const rawPath = repo.path ?? repo.fs_uri ?? "";
            const path = rawPath.startsWith("file://")
              ? rawPath.replace("file://", "")
              : rawPath;

            return {
              folderPath: path,
              folderName: repo.name ?? path.split("/").pop() ?? path,
              sortOrder: index,
              isPrimary: index === 0,
              repoId: repo.id,
              kind: repo.kind === "folder" ? "folder" : "git",
            };
          })
          .filter((f): f is NonNullable<typeof f> => f !== null);

        if (apiFolders.length < 2) return;

        const persisted = editingWorkspace
          ? await updateWorkspace(
              editingWorkspace.workspaceId,
              workspaceName,
              apiFolders
            )
          : await createWorkspace(workspaceName, apiFolders);

        const folders: WorkspaceFolder[] = persisted.folders.map((folder) => {
          const repoName = folder.repoId
            ? repoMap.get(folder.repoId)?.name
            : undefined;
          return {
            id: crypto.randomUUID(),
            name: repoName ?? folder.folderName,
            path: folder.folderPath,
            uri: `file://${folder.folderPath}`,
            isPrimary: folder.isPrimary,
            repoId: folder.repoId ?? undefined,
            kind:
              folder.kind === "folder" ? ("folder" as const) : ("git" as const),
          };
        });

        dispatchSetFolders(folders, persisted.workspaceId);
        setActiveWorkspaceName(persisted.name);

        const refreshed = await listWorkspaces();
        setSavedWorkspaces(refreshed);

        setEditingWorkspace(null);
        onSuccess?.();
        onClose?.();
      } finally {
        setLoading(false);
      }
    },
    [
      centralRepos,
      dispatchSetFolders,
      setActiveWorkspaceName,
      setSavedWorkspaces,
      onSuccess,
      onClose,
      editingWorkspace,
    ]
  );

  const resetForm = useCallback(() => {
    setLoading(false);
    setEditingWorkspace(null);
  }, []);

  return {
    repos,
    loading,
    editingWorkspace,
    setEditingWorkspace,
    handleSubmit,
    resetForm,
  };
}

/**
 * RepoLoader - Global component to load repos on app initialization
 *
 * Responsibilities:
 * - Auto-loads repos on mount (autoLoad: true)
 * - Loads saved workspaces from DB and hydrates savedWorkspacesAtom
 * - Restores the active workspace (if any) on startup
 * - Listens for app-controlled File > Open Recent events
 *   and routes them to repo selection
 * - Handles "Add Folder to Workspace" menu events (multi-root workspace)
 * - Syncs selected repo → workspace folders (migration from single-repo)
 */
import { useAtomValue, useSetAtom } from "jotai";
import { type FC, useCallback, useEffect, useRef } from "react";

import { type WorkspaceRecord, listWorkspaces } from "@src/api/tauri/workspace";
import { setEventStoreRepoContext } from "@src/engines/SessionCore/ingestion/rustBridge";
import { useRepoSelection } from "@src/hooks/git/useRepoSelection";
import { useRecentFolderEvents } from "@src/hooks/git/useRepoSelection/useRecentFolderEvents";
import { useWorkspaceGitStatus } from "@src/hooks/git/useWorkspaceGitStatus";
import { createLogger } from "@src/hooks/logger";
import { useTerminalRepoSync } from "@src/hooks/terminal/useTerminalRepoSync";
import {
  closeWorkspace,
  openWorkspaceFile,
  recordRecentWorkspace,
  saveWorkspaceAs,
} from "@src/services/workspace";
import {
  activeWorkspaceIdAtom,
  addWorkspaceFolderAtom,
  savedWorkspacesAtom,
  setWorkspaceFoldersAtom,
  workspaceConfigPathAtom,
  workspaceFoldersAtom,
} from "@src/store/ui/workspaceFoldersAtom";
import type { WorkspaceFolder } from "@src/types/workspace";

const log = createLogger("RepoLoader");

function normalizeToFsPath(path: string): string {
  return path.startsWith("file://") ? path.replace("file://", "") : path;
}

export const RepoLoader: FC = () => {
  const { repos, currentRepo, selectRepo, forceRefreshRepos } =
    useRepoSelection({
      autoLoad: true,
    });

  const workspaceFolders = useAtomValue(workspaceFoldersAtom);
  const activeWorkspaceId = useAtomValue(activeWorkspaceIdAtom);
  const dispatchAddFolder = useSetAtom(addWorkspaceFolderAtom);
  const dispatchSetFolders = useSetAtom(setWorkspaceFoldersAtom);
  const setSavedWorkspaces = useSetAtom(savedWorkspacesAtom);
  const setConfigPath = useSetAtom(workspaceConfigPathAtom);

  const addWorkspaceFolder = useCallback(
    (path: string) => {
      dispatchAddFolder({ path });
    },
    [dispatchAddFolder]
  );

  const resetWorkspaceFolders = useCallback(() => {
    prevRepoPathRef.current = undefined;
    dispatchSetFolders([]);
  }, [dispatchSetFolders]);

  const workspaceFoldersRef = useRef(workspaceFolders);
  useEffect(() => {
    workspaceFoldersRef.current = workspaceFolders;
  }, [workspaceFolders]);

  const handleSaveWorkspaceAs = useCallback(async () => {
    const folders = workspaceFoldersRef.current;
    if (folders.length === 0) return;
    const savedPath = await saveWorkspaceAs(folders);
    if (savedPath) {
      setConfigPath(savedPath);
      recordRecentWorkspace(savedPath, folders);
    }
  }, [setConfigPath]);

  const handleOpenWorkspaceFile = useCallback(async () => {
    try {
      const result = await openWorkspaceFile();
      if (!result) return;
      dispatchSetFolders(result.folders);
      setConfigPath(result.filePath);
      recordRecentWorkspace(result.filePath, result.folders);
    } catch (error) {
      log.error("[RepoLoader] Failed to open workspace file:", error);
    }
  }, [dispatchSetFolders, setConfigPath]);

  const handleCloseWorkspace = useCallback(() => {
    const folders = workspaceFoldersRef.current;
    const next = closeWorkspace(folders);
    dispatchSetFolders(next);
    setConfigPath(null);
  }, [dispatchSetFolders, setConfigPath]);

  // Load saved workspaces from DB on mount, then restore the active
  // workspace if one was previously active. Falls back to syncing the
  // current repo as a single-folder workspace.
  const prevRepoPathRef = useRef<string | undefined>(undefined);
  const restoreAttemptedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const syncPrimaryFolder = () => {
      const rawPath = currentRepo?.path ?? currentRepo?.fs_uri;
      if (!rawPath) return;
      const repoPath = normalizeToFsPath(rawPath);
      if (repoPath === prevRepoPathRef.current) return;
      prevRepoPathRef.current = repoPath;

      if (workspaceFoldersRef.current.length > 1) return;

      const repoName =
        currentRepo?.name ?? repoPath.split("/").pop() ?? repoPath;

      const primaryFolder: WorkspaceFolder = {
        id: currentRepo?.id ?? crypto.randomUUID(),
        name: repoName,
        path: repoPath,
        uri: `file://${repoPath}`,
        isPrimary: true,
      };

      dispatchSetFolders([primaryFolder]);
    };

    if (!restoreAttemptedRef.current) {
      restoreAttemptedRef.current = true;

      (async () => {
        try {
          const dbWorkspaces = await listWorkspaces();
          if (!cancelled) {
            setSavedWorkspaces(dbWorkspaces);
          }

          if (
            !cancelled &&
            activeWorkspaceId &&
            workspaceFoldersRef.current.length <= 1
          ) {
            const active = dbWorkspaces.find(
              (ws: WorkspaceRecord) => ws.workspaceId === activeWorkspaceId
            );
            if (active && active.folders.length >= 2) {
              const folders: WorkspaceFolder[] = active.folders.map((f) => ({
                id: crypto.randomUUID(),
                name: f.folderName,
                path: f.folderPath,
                uri: `file://${f.folderPath}`,
                isPrimary: f.isPrimary,
                repoId: f.repoId ?? undefined,
                kind:
                  f.kind === "folder" ? ("folder" as const) : ("git" as const),
              }));
              dispatchSetFolders(folders, activeWorkspaceId);
              return;
            }
          }
        } catch {
          // DB not ready — fall through to sync
        }

        if (!cancelled) {
          syncPrimaryFolder();
        }
      })();
    } else {
      syncPrimaryFolder();
    }

    return () => {
      cancelled = true;
    };
  }, [currentRepo, activeWorkspaceId, dispatchSetFolders, setSavedWorkspaces]);

  useRecentFolderEvents({
    repos,
    selectRepo,
    forceRefreshRepos,
    addWorkspaceFolder,
    resetWorkspaceFolders,
    onSaveWorkspaceAs: handleSaveWorkspaceAs,
    onOpenWorkspaceFile: handleOpenWorkspaceFile,
    onCloseWorkspace: handleCloseWorkspace,
  });

  useWorkspaceGitStatus();
  useTerminalRepoSync();

  // Sync active repo context to Rust EventStore so new events are stamped
  useEffect(() => {
    const rawPath = currentRepo?.path ?? currentRepo?.fs_uri;
    const repoPath = rawPath
      ? rawPath.startsWith("file://")
        ? rawPath.replace("file://", "")
        : rawPath
      : undefined;
    setEventStoreRepoContext(currentRepo?.id, repoPath).catch(() => {
      /* EventStore may not be ready yet */
    });
  }, [currentRepo?.id, currentRepo?.path, currentRepo?.fs_uri]);

  return null;
};

export default RepoLoader;

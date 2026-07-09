/**
 * useWorkspaceGitStatus - Multi-root workspace git status tracking
 *
 * Registers file watchers for all workspace folders and collects
 * per-folder git status into workspaceGitStatusMapAtom.
 *
 * When the workspace has a single folder, this is a no-op
 * (the existing GitStatusProvider handles it).
 */
import { invoke } from "@tauri-apps/api/core";
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { getGitStatus } from "@src/api/http/git/status";
import { getCodeEditorWebSocket } from "@src/api/realtime/codeEditorWebSocket";
import { createLogger } from "@src/hooks/logger";
import { workspaceGitStatusMapAtom } from "@src/store/git";
import {
  isMultiRootWorkspaceAtom,
  workspaceFoldersAtom,
} from "@src/store/ui/workspaceFoldersAtom";
import type { GitRepositoryStatus } from "@src/types/session/steps";

const log = createLogger("useWorkspaceGitStatus");

interface RegisteredFolder {
  id: string;
  path: string;
}

export function useWorkspaceGitStatus(): void {
  const workspaceFolders = useAtomValue(workspaceFoldersAtom);
  const isMultiRoot = useAtomValue(isMultiRootWorkspaceAtom);
  const setWorkspaceGitStatusMap = useSetAtom(workspaceGitStatusMapAtom);

  const registeredFoldersRef = useRef<Map<string, RegisteredFolder>>(new Map());
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Stable key derived from folder paths only — renames/reorders of folders
  // must not retrigger watcher registration or full status refetches.
  const folderPathsKey = useMemo(
    () =>
      workspaceFolders
        .map((folder) => folder.path)
        .sort()
        .join("\n"),
    [workspaceFolders]
  );

  // Keep latest folders in a ref so path-keyed effects can read them
  // without depending on the array identity. Declared before the consuming
  // effects so it runs first on every commit.
  const workspaceFoldersRef = useRef(workspaceFolders);
  useEffect(() => {
    workspaceFoldersRef.current = workspaceFolders;
  }, [workspaceFolders]);

  const registerAndUnregisterWatchers = useCallback(async () => {
    if (!isMultiRoot) return;

    const folders = workspaceFoldersRef.current;
    const currentPathSet = new Set(folders.map((f) => f.path));

    // Unwatch folders that were removed from the workspace
    const toUnwatch: string[] = [];
    for (const [path, folder] of registeredFoldersRef.current) {
      if (!currentPathSet.has(path)) {
        toUnwatch.push(folder.id);
        registeredFoldersRef.current.delete(path);
      }
    }

    for (const folderId of toUnwatch) {
      try {
        await invoke("unwatch_repo", { repoId: folderId });
      } catch {
        // Already unwatched or manager not ready — safe to ignore
      }
    }

    // Register new folders
    const reposToRegister = folders
      .filter((folder) => !registeredFoldersRef.current.has(folder.path))
      .map((folder) => ({
        repo_id: folder.id,
        repo_path: folder.path,
        repo_name: folder.name,
      }));

    if (reposToRegister.length === 0) return;

    try {
      await invoke("watch_repos", { repos: reposToRegister });
      for (const repo of reposToRegister) {
        registeredFoldersRef.current.set(repo.repo_path, {
          id: repo.repo_id,
          path: repo.repo_path,
        });
      }
    } catch (error) {
      log.error("[useWorkspaceGitStatus] Failed to register watchers:", error);
    }
  }, [isMultiRoot]);

  // Register/unregister watchers when folder paths change.
  // New folders are registered immediately; the delay only applies to
  // the initial mount (avoids thrashing during rapid workspace load).
  useEffect(() => {
    if (!isMultiRoot || workspaceFoldersRef.current.length <= 1) return;

    const hasRegistered = registeredFoldersRef.current.size > 0;

    if (hasRegistered) {
      registerAndUnregisterWatchers();
      return;
    }

    if (pendingTimerRef.current) {
      clearTimeout(pendingTimerRef.current);
    }

    const INITIAL_DELAY_MS = 1000;
    pendingTimerRef.current = setTimeout(() => {
      pendingTimerRef.current = null;
      registerAndUnregisterWatchers();
    }, INITIAL_DELAY_MS);

    return () => {
      if (pendingTimerRef.current) {
        clearTimeout(pendingTimerRef.current);
        pendingTimerRef.current = null;
      }
    };
  }, [isMultiRoot, folderPathsKey, registerAndUnregisterWatchers]);

  // When leaving multi-root mode, unwatch everything and clear the map
  // so stale watchers and entries don't linger.
  useEffect(() => {
    if (isMultiRoot) return;
    if (registeredFoldersRef.current.size === 0) return;

    if (pendingTimerRef.current) {
      clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = null;
    }

    const registered = [...registeredFoldersRef.current.values()];
    registeredFoldersRef.current.clear();

    for (const folder of registered) {
      invoke("unwatch_repo", { repoId: folder.id }).catch(() => {
        // Already unwatched or manager not ready — safe to ignore
      });
    }

    setWorkspaceGitStatusMap((prev) => (prev.size > 0 ? new Map() : prev));
  }, [isMultiRoot, setWorkspaceGitStatusMap]);

  // Fetch initial status for each workspace folder + prune stale entries
  useEffect(() => {
    const folders = workspaceFoldersRef.current;
    if (!isMultiRoot || folders.length <= 1) return;

    let cancelled = false;

    const currentPaths = new Set(folders.map((f) => f.path));
    setWorkspaceGitStatusMap((prev) => {
      let pruned = false;
      const next = new Map(prev);
      for (const key of next.keys()) {
        if (!currentPaths.has(key)) {
          next.delete(key);
          pruned = true;
        }
      }
      return pruned ? next : prev;
    });

    const fetchAllStatuses = async () => {
      for (const folder of folders) {
        if (cancelled) return;
        try {
          const statusData = await getGitStatus({
            repo_id: folder.id,
            repo_path: folder.path,
          });
          if (!cancelled && statusData) {
            setWorkspaceGitStatusMap((prev) => {
              const next = new Map(prev);
              next.set(folder.path, statusData as GitRepositoryStatus);
              return next;
            });
          }
        } catch {
          // Folder may not be a git repo - that's fine
        }
      }
    };

    fetchAllStatuses();

    return () => {
      cancelled = true;
    };
  }, [isMultiRoot, folderPathsKey, setWorkspaceGitStatusMap]);

  // Listen for status updates from all workspace folders.
  // Handlers on CodeEditorWebSocketClient are client-level and survive socket
  // reconnects, so subscribing once is reconnect-safe. The only gap is the
  // singleton not existing yet when this effect runs — poll briefly for it
  // instead of permanently giving up.
  useEffect(() => {
    const folders = workspaceFoldersRef.current;
    if (!isMultiRoot || folders.length <= 1) return;

    let mounted = true;
    let unsubscribe: (() => void) | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const folderPathById = new Map<string, string>();
    for (const folder of folders) {
      folderPathById.set(folder.id, folder.path);
    }

    const trySubscribe = () => {
      if (!mounted) return;

      const websocket = getCodeEditorWebSocket();
      if (!websocket) {
        retryTimer = setTimeout(trySubscribe, 1000);
        return;
      }

      unsubscribe = websocket.on("repo:status_updated", (data) => {
        if (!mounted) return;
        if (document.hidden) return;

        const payload = data as {
          repo_id?: string;
          status?: GitRepositoryStatus;
        };

        if (!payload.repo_id || !payload.status) return;

        const folderPath = folderPathById.get(payload.repo_id);
        if (!folderPath) return;

        setWorkspaceGitStatusMap((prev) => {
          const next = new Map(prev);
          next.set(folderPath, payload.status as GitRepositoryStatus);
          return next;
        });
      });
    };

    trySubscribe();

    return () => {
      mounted = false;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
      unsubscribe?.();
    };
  }, [isMultiRoot, folderPathsKey, setWorkspaceGitStatusMap]);
}

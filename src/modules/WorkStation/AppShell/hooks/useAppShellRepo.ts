import { exists } from "@tauri-apps/plugin-fs";
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";

import { activeWorkspaceRootAtom } from "@src/store/workspace";
import { activeHostAtom } from "@src/store/workstation";
import { toFsPluginPath } from "@src/util/file/pathUtils";

const getFolderName = (path: string): string => {
  if (!path) return "";
  const cleanPath = path.replace(/\/+$/, "");
  const segments = cleanPath.split("/").filter(Boolean);
  return segments[segments.length - 1] || "";
};

const normalizePath = (path: string): string => {
  if (!path) return "";
  // Strip `file://` and the Windows `\\?\` verbatim prefix so the fs plugin's
  // `exists()` gets a path it can parse.
  return toFsPluginPath(path);
};

export interface AppShellRepoState {
  repoPath: string;
  repoName: string;
  /** null = not yet checked / not in code mode; false = path missing; true = path ok */
  pathExists: boolean | null;
  lastSeenPath: string;
}

export function useAppShellRepo(): AppShellRepoState {
  const activeWorkspaceRoot = useAtomValue(activeWorkspaceRootAtom);
  const repoPath = activeWorkspaceRoot?.path ?? "";
  const repoName = activeWorkspaceRoot?.name ?? getFolderName(repoPath);

  // Unified surface: gate the repo-path check on the active tab's host, not the
  // route — the Code Editor shows whenever a code-host tab is active.
  const activeHost = useAtomValue(activeHostAtom);

  const [pathExists, setPathExists] = useState<boolean | null>(null);
  const [lastSeenPath, setLastSeenPath] = useState<string>("");

  useEffect(() => {
    let cancelled = false;

    const checkPathExists = async () => {
      if (activeHost !== "code") {
        setPathExists(null);
        return;
      }

      if (!repoPath) {
        setPathExists(null);
        return;
      }

      const normalizedPath = normalizePath(repoPath);
      if (!normalizedPath) {
        setPathExists(null);
        return;
      }

      try {
        const pathExistsResult = await exists(normalizedPath);
        if (cancelled) return;
        setPathExists(pathExistsResult);
        if (pathExistsResult) {
          setLastSeenPath("");
        } else {
          setLastSeenPath(normalizedPath);
        }
      } catch (_pathCheckError) {
        if (cancelled) return;
        // `exists()` (Tauri fs plugin) throws for reasons other than a missing
        // path — notably when the path is outside the plugin's $HOME scope, or
        // is an extended-length `\\?\` path from canonicalize(). Both are common
        // on Windows, where repos often live outside the home dir (C:\Projects\…).
        // Treat a throw as "unknown", not "missing", so a valid out-of-home repo
        // still renders instead of showing a false "Cannot find".
        setPathExists(null);
      }
    };

    checkPathExists();
    return () => {
      cancelled = true;
    };
  }, [repoPath, activeHost]);

  return { repoPath, repoName, pathExists, lastSeenPath };
}

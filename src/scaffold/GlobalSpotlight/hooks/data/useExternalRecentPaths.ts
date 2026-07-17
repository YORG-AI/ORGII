import { useEffect, useMemo, useState } from "react";

import {
  claudeCodeRecentPaths,
  codexAppRecentPaths,
  opencodeRecentPaths,
  qoderRecentPaths,
  warpRecentPaths,
  windsurfRecentPaths,
  zcodeRecentPaths,
} from "@src/api/tauri/externalHistory";
import type { RepoItem } from "@src/scaffold/GlobalSpotlight/types";
import { REPO_KIND } from "@src/store/repo";

import { getWorkspacePathDisplayName } from "../../palettes/WorkspacePalette/pathImport";

export const EXTERNAL_RECENT_PATH_WORKSPACE_THRESHOLD = 5;
const EXTERNAL_RECENT_PATH_LIMIT = 12;

interface RecentPathRecord {
  path: string;
  name?: string;
  lastUsedAt: string;
  sessionCount: number;
}

interface UseExternalRecentPathsOptions {
  enabled: boolean;
  existingRepoPaths: readonly string[];
  searchQuery: string;
}

interface UseExternalRecentPathsReturn {
  recentPathRepos: RepoItem[];
}

function normalizePath(path: string): string {
  return path
    .trim()
    .replace(/^file:\/\//, "")
    .replace(/[\\/]+$/, "");
}

function mergeRecentPaths(paths: RecentPathRecord[]): RecentPathRecord[] {
  const byPath = new Map<string, RecentPathRecord>();

  for (const recentPath of paths) {
    const path = normalizePath(recentPath.path);
    if (!path) continue;

    const existing = byPath.get(path);
    if (!existing) {
      byPath.set(path, { ...recentPath, path });
      continue;
    }

    byPath.set(path, {
      path,
      name: existing.name ?? recentPath.name,
      lastUsedAt:
        recentPath.lastUsedAt > existing.lastUsedAt
          ? recentPath.lastUsedAt
          : existing.lastUsedAt,
      sessionCount: existing.sessionCount + recentPath.sessionCount,
    });
  }

  return [...byPath.values()].sort((pathA, pathB) =>
    pathB.lastUsedAt.localeCompare(pathA.lastUsedAt)
  );
}

export function useExternalRecentPaths({
  enabled,
  existingRepoPaths,
  searchQuery,
}: UseExternalRecentPathsOptions): UseExternalRecentPathsReturn {
  const [paths, setPaths] = useState<RecentPathRecord[]>([]);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

    Promise.all([
      codexAppRecentPaths({ limit: EXTERNAL_RECENT_PATH_LIMIT }),
      claudeCodeRecentPaths({ limit: EXTERNAL_RECENT_PATH_LIMIT }),
      opencodeRecentPaths({ limit: EXTERNAL_RECENT_PATH_LIMIT }),
      windsurfRecentPaths({ limit: EXTERNAL_RECENT_PATH_LIMIT }),
      warpRecentPaths({ limit: EXTERNAL_RECENT_PATH_LIMIT }),
      zcodeRecentPaths({ limit: EXTERNAL_RECENT_PATH_LIMIT }),
      qoderRecentPaths({ limit: EXTERNAL_RECENT_PATH_LIMIT }),
    ]).then(
      ([
        codexPaths,
        claudePaths,
        opencodePaths,
        windsurfPaths,
        warpPaths,
        zcodePaths,
        qoderPaths,
      ]) => {
        if (!cancelled) {
          setPaths(
            mergeRecentPaths([
              ...codexPaths,
              ...claudePaths,
              ...opencodePaths,
              ...windsurfPaths,
              ...warpPaths,
              ...zcodePaths,
              ...qoderPaths,
            ])
          );
        }
      }
    );

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const existingPaths = useMemo(
    () => new Set(existingRepoPaths.map(normalizePath).filter(Boolean)),
    [existingRepoPaths]
  );

  const normalizedQuery = searchQuery.trim().toLowerCase();

  const recentPathRepos = useMemo(() => {
    return paths
      .filter(
        (recentPath) => !existingPaths.has(normalizePath(recentPath.path))
      )
      .filter((recentPath) => {
        if (!normalizedQuery) return true;
        const name =
          recentPath.name ?? getWorkspacePathDisplayName(recentPath.path);
        return [name, recentPath.path].some((value) =>
          value.toLowerCase().includes(normalizedQuery)
        );
      })
      .slice(0, EXTERNAL_RECENT_PATH_LIMIT)
      .map((recentPath): RepoItem => {
        const name =
          recentPath.name ?? getWorkspacePathDisplayName(recentPath.path);
        return {
          id: `external-recent:${recentPath.path}`,
          name,
          description: recentPath.path,
          fs_uri: recentPath.path,
          kind: REPO_KIND.FOLDER,
        };
      });
  }, [existingPaths, normalizedQuery, paths]);

  return { recentPathRepos };
}

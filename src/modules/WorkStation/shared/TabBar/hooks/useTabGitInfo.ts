import { useMemo } from "react";

import type { GitFileInfo } from "@src/store/git";
import type { WorkStationTab } from "@src/store/workstation/tabs";

type GitStatusLookup = {
  directMap: Map<string, GitFileInfo>;
  suffixIndex: Map<string, Array<[string, GitFileInfo]>>;
};

function normalizeGitPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

function trimTrailingSlash(path: string): string {
  return path.replace(/\/+$/, "");
}

function getBaseName(path: string): string {
  const separatorIndex = path.lastIndexOf("/");
  return separatorIndex === -1 ? path : path.slice(separatorIndex + 1);
}

function getRelativeFilePath(filePath: string, repoPath: string): string {
  const normalizedFilePath = normalizeGitPath(filePath);
  const normalizedRepoPath = trimTrailingSlash(normalizeGitPath(repoPath));

  if (
    normalizedRepoPath &&
    normalizedFilePath.startsWith(`${normalizedRepoPath}/`)
  ) {
    return normalizedFilePath.slice(normalizedRepoPath.length + 1);
  }

  return normalizedFilePath;
}

function createGitStatusLookup(
  gitStatusMap: Map<string, GitFileInfo>
): GitStatusLookup {
  const directMap = new Map<string, GitFileInfo>();
  const suffixIndex = new Map<string, Array<[string, GitFileInfo]>>();

  for (const [relativePath, gitInfo] of gitStatusMap) {
    const normalizedPath = normalizeGitPath(relativePath);
    directMap.set(normalizedPath, gitInfo);

    const baseName = getBaseName(normalizedPath);
    const entries = suffixIndex.get(baseName);
    if (entries) {
      entries.push([normalizedPath, gitInfo]);
    } else {
      suffixIndex.set(baseName, [[normalizedPath, gitInfo]]);
    }
  }

  return { directMap, suffixIndex };
}

function getGitInfoForFilePath(
  lookup: GitStatusLookup,
  filePath: string,
  repoPath: string
): GitFileInfo | null {
  const relativeFilePath = getRelativeFilePath(filePath, repoPath);
  const directInfo = lookup.directMap.get(relativeFilePath);
  if (directInfo) return directInfo;

  const baseName = getBaseName(relativeFilePath);
  const suffixCandidates = lookup.suffixIndex.get(baseName);
  if (!suffixCandidates) return null;

  for (const [relativePath, gitInfo] of suffixCandidates) {
    if (
      relativeFilePath === relativePath ||
      relativeFilePath.endsWith(`/${relativePath}`)
    ) {
      return gitInfo;
    }
  }

  return null;
}

export function useTabGitInfoMap(
  tabs: WorkStationTab[],
  repoPath: string,
  gitStatusMap: Map<string, GitFileInfo>
): Map<string, GitFileInfo> {
  const lookup = useMemo(
    () => createGitStatusLookup(gitStatusMap),
    [gitStatusMap]
  );

  return useMemo(() => {
    if (tabs.length === 0 || gitStatusMap.size === 0) {
      return new Map<string, GitFileInfo>();
    }

    const tabGitInfoMap = new Map<string, GitFileInfo>();

    for (const tab of tabs) {
      if (tab.type !== "file") continue;

      const filePath = tab.data.filePath;
      if (typeof filePath !== "string" || filePath.length === 0) continue;

      const gitInfo = getGitInfoForFilePath(lookup, filePath, repoPath);
      if (gitInfo) {
        tabGitInfoMap.set(tab.id, gitInfo);
      }
    }

    return tabGitInfoMap;
  }, [gitStatusMap.size, lookup, repoPath, tabs]);
}

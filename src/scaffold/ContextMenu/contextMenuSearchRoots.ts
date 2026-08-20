import type { SearchResultItem } from "@src/scaffold/ContextMenu/types";
import type { Repo } from "@src/store/repo/types";
import type { WorkspaceFolder } from "@src/types/workspace";

export interface ContextMenuSearchRoot {
  path: string;
  name: string;
}

export function normalizeRootPath(path: string): string {
  return path.replace(/\/+$/, "");
}

export function basenameFromPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export function buildContextMenuSearchRoots(params: {
  repoPath?: string;
  currentRepo?: Pick<Repo, "name" | "path"> | null;
  workspaceFolders?: ReadonlyArray<Pick<WorkspaceFolder, "path" | "name">>;
}): ContextMenuSearchRoot[] {
  const roots: ContextMenuSearchRoot[] = [];
  const seen = new Set<string>();

  const addRoot = (path: string | undefined, name: string | undefined) => {
    if (!path) return;
    const normalizedPath = normalizeRootPath(path);
    if (!normalizedPath || seen.has(normalizedPath)) return;
    seen.add(normalizedPath);
    roots.push({
      path: normalizedPath,
      name: name?.trim() || basenameFromPath(normalizedPath) || normalizedPath,
    });
  };

  for (const folder of params.workspaceFolders ?? []) {
    addRoot(folder.path, folder.name);
  }

  addRoot(
    params.repoPath || params.currentRepo?.path,
    params.currentRepo?.name || basenameFromPath(params.repoPath ?? "")
  );

  return roots;
}

export function buildRootSearchResult(
  root: ContextMenuSearchRoot
): SearchResultItem {
  return {
    type: "folder",
    path: root.path,
    name: root.name,
    repoPath: root.path,
    repoName: root.name,
    iconType: "repo",
  };
}

export function attachSearchRootMetadata(
  matches: SearchResultItem[],
  root: ContextMenuSearchRoot
): SearchResultItem[] {
  return matches.map((match) => ({
    ...match,
    repoPath: root.path,
    repoName: root.name,
  }));
}

export function mergeSearchResultsByRoot(
  resultGroups: ReadonlyArray<ReadonlyArray<SearchResultItem>>,
  maxResults: number
): SearchResultItem[] {
  const seen = new Set<string>();
  const merged: SearchResultItem[] = [];

  for (const group of resultGroups) {
    for (const item of group) {
      const key = `${item.repoPath ?? ""}\0${item.type}\0${item.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
      if (merged.length >= maxResults) return merged;
    }
  }

  return merged;
}

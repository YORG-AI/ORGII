import type { ContextMenuSearchRoot } from "@src/scaffold/ContextMenu/contextMenuSearchRoots";
import { normalizeRootPath } from "@src/scaffold/ContextMenu/contextMenuSearchRoots";
import type { FileSearchResult as NativeFileSearchResult } from "@src/util/platform/tauri/fileSearch";

import type { FileSearchResult } from "../types";

export function mapNativeFileResultsForRoot(
  files: NativeFileSearchResult[],
  root: ContextMenuSearchRoot
): FileSearchResult[] {
  const normalizedRoot = normalizeRootPath(root.path);
  const rootPrefix = `${normalizedRoot}/`;

  return files.map((file) => {
    const path = normalizeRootPath(file.path);
    const relativePath = path.startsWith(rootPrefix)
      ? path.slice(rootPrefix.length)
      : path === normalizedRoot
        ? ""
        : path;
    const parts = relativePath.split("/").filter(Boolean);
    const name = parts[parts.length - 1] || file.filename || path;
    const directory = parts.slice(0, -1).join("/") || "/";

    return {
      path: file.path,
      name,
      directory,
      score: file.score,
      repoPath: normalizedRoot,
      repoName: root.name,
    };
  });
}

export function mergeFileModeResults(
  resultGroups: ReadonlyArray<ReadonlyArray<FileSearchResult>>,
  maxResults: number
): FileSearchResult[] {
  const seen = new Set<string>();
  return resultGroups
    .flat()
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .filter((item) => {
      const key = `${item.repoPath}\0${item.path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, maxResults);
}

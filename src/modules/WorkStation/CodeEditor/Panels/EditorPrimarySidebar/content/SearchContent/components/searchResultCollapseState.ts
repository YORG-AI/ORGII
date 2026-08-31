import type { SearchResultFile } from "./types";

export interface SearchResultCollapseState {
  firstFile: string;
  resultCount: number;
  collapsedFiles: Set<string>;
}

function allResultPaths(results: SearchResultFile[]): Set<string> {
  return new Set(results.map((result) => result.file_path));
}

export function createSearchResultCollapseState(
  results: SearchResultFile[],
  totalMatches: number,
  autoCollapseThreshold: number
): SearchResultCollapseState {
  return {
    firstFile: results[0]?.file_path ?? "",
    resultCount: results.length,
    collapsedFiles:
      totalMatches > autoCollapseThreshold
        ? allResultPaths(results)
        : new Set(),
  };
}

export function advanceSearchResultCollapseState(
  previous: SearchResultCollapseState,
  results: SearchResultFile[],
  totalMatches: number,
  autoCollapseThreshold: number,
  collapseNewFilesOnLoadMore: boolean
): SearchResultCollapseState {
  const firstFile = results[0]?.file_path ?? "";
  if (
    previous.firstFile === firstFile &&
    previous.resultCount === results.length
  ) {
    return previous;
  }

  const isNewSearch = firstFile !== previous.firstFile && firstFile !== "";
  const isLoadMore = results.length > previous.resultCount && !isNewSearch;
  let collapsedFiles = previous.collapsedFiles;
  if (isNewSearch) {
    collapsedFiles =
      totalMatches > autoCollapseThreshold
        ? allResultPaths(results)
        : new Set();
  } else if (
    collapseNewFilesOnLoadMore &&
    isLoadMore &&
    totalMatches > autoCollapseThreshold
  ) {
    collapsedFiles = new Set(previous.collapsedFiles);
    for (const result of results) {
      collapsedFiles.add(result.file_path);
    }
  }

  return {
    firstFile,
    resultCount: results.length,
    collapsedFiles,
  };
}

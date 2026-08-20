/**
 * Search State Atoms
 *
 * Jotai atoms for codebase search state management.
 * Shared by both UI (useRepoSearchPanel) and AI (SearchService).
 *
 * Related submodules (also re-exported below):
 * - cacheAtom: Search result caching with TTL and stats
 * - fileTrackingAtom: Incremental indexing file tracking
 * - ignoreAtom: .gitignore / custom ignore pattern management
 * - indexingProgressAtom: Indexing progress UI state
 */
import { atom } from "jotai";

import type { SearchOptions, SearchResultFile } from "./types";

export type { SearchMatch, SearchResultFile, SearchOptions } from "./types";

// ============================================
// Default Values
// ============================================

const DEFAULT_EXCLUDE_DIRS = ["node_modules", ".git", "dist", "build"];

const DEFAULT_OPTIONS: SearchOptions = {
  caseSensitive: false,
  wholeWord: false,
  useRegex: false,
  fileExtensions: [],
  excludeDirs: DEFAULT_EXCLUDE_DIRS,
  filesToInclude: "",
  filesToExclude: "",
  onlyOpenFiles: false,
};

// ============================================
// Core State Atoms
// ============================================

/** Current search query */
export const searchQueryAtom = atom<string>("");
searchQueryAtom.debugLabel = "searchQueryAtom";

/** Search options */
export const searchOptionsAtom = atom<SearchOptions>(DEFAULT_OPTIONS);
searchOptionsAtom.debugLabel = "searchOptionsAtom";

/** Search results (current page/batch) */
export const searchResultsAtom = atom<SearchResultFile[]>([]);
searchResultsAtom.debugLabel = "searchResultsAtom";

/** Loading state */
export const searchLoadingAtom = atom<boolean>(false);
searchLoadingAtom.debugLabel = "searchLoadingAtom";

/** Loading more results */
export const searchLoadingMoreAtom = atom<boolean>(false);
searchLoadingMoreAtom.debugLabel = "searchLoadingMoreAtom";

/** Error state */
export const searchErrorAtom = atom<string | null>(null);
searchErrorAtom.debugLabel = "searchErrorAtom";

/** Whether more results are available */
export const searchHasMoreAtom = atom<boolean>(false);
searchHasMoreAtom.debugLabel = "searchHasMoreAtom";

/** Actual total matches (may be more than loaded) */
export const searchActualTotalMatchesAtom = atom<number>(0);
searchActualTotalMatchesAtom.debugLabel = "searchActualTotalMatchesAtom";

/** Actual total files (may be more than loaded) */
export const searchActualTotalFilesAtom = atom<number>(0);
searchActualTotalFilesAtom.debugLabel = "searchActualTotalFilesAtom";

// ============================================
// Derived Atoms
// ============================================

/** Total matches count (loaded) */
export const searchTotalMatchesAtom = atom((get) => {
  const results = get(searchResultsAtom);
  return results.reduce((sum, file) => sum + file.matches.length, 0);
});
searchTotalMatchesAtom.debugLabel = "searchTotalMatchesAtom";

/** Total files count (loaded) */
export const searchTotalFilesAtom = atom((get) => {
  return get(searchResultsAtom).length;
});
searchTotalFilesAtom.debugLabel = "searchTotalFilesAtom";

// ============================================
// Action Atoms
// ============================================

/** Set search query */
export const searchSetQueryAtom = atom(null, (_get, set, query: string) => {
  set(searchQueryAtom, query);
});

/** Update search options */
export const searchSetOptionsAtom = atom(
  null,
  (get, set, options: Partial<SearchOptions>) => {
    const current = get(searchOptionsAtom);
    set(searchOptionsAtom, { ...current, ...options });
  }
);

/** Clear search results */
export const searchClearAtom = atom(null, (_get, set) => {
  set(searchResultsAtom, []);
  set(searchErrorAtom, null);
  set(searchHasMoreAtom, false);
  set(searchActualTotalMatchesAtom, 0);
  set(searchActualTotalFilesAtom, 0);
});

/**
 * Hard ceiling on matches retained in `searchResultsAtom` across "load more"
 * rounds. Mirrors `SEARCH_CONSTANTS.MAX_TOTAL_RESULTS` in the search sidebar
 * (which already renders "20,000+" past this point) — without it, repeated
 * load-more on a broad regex accumulated result rows without bound.
 */
export const SEARCH_MAX_RETAINED_MATCHES = 20_000;

/** Append more results (bounded by `SEARCH_MAX_RETAINED_MATCHES`). */
export const searchAppendResultsAtom = atom(
  null,
  (get, set, newResults: SearchResultFile[]) => {
    const current = get(searchResultsAtom);
    let retained = current.reduce((sum, file) => sum + file.matches.length, 0);
    const accepted: SearchResultFile[] = [];
    let truncated = false;
    for (const file of newResults) {
      if (retained >= SEARCH_MAX_RETAINED_MATCHES) {
        truncated = true;
        break;
      }
      accepted.push(file);
      retained += file.matches.length;
    }
    if (accepted.length > 0) {
      set(searchResultsAtom, [...current, ...accepted]);
    }
    if (truncated || retained >= SEARCH_MAX_RETAINED_MATCHES) {
      set(searchHasMoreAtom, false);
    }
  }
);

// ============================================
// Re-exports from submodules
// ============================================

export * from "./cacheAtom";
export * from "./fileTrackingAtom";
export * from "./ignoreAtom";
export type { IndexingProgress } from "./indexingProgressAtom";
export {
  indexingProgressAtom,
  isIndexingAtom,
  indexingPercentAtom,
  indexingStatusMessageAtom,
  startIndexingProgressAtom,
  updateIndexingProgressAtom,
  completeIndexingAtom,
  setIndexingErrorAtom,
  cancelIndexingAtom,
  resetIndexingAtom,
} from "./indexingProgressAtom";
export * from "./searchTabSessionCache";

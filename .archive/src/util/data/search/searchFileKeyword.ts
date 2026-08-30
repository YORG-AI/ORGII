/**
 * File Search Service
 *
 * Provides file and folder search functionality using native Tauri search.
 * The native search uses Rust with fuzzy matching for file and folder paths.
 */
import { createLogger } from "@src/hooks/logger";
import { debounceAsync } from "@src/util/core/debounce";
import {
  convertToSearchResultItems,
  isNativeSearchAvailable,
  searchFilesNative,
} from "@src/util/platform/tauri/fileSearch";

const log = createLogger("FileSearch");

// Type definition for search results
interface SearchResultItem {
  type: "file" | "folder";
  path: string;
}

// ============================================
// Constants
// ============================================

/** Storage key for current workspace local path */
const WORKSPACE_PATH_KEY = "currentWorkspaceLocalPath";

/** Default file extensions for search filtering */
const _DEFAULT_FILE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".json",
  ".md",
  ".css",
  ".scss",
  ".html",
  ".vue",
  ".py",
  ".rs",
  ".go",
];

// ============================================
// Path Management
// ============================================

/**
 * Get the current workspace local path for native search
 *
 * Checks multiple sources in order:
 * 1. Session storage (currentWorkspaceLocalPath)
 * 2. Local storage (currentWorkspaceLocalPath)
 * 3. Returns null if no local path is available
 */
export const getCurrentRepoPath = (): string | null => {
  // Check session storage first (for current session)
  const sessionPath = sessionStorage.getItem(WORKSPACE_PATH_KEY);
  if (sessionPath) return sessionPath;

  // Check local storage (for persistence across sessions)
  const localPath = localStorage.getItem(WORKSPACE_PATH_KEY);
  if (localPath) return localPath;

  return null;
};

/**
 * Set the current workspace local path for native search
 *
 * @param path Local filesystem path (e.g., /Users/me/project)
 */
export const setCurrentRepoPath = (path: string | null): void => {
  if (path) {
    sessionStorage.setItem(WORKSPACE_PATH_KEY, path);
    localStorage.setItem(WORKSPACE_PATH_KEY, path);
  } else {
    sessionStorage.removeItem(WORKSPACE_PATH_KEY);
    localStorage.removeItem(WORKSPACE_PATH_KEY);
  }
};

// ============================================
// Search Implementation
// ============================================

interface SearchResult {
  files: SearchResultItem[];
  folders: SearchResultItem[];
  showFullPath: boolean;
}

/**
 * Search using native Tauri filesystem
 */
const searchNative = async (
  keyword: string,
  repoPath: string
): Promise<SearchResult | null> => {
  try {
    const results = await searchFilesNative({
      root_path: repoPath,
      query: keyword,
      max_results: 20,
      // Optionally filter by common code file extensions
      // file_extensions: DEFAULT_FILE_EXTENSIONS,
    });

    const converted = convertToSearchResultItems(results);

    return {
      files: converted.files,
      folders: converted.folders,
      showFullPath: true,
    };
  } catch (error) {
    log.warn("[FileSearch] Native search failed:", error);
    return null;
  }
};

/**
 * Fallback when native search is not available
 * Returns empty results - API search has been removed
 */
const searchFallback = async (keyword: string): Promise<SearchResult> => {
  if (keyword) {
    // Return empty results - API search removed
    return { files: [], folders: [], showFullPath: true };
  } else {
    // Return placeholder items when no keyword
    return {
      files: [{ type: "file" as const, path: "File" }],
      folders: [{ type: "folder" as const, path: "Folder" }],
      showFullPath: false,
    };
  }
};

/**
 * Main search implementation
 *
 * Priority:
 * 1. If native search is available AND workspace has a local path → use native
 * 2. Otherwise → use fallback search
 */
const searchForKeywordImpl = async (keyword: string): Promise<SearchResult> => {
  const repoPath = getCurrentRepoPath();

  // Try native search first if available
  if (isNativeSearchAvailable() && repoPath) {
    const nativeResult = await searchNative(keyword, repoPath);
    if (nativeResult) {
      return nativeResult;
    }
    // If native search failed, fall through to fallback
  }

  // Use fallback when native search is not available
  return searchFallback(keyword);
};

// ============================================
// Exports
// ============================================

/**
 * Debounced search function for use in components
 *
 * @example
 * ```typescript
 * const { files, folders, showFullPath } = await searchForKeyword('comp');
 * ```
 */
export const searchForKeyword = debounceAsync(searchForKeywordImpl, 300);

/**
 * Non-debounced search function for immediate searches
 */
export const searchForKeywordImmediate = searchForKeywordImpl;

/**
 * Check if native search is currently available
 *
 * This checks both:
 * 1. Tauri APIs are initialized
 * 2. A local repo path is set
 */
export const isNativeSearchEnabled = (): boolean => {
  return isNativeSearchAvailable() && getCurrentRepoPath() !== null;
};

export default {
  searchForKeyword,
  searchForKeywordImmediate,
  getCurrentRepoPath,
  setCurrentRepoPath,
  isNativeSearchEnabled,
};

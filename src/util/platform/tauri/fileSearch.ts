/**
 * Tauri File Search Module
 *
 * High-performance native file search using Rust backend with fuzzy matching.
 * Provides Cursor/Continue-like file search experience.
 *
 * Features:
 * - Fuzzy matching for filename and path search
 * - Fast directory traversal with .gitignore support
 * - Path-aware scoring (filename matches ranked higher)
 * - Cached file index for repeated searches
 */
import { createLogger } from "@src/hooks/logger";
import type { SearchResultItem } from "@src/scaffold/ContextMenu/types";

import { ensureTauriReady, invokeTauri, isTauriReady } from "./init";

const log = createLogger("FileSearch");
const prewarmRequests = new Map<string, Promise<number>>();

// ============================================
// Types
// ============================================

export interface FileSearchResult {
  path: string;
  type: "file" | "folder";
  score: number;
  filename: string;
}

export interface SearchResults {
  files: FileSearchResult[];
  folders: FileSearchResult[];
  total_indexed: number;
  search_time_ms: number;
}

/**
 * Default max search results - aligned with VS Code's approach
 * VS Code uses 20,000; we use 500 as a reasonable balance for UI performance
 */
export const DEFAULT_MAX_SEARCH_RESULTS = 500;

export interface SearchOptions {
  /** Root directory path to search in */
  root_path: string;
  /** Search query string */
  query: string;
  /** Maximum number of results (default: 500, VS Code uses 20000) */
  max_results?: number;
  /** Filter by file extensions (e.g., ['.ts', '.tsx']) */
  file_extensions?: string[];
  /** Directories to exclude (default: node_modules, .git, dist, etc.) */
  exclude_dirs?: string[];
}

// ============================================
// Search Functions
// ============================================

/**
 * Search files in a directory with fuzzy matching using native Tauri command
 *
 * @param options Search configuration options
 * @returns Search results with files and folders
 * @throws Error if not in Tauri environment or search fails
 *
 * @example
 * ```typescript
 * const results = await searchFilesNative({
 *   root_path: '/Users/me/project',
 *   query: 'cpt',
 *   max_results: 20,
 * });
 * // results.files = [{ path: '/src/component.tsx', ... }]
 * ```
 */
export async function searchFilesNative(
  options: SearchOptions
): Promise<SearchResults> {
  ensureTauriReady();

  try {
    const result = await invokeTauri<SearchResults>("search_files_fuzzy", {
      options: {
        root_path: options.root_path,
        query: options.query,
        max_results: options.max_results ?? DEFAULT_MAX_SEARCH_RESULTS,
        file_extensions: options.file_extensions,
        exclude_dirs: options.exclude_dirs,
      },
    });

    return result;
  } catch (error) {
    log.error("[FileSearch] Native search failed:", error);
    throw error;
  }
}

/**
 * Force re-index a workspace directory
 *
 * Call this when you know files have changed and want to refresh the cache.
 *
 * @param rootPath Root directory to index
 * @param excludeDirs Optional directories to exclude
 * @returns Number of files indexed
 */
export async function indexProjectFiles(
  rootPath: string,
  excludeDirs?: string[]
): Promise<number> {
  ensureTauriReady();

  try {
    const count = await invokeTauri<number>("index_project_files", {
      root_path: rootPath,
      exclude_dirs: excludeDirs,
    });
    return count;
  } catch (error) {
    log.error("[FileSearch] Failed to index project:", error);
    throw error;
  }
}

/**
 * Pre-warm the file index for a workspace directory.
 *
 * Call this when a project is opened / switched so that the first `@`
 * search is instant.  If the cache is already fresh, this is a no-op
 * on the Rust side (returns immediately with the cached count).
 *
 * @param rootPath Root directory to pre-warm
 * @returns Number of entries indexed (or cached)
 */
export async function prewarmFileIndex(rootPath: string): Promise<number> {
  if (!isTauriReady()) return 0;
  if (!shouldPrewarmFileIndex(globalThis.document?.visibilityState)) return 0;

  const existingRequest = prewarmRequests.get(rootPath);
  if (existingRequest) return existingRequest;

  const request = invokeTauri<number>("prewarm_file_index", { rootPath })
    .catch((error) => {
      // Non-fatal — search will still work, just cold on first use.
      log.warn("[FileSearch] Prewarm failed (non-fatal):", error);
      return 0;
    })
    .finally(() => {
      if (prewarmRequests.get(rootPath) === request) {
        prewarmRequests.delete(rootPath);
      }
    });

  prewarmRequests.set(rootPath, request);
  return request;
}

/** Hidden windows do not spend CPU pre-walking projects. */
export function shouldPrewarmFileIndex(
  visibilityState: DocumentVisibilityState | undefined
): boolean {
  return visibilityState !== "hidden";
}

/**
 * Clear the file index cache
 *
 * Call this when switching projects or to force fresh indexing.
 */
export async function clearFileIndexCache(): Promise<void> {
  if (!isTauriReady()) {
    return; // Silently ignore in non-Tauri environment
  }

  try {
    await invokeTauri("clear_file_index_cache");
  } catch (error) {
    log.error("[FileSearch] Failed to clear cache:", error);
    throw error;
  }
}

/**
 * Mark one workspace's file-path index stale without starting a scan.
 * The next foreground prewarm or search rebuilds it on demand.
 */
export async function invalidateFileIndexCache(
  rootPath: string
): Promise<void> {
  if (!isTauriReady()) return;

  try {
    await invokeTauri("invalidate_file_index_cache", { rootPath });
  } catch (error) {
    log.error("[FileSearch] Failed to invalidate cache:", error);
    throw error;
  }
}

// ============================================
// Helper Functions
// ============================================

/**
 * Check if native file search is available
 */
export function isNativeSearchAvailable(): boolean {
  return isTauriReady();
}

/**
 * Convert native search results to the format expected by existing components
 *
 * This bridges the new Rust search with existing SearchResults component.
 */
export function convertToSearchResultItems(results: SearchResults): {
  files: SearchResultItem[];
  folders: SearchResultItem[];
} {
  return {
    files: results.files.map((f) => ({
      type: "file" as const,
      path: f.path,
    })),
    folders: results.folders.map((f) => ({
      type: "folder" as const,
      path: f.path,
    })),
  };
}

/**
 * Search with fallback to handle errors gracefully
 *
 * Returns empty results on error instead of throwing.
 */
export async function searchFilesNativeSafe(
  options: SearchOptions
): Promise<{ files: SearchResultItem[]; folders: SearchResultItem[] }> {
  try {
    const results = await searchFilesNative(options);
    return convertToSearchResultItems(results);
  } catch (error) {
    log.warn("[FileSearch] Native search failed, returning empty:", error);
    return { files: [], folders: [] };
  }
}

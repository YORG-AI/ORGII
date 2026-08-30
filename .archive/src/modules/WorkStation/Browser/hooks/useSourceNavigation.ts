/**
 * useSourceNavigation - Navigate from DOM elements to source code
 *
 * Provides functionality to open source files in the editor when clicking
 * on DOM elements in the Browser DevTools. Handles path resolution for
 * different frameworks and project structures.
 *
 * Search Strategy:
 * 1. File name search (fast) - finds ComponentName.tsx, etc.
 * 2. Content search (thorough) - finds "function ComponentName", "const ComponentName", etc.
 */
import { invoke } from "@tauri-apps/api/core";
import { useCallback } from "react";

import { createLogger } from "@src/hooks/logger";
import { FileOperationsService } from "@src/services/file";
import {
  isNativeSearchAvailable,
  searchFilesNative,
} from "@src/util/platform/tauri/fileSearch";

import {
  isDefinitionKind,
  scoreComponentLocation,
} from "./sourceNavigation/componentScorer";
import { resolveSourcePath } from "./sourceNavigation/pathUtils";
import type {
  CodeSearchResult,
  ComponentSearchResult,
  IndexStats,
  IndexedComponentLocation,
  SearchFilters,
  UseSourceNavigationOptions,
  UseSourceNavigationReturn,
} from "./sourceNavigation/types";
import type { SourceLocation } from "./useWebviewInspector";

export type {
  UseSourceNavigationOptions,
  ComponentSearchResult,
  EnrichedSourceInfo,
  UseSourceNavigationReturn,
} from "./sourceNavigation/types";

export {
  getFilenameFromPath,
  formatSourceLocation,
} from "./sourceNavigation/pathUtils";

const log = createLogger("useSourceNavigation");

// ============================================
// Component Index Functions (AST-based lookup)
// ============================================

async function isRepoIndexed(repoPath: string): Promise<boolean> {
  try {
    return await invoke<boolean>("ui_index_is_repo_indexed", { repoPath });
  } catch {
    return false;
  }
}

export async function indexRepository(
  repoPath: string
): Promise<IndexStats | null> {
  try {
    const stats = await invoke<IndexStats>("ui_index_build_repo", {
      repoPath,
    });
    return stats;
  } catch (error) {
    log.warn("[UiIndexer] Failed to index repository:", error);
    return null;
  }
}

async function lookupComponentInIndex(
  repoPath: string,
  componentName: string
): Promise<IndexedComponentLocation[]> {
  try {
    return await invoke<IndexedComponentLocation[]>(
      "ui_index_lookup_component",
      {
        repoPath,
        componentName,
      }
    );
  } catch (error) {
    log.debug("[UiIndexer] Lookup failed:", error);
    return [];
  }
}

// ============================================
// Hook
// ============================================

export function useSourceNavigation(
  options: UseSourceNavigationOptions
): UseSourceNavigationReturn {
  const { repoPath, onSearchFiles } = options;

  const canOpenSource = useCallback(
    (sourceLocation: SourceLocation | null): boolean => {
      if (!sourceLocation) return false;
      if (!sourceLocation.path) return false;
      return true;
    },
    []
  );

  const canSearchForComponent = useCallback(
    (sourceLocation: SourceLocation | null): boolean => {
      if (!sourceLocation) return false;
      return !!(sourceLocation.componentName || sourceLocation.searchHint);
    },
    []
  );

  const searchForComponent = useCallback(
    async (
      sourceLocation: SourceLocation
    ): Promise<Array<{ path: string; line?: number }>> => {
      const searchTerm =
        sourceLocation.searchHint || sourceLocation.componentName;
      if (!searchTerm || !repoPath) return [];

      const results: Array<{ path: string; line?: number; score: number }> = [];
      const seenPaths = new Set<string>();

      const isLibraryComponent = searchTerm.includes(".");

      try {
        // === Component Index Lookup (instant) ===
        const indexed = await isRepoIndexed(repoPath);
        if (indexed) {
          const indexResults = await lookupComponentInIndex(
            repoPath,
            searchTerm
          );
          if (indexResults.length > 0) {
            const scored = indexResults.map((loc) => ({
              location: loc,
              score: scoreComponentLocation(loc, searchTerm),
            }));
            scored.sort((a, b) => b.score - a.score);

            const definitions = scored.filter((scoredItem) =>
              isDefinitionKind(scoredItem.location.kind)
            );

            const toReturn = definitions.length > 0 ? definitions : scored;
            return toReturn.slice(0, 5).map((scoredItem) => ({
              path: scoredItem.location.file,
              line: scoredItem.location.line,
            }));
          }
        }

        // === File Name Search (fast) ===
        if (isNativeSearchAvailable() && !isLibraryComponent) {
          const searchResults = await searchFilesNative({
            root_path: repoPath,
            query: searchTerm,
            max_results: 20,
            file_extensions: [".tsx", ".jsx", ".ts", ".js", ".vue", ".svelte"],
          });

          const componentNameLower = searchTerm.toLowerCase();

          for (const file of searchResults.files) {
            const filenameLower = file.filename.toLowerCase();
            const nameWithoutExt = filenameLower.replace(/\.[^.]+$/, "");

            let score = file.score;
            if (nameWithoutExt === componentNameLower) {
              score += 1000;
            } else if (
              filenameLower === "index.tsx" ||
              filenameLower === "index.jsx"
            ) {
              const folderName = file.path.split("/").slice(-2, -1)[0] || "";
              if (folderName.toLowerCase() === componentNameLower) {
                score += 800;
              }
            }

            if (!seenPaths.has(file.path)) {
              seenPaths.add(file.path);
              results.push({ path: file.path, score });
            }
          }
        }

        // === Content Search (thorough) ===
        const escapedTerm = searchTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

        let regexPattern: string;

        if (isLibraryComponent) {
          regexPattern = [
            `<${escapedTerm}`,
            `${escapedTerm}\\(`,
            `${escapedTerm}\``,
          ].join("|");
        } else {
          regexPattern = [
            `function ${escapedTerm}\\s*\\(`,
            `const ${escapedTerm}\\s*=`,
            `export function ${escapedTerm}`,
            `export const ${escapedTerm}`,
            `export default function ${escapedTerm}`,
            `class ${escapedTerm}\\s`,
            `export class ${escapedTerm}`,
            `name:\\s*["']${escapedTerm}["']`,
            `<${escapedTerm}[\\s/>]`,
          ].join("|");
        }

        try {
          const contentResults = await invoke<CodeSearchResult[]>(
            "search_code_regex",
            {
              query: regexPattern,
              repoPaths: [repoPath],
              filters: {
                file_extensions: [
                  ".tsx",
                  ".jsx",
                  ".ts",
                  ".js",
                  ".vue",
                  ".svelte",
                ],
                case_sensitive: true,
                use_regex: true,
                max_results: 50,
              } as SearchFilters,
            }
          );

          for (const result of contentResults) {
            if (!seenPaths.has(result.file_path)) {
              seenPaths.add(result.file_path);
              const firstMatch = result.matches[0];
              results.push({
                path: result.file_path,
                line: firstMatch?.line,
                score: 500,
              });
            } else {
              const existing = results.find((r) => r.path === result.file_path);
              if (existing && !existing.line && result.matches[0]) {
                existing.line = result.matches[0].line;
              }
            }
          }
        } catch (searchError) {
          log.warn("[useSourceNavigation] Content search failed:", searchError);
        }

        results.sort((a, b) => b.score - a.score);
        return results.slice(0, 10).map(({ path, line }) => ({ path, line }));
      } catch (error) {
        log.error("[useSourceNavigation] Error searching:", error);

        if (onSearchFiles) {
          onSearchFiles(searchTerm);
        }

        return [];
      }
    },
    [repoPath, onSearchFiles]
  );

  const enrichSourceLocation = useCallback(
    async (
      sourceLocation: SourceLocation | null
    ): Promise<SourceLocation | null> => {
      if (!sourceLocation) return null;

      const componentName =
        sourceLocation.componentName || sourceLocation.searchHint;
      if (!componentName || !repoPath) return sourceLocation;

      try {
        const indexed = await isRepoIndexed(repoPath);
        if (!indexed) return sourceLocation;

        const results = await lookupComponentInIndex(repoPath, componentName);
        if (results.length === 0) return sourceLocation;

        const scored = results.map((loc) => ({
          location: loc,
          score: scoreComponentLocation(loc, componentName),
        }));
        scored.sort((a, b) => b.score - a.score);

        const best = scored[0].location;
        return {
          ...sourceLocation,
          path: best.file,
          line: best.line,
          column: best.column,
          method: "component-index",
        };
      } catch (error) {
        log.debug("[useSourceNavigation] Enrich failed:", error);
        return sourceLocation;
      }
    },
    [repoPath]
  );

  const openSourceLocation = useCallback(
    async (sourceLocation: SourceLocation): Promise<boolean> => {
      if (!sourceLocation.path) {
        log.warn(
          "[useSourceNavigation] No source path available:",
          sourceLocation
        );
        return false;
      }

      try {
        const resolvedPath = resolveSourcePath(sourceLocation.path, repoPath);
        const line = sourceLocation.line || 1;
        const result = await FileOperationsService.openAtLine(
          resolvedPath,
          line
        );

        if (!result.success) {
          log.error(
            "[useSourceNavigation] Failed to open file:",
            result.message
          );
          return false;
        }

        return true;
      } catch (error) {
        log.error("[useSourceNavigation] Error opening source:", error);
        return false;
      }
    },
    [repoPath]
  );

  const openFileAtLine = useCallback(
    async (path: string, line?: number): Promise<boolean> => {
      try {
        const resolvedPath = resolveSourcePath(path, repoPath);
        const result = await FileOperationsService.openAtLine(
          resolvedPath,
          line || 1
        );
        return result.success;
      } catch (error) {
        log.error("[useSourceNavigation] Error opening file:", error);
        return false;
      }
    },
    [repoPath]
  );

  const getDefinitionAndUsages = useCallback(
    async (
      sourceLocation: SourceLocation | null
    ): Promise<{
      definition: ComponentSearchResult | null;
      usages: ComponentSearchResult[];
    }> => {
      if (!sourceLocation) {
        log.debug("[getDefinitionAndUsages] No sourceLocation");
        return { definition: null, usages: [] };
      }

      const componentName =
        sourceLocation.componentName || sourceLocation.searchHint;
      if (!componentName || !repoPath) {
        log.debug(
          "[getDefinitionAndUsages] Missing componentName or repoPath",
          {
            componentName,
            repoPath,
          }
        );
        return { definition: null, usages: [] };
      }

      try {
        const indexed = await isRepoIndexed(repoPath);
        if (!indexed) {
          log.warn("[getDefinitionAndUsages] Repo not indexed yet!");
          return { definition: null, usages: [] };
        }

        const results = await lookupComponentInIndex(repoPath, componentName);
        if (results.length === 0) return { definition: null, usages: [] };

        const scored = results.map((loc) => ({
          location: loc,
          score: scoreComponentLocation(loc, componentName),
        }));

        const definitions = scored
          .filter((scoredItem) => isDefinitionKind(scoredItem.location.kind))
          .sort((a, b) => b.score - a.score);

        const usageItems = scored
          .filter((scoredItem) => !isDefinitionKind(scoredItem.location.kind))
          .sort((a, b) => b.score - a.score);

        const bestDef = definitions[0]?.location;
        const definition = bestDef
          ? { path: bestDef.file, line: bestDef.line, isDefinition: true }
          : null;

        const usages = usageItems.slice(0, 10).map((scoredItem) => ({
          path: scoredItem.location.file,
          line: scoredItem.location.line,
          isDefinition: false,
        }));

        return { definition, usages };
      } catch (error) {
        log.debug(
          "[useSourceNavigation] getDefinitionAndUsages failed:",
          error
        );
        return { definition: null, usages: [] };
      }
    },
    [repoPath]
  );

  return {
    openSourceLocation,
    openFileAtLine,
    canOpenSource,
    canSearchForComponent,
    searchForComponent,
    enrichSourceLocation,
    getDefinitionAndUsages,
  };
}

export default useSourceNavigation;

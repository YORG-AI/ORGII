/**
 * useSourceNavigation - Navigate from DOM elements to source code.
 *
 * Source discovery uses bounded filename and content searches. The retired
 * repository-wide component index is preserved under `.archive`.
 */
import { invoke } from "@tauri-apps/api/core";
import { useCallback } from "react";

import { createLogger } from "@src/hooks/logger";
import { FileOperationsService } from "@src/services/file";
import {
  isNativeSearchAvailable,
  searchFilesNative,
} from "@src/util/platform/tauri/fileSearch";

import { resolveSourcePath } from "./sourceNavigation/pathUtils";
import type {
  CodeSearchResult,
  ComponentSearchResult,
  SearchFilters,
  UseSourceNavigationOptions,
  UseSourceNavigationReturn,
} from "./sourceNavigation/types";
import type { SourceLocation } from "./useWebviewInspector";

export type {
  ComponentSearchResult,
  UseSourceNavigationOptions,
  UseSourceNavigationReturn,
} from "./sourceNavigation/types";

export {
  formatSourceLocation,
  getFilenameFromPath,
} from "./sourceNavigation/pathUtils";

const log = createLogger("useSourceNavigation");

export function useSourceNavigation(
  options: UseSourceNavigationOptions
): UseSourceNavigationReturn {
  const { repoPath, onSearchFiles } = options;

  const canSearchForComponent = useCallback(
    (sourceLocation: SourceLocation | null): boolean =>
      Boolean(sourceLocation?.componentName || sourceLocation?.searchHint),
    []
  );

  const searchForComponent = useCallback(
    async (
      sourceLocation: SourceLocation
    ): Promise<ComponentSearchResult[]> => {
      const searchTerm =
        sourceLocation.searchHint || sourceLocation.componentName;
      if (!searchTerm || !repoPath) return [];

      const results: Array<ComponentSearchResult & { score: number }> = [];
      const seenPaths = new Set<string>();
      const isLibraryComponent = searchTerm.includes(".");

      try {
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

        const escapedTerm = searchTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regexPattern = isLibraryComponent
          ? [`<${escapedTerm}`, `${escapedTerm}\\(`, `${escapedTerm}\``].join(
              "|"
            )
          : [
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
              results.push({
                path: result.file_path,
                line: result.matches[0]?.line,
                score: 500,
              });
            } else {
              const existing = results.find(
                (candidate) => candidate.path === result.file_path
              );
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
        onSearchFiles?.(searchTerm);
        return [];
      }
    },
    [repoPath, onSearchFiles]
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

  return {
    openFileAtLine,
    canSearchForComponent,
    searchForComponent,
  };
}

export default useSourceNavigation;

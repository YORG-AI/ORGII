/**
 * useFileMode Hook
 *
 * File search mode for EditorPalette - integrates with native file search
 */
import { createElement, useEffect, useMemo, useRef, useState } from "react";

import FileTypeIcon, {
  getFileTypeFromName,
} from "@src/components/FileTypeIcon";
import { createLogger } from "@src/hooks/logger";
import {
  type ContextMenuSearchRoot,
  buildContextMenuSearchRoots,
} from "@src/scaffold/ContextMenu/contextMenuSearchRoots";
import type { Repo } from "@src/store/repo/types";
import type { WorkspaceFolder } from "@src/types/workspace";
import {
  DEFAULT_MAX_SEARCH_RESULTS,
  prewarmFileIndex,
  searchFilesNative,
} from "@src/util/platform/tauri/fileSearch";

import type { SpotlightItem } from "../../../shared";
import type { FileSearchResult } from "../types";
import {
  mapNativeFileResultsForRoot,
  mergeFileModeResults,
} from "./fileModeSearch";

const log = createLogger("EditorPalette");

interface UseFileModeOptions {
  repoPath: string;
  searchTerm: string;
  enabled: boolean;
  currentRepo?: Pick<Repo, "name" | "path"> | null;
  workspaceFolders?: ReadonlyArray<Pick<WorkspaceFolder, "path" | "name">>;
  onFileOpen?: (path: string) => void;
}

interface UseFileModeReturn {
  items: SpotlightItem[];
  isLoading: boolean;
  error: string | null;
}

/**
 * Hook to generate file search items
 */
export function useFileMode({
  repoPath,
  searchTerm,
  enabled,
  currentRepo,
  workspaceFolders,
  onFileOpen,
}: UseFileModeOptions): UseFileModeReturn {
  const [files, setFiles] = useState<FileSearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track whether the first search has fired so we can skip debounce for it
  const hasFiredFirstSearch = useRef(false);
  const searchRoots = useMemo<ContextMenuSearchRoot[]>(
    () =>
      buildContextMenuSearchRoots({
        repoPath,
        currentRepo,
        workspaceFolders,
      }),
    [currentRepo, repoPath, workspaceFolders]
  );
  const searchRootsKey = searchRoots.map((root) => root.path).join("\0");

  // Reset first-search flag when spotlight is disabled (closed)
  useEffect(() => {
    if (!enabled) {
      hasFiredFirstSearch.current = false;
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled || searchRoots.length === 0) return;

    for (const root of searchRoots) {
      prewarmFileIndex(root.path).catch(() => {
        // Non-fatal — search will still work if prewarm fails.
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- searchRootsKey encodes every root path used by prewarmFileIndex and avoids repeated IPC for equivalent root arrays
  }, [enabled, searchRootsKey]);

  // Search files
  useEffect(() => {
    if (!enabled || searchRoots.length === 0) {
      setFiles([]);
      return;
    }

    // If empty query, don't search yet (could show recent files later)
    if (!searchTerm) {
      setFiles([]);
      setIsLoading(false);
      return;
    }

    const searchFiles = async () => {
      setIsLoading(true);
      setError(null);

      try {
        const startedAt = performance.now();
        const resultGroups = await Promise.all(
          searchRoots.map(async (root) => {
            const results = await searchFilesNative({
              root_path: root.path,
              query: searchTerm,
              max_results: DEFAULT_MAX_SEARCH_RESULTS,
              exclude_dirs: [
                "node_modules",
                ".git",
                "dist",
                "build",
                ".next",
                "target",
                ".cache",
                "coverage",
                "__pycache__",
                ".venv",
                "venv",
              ],
            });
            return {
              root,
              results,
            };
          })
        );
        const elapsedMs = Math.round(performance.now() - startedAt);
        const nativeSearchTimeMs = resultGroups.reduce(
          (sum, group) => sum + group.results.search_time_ms,
          0
        );
        const totalIndexed = resultGroups.reduce(
          (sum, group) => sum + group.results.total_indexed,
          0
        );
        if (elapsedMs > 500) {
          log.warn("[EditorPalette] Slow file search", {
            elapsedMs,
            nativeSearchTimeMs,
            totalIndexed,
            roots: searchRoots.length,
            queryLength: searchTerm.length,
          });
        }

        const fileResults: FileSearchResult[] = mergeFileModeResults(
          resultGroups.map((group) =>
            mapNativeFileResultsForRoot(group.results.files, group.root)
          ),
          DEFAULT_MAX_SEARCH_RESULTS
        );

        setFiles(fileResults);
      } catch (err) {
        log.error("[useFileMode] Search failed:", err);
        setError(err instanceof Error ? err.message : "Search failed");
        setFiles([]);
      } finally {
        setIsLoading(false);
      }
    };

    // Fire first search immediately (no debounce), debounce subsequent ones
    if (!hasFiredFirstSearch.current) {
      hasFiredFirstSearch.current = true;
      searchFiles();
      return;
    }

    // Debounce subsequent searches (150ms)
    const timer = setTimeout(searchFiles, 150);
    return () => clearTimeout(timer);
  }, [searchRoots, searchRootsKey, searchTerm, enabled]);

  // Convert files to spotlight items
  const items: SpotlightItem[] = files.map((file) => {
    const fileType = getFileTypeFromName(file.name);

    // Create icon component for this file
    const FileIcon = () => {
      return createElement(FileTypeIcon, {
        fileName: file.name,
        type: fileType,
        size: "spotlight",
      });
    };

    return {
      id: file.path,
      label: file.name,
      // Don't show description - single line only
      icon: FileIcon,
      type: "file",
      data: {
        rightLabel: file.repoName
          ? `${file.repoName} · ${file.directory}`
          : file.directory,
      },
      action: () => {
        onFileOpen?.(file.path);
      },
    };
  });

  return {
    items,
    isLoading,
    error,
  };
}

export default useFileMode;

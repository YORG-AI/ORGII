/**
 * useDisplayData Hook
 *
 * Computes the tree data to display in the file explorer based on the active
 * view mode, filter state, and search results.
 *
 * OPTIMIZATION (Jan 2026): Hybrid approach for file filtering
 * 1. Server search (searchFilesNative) finds files in ALL directories
 * 2. buildTreeFromSearchResults converts flat results to tree structure
 * 3. Falls back to client-side filterTree for instant feedback while server loads
 *
 * Extracted from EditorPrimarySidebar.
 */
import { useMemo } from "react";

import type { TreePanelNode } from "@src/components/TreePanelSidebar/types";
import type {
  FileNode,
  FileSearchResult,
} from "@src/modules/WorkStation/CodeEditor/hooks/useCodeEditor";

import type { EditorPrimarySidebarViewMode } from "../types";
import { buildTreeFromSearchResults, filterTree } from "../utils/filterTree";

/**
 * Convert FileNode to TreePanelNode (recursive)
 * Preserves git status, symlink, and ignored information from FileNode
 */
export function convertToTreeNode(node: FileNode): TreePanelNode {
  return {
    id: node.path,
    name: node.name,
    path: node.path,
    type: node.type,
    children: node.children?.map(convertToTreeNode),
    expanded: node.expanded,
    gitStatus: node.gitStatus,
    gitStaged: node.gitStaged,
    aggregateStatus: node.aggregateStatus,
    isSymlink: node.isSymlink,
    isIgnored: node.isIgnored,
  };
}

export interface UseDisplayDataOptions {
  fileTree: FileNode[];
  viewMode: EditorPrimarySidebarViewMode;
  filterQuery: string;
  searchResults: FileSearchResult[];
  searchLoading: boolean;
  repoPath: string;
}

export interface UseDisplayDataResult {
  /** Converted tree data (always computed from fileTree) */
  treeData: TreePanelNode[];
  /** Filtered/searched display data for the current view */
  displayData: TreePanelNode[];
  /** Whether there's an active filter query */
  hasActiveFilter: boolean;
  /** Whether search results exist */
  hasSearchResults: boolean;
}

export function useDisplayData({
  fileTree,
  viewMode,
  filterQuery,
  searchResults,
  searchLoading,
  repoPath,
}: UseDisplayDataOptions): UseDisplayDataResult {
  const treeData = useMemo(() => fileTree.map(convertToTreeNode), [fileTree]);

  const hasActiveFilter = filterQuery.trim().length > 0;
  const hasSearchResults = searchResults.length > 0;

  const displayData = useMemo(() => {
    if (viewMode === "files") {
      if (hasActiveFilter) {
        if (hasSearchResults) {
          // Server search complete - build tree from results
          return buildTreeFromSearchResults(
            searchResults.map((result) => ({
              path: result.path,
              filename: result.filename,
              type: result.type,
              score: result.score,
            })),
            repoPath
          );
        } else if (!searchLoading) {
          // Server search returned empty - show client-side filter as fallback
          const { filteredTree } = filterTree(treeData, {
            query: filterQuery,
            matchPath: true,
            fuzzyMatch: true,
          });
          return filteredTree;
        }
        // Still loading - show client-side filter for instant feedback
        const { filteredTree } = filterTree(treeData, {
          query: filterQuery,
          matchPath: true,
          fuzzyMatch: true,
        });
        return filteredTree;
      }
      return treeData;
    }

    // For other view modes, return empty (they have their own content)
    return [];
  }, [
    viewMode,
    hasActiveFilter,
    hasSearchResults,
    searchResults,
    searchLoading,
    treeData,
    filterQuery,
    repoPath,
  ]);

  return { treeData, displayData, hasActiveFilter, hasSearchResults };
}

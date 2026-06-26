/**
 * Search Results Component
 *
 * Uses VirtualizedStickyTree for consistent behavior with file explorer.
 * Shows VS Code-style sticky headers for file results when scrolling.
 *
 * Structure:
 * - File header (collapsible, becomes sticky when scrolled)
 *   - Match line (indented)
 *   - Match line
 */
import { useSetAtom } from "jotai";
import { ChevronDown, ChevronRight } from "lucide-react";
import React, {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import FileTypeIcon from "@src/components/FileTypeIcon";
import {
  TREE_INDENT_PX,
  TREE_PADDING_X,
  TREE_ROW_HEIGHT,
  TreeRowBase,
} from "@src/components/TreeRow";
import type { TreeRowNode } from "@src/components/TreeRow";
import type {
  FlattenedTreeNode,
  StickyScrollNode,
  TreeNodeBase,
} from "@src/components/VirtualizedStickyTree";
import {
  CHEVRON_SIZE,
  STICKY_ROW,
  VirtualizedStickyTree,
  stickyRowPadding,
} from "@src/components/VirtualizedStickyTree";
import { SURFACE_TOKENS } from "@src/config/surfaceTokens";
import { usePrimarySidebarSurface } from "@src/modules/WorkStation/shared/hooks/usePrimarySidebarSurface";
import {
  COUNT_BADGE,
  PRIMARY_SIDEBAR_HOVER,
  getCountBadgeSizeClass,
} from "@src/modules/WorkStation/shared/tokens";
import {
  searchResultSelectedKeyAtom,
  useIsSearchResultSelected,
} from "@src/store/ui/searchResultSelectionAtom";

import type { SearchMatch, SearchResultFile } from "./types";
import { formatSearchMatch } from "./utils";

// ============================================
// Types
// ============================================

/** Node type for search results - extends TreeNodeBase for VirtualizedStickyTree */
interface SearchNode extends TreeNodeBase {
  /** Type of node */
  type: "file" | "match";
  /** Original file path (for selection keys and click handlers) */
  filePath: string;
  /** For file nodes: the result data */
  result?: SearchResultFile;
  /** For match items: the match data */
  match?: SearchMatch;
  /** For match items: index in matches array */
  matchIndex?: number;
  /** For file nodes: file name for display */
  fileName?: string;
  /** Relative path for display */
  relativePath?: string;
}

export interface SearchResultsHandle {
  /** Collapse all file headers */
  collapseAll: () => void;
}

export interface SearchResultsProps {
  results: SearchResultFile[];
  onMatchClick?: (filePath: string, line: number) => void;
  /** Called when scrolling near the end - for loading more results */
  onEndReached?: () => void;
  /** Whether more results are being loaded */
  loadingMore?: boolean;
}

// ============================================
// Helper: Build relative path for display
// ============================================

function buildRelativePath(filePath: string): string {
  const pathParts = filePath.split("/");
  const fileName = pathParts.pop() || filePath;

  const githubIdx = pathParts.findIndex((part) => part === "GitHub");
  if (githubIdx !== -1 && pathParts[githubIdx + 1]) {
    return [...pathParts.slice(githubIdx + 1), fileName].join("/");
  }
  const startIdx = Math.max(0, pathParts.length - 3);
  return [...pathParts.slice(startIdx), fileName].join("/");
}

// ============================================
// File Header Component (uses TreeRowBase)
// ============================================

interface FileHeaderProps {
  node: SearchNode;
  onToggle: (filePath: string) => void;
}

const FileHeader: React.FC<FileHeaderProps> = React.memo(
  ({ node, onToggle }) => {
    const selectionKey = `file:${node.filePath}`;
    const isSelected = useIsSearchResultSelected(selectionKey);
    const isExpanded = node.expanded ?? false;

    const handleClick = useCallback(() => {
      onToggle(node.filePath);
    }, [node.filePath, onToggle]);

    // TreeRowNode for TreeRowBase - icon includes chevron + file icon
    const treeNode: TreeRowNode = useMemo(
      () => ({
        id: node.path,
        name: node.fileName || node.name,
        path: node.path,
        type: "file", // Use "file" so TreeRowBase doesn't add extra chevron
        expanded: isExpanded,
        icon: (
          <div className="flex items-center gap-1.5">
            <div className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
              {isExpanded ? (
                <ChevronDown size={14} className="text-text-3" />
              ) : (
                <ChevronRight size={14} className="text-text-3" />
              )}
            </div>
            <FileTypeIcon
              fileName={node.fileName || node.name}
              size="small"
              className="flex-shrink-0"
            />
          </div>
        ),
      }),
      [node.path, node.fileName, node.name, isExpanded]
    );

    const matchCount = node.result?.matches.length ?? 0;
    const countBadgeVariant =
      matchCount === 0 ? COUNT_BADGE.muted : COUNT_BADGE.primary;

    return (
      <TreeRowBase
        node={treeNode}
        depth={0}
        isSelected={isSelected}
        onClick={handleClick}
        dataPath={node.relativePath}
      >
        <div
          className={`${COUNT_BADGE.base} ${getCountBadgeSizeClass(matchCount)} ${countBadgeVariant}`}
        >
          {matchCount}
        </div>
      </TreeRowBase>
    );
  }
);

FileHeader.displayName = "FileHeader";

// ============================================
// Match Line Component (uses TreeRowBase)
// ============================================

interface MatchLineProps {
  node: SearchNode;
  onClick: (filePath: string, line: number, matchIndex: number) => void;
}

const MatchLine: React.FC<MatchLineProps> = React.memo(({ node, onClick }) => {
  const selectionKey = `match:${node.filePath}:${node.matchIndex}`;
  const isSelected = useIsSearchResultSelected(selectionKey);
  const match = node.match!;

  const { before, match: matchText, after } = formatSearchMatch(match);

  const handleClick = useCallback(() => {
    onClick(node.filePath, match.line, node.matchIndex!);
  }, [node.filePath, match.line, node.matchIndex, onClick]);

  // Custom row for match lines - simpler than TreeRowBase
  // Indent: depth 1 = 1 * TREE_INDENT_PX + TREE_PADDING_X
  const paddingLeft = 1 * TREE_INDENT_PX + TREE_PADDING_X;

  return (
    <div
      className={`flex h-7 cursor-pointer items-center gap-1.5 transition-colors ${
        isSelected
          ? `${SURFACE_TOKENS.selected} ${PRIMARY_SIDEBAR_HOVER.selectedRow}`
          : PRIMARY_SIDEBAR_HOVER.row
      }`}
      style={{ paddingLeft: `${paddingLeft}px`, paddingRight: "8px" }}
      onClick={handleClick}
    >
      <span className="min-w-0 flex-1 truncate text-[12px] text-text-2">
        {before}
        <span className="bg-primary-6/20 text-primary-6">{matchText}</span>
        {after}
      </span>
      <span className="flex-shrink-0 text-[11px] text-text-4">
        {match.line}
      </span>
    </div>
  );
});

MatchLine.displayName = "MatchLine";

// ============================================
// Main Component
// ============================================

const AUTO_COLLAPSE_THRESHOLD = 500;

function arePropsEqual(
  prevProps: SearchResultsProps,
  nextProps: SearchResultsProps
): boolean {
  if (prevProps.results === nextProps.results) {
    return prevProps.loadingMore === nextProps.loadingMore;
  }

  const prevLen = prevProps.results.length;
  const nextLen = nextProps.results.length;

  if (prevLen !== nextLen) {
    return false;
  }

  const prevFirst = prevProps.results[0]?.file_path;
  const nextFirst = nextProps.results[0]?.file_path;
  const prevLast = prevProps.results[prevLen - 1]?.file_path;
  const nextLast = nextProps.results[nextLen - 1]?.file_path;

  return (
    prevFirst === nextFirst &&
    prevLast === nextLast &&
    prevProps.loadingMore === nextProps.loadingMore
  );
}

const SearchResultsInner = forwardRef<SearchResultsHandle, SearchResultsProps>(
  ({ results, onMatchClick, onEndReached, loadingMore }, ref) => {
    const { t } = useTranslation();
    const { stickyBgClass } = usePrimarySidebarSurface();
    const setSelectedKey = useSetAtom(searchResultSelectedKeyAtom);

    const totalMatches = useMemo(
      () => results.reduce((sum, result) => sum + result.matches.length, 0),
      [results]
    );

    const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(
      new Set()
    );
    const prevFirstFileRef = useRef<string>("");
    const prevResultCountRef = useRef(0);
    const isInitializedRef = useRef(false);

    // Auto-collapse logic:
    // - On new search: if > threshold, collapse all
    // - On load more: if > threshold, collapse newly added files
    useEffect(() => {
      const firstFile = results[0]?.file_path || "";
      const prevFirstFile = prevFirstFileRef.current;
      const prevResultCount = prevResultCountRef.current;

      prevFirstFileRef.current = firstFile;
      prevResultCountRef.current = results.length;

      if (!isInitializedRef.current) {
        isInitializedRef.current = true;
        if (totalMatches > AUTO_COLLAPSE_THRESHOLD) {
          const allPaths = new Set(results.map((result) => result.file_path));
          setCollapsedFiles(allPaths);
        }
        return;
      }

      const isNewSearch = firstFile !== prevFirstFile && firstFile !== "";
      const isLoadMore = results.length > prevResultCount && !isNewSearch;

      if (isNewSearch) {
        // New search - collapse all if above threshold, otherwise expand all
        if (totalMatches > AUTO_COLLAPSE_THRESHOLD) {
          const allPaths = new Set(results.map((result) => result.file_path));
          setCollapsedFiles(allPaths);
        } else {
          setCollapsedFiles(new Set());
        }
      } else if (isLoadMore && totalMatches > AUTO_COLLAPSE_THRESHOLD) {
        // Loading more results while above threshold - collapse new files
        setCollapsedFiles((prev) => {
          const newPaths = new Set(prev);
          for (const result of results) {
            if (!prev.has(result.file_path)) {
              newPaths.add(result.file_path);
            }
          }
          return newPaths;
        });
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [results.length, totalMatches]);

    useImperativeHandle(
      ref,
      () => ({
        collapseAll: () => {
          const allPaths = new Set(results.map((result) => result.file_path));
          setCollapsedFiles(allPaths);
        },
      }),
      [results]
    );

    const toggleFile = useCallback((filePath: string) => {
      setCollapsedFiles((prev) => {
        const next = new Set(prev);
        if (next.has(filePath)) {
          next.delete(filePath);
        } else {
          next.add(filePath);
        }
        return next;
      });
    }, []);

    // Build flattened nodes for VirtualizedStickyTree
    const flattenedNodes = useMemo((): FlattenedTreeNode<SearchNode>[] => {
      const nodes: FlattenedTreeNode<SearchNode>[] = [];

      for (const result of results) {
        const fileName = result.file_path.split("/").pop() || result.file_path;
        const relativePath = buildRelativePath(result.file_path);
        const isExpanded = !collapsedFiles.has(result.file_path);

        // File header node (depth 0, isFolder = true for sticky)
        nodes.push({
          node: {
            path: result.file_path,
            name: fileName,
            isFolder: true,
            expanded: isExpanded,
            type: "file",
            filePath: result.file_path,
            result,
            fileName,
            relativePath,
          },
          depth: 0,
        });

        // Match nodes (depth 1, only if expanded)
        if (isExpanded) {
          result.matches.forEach((match, idx) => {
            nodes.push({
              node: {
                // Path must be unique for each node (used as Virtuoso key)
                path: `${result.file_path}:match:${idx}`,
                name: `${result.file_path}:${idx}`,
                isFolder: false,
                type: "match",
                filePath: result.file_path,
                match,
                matchIndex: idx,
              },
              depth: 1,
            });
          });
        }
      }

      return nodes;
    }, [results, collapsedFiles]);

    // Handle file toggle
    const handleFileToggle = useCallback(
      (filePath: string) => {
        setSelectedKey(`file:${filePath}`);
        toggleFile(filePath);
      },
      [toggleFile, setSelectedKey]
    );

    // Handle match click
    const handleMatchClick = useCallback(
      (filePath: string, line: number, matchIndex: number) => {
        setSelectedKey(`match:${filePath}:${matchIndex}`);
        onMatchClick?.(filePath, line);
      },
      [onMatchClick, setSelectedKey]
    );

    // Render item
    const renderItem = useCallback(
      (item: FlattenedTreeNode<SearchNode>) => {
        if (item.node.type === "file" && item.node.result) {
          return <FileHeader node={item.node} onToggle={handleFileToggle} />;
        }

        if (item.node.type === "match" && item.node.match) {
          return <MatchLine node={item.node} onClick={handleMatchClick} />;
        }

        return null;
      },
      [handleFileToggle, handleMatchClick]
    );

    // Render sticky item (file headers only)
    const renderStickyItem = useCallback(
      (stickyNode: StickyScrollNode<SearchNode>, onClick: () => void) => {
        const { node, depth } = stickyNode;
        const isExpanded = node.expanded ?? false;
        const matchCount = node.result?.matches.length ?? 0;
        const countBadgeVariant =
          matchCount === 0 ? COUNT_BADGE.muted : COUNT_BADGE.primary;

        return (
          <div
            className={`${STICKY_ROW.rowBase} ${stickyBgClass}`}
            style={stickyRowPadding(depth)}
            onClick={onClick}
            title={t("tooltips.scrollToItem", { name: node.name })}
          >
            <div className={STICKY_ROW.chevronBox}>
              {isExpanded ? (
                <ChevronDown
                  size={CHEVRON_SIZE}
                  className={STICKY_ROW.chevronIcon}
                />
              ) : (
                <ChevronRight
                  size={CHEVRON_SIZE}
                  className={STICKY_ROW.chevronIcon}
                />
              )}
            </div>

            <FileTypeIcon
              fileName={node.fileName || node.name}
              size="small"
              className="flex-shrink-0"
            />

            <span className={STICKY_ROW.name}>
              {node.fileName || node.name}
            </span>

            <div
              className={`${COUNT_BADGE.base} ${getCountBadgeSizeClass(matchCount)} ${countBadgeVariant}`}
            >
              {matchCount}
            </div>
          </div>
        );
      },
      [stickyBgClass, t]
    );
    const handleStickyHeaderClick = useCallback(
      (_nodePath: string, node: SearchNode) => {
        setSelectedKey(`file:${node.filePath}`);
      },
      [setSelectedKey]
    );

    // Handle end reached for loading more results
    const handleEndReached = useCallback(() => {
      if (!loadingMore && onEndReached) {
        onEndReached();
      }
    }, [loadingMore, onEndReached]);

    if (flattenedNodes.length === 0) {
      return null;
    }

    return (
      <VirtualizedStickyTree<SearchNode>
        flattenedNodes={flattenedNodes}
        rowHeight={TREE_ROW_HEIGHT}
        renderItem={renderItem}
        renderStickyItem={renderStickyItem}
        onStickyHeaderClick={handleStickyHeaderClick}
        onEndReached={handleEndReached}
        emptyMessage="No results"
        stickyBgClass={stickyBgClass}
      />
    );
  }
);

SearchResultsInner.displayName = "SearchResultsInner";

export const SearchResults = memo(
  SearchResultsInner,
  arePropsEqual
) as typeof SearchResultsInner;

SearchResults.displayName = "SearchResults";

export default SearchResults;

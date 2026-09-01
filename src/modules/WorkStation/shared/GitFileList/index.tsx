/**
 * GitFileList Component
 *
 * Reusable file list with list/tree view toggle and search filter.
 * Used by Source Control panel and Commit Detail view.
 *
 * Features:
 * - Flat list or VS Code-style tree view
 * - Search/filter input
 * - View mode toggle button in section header
 * - VirtualizedStickyTree with sticky directory headers (tree mode)
 * - Hidden scrollbar
 */
import React, { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import FileTypeIcon from "@src/components/FileTypeIcon";
import Input from "@src/components/Input";
import {
  GitStatusBadge,
  TREE_ROW_HEIGHT,
  TreeRowBase,
} from "@src/components/TreeRow";
import type { GitStatusInfo, TreeRowNode } from "@src/components/TreeRow";
import type {
  FlattenedTreeNode,
  StickyScrollNode,
} from "@src/components/VirtualizedStickyTree";
import {
  CHEVRON_SIZE,
  STICKY_ROW,
  VirtualizedStickyTree,
  stickyRowPadding,
} from "@src/components/VirtualizedStickyTree";
import { getStatusColorForFile } from "@src/config/gitStatus";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  FilterIcon,
  HierarchyFilesIcon,
  HugeiconsIcon,
  ListIcon,
  Search01Icon,
} from "@src/icons";
import type { GitFile } from "@src/types/git/types";
import { getFileName } from "@src/util/file/pathUtils";

import { SectionHeader } from "../../CodeEditor/Panels/EditorPrimarySidebar/content/SourceControlContent/components";
import type { GitFileTreeNode } from "../../CodeEditor/Panels/EditorPrimarySidebar/content/SourceControlContent/components/GitFileTreeItem";
import {
  buildVSCodeStyleTree,
  flattenGitFileTree,
  toggleDirectoryInTree,
} from "../../CodeEditor/Panels/EditorPrimarySidebar/content/SourceControlContent/utils/treeUtils";
import { HEADER_BUTTON } from "../tokens";

// ============================================
// Types
// ============================================

type FileListViewMode = "list" | "list-tree";

interface GitFileListProps {
  /** Files to display */
  files: GitFile[];
  /** Currently selected file ID (path) */
  selectedFileId: string | null;
  /** Called when a file is clicked */
  onFileSelect: (fileId: string) => void;
  /** Section title */
  title?: string;
  /** Unfiltered display label when the backing result is remotely capped. */
  unfilteredCountLabel?: string;
  /** Whether to show filter toggle in header */
  showFilterToggle?: boolean;
  /** Initial view mode */
  defaultViewMode?: FileListViewMode;
  /** Whether the list is loading */
  loading?: boolean;
}

/**
 * Node type for VirtualizedStickyTree.
 * Wraps both flat file items and tree directory/file items.
 */
interface GitFileListNode {
  path: string;
  name: string;
  isFolder: boolean;
  expanded: boolean;
  file?: GitFile;
  treeNode?: GitFileTreeNode;
}

// ============================================
// Helpers
// ============================================

// ============================================
// Flat List Item
// ============================================

interface FlatFileItemProps {
  file: GitFile;
  isSelected: boolean;
  onSelect: (fileId: string) => void;
}

const FlatFileItem: React.FC<FlatFileItemProps> = memo(
  ({ file, isSelected, onSelect }) => {
    const treeNode: TreeRowNode = useMemo(
      () => ({
        id: file.id,
        name: getFileName(file.path),
        path: file.path,
        type: "file" as const,
      }),
      [file.id, file.path]
    );

    const gitStatus: GitStatusInfo | null = useMemo(
      () => ({ status: file.status, staged: true }),
      [file.status]
    );

    const handleClick = useCallback(() => {
      onSelect(file.id);
    }, [file.id, onSelect]);

    return (
      <TreeRowBase
        node={treeNode}
        depth={0}
        isSelected={isSelected}
        gitStatus={gitStatus}
        onClick={handleClick}
      >
        <GitStatusBadge status={gitStatus} isDirectory={false} />
      </TreeRowBase>
    );
  }
);

FlatFileItem.displayName = "FlatFileItem";

// ============================================
// Tree Item (directory or file)
// ============================================

interface TreeFileItemProps {
  node: GitFileTreeNode;
  depth: number;
  selectedFileId: string | null;
  onSelect: (fileId: string) => void;
  onToggleDirectory: (path: string) => void;
}

const TreeFileItem: React.FC<TreeFileItemProps> = memo(
  ({ node, depth, selectedFileId, onSelect, onToggleDirectory }) => {
    const isDirectory = node.type === "directory";
    const isSelected = !isDirectory && node.file?.id === selectedFileId;

    const treeNode: TreeRowNode = useMemo(
      () => ({
        id: node.path,
        name: node.name,
        path: node.path,
        type: node.type,
        expanded: node.expanded ?? true,
      }),
      [node.path, node.name, node.type, node.expanded]
    );

    const gitStatus: GitStatusInfo | null = useMemo(() => {
      if (isDirectory && node.aggregateStatus) {
        return { status: node.aggregateStatus, staged: false };
      }
      if (!isDirectory && node.file) {
        return { status: node.file.status, staged: true };
      }
      return null;
    }, [isDirectory, node.aggregateStatus, node.file]);

    const handleClick = useCallback(() => {
      if (isDirectory) {
        onToggleDirectory(node.path);
      } else if (node.file) {
        onSelect(node.file.id);
      }
    }, [isDirectory, node.path, node.file, onSelect, onToggleDirectory]);

    return (
      <TreeRowBase
        node={treeNode}
        depth={depth}
        isSelected={isSelected}
        gitStatus={gitStatus}
        onClick={handleClick}
      >
        <GitStatusBadge status={gitStatus} isDirectory={isDirectory} />
      </TreeRowBase>
    );
  }
);

TreeFileItem.displayName = "TreeFileItem";

// ============================================
// Virtualized tree helpers
// ============================================

/**
 * Convert flattened GitFileTreeNode list to VirtualizedStickyTree format.
 */
function toVirtualizedNodes(
  flattenedTree: Array<{ node: GitFileTreeNode; depth: number }>
): FlattenedTreeNode<GitFileListNode>[] {
  return flattenedTree.map(({ node, depth }) => ({
    node: {
      path: node.path,
      name: node.name,
      isFolder: node.type === "directory",
      expanded: node.expanded ?? true,
      file: node.file,
      treeNode: node,
    },
    depth,
  }));
}

/**
 * Convert flat file list to VirtualizedStickyTree format.
 */
function toFlatVirtualizedNodes(
  files: GitFile[]
): FlattenedTreeNode<GitFileListNode>[] {
  return files.map((file) => ({
    node: {
      path: file.id,
      name: getFileName(file.path),
      isFolder: false,
      expanded: false,
      file,
    },
    depth: 0,
  }));
}

// ============================================
// Main Component
// ============================================

const GitFileList: React.FC<GitFileListProps> = ({
  files,
  selectedFileId,
  onFileSelect,
  title,
  unfilteredCountLabel,
  showFilterToggle = true,
  defaultViewMode = "list",
  loading: _loading = false,
}) => {
  const { t } = useTranslation();

  const [isCollapsed, setIsCollapsed] = useState(false);
  const [viewMode, setViewMode] = useState<FileListViewMode>(defaultViewMode);
  const [showFilter, setShowFilter] = useState(false);
  const [filterQuery, setFilterQuery] = useState("");
  const [treeData, setTreeData] = useState<GitFileTreeNode[]>([]);

  // Toggle view mode
  const handleViewModeToggle = useCallback(() => {
    setViewMode((prev) => (prev === "list" ? "list-tree" : "list"));
  }, []);

  // Toggle filter visibility
  const handleFilterToggle = useCallback(() => {
    setShowFilter((prev) => !prev);
    if (showFilter) setFilterQuery(""); // Clear on hide
  }, [showFilter]);

  // Filter files by query
  const filteredFiles = useMemo(() => {
    if (!filterQuery) return files;
    const query = filterQuery.toLowerCase();
    return files.filter((file) => file.path.toLowerCase().includes(query));
  }, [files, filterQuery]);

  // Build tree from filtered files (only in tree mode)
  const tree = useMemo(() => {
    if (viewMode !== "list-tree") return [];
    return buildVSCodeStyleTree(filteredFiles);
  }, [filteredFiles, viewMode]);

  // Merge tree with expanded state
  const mergedTree = useMemo(() => {
    if (viewMode !== "list-tree") return [];
    if (treeData.length === 0) return tree;

    // Preserve expanded state from previous tree
    const expandedPaths = new Set<string>();
    const collectExpanded = (nodes: GitFileTreeNode[]) => {
      for (const node of nodes) {
        if (node.type === "directory" && node.expanded) {
          expandedPaths.add(node.path);
        }
        if (node.children) collectExpanded(node.children);
      }
    };
    collectExpanded(treeData);

    const applyExpanded = (nodes: GitFileTreeNode[]): GitFileTreeNode[] =>
      nodes.map((node) => ({
        ...node,
        expanded:
          node.type === "directory"
            ? expandedPaths.has(node.path)
            : node.expanded,
        children: node.children ? applyExpanded(node.children) : undefined,
      }));

    return applyExpanded(tree);
  }, [tree, treeData, viewMode]);

  // Flatten tree for rendering
  const flattenedTree = useMemo(
    () => (viewMode === "list-tree" ? flattenGitFileTree(mergedTree) : []),
    [mergedTree, viewMode]
  );

  // Convert to VirtualizedStickyTree format
  const virtualizedNodes = useMemo(
    () =>
      viewMode === "list-tree"
        ? toVirtualizedNodes(flattenedTree)
        : toFlatVirtualizedNodes(filteredFiles),
    [viewMode, flattenedTree, filteredFiles]
  );

  // Toggle directory expanded state
  const handleToggleDirectory = useCallback(
    (path: string) => {
      setTreeData((prev) => {
        const source = prev.length > 0 ? prev : mergedTree;
        return toggleDirectoryInTree(source, path);
      });
    },
    [mergedTree]
  );

  // Render a single tree/list item
  const renderItem = useCallback(
    (item: FlattenedTreeNode<GitFileListNode>) => {
      const { node, depth } = item;

      if (node.treeNode) {
        return (
          <TreeFileItem
            node={node.treeNode}
            depth={depth}
            selectedFileId={selectedFileId}
            onSelect={onFileSelect}
            onToggleDirectory={handleToggleDirectory}
          />
        );
      }

      if (node.file) {
        return (
          <FlatFileItem
            file={node.file}
            isSelected={node.file.id === selectedFileId}
            onSelect={onFileSelect}
          />
        );
      }

      return null;
    },
    [selectedFileId, onFileSelect, handleToggleDirectory]
  );

  // Render sticky header for directory nodes (tree mode only)
  const renderStickyItem = useCallback(
    (stickyNode: StickyScrollNode<GitFileListNode>, onClick: () => void) => {
      const { node, depth } = stickyNode;
      const isExpanded = node.expanded;

      const gitStatus: GitStatusInfo | null = node.treeNode?.aggregateStatus
        ? { status: node.treeNode.aggregateStatus, staged: false }
        : null;
      const textColorClass = gitStatus
        ? getStatusColorForFile(gitStatus.status, gitStatus.staged)
        : "text-text-2";

      return (
        <div
          className={STICKY_ROW.row}
          style={stickyRowPadding(depth)}
          onClick={onClick}
          title={`Scroll to ${node.name}`}
        >
          <div className={STICKY_ROW.chevronBox}>
            {isExpanded ? (
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                data-icon="chevron-down"
                size={CHEVRON_SIZE}
                className={STICKY_ROW.chevronIcon}
              />
            ) : (
              <HugeiconsIcon
                icon={ArrowRight01Icon}
                data-icon="chevron-right"
                size={CHEVRON_SIZE}
                className={STICKY_ROW.chevronIcon}
              />
            )}
          </div>

          {!node.isFolder && (
            <FileTypeIcon
              fileName={node.name}
              size="small"
              className="flex-shrink-0 text-text-2"
            />
          )}

          <span className={`${STICKY_ROW.nameBase} ${textColorClass}`}>
            {node.name}
          </span>

          <GitStatusBadge status={gitStatus} isDirectory={node.isFolder} />
        </div>
      );
    },
    []
  );

  // Handle sticky header click — toggle directory
  // VS Code pattern: scroll-to-reveal only, never toggle collapse
  const handleStickyHeaderClick = useCallback(
    (_nodePath: string, _node: GitFileListNode) => {},
    []
  );

  // Section header actions
  const sectionActions = useMemo(
    () => (
      <div className="flex items-center gap-0.5 opacity-0 group-hover/header:opacity-100">
        {showFilterToggle && (
          <button
            className={`${HEADER_BUTTON.actionTreeRow} ${showFilter ? "text-primary-6" : ""}`}
            onClick={handleFilterToggle}
            title={
              showFilter
                ? t("workstation.hideFilter")
                : t("workstation.filterFilesAction")
            }
          >
            <HugeiconsIcon
              icon={FilterIcon}
              data-icon="filter"
              size={14}
              strokeWidth={1.75}
              className={showFilter ? "text-primary-6" : "text-text-3"}
            />
          </button>
        )}
        <button
          className={HEADER_BUTTON.actionTreeRow}
          onClick={handleViewModeToggle}
          title={
            viewMode === "list"
              ? t("workstation.switchToTreeView")
              : t("workstation.switchToListView")
          }
        >
          {viewMode === "list" ? (
            <HugeiconsIcon
              icon={HierarchyFilesIcon}
              data-icon="list-tree"
              size={14}
              strokeWidth={1.75}
              className="text-text-3"
            />
          ) : (
            <HugeiconsIcon
              icon={ListIcon}
              data-icon="list"
              size={14}
              strokeWidth={1.75}
              className="text-text-3"
            />
          )}
        </button>
      </div>
    ),
    [
      viewMode,
      showFilter,
      showFilterToggle,
      handleViewModeToggle,
      handleFilterToggle,
      t,
    ]
  );

  const displayTitle = title ?? t("labels.changedFiles");
  const displayCountLabel = filterQuery ? undefined : unfilteredCountLabel;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Section header */}
      <SectionHeader
        title={displayTitle}
        count={filteredFiles.length}
        countLabel={displayCountLabel}
        isCollapsed={isCollapsed}
        onToggle={() => setIsCollapsed((prev) => !prev)}
        actions={sectionActions}
        heightClassName="h-[40px]"
      />

      {!isCollapsed && (
        <>
          {/* Filter input */}
          {showFilter && (
            <div className="flex-shrink-0 bg-inherit px-3 pb-2">
              <Input
                prefix={
                  <HugeiconsIcon
                    icon={Search01Icon}
                    data-icon="search-icon"
                    size={14}
                    strokeWidth={1.75}
                  />
                }
                placeholder={t("placeholders.filterChanges")}
                value={filterQuery}
                onChange={setFilterQuery}
                size="small"
              />
            </div>
          )}

          {/* Virtualized file list with sticky headers */}
          <div className="min-h-0 flex-1">
            <VirtualizedStickyTree
              flattenedNodes={virtualizedNodes}
              rowHeight={TREE_ROW_HEIGHT}
              renderItem={renderItem}
              renderStickyItem={
                viewMode === "list-tree" ? renderStickyItem : undefined
              }
              onStickyHeaderClick={
                viewMode === "list-tree" ? handleStickyHeaderClick : undefined
              }
              emptyMessage={t("placeholders.noFilesFound")}
            />
          </div>
        </>
      )}
    </div>
  );
};

export default memo(GitFileList);

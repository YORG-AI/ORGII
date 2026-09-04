/**
 * WorkStation FileTreeContent implementation
 *
 * Renders the file tree structure with search/filter input and tree view.
 * Uses VirtualizedStickyTree for virtualization and sticky headers.
 *
 * Features:
 * - Virtualized rendering via VirtualizedStickyTree
 * - VS Code-style sticky breadcrumb headers
 * - Git status integration via render-time lookup
 * - Drag support for file references
 * - Jotai-based selection for minimal re-renders
 * - Context menu for file operations
 * - Inline rename with F2 selection cycling
 * - Keyboard shortcuts (Delete, Enter for rename)
 */
import {
  gitFileStatusMapAtom,
  gitFolderStatusMapAtom,
  workspaceFileStatusMapAtom,
  workspaceFolderStatusMapAtom,
} from "@/src/store/git";
import { useAtomValue, useSetAtom } from "jotai";
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
import type { VirtuosoHandle } from "react-virtuoso";

import { useActionSystem } from "@src/ActionSystem";
import Input from "@src/components/Input";
import { Placeholder } from "@src/components/Placeholder";
import type { TreePanelNode } from "@src/components/TreePanelSidebar/types";
import { TREE_ROW_HEIGHT } from "@src/components/TreeRow";
import type {
  FlattenedTreeNode,
  StickyScrollNode,
  VirtualizedStickyTreeHandle,
} from "@src/components/VirtualizedStickyTree";
import {
  CHEVRON_SIZE,
  STICKY_ROW,
  VirtualizedStickyTree,
  stickyRowPadding,
} from "@src/components/VirtualizedStickyTree";
import { getStatusBgColor } from "@src/config/gitStatus";
import {
  estimateRuntimeValueBytes,
  removeFileTreeMemoryEntry,
  updateFileTreeMemoryEntry,
} from "@src/hooks/perf/runtimeMemoryStats";
import { useElementDimensions } from "@src/hooks/ui/layout/useElementDimensions";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  HugeiconsIcon,
  Search01Icon,
} from "@src/icons";
import { FolderHeaderRow } from "@src/modules/WorkStation/shared/FolderHeaderRow";
import { fileTreeSelectedPathAtom } from "@src/store/ui/fileTreeSelectionAtom";

import { FileExplorerContextMenu } from "./FileExplorerMenu";
import { NewItemInput } from "./NewItemInput";
import { TreeNode } from "./TreeNode";
import { GitStatusContext } from "./context";
import { useRevealPath } from "./hooks/useRevealPath";
import type {
  FileTreeContentHandle,
  FileTreeContentProps,
  FlattenedNode,
} from "./types";
import {
  NEW_ITEM_PLACEHOLDER_ID,
  useFileTreeMutationState,
} from "./useFileTreeMutationState";
import { flattenTree } from "./utils/treeUtils";

const DEFAULT_FILTER_PLACEHOLDER = "Search files";
const DEFAULT_EMPTY_MESSAGE = "No files found";
const DEFAULT_NO_RESULTS_MESSAGE = "No files matching filter";

/**
 * FileTreeContent - Main file tree display component.
 *
 * @param stickyBgClass - Optional CSS class for sticky header background.
 *   Defaults to an empty string; pass a surface class from your design system
 *   (e.g. from `usePrimarySidebarSurface().stickyBgClass`) to match your panel style.
 */
export const FileTreeContent = memo(
  forwardRef<
    FileTreeContentHandle,
    FileTreeContentProps & { stickyBgClass?: string }
  >(
    (
      {
        treeData,
        selectedPath,
        repoPath = null,
        onSelectNode,
        onToggleDirectory,
        filterQuery,
        onFilterChange,
        filterPlaceholder,
        showFilter = false,
        loading = false,
        error = null,
        emptyMessage,
        noResultsMessage,
        revealPath = null,
        revealKey = null,
        dispatch: externalDispatch,
        isMultiRoot = false,
        stickyBgClass = "",
      },
      ref
    ) => {
      const { t } = useTranslation();
      const resolvedFilterPlaceholder =
        filterPlaceholder ??
        t("placeholders.searchFiles", {
          defaultValue: DEFAULT_FILTER_PLACEHOLDER,
        });
      const resolvedEmptyMessage =
        emptyMessage ??
        t("placeholders.noFilesFound", { defaultValue: DEFAULT_EMPTY_MESSAGE });
      const resolvedNoResultsMessage =
        noResultsMessage ??
        t("placeholders.noMatchingFiles", {
          defaultValue: DEFAULT_NO_RESULTS_MESSAGE,
        });

      const virtuosoRef = useRef<VirtuosoHandle>(null);
      const treeRef = useRef<VirtualizedStickyTreeHandle>(null);
      const containerRef = useRef<HTMLDivElement>(null);
      const memoryStatsKeyRef = useRef(Symbol("file-tree-memory"));
      const viewportHeight = useElementDimensions(containerRef, {
        dimension: "height",
      });
      const lastScrollTopRef = useRef(0);

      const [contextMenuOpen, setContextMenuOpen] = useState(false);
      const [contextMenuNode, setContextMenuNode] =
        useState<TreePanelNode | null>(null);

      const actionSystem = useActionSystem();
      const dispatch = externalDispatch ?? actionSystem.dispatch;

      // Git status from centralized atoms
      const singleRepoStatusMap = useAtomValue(gitFileStatusMapAtom);
      const singleFolderStatusMap = useAtomValue(gitFolderStatusMapAtom);
      const workspaceStatusMap = useAtomValue(workspaceFileStatusMapAtom);
      const wsFolderStatusMap = useAtomValue(workspaceFolderStatusMapAtom);

      const gitStatusMap = isMultiRoot
        ? workspaceStatusMap
        : singleRepoStatusMap;
      const gitFolderStatusMap = isMultiRoot
        ? wsFolderStatusMap
        : singleFolderStatusMap;

      const setFileTreeSelectedPath = useSetAtom(fileTreeSelectedPathAtom);
      useEffect(() => {
        setFileTreeSelectedPath(selectedPath);
      }, [selectedPath, setFileTreeSelectedPath]);

      const gitStatusContextValue = useMemo(
        () => ({
          statusMap: gitStatusMap,
          folderStatusMap: gitFolderStatusMap,
          repoPath,
          isMultiRoot,
        }),
        [gitStatusMap, gitFolderStatusMap, repoPath, isMultiRoot]
      );

      const handleContextMenu = useCallback(
        (event: React.MouseEvent, node: TreePanelNode | null) => {
          event.preventDefault();
          event.stopPropagation();
          setContextMenuNode(node);
          setContextMenuOpen(true);
        },
        []
      );

      const handleCloseContextMenu = useCallback(() => {
        setContextMenuOpen(false);
        setContextMenuNode(null);
      }, []);

      const baseFlattenedNodes = useMemo(
        () => flattenTree(treeData),
        [treeData]
      );

      useEffect(() => {
        const key = memoryStatsKeyRef.current;
        updateFileTreeMemoryEntry(key, {
          bytes:
            estimateRuntimeValueBytes(treeData) +
            estimateRuntimeValueBytes(baseFlattenedNodes),
          items: baseFlattenedNodes.length,
        });
        return () => removeFileTreeMemoryEntry(key);
      }, [baseFlattenedNodes, treeData]);

      const {
        renamingPath,
        creatingNew,
        flattenedNodes,
        handleStartRename,
        handleRenameConfirm,
        handleRenameCancel,
        handleStartCreateNew,
        handleCreateNewConfirm,
        handleCreateNewCancel,
        handleKeyDown,
      } = useFileTreeMutationState({
        selectedPath,
        baseFlattenedNodes,
        onToggleDirectory,
        dispatch,
        virtuosoRef,
      });

      useImperativeHandle(
        ref,
        () => ({
          startCreatingNew: handleStartCreateNew,
        }),
        [handleStartCreateNew]
      );

      const renderItem = useCallback(
        (item: FlattenedTreeNode<TreePanelNode>) => {
          if (item.node.path === NEW_ITEM_PLACEHOLDER_ID && creatingNew) {
            return (
              <NewItemInput
                depth={item.depth}
                isFolder={creatingNew.isFolder}
                onConfirm={handleCreateNewConfirm}
                onCancel={handleCreateNewCancel}
              />
            );
          }

          if (
            isMultiRoot &&
            item.depth === 0 &&
            item.node.type === "directory"
          ) {
            const isExpanded = item.node.expanded ?? false;
            return (
              <FolderHeaderRow
                name={item.node.name}
                expanded={isExpanded}
                onToggle={() => onToggleDirectory(item.node.path)}
                onContextMenu={(event) => handleContextMenu(event, item.node)}
              />
            );
          }

          const isRenaming = renamingPath === item.node.path;
          const depth = isMultiRoot ? Math.max(0, item.depth - 1) : item.depth;

          return (
            <div onContextMenu={(event) => handleContextMenu(event, item.node)}>
              <TreeNode
                node={item.node}
                depth={depth}
                onSelectNode={onSelectNode}
                onToggleDirectory={onToggleDirectory}
                isRenaming={isRenaming}
                onRenameConfirm={handleRenameConfirm}
                onRenameCancel={handleRenameCancel}
              />
            </div>
          );
        },
        [
          onSelectNode,
          onToggleDirectory,
          renamingPath,
          creatingNew,
          isMultiRoot,
          handleContextMenu,
          handleRenameConfirm,
          handleRenameCancel,
          handleCreateNewConfirm,
          handleCreateNewCancel,
        ]
      );

      const renderStickyItem = useCallback(
        (stickyNode: StickyScrollNode<TreePanelNode>, onClick: () => void) => {
          const { node, depth } = stickyNode;

          const lookupPath = isMultiRoot
            ? node.path
            : repoPath && node.path.startsWith(repoPath)
              ? node.path.substring(repoPath.length + 1)
              : node.path;

          const aggregateStatus = gitFolderStatusMap.get(lookupPath);
          const gitInfo = aggregateStatus
            ? { status: aggregateStatus, staged: false }
            : null;
          const isExpanded = node.expanded ?? false;

          return (
            <div
              className={`${STICKY_ROW.rowBase} ${stickyBgClass}`}
              style={stickyRowPadding(depth)}
              onClick={onClick}
              title={t("tooltips.scrollToItem", { name: node.name })}
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

              <span className={STICKY_ROW.name}>{node.name}</span>

              <div className="flex h-3.5 w-5 shrink-0 items-center justify-center">
                {gitInfo && (
                  <div
                    className={`h-1.5 w-1.5 rounded-full ${getStatusBgColor(gitInfo.status)}`}
                    title={t("tooltips.containsStatusFiles", {
                      status: gitInfo.status,
                    })}
                  />
                )}
              </div>
            </div>
          );
        },
        [repoPath, isMultiRoot, gitFolderStatusMap, stickyBgClass, t]
      );

      const handleStickyHeaderClick = useCallback(
        (nodePath: string, node: TreePanelNode) => {
          onSelectNode(nodePath, node);
        },
        [onSelectNode]
      );

      const flattenedNodesRef = useRef<FlattenedNode[]>(flattenedNodes);
      useEffect(() => {
        flattenedNodesRef.current = flattenedNodes;
      }, [flattenedNodes]);

      const stickyHeight = useMemo(() => {
        const firstItem = flattenedNodes[0];
        if (!firstItem) return 0;
        return Math.min(
          firstItem.depth * TREE_ROW_HEIGHT,
          viewportHeight * 0.4
        );
      }, [flattenedNodes, viewportHeight]);

      useRevealPath({
        revealPath,
        revealKey,
        selectedPath,
        virtuosoRef,
        useVirtualization: flattenedNodes.length > 0,
        flattenedNodesRef,
        lastScrollTopRef,
        viewportHeight,
        stickyHeight,
      });

      const hasFilter = filterQuery.trim().length > 0;
      const showEmptyNoResults = !loading && treeData.length === 0 && hasFilter;

      return (
        <GitStatusContext.Provider value={gitStatusContextValue}>
          <div
            className="flex h-full w-full flex-col outline-none"
            tabIndex={0}
            onKeyDown={handleKeyDown}
            onContextMenu={(event) => {
              if (
                (event.target as HTMLElement).closest("[data-tree-path]") ===
                null
              ) {
                handleContextMenu(event, null);
              }
            }}
          >
            {showFilter && (
              <div className="shrink-0 px-3 pb-2">
                <Input
                  prefix={
                    <HugeiconsIcon
                      icon={Search01Icon}
                      data-icon="search-icon"
                      size={14}
                      strokeWidth={1.75}
                    />
                  }
                  placeholder={resolvedFilterPlaceholder}
                  value={filterQuery}
                  onChange={onFilterChange}
                  size="small"
                  className="input-pane-surface"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                />
              </div>
            )}

            <div ref={containerRef} className="min-h-0 flex-1">
              {showEmptyNoResults ? (
                <Placeholder
                  variant="no-results"
                  placement="sidebar"
                  title={resolvedNoResultsMessage}
                  fillParentHeight
                />
              ) : (
                <VirtualizedStickyTree
                  ref={treeRef}
                  flattenedNodes={
                    flattenedNodes as FlattenedTreeNode<TreePanelNode>[]
                  }
                  rowHeight={TREE_ROW_HEIGHT}
                  renderItem={renderItem}
                  renderStickyItem={renderStickyItem}
                  onStickyHeaderClick={handleStickyHeaderClick}
                  virtuosoRef={virtuosoRef}
                  loading={loading}
                  error={error}
                  emptyMessage={resolvedEmptyMessage}
                  stickyBgClass={stickyBgClass}
                />
              )}
            </div>

            {contextMenuOpen && repoPath && (
              <FileExplorerContextMenu
                node={contextMenuNode}
                repoPath={repoPath}
                onClose={handleCloseContextMenu}
                onStartRename={handleStartRename}
                onStartCreateNew={handleStartCreateNew}
                dispatch={dispatch}
              />
            )}
          </div>
        </GitStatusContext.Provider>
      );
    }
  )
);

FileTreeContent.displayName = "FileTreeContent";

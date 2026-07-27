/**
 * TreePanelSidebar Component
 *
 * A reusable sidebar panel with tabs, filter input, and hierarchical tree structure.
 * Similar to ListPanelSidebar but designed for tree data (files, folders, etc.)
 *
 * Features:
 * - Tab navigation with optional icons
 * - Filter/search input
 * - Recursive tree rendering with expand/collapse
 * - Lazy loading support (load children on expand)
 * - Custom node rendering
 * - Loading, error, and empty states
 *
 * @example
 * ```tsx
 * <TreePanelSidebar
 *   tabs={[
 *     { key: 'files', label: 'Files', icon: <Files size={16} /> },
 *     { key: 'search', label: 'Search', icon: <Search size={16} /> },
 *   ]}
 *   activeTab={activeTab}
 *   onTabChange={setActiveTab}
 *   filterQuery={filterQuery}
 *   onFilterChange={setFilterQuery}
 *   treeData={fileTree}
 *   selectedPath={selectedFile}
 *   onSelectNode={handleSelect}
 *   onToggleDirectory={handleToggle}
 * />
 * ```
 */
import { ChevronDown, ChevronRight, Search as SearchIcon } from "lucide-react";
import React, { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Virtuoso } from "react-virtuoso";

import FolderIcon from "@src/assets/fileTypeIcons/folder-base.svg";
import FileTypeIcon from "@src/components/FileTypeIcon";
import Input from "@src/components/Input";
import ListPanelTabPillRow from "@src/components/ListPanel/ListPanelTabPillRow";
import { Placeholder } from "@src/components/Placeholder";
import TabPill from "@src/components/TabPill";
import { SURFACE_TOKENS } from "@src/config/surfaceTokens";

import {
  type TreePanelNode,
  type TreePanelSidebarProps,
  isSectionHeaderCustomAction,
} from "./types";

// ============================================
// Default Tree Node Renderer
// ============================================

interface TreeNodeProps {
  node: TreePanelNode;
  depth: number;
  selectedPath: string | null;
  onSelectNode: (path: string, node: TreePanelNode) => void;
  onToggleDirectory: (path: string) => void;
}

const DefaultTreeNode: React.FC<TreeNodeProps> = memo(
  ({ node, depth, selectedPath, onSelectNode, onToggleDirectory }) => {
    const isDirectory = node.type === "directory";
    const isSelected = selectedPath === node.path;
    const isExpanded = node.expanded ?? false;

    const handleClick = useCallback(() => {
      // Always select the node (both files and folders)
      onSelectNode(node.path, node);
      // Additionally toggle directory if it's a directory
      if (isDirectory) {
        onToggleDirectory(node.path);
      }
    }, [isDirectory, node, onSelectNode, onToggleDirectory]);

    return (
      <div
        className={`flex cursor-pointer items-center gap-1.5 rounded-lg py-1 transition-colors ${
          isSelected
            ? `${SURFACE_TOKENS.selected} ${SURFACE_TOKENS.selectedHover}`
            : SURFACE_TOKENS.hover
        }`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={handleClick}
      >
        {/* Expand/collapse icon for directories */}
        {isDirectory && (
          <div className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
            {isExpanded ? (
              <ChevronDown size={14} className="text-text-3" />
            ) : (
              <ChevronRight size={14} className="text-text-3" />
            )}
          </div>
        )}

        {/* Icon */}
        {node.icon ? (
          <span className="flex-shrink-0">{node.icon}</span>
        ) : isDirectory ? (
          <FolderIcon width={16} height={16} className="flex-shrink-0" />
        ) : (
          <>
            {/* Spacer for alignment with directories */}
            <div className="w-4 flex-shrink-0" />
            <FileTypeIcon
              fileName={node.name}
              size="small"
              className="flex-shrink-0"
            />
          </>
        )}

        {/* Name */}
        <span
          className={`truncate text-[13px] ${
            isSelected ? "font-medium text-text-1" : "text-text-2"
          }`}
          title={node.name}
        >
          {node.name}
        </span>

        {/* Agent indicator */}
        {node.isAgentSelected && (
          <div className="ml-auto flex h-4 w-4 flex-shrink-0 items-center justify-center">
            <div className="h-[6px] w-[6px] rounded-full bg-primary-6" />
          </div>
        )}
      </div>
    );
  }
);

DefaultTreeNode.displayName = "DefaultTreeNode";

// ============================================
// Main Component
// ============================================

export function TreePanelSidebar<TTab extends string = string>({
  tabs,
  activeTab,
  onTabChange,
  tabIconOnly = false,
  filterQuery,
  onFilterChange,
  filterPlaceholder = "Filter...",
  treeData,
  selectedPath,
  onSelectNode,
  onToggleDirectory,
  renderNode,
  loading = false,
  error = null,
  emptyMessage,
  noResultsMessage,
  widthClass = "w-72",
  tabsFillWidth = true,
  sectionTitle,
  sectionCollapsible = false,
  sectionDefaultExpanded = true,
  sectionActions = [],
}: TreePanelSidebarProps<TTab>) {
  const { t } = useTranslation();
  const resolvedEmptyMessage = emptyMessage ?? t("placeholders.noItems");
  const resolvedNoResultsMessage =
    noResultsMessage ?? t("placeholders.noMatchingItems");

  // Section collapse state
  const [sectionExpanded, setSectionExpanded] = useState(
    sectionDefaultExpanded
  );

  // Scroll container ref to maintain scroll position
  const scrollContainerRef = React.useRef<HTMLDivElement>(null);

  // Flatten tree to array for virtualization (when filtered or large)
  const flattenedNodes = useMemo(() => {
    const result: Array<{ node: TreePanelNode; depth: number }> = [];

    function flatten(nodes: TreePanelNode[], depth: number = 0) {
      for (const node of nodes) {
        result.push({ node, depth });
        // Include expanded children
        if (node.type === "directory" && node.expanded && node.children) {
          flatten(node.children, depth + 1);
        }
      }
    }

    flatten(treeData);
    return result;
  }, [treeData]);

  // Use virtualization for large lists (>100 items)
  const useVirtualization = flattenedNodes.length > 100;

  // Render single node (memoized to prevent re-renders)
  const renderSingleNode = useCallback(
    (item: { node: TreePanelNode; depth: number }) => {
      const { node, depth } = item;

      if (renderNode) {
        return renderNode(node, selectedPath === node.path, depth);
      }

      return (
        <DefaultTreeNode
          node={node}
          depth={depth}
          selectedPath={selectedPath}
          onSelectNode={onSelectNode}
          onToggleDirectory={onToggleDirectory}
        />
      );
    },
    [renderNode, selectedPath, onSelectNode, onToggleDirectory]
  );

  const hasFilter = filterQuery.trim().length > 0;

  return (
    <div className={`flex h-full ${widthClass} shrink-0 flex-col`}>
      {/* Header with Tabs */}
      <ListPanelTabPillRow>
        <TabPill
          activeTab={activeTab}
          tabs={tabs}
          onChange={(key) => onTabChange(key as TTab)}
          variant="pill"
          color="fill"
          size="default"
          className="flex-1"
          fillWidth={tabsFillWidth}
          iconOnly={tabIconOnly}
        />
      </ListPanelTabPillRow>

      {/* Section Header (if title provided) */}
      {sectionTitle && (
        <div
          className={`group flex h-[32px] flex-shrink-0 items-center justify-between px-3 ${
            sectionCollapsible ? "cursor-pointer hover:bg-fill-3" : ""
          }`}
          onClick={
            sectionCollapsible
              ? () => setSectionExpanded(!sectionExpanded)
              : undefined
          }
        >
          <div className="flex flex-1 items-center gap-1.5">
            {/* Collapse chevron */}
            {sectionCollapsible &&
              (sectionExpanded ? (
                <ChevronDown
                  size={12}
                  strokeWidth={2}
                  className="text-text-3"
                />
              ) : (
                <ChevronRight
                  size={12}
                  strokeWidth={2}
                  className="text-text-3"
                />
              ))}
            {/* Section title */}
            <span className="truncate text-[12px] font-medium text-text-2">
              {sectionTitle}
            </span>
          </div>

          {/* Action buttons */}
          {sectionActions.length > 0 && (
            <div className="flex items-center gap-0.5 opacity-100 transition-opacity">
              {sectionActions.map((action) => {
                if (isSectionHeaderCustomAction(action)) {
                  return <div key={action.key}>{action.customRender}</div>;
                }
                return (
                  <button
                    key={action.key}
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      action.onClick();
                    }}
                    className="flex h-5 w-5 items-center justify-center rounded text-text-3 transition-colors hover:bg-fill-2 hover:text-text-1"
                    title={action.tooltip}
                  >
                    {action.icon}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Filter Input */}
      <div className="flex-shrink-0 px-3 pb-2">
        <Input
          prefix={<SearchIcon size={14} strokeWidth={1.75} />}
          placeholder={filterPlaceholder}
          value={filterQuery}
          onChange={onFilterChange}
          size="default"
        />
      </div>

      {/* Tree content - only render if section is expanded */}
      {(!sectionCollapsible || sectionExpanded) && (
        <div
          ref={scrollContainerRef}
          className="min-h-0 flex-1 overflow-y-auto px-2 scrollbar-hide"
        >
          {/* Loading State */}
          {loading && treeData.length === 0 && (
            <Placeholder variant="loading" />
          )}

          {/* Error State */}
          {!loading && error && <Placeholder variant="error" title={error} />}

          {/* No Results State (when filter has no matches) */}
          {!loading && !error && treeData.length === 0 && hasFilter && (
            <Placeholder
              variant="no-results"
              title={resolvedNoResultsMessage}
            />
          )}

          {/* Empty State (no data at all) */}
          {!loading && !error && treeData.length === 0 && !hasFilter && (
            <Placeholder variant="empty" title={resolvedEmptyMessage} />
          )}

          {/* Tree Items */}
          {!loading && !error && treeData.length > 0 && (
            <div className="pb-2">
              {useVirtualization ? (
                /* Virtualized list for large trees */
                <Virtuoso
                  totalCount={flattenedNodes.length}
                  itemContent={(index) => (
                    <div key={flattenedNodes[index].node.path}>
                      {renderSingleNode(flattenedNodes[index])}
                    </div>
                  )}
                  computeItemKey={(index) => flattenedNodes[index].node.path}
                  overscan={20}
                  increaseViewportBy={{ top: 200, bottom: 200 }}
                  style={{ height: "100%" }}
                  followOutput={false}
                  defaultItemHeight={28}
                />
              ) : (
                /* Non-virtualized for small trees */
                flattenedNodes.map((item) => (
                  <div key={item.node.path}>{renderSingleNode(item)}</div>
                ))
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default memo(TreePanelSidebar) as typeof TreePanelSidebar;

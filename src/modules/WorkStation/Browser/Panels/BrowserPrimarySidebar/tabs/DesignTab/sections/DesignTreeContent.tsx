import React, { memo, useCallback, useMemo } from "react";

import Input from "@src/components/Input";
import { Placeholder } from "@src/components/Placeholder";
import type { TreePanelNode } from "@src/components/TreePanelSidebar/types";
import {
  TREE_ROW_HEIGHT,
  TreeRowBase,
  type TreeRowNode,
} from "@src/components/TreeRow";
import {
  type FlattenedTreeNode,
  VirtualizedStickyTree,
} from "@src/components/VirtualizedStickyTree";
import { FilterIcon, HugeiconsIcon } from "@src/icons";

interface FlattenedDesignNode {
  node: TreePanelNode;
  depth: number;
}

export interface DesignTreeContentProps {
  treeData: TreePanelNode[];
  selectedPath: string | null;
  onSelectNode: (path: string, node: TreePanelNode) => void;
  onToggleDirectory: (path: string) => void;
  filterQuery: string;
  onFilterChange: (query: string) => void;
  filterPlaceholder?: string;
  showFilter?: boolean;
  loading?: boolean;
  error?: string | null;
  emptyMessage?: string;
  noResultsMessage?: string;
}

function flattenDesignTree(nodes: TreePanelNode[]): FlattenedDesignNode[] {
  const flattened: FlattenedDesignNode[] = [];

  function append(nodeList: TreePanelNode[], depth: number) {
    for (const node of nodeList) {
      flattened.push({ node, depth });
      if (node.type === "directory" && node.expanded && node.children) {
        append(node.children, depth + 1);
      }
    }
  }

  append(nodes, 0);
  return flattened;
}

function toTreeRowNode(node: TreePanelNode): TreeRowNode {
  return {
    id: node.path,
    name: node.name,
    path: node.path,
    type: node.type,
    expanded: node.expanded ?? false,
    ...(node.icon !== undefined ? { icon: node.icon } : {}),
    isSymlink: node.isSymlink,
    isIgnored: node.isIgnored,
  };
}

export const DesignTreeContent: React.FC<DesignTreeContentProps> = memo(
  ({
    treeData,
    selectedPath,
    onSelectNode,
    onToggleDirectory,
    filterQuery,
    onFilterChange,
    filterPlaceholder = "Filter...",
    showFilter = false,
    loading = false,
    error = null,
    emptyMessage = "No items",
    noResultsMessage = "No matching items",
  }) => {
    const flattenedNodes = useMemo(
      () => flattenDesignTree(treeData),
      [treeData]
    );
    const hasFilter = filterQuery.trim().length > 0;
    const showEmptyNoResults = !loading && treeData.length === 0 && hasFilter;

    const renderItem = useCallback(
      (item: FlattenedTreeNode<TreePanelNode>) => {
        const rowNode = toTreeRowNode(item.node);
        const isSelected = selectedPath === item.node.path;
        const handleClick = () => {
          onSelectNode(item.node.path, item.node);
          if (item.node.type === "directory") {
            onToggleDirectory(item.node.path);
          }
        };

        return (
          <TreeRowBase
            node={rowNode}
            depth={item.depth}
            isSelected={isSelected}
            onClick={handleClick}
            dataPath={item.node.path}
          >
            {item.node.secondaryText && (
              <span className="ml-auto flex-shrink-0 text-[11px] text-text-4">
                {item.node.secondaryText}
              </span>
            )}
          </TreeRowBase>
        );
      },
      [onSelectNode, onToggleDirectory, selectedPath]
    );

    return (
      <div className="flex h-full w-full flex-col outline-none">
        {showFilter && (
          <div className="flex-shrink-0 px-3 pb-2">
            <Input
              prefix={
                <HugeiconsIcon
                  icon={FilterIcon}
                  data-icon="filter-icon"
                  size={14}
                  strokeWidth={1.75}
                />
              }
              placeholder={filterPlaceholder}
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

        <div className="min-h-0 flex-1">
          {showEmptyNoResults ? (
            <Placeholder
              variant="no-results"
              placement="sidebar"
              title={noResultsMessage}
              fillParentHeight
            />
          ) : (
            <VirtualizedStickyTree
              flattenedNodes={
                flattenedNodes as FlattenedTreeNode<TreePanelNode>[]
              }
              rowHeight={TREE_ROW_HEIGHT}
              renderItem={renderItem}
              loading={loading}
              error={error}
              emptyMessage={emptyMessage}
            />
          )}
        </div>
      </div>
    );
  }
);

DesignTreeContent.displayName = "DesignTreeContent";

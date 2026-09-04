/**
 * DesignTabPages - Pages section for DesignTab sidebar
 */
import React, { memo, useCallback, useEffect, useMemo, useState } from "react";

import type { TreePanelNode } from "@src/components/TreePanelSidebar/types";
import { FileScriptIcon, HugeiconsIcon } from "@src/icons";

import { TREE_ICON_SIZE } from "../config";
import type { DesignTabPagesProps, PageItem } from "../types";
import { DesignTreeContent } from "./DesignTreeContent";

// ============================================
// Utility Functions
// ============================================

/** Convert PageItem[] to TreePanelNode[] for design tree rendering. */
function pagesToTreeNodes(pages: PageItem[]): TreePanelNode[] {
  return pages.map((page) => ({
    id: page.id,
    name: page.name,
    path: page.path,
    type: "file" as const,
    icon: (
      <HugeiconsIcon
        icon={FileScriptIcon}
        data-icon="file-code"
        size={TREE_ICON_SIZE}
        className="text-text-3"
      />
    ),
  }));
}

// ============================================
// Component
// ============================================

export const DesignTabPages: React.FC<DesignTabPagesProps> = memo(
  ({
    pages,
    activePageId,
    onSelectPage,
    showFilter = false,
    onRegisterCollapseAll,
  }) => {
    const [filterQuery, setFilterQuery] = useState("");

    // Collapse all - no-op for flat pages, but provided for consistency
    const collapseAll = useCallback(() => {
      // Pages are flat, nothing to collapse
    }, []);

    // Register collapseAll with parent
    useEffect(() => {
      onRegisterCollapseAll?.(collapseAll);
    }, [onRegisterCollapseAll, collapseAll]);

    // Convert pages to tree nodes
    const treeData = useMemo(() => pagesToTreeNodes(pages), [pages]);

    // Filter pages if query is set
    const filteredTreeData = useMemo(() => {
      if (!filterQuery.trim()) return treeData;
      const query = filterQuery.toLowerCase();
      return treeData.filter((node) => node.name.toLowerCase().includes(query));
    }, [treeData, filterQuery]);

    // Handle node selection
    const handleSelectNode = useCallback(
      (path: string, _node: TreePanelNode) => {
        // Extract page ID from path
        const page = pages.find((pageItem) => pageItem.path === path);
        if (page) {
          onSelectPage?.(page.id);
        }
      },
      [pages, onSelectPage]
    );

    // No-op for directories (pages are flat)
    const handleToggleDirectory = useCallback(() => {}, []);

    return (
      <DesignTreeContent
        treeData={filteredTreeData}
        selectedPath={
          pages.find((page) => page.id === activePageId)?.path || null
        }
        onSelectNode={handleSelectNode}
        onToggleDirectory={handleToggleDirectory}
        filterQuery={filterQuery}
        onFilterChange={setFilterQuery}
        filterPlaceholder="Filter..."
        showFilter={showFilter}
        emptyMessage="No pages"
        noResultsMessage="No matching pages"
      />
    );
  }
);

DesignTabPages.displayName = "DesignTabPages";

/**
 * DesignTabGlobalTokens - Global Tokens section for DesignTab sidebar
 *
 * Shows a single "Color Tokens" entry with total count.
 * Opens a consolidated tab with all color tokens.
 */
import React, { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Placeholder } from "@src/components/Placeholder";
import type { TreePanelNode } from "@src/components/TreePanelSidebar/types";
import { ColorPickerIcon, HugeiconsIcon } from "@src/icons";
import { useGlobalTokens } from "@src/modules/WorkStation/Browser/hooks/useGlobalTokens";

import { TREE_ICON_SIZE } from "../config";
import type { DesignTabGlobalTokensProps } from "../types";
import { DesignTreeContent } from "./DesignTreeContent";

export const DesignTabGlobalTokens: React.FC<DesignTabGlobalTokensProps> = memo(
  ({ repoPath, onOpenColorTokens, showFilter = false, onRegisterRefresh }) => {
    const { t } = useTranslation();
    const { tokens, categories, loading, error, scan } = useGlobalTokens({
      repoPath,
      autoScan: true,
    });

    const [filterQuery, setFilterQuery] = useState("");

    // Register refresh callback with parent
    useEffect(() => {
      onRegisterRefresh?.(scan);
    }, [onRegisterRefresh, scan]);

    // Count total color tokens across all categories
    const totalColorTokens = useMemo(() => {
      return categories.reduce((sum, cat) => sum + cat.tokens.length, 0);
    }, [categories]);

    // Create single tree node for Color Tokens
    const treeData = useMemo((): TreePanelNode[] => {
      if (categories.length === 0) return [];
      return [
        {
          id: "color-tokens",
          name: "Color Tokens",
          path: "color-tokens",
          type: "file" as const,
          icon: (
            <HugeiconsIcon
              icon={ColorPickerIcon}
              data-icon="palette"
              size={TREE_ICON_SIZE}
              className="text-primary-6"
            />
          ),
          secondaryText: `${totalColorTokens}`,
        },
      ];
    }, [categories, totalColorTokens]);

    // Filter (only one item, but keeping pattern)
    const filteredTreeData = useMemo(() => {
      if (!filterQuery.trim()) return treeData;
      const query = filterQuery.toLowerCase();
      return treeData.filter((node) => node.name.toLowerCase().includes(query));
    }, [treeData, filterQuery]);

    // Handle node selection - opens Color Tokens tab
    const handleSelectNode = useCallback(
      (_path: string, _node: TreePanelNode) => {
        onOpenColorTokens?.();
      },
      [onOpenColorTokens]
    );

    // No-op for directories (flat list)
    const handleToggleDirectory = useCallback(() => {}, []);

    // Loading state
    if (loading) {
      return (
        <Placeholder variant="loading" placement="sidebar" fillParentHeight />
      );
    }

    // Error state
    if (error) {
      return (
        <Placeholder
          variant="error"
          title={error}
          subtitle={t("placeholders.retryToScanAgain")}
          onRetry={scan}
          placement="sidebar"
          fillParentHeight
        />
      );
    }

    // Empty state
    if (tokens.length === 0) {
      return (
        <Placeholder
          variant="empty"
          title={t("placeholders.noTokensFound")}
          subtitle={t("placeholders.addCssVariables")}
          placement="sidebar"
          fillParentHeight
        />
      );
    }

    return (
      <DesignTreeContent
        treeData={filteredTreeData}
        selectedPath={null}
        onSelectNode={handleSelectNode}
        onToggleDirectory={handleToggleDirectory}
        filterQuery={filterQuery}
        onFilterChange={setFilterQuery}
        filterPlaceholder="Filter tokens..."
        showFilter={showFilter}
        emptyMessage="No tokens"
        noResultsMessage="No matching tokens"
      />
    );
  }
);

DesignTabGlobalTokens.displayName = "DesignTabGlobalTokens";

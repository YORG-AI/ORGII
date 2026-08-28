/**
 * useSourceControlActions
 *
 * Builds the action button list for the Source Control sidebar tab header.
 * Extracted from `useExplorerActions` so the Source Control sidebar module
 * can be reused outside the Code Editor (e.g. Control Tower peek).
 */
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import AnyIcon from "@src/components/AnyIcon";
import type { SectionHeaderAction } from "@src/components/TreePanelSidebar/types";
import { useRefreshSpin } from "@src/hooks/ui";

import { ICON_CONFIG, PANEL_CONSTANTS } from "../config";

const {
  filter: FilterIcon,
  refresh: RefreshIcon,
  listTree: ListTreeIcon,
  list: ListIcon,
} = ICON_CONFIG;

export interface UseSourceControlActionsOptions {
  showFilter: boolean;
  viewMode: "list-tree" | "list";
  onToggleFilter: () => void;
  onToggleViewMode: () => void;
  onRefresh: () => void;
  /** Whether refresh is in progress (drives spin animation). */
  refreshLoading?: boolean;
}

export function useSourceControlActions({
  showFilter,
  viewMode,
  onToggleFilter,
  onToggleViewMode,
  onRefresh,
  refreshLoading = false,
}: UseSourceControlActionsOptions): SectionHeaderAction[] {
  const { t } = useTranslation("common");
  const { spinClass: refreshSpinClass, handleClick: handleRefreshClick } =
    useRefreshSpin(onRefresh, refreshLoading);

  return useMemo<SectionHeaderAction[]>(() => {
    const actions: SectionHeaderAction[] = [
      {
        key: "filter-git",
        icon: (
          <AnyIcon
            icon={FilterIcon}
            size={PANEL_CONSTANTS.ACTION_ICON_SIZE}
            strokeWidth={PANEL_CONSTANTS.ACTION_ICON_STROKE}
            className={showFilter ? "text-primary-6" : ""}
          />
        ),
        tooltip: t("actions.filter", "Filter"),
        onClick: onToggleFilter,
      },
      {
        key: "view-mode-toggle",
        icon:
          viewMode === "list" ? (
            <AnyIcon
              icon={ListTreeIcon}
              size={PANEL_CONSTANTS.ACTION_ICON_SIZE}
              strokeWidth={PANEL_CONSTANTS.ACTION_ICON_STROKE}
            />
          ) : (
            <AnyIcon
              icon={ListIcon}
              size={PANEL_CONSTANTS.ACTION_ICON_SIZE}
              strokeWidth={PANEL_CONSTANTS.ACTION_ICON_STROKE}
            />
          ),
        tooltip:
          viewMode === "list-tree"
            ? "Switch to list view"
            : "Switch to tree view",
        onClick: onToggleViewMode,
      },
      {
        key: "refresh-git",
        icon: (
          <AnyIcon
            icon={RefreshIcon}
            size={PANEL_CONSTANTS.ACTION_ICON_SIZE}
            strokeWidth={PANEL_CONSTANTS.ACTION_ICON_STROKE}
            className={refreshSpinClass}
          />
        ),
        tooltip: t("actions.refresh", "Refresh"),
        onClick: handleRefreshClick,
      },
    ];

    return actions;
  }, [
    showFilter,
    viewMode,
    onToggleFilter,
    onToggleViewMode,
    refreshSpinClass,
    handleRefreshClick,
    t,
  ]);
}

/**
 * useExplorerActions Hook
 *
 * Manages action button configurations for EditorPrimarySidebar tabs.
 */
import { useMemo } from "react";

import AnyIcon from "@src/components/AnyIcon";
import type { SectionHeaderAction } from "@src/components/TreePanelSidebar/types";
import { useRefreshSpin } from "@src/hooks/ui";

import { ICON_CONFIG, PANEL_CONSTANTS } from "../config";

const {
  filter: FilterIcon,
  search: SearchIcon,
  addFile: AddFileIcon,
  addFolder: AddFolderIcon,
  refresh: RefreshIcon,
  collapseAll: CollapseAllIcon,
  openInTab: OpenInTabIcon,
} = ICON_CONFIG;

export interface UseExplorerActionsOptions {
  showFilterFiles: boolean;
  onToggleFilterFiles: () => void;
  onRefresh?: () => void;
  filesRefreshLoading?: boolean;
  onCollapseAll?: () => void;
  onAddFile?: () => void;
  onAddFolder?: () => void;
  showSearchFilters?: boolean;
  onToggleSearchFilters?: () => void;
  onSearchCollapseAll?: () => void;
  onOpenSearchTab?: () => void;
}

export interface UseExplorerActionsResult {
  filesActions: SectionHeaderAction[];
  searchActions: SectionHeaderAction[];
}

export function useExplorerActions({
  showFilterFiles,
  onToggleFilterFiles,
  onRefresh,
  filesRefreshLoading = false,
  onCollapseAll,
  onAddFile,
  onAddFolder,
  showSearchFilters = false,
  onToggleSearchFilters,
  onSearchCollapseAll,
  onOpenSearchTab,
}: UseExplorerActionsOptions): UseExplorerActionsResult {
  const {
    spinClass: filesRefreshSpinClass,
    handleClick: handleFilesRefreshClick,
  } = useRefreshSpin(onRefresh ?? (() => {}), filesRefreshLoading);

  const filesActions = useMemo<SectionHeaderAction[]>(() => {
    const actions: SectionHeaderAction[] = [];

    actions.push({
      key: "search",
      icon: (
        <AnyIcon
          icon={SearchIcon}
          size={PANEL_CONSTANTS.ACTION_ICON_SIZE}
          strokeWidth={PANEL_CONSTANTS.ACTION_ICON_STROKE}
          className={showFilterFiles ? "text-primary-6" : ""}
        />
      ),
      tooltip: "Search",
      onClick: onToggleFilterFiles,
    });

    if (onAddFile) {
      actions.push({
        key: "add-file",
        icon: (
          <AnyIcon
            icon={AddFileIcon}
            size={PANEL_CONSTANTS.ACTION_ICON_SIZE}
            strokeWidth={PANEL_CONSTANTS.ACTION_ICON_STROKE}
          />
        ),
        tooltip: "New File",
        onClick: onAddFile,
      });
    }

    if (onAddFolder) {
      actions.push({
        key: "add-folder",
        icon: (
          <AnyIcon
            icon={AddFolderIcon}
            size={PANEL_CONSTANTS.ACTION_ICON_SIZE}
            strokeWidth={PANEL_CONSTANTS.ACTION_ICON_STROKE}
          />
        ),
        tooltip: "New Folder",
        onClick: onAddFolder,
      });
    }

    if (onRefresh) {
      actions.push({
        key: "refresh",
        icon: (
          <AnyIcon
            icon={RefreshIcon}
            size={PANEL_CONSTANTS.ACTION_ICON_SIZE}
            strokeWidth={PANEL_CONSTANTS.ACTION_ICON_STROKE}
            className={filesRefreshSpinClass}
          />
        ),
        tooltip: "Refresh Explorer",
        onClick: handleFilesRefreshClick,
      });
    }

    if (onCollapseAll) {
      actions.push({
        key: "collapse-all",
        icon: (
          <AnyIcon
            icon={CollapseAllIcon}
            size={PANEL_CONSTANTS.ACTION_ICON_SIZE}
            strokeWidth={PANEL_CONSTANTS.ACTION_ICON_STROKE}
          />
        ),
        tooltip: "Collapse All",
        onClick: onCollapseAll,
      });
    }

    return actions;
  }, [
    showFilterFiles,
    onToggleFilterFiles,
    onAddFile,
    onAddFolder,
    onRefresh,
    filesRefreshSpinClass,
    handleFilesRefreshClick,
    onCollapseAll,
  ]);

  const searchActions = useMemo<SectionHeaderAction[]>(() => {
    const actions: SectionHeaderAction[] = [];

    if (onOpenSearchTab) {
      actions.push({
        key: "open-search-tab",
        icon: (
          <AnyIcon
            icon={OpenInTabIcon}
            size={PANEL_CONSTANTS.ACTION_ICON_SIZE}
            strokeWidth={PANEL_CONSTANTS.ACTION_ICON_STROKE}
          />
        ),
        tooltip: "Open in Tab",
        onClick: onOpenSearchTab,
      });
    }

    if (onToggleSearchFilters) {
      actions.push({
        key: "toggle-search-filters",
        icon: (
          <AnyIcon
            icon={FilterIcon}
            size={PANEL_CONSTANTS.ACTION_ICON_SIZE}
            strokeWidth={PANEL_CONSTANTS.ACTION_ICON_STROKE}
            className={showSearchFilters ? "text-primary-6" : ""}
          />
        ),
        tooltip: showSearchFilters ? "Hide Filters" : "Show Filters",
        onClick: onToggleSearchFilters,
      });
    }

    if (onSearchCollapseAll) {
      actions.push({
        key: "collapse-expand-search",
        icon: (
          <AnyIcon
            icon={CollapseAllIcon}
            size={PANEL_CONSTANTS.ACTION_ICON_SIZE}
            strokeWidth={PANEL_CONSTANTS.ACTION_ICON_STROKE}
          />
        ),
        tooltip: "Collapse All",
        onClick: onSearchCollapseAll,
      });
    }

    return actions;
  }, [
    showSearchFilters,
    onToggleSearchFilters,
    onSearchCollapseAll,
    onOpenSearchTab,
  ]);

  return {
    filesActions,
    searchActions,
  };
}

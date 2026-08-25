/**
 * useExplorerTabs Hook
 *
 * Manages tab state and tab change logic for EditorPrimarySidebar.
 * Handles auto-reveal when switching to Files tab.
 *
 * SYNC: Syncs with workStationPrimarySidebarTabAtom so AI actions can switch tabs.
 */
import { useAtom } from "jotai";
import React, { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { workStationPrimarySidebarTabAtom } from "@src/store/ui/workStationAtom";

import { ICON_CONFIG, PANEL_CONSTANTS, TAB_LABELS, TAB_ORDER } from "../config";
import type { ExplorerViewMode } from "../types";

export interface UseExplorerTabsOptions {
  activeFilePath?: string | null;
  onRevealFile?: (filePath: string) => Promise<void>;
  onTabChange?: (tab: ExplorerViewMode) => void;
}

export interface UseExplorerTabsResult {
  viewMode: ExplorerViewMode;
  tabs: Array<{
    key: ExplorerViewMode;
    label: string;
    icon: React.ReactNode;
  }>;
  handleTabChange: (mode: string) => void;
}

export function useExplorerTabs({
  activeFilePath,
  onRevealFile,
  onTabChange,
}: UseExplorerTabsOptions): UseExplorerTabsResult {
  // Tab state - synced with global atom for AI action support
  const [globalTab, setGlobalTab] = useAtom(workStationPrimarySidebarTabAtom);

  // Use the global tab as the source of truth (no local state needed)
  const viewMode = globalTab as ExplorerViewMode;

  // Destructure icon components to avoid JSX parsing issues
  const FilesIcon = ICON_CONFIG.files;
  const SearchIcon = ICON_CONFIG.search;

  // Tab icon configurations - keyed by tab ID
  const tabIconConfigs: Record<ExplorerViewMode, React.ReactNode> = useMemo(
    () => ({
      files: React.createElement(FilesIcon, {
        size: PANEL_CONSTANTS.TAB_ICON_SIZE,
      }),
      search: React.createElement(SearchIcon, {
        size: PANEL_CONSTANTS.TAB_ICON_SIZE,
      }),
    }),
    [FilesIcon, SearchIcon]
  );

  const { t } = useTranslation();

  // Build tabs array from TAB_ORDER (labels are i18n keys)
  const tabs = useMemo(
    () =>
      TAB_ORDER.map((key) => ({
        key,
        label: t(TAB_LABELS[key]),
        icon: tabIconConfigs[key],
      })),
    [tabIconConfigs, t]
  );

  // Handle tab change - updates global state
  const handleTabChange = useCallback(
    (mode: string) => {
      const tabMode = mode as ExplorerViewMode;
      setGlobalTab(tabMode); // Update global atom (viewMode will automatically reflect this)

      // When switching to files tab, reveal the active file
      if (tabMode === "files" && activeFilePath) {
        // Call the reveal function to expand parent directories
        if (onRevealFile) {
          onRevealFile(activeFilePath);
        }
      }

      // Notify parent
      if (onTabChange) {
        onTabChange(tabMode);
      }
    },
    [onTabChange, activeFilePath, onRevealFile, setGlobalTab]
  );

  return {
    viewMode,
    tabs,
    handleTabChange,
  };
}

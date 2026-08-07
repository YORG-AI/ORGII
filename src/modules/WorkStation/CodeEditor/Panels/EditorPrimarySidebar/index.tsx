/**
 * EditorPrimarySidebar Component
 *
 * Main left panel for Code Editor with multiple tabs:
 * - Files: File tree, outline view, timeline
 * - Search: Repository-wide search
 * - Testing: Test runner panel
 *
 * ARCHITECTURE (Jan 2026):
 * Single Source of Truth: The active editor tab is THE source of truth for file selection.
 * - `useSelectedFile` hook provides selectedFilePath derived from active tab
 * - Explorer and Search read from the same source
 * - Selecting a file anywhere opens a tab, which becomes the new selection
 *
 * PERFORMANCE (Jan 2026):
 * Heavy hooks are encapsulated in tab config files. Combined with lazy mounting
 * in PrimarySidebarLayoutWithSections, this defers search work until its tab is
 * first visited.
 *
 * MODULARIZATION (Feb 2026):
 * Business logic extracted into focused hooks under ./hooks/:
 * - useOpenSearchTab: Search tab creation in editor pane
 * - useFolderSelection: Folder/file selection + tree node handler
 * - useTargetDirectory: Target dir for new file/folder creation
 * - useDisplayData: Tree data conversion + filtering/search
 */
import React, { memo, useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useSelectedFile } from "@src/hooks/workStation/tabs/useSelectedFile";
import {
  HUMANTOOLS_TEXT_KEYS,
  PrimarySidebarLayoutWithSections,
} from "@src/modules/WorkStation/shared";

// Content components
import {
  FileTreeContent,
  type FileTreeContentHandle,
} from "./content/FileTreeContent";
import TestingContent from "./content/TestingContent";
// Extracted hooks
import { useDisplayData } from "./hooks/useDisplayData";
import { useExplorerActions } from "./hooks/useExplorerActions";
import { useExplorerTabs } from "./hooks/useExplorerTabs";
import { useFileReveal } from "./hooks/useFileReveal";
import { useFilterState } from "./hooks/useFilterState";
import { useFolderSelection } from "./hooks/useFolderSelection";
import { useOpenSearchTab } from "./hooks/useOpenSearchTab";
import { useTargetDirectory } from "./hooks/useTargetDirectory";
// Tab configs
import { useFilesTabConfig } from "./tabs/FilesTab";
import { type SearchTabHandle, useSearchTabConfig } from "./tabs/SearchTab";
import { useTestingTabConfig } from "./tabs/TestingTab";
import type { EditorPrimarySidebarProps } from "./types";

export const EditorPrimarySidebar: React.FC<EditorPrimarySidebarProps> = memo(
  ({
    fileTree,
    selectedCommitSha,
    loading,
    error,
    repoPath,
    repoId,
    repoName,
    searchResults = [],
    searchLoading = false,
    onFileSelect,
    onFileSelectWithLine,
    onDirectoryToggle,
    onRefresh,
    onCollapseAll,
    onFilterSearch,
    onClearSearch,
    onTabChange,
    iconOnly = true,
    onSymbolClick,
    onTimelineCommitClick,
    onRevealFile,
    onOpenSearchTab: onOpenSearchTabProp,
    isMultiRoot = false,
  }) => {
    const { t } = useTranslation();

    // ============================================
    // SINGLE SOURCE OF TRUTH: Active tab selection
    // ============================================
    const { selectedFilePath } = useSelectedFile();

    // ============================================
    // Extracted hooks
    // ============================================

    const {
      effectiveSelectedPath,
      selectedFolderPath,
      handleSelectNode,
      explorerClickPathRef,
    } = useFolderSelection({ selectedFilePath, onFileSelect });

    const handleOpenSearchTab = useOpenSearchTab({
      repoPath,
      onOpenSearchTab: onOpenSearchTabProp,
    });

    // ============================================
    // Local UI state
    // ============================================
    const [showSearchFilters, setShowSearchFilters] = useState(false);
    const [showTestingFilter, setShowTestingFilter] = useState(false);

    // Refs for panel collapse/expand and refresh control
    const searchPanelRef = useRef<SearchTabHandle>(null);
    const fileTreeRef = useRef<FileTreeContentHandle>(null);

    // ============================================
    // Tab & filter state
    // ============================================
    const { viewMode, handleTabChange } = useExplorerTabs({
      activeFilePath: selectedFilePath,
      onRevealFile,
      onTabChange,
    });

    const { revealRequest } = useFileReveal({
      activeFilePath: selectedFilePath,
      viewMode,
      onRevealFile,
      explorerClickPathRef,
    });

    const filterState = useFilterState({
      viewMode,
      onClearSearch,
      onFilterSearch,
    });

    // ============================================
    // Display data (tree conversion + filtering)
    // ============================================
    const { displayData, hasActiveFilter } = useDisplayData({
      fileTree,
      viewMode,
      filterQuery: filterState.filterQuery,
      searchResults,
      searchLoading,
      repoPath,
    });
    const hasVisibleFileTreeItems = displayData.length > 0;

    // ============================================
    // Simple callbacks
    // ============================================
    const handleBackToFiles = useCallback(() => {
      handleTabChange("files");
    }, [handleTabChange]);

    const handleToggleSearchFilters = useCallback(() => {
      setShowSearchFilters((prev) => !prev);
    }, []);

    const handleSearchCollapseAll = useCallback(() => {
      searchPanelRef.current?.collapseAll();
    }, []);

    const handleToggleTestingFilter = useCallback(() => {
      setShowTestingFilter((prev) => !prev);
    }, []);

    // Target directory for new file/folder
    const getTargetDirectory = useTargetDirectory({
      repoPath,
      effectiveSelectedPath,
      selectedFolderPath,
      fileTree,
    });

    const handleAddFile = useCallback(() => {
      const targetDir = getTargetDirectory();
      if (targetDir) fileTreeRef.current?.startCreatingNew(targetDir, false);
    }, [getTargetDirectory]);

    const handleAddFolder = useCallback(() => {
      const targetDir = getTargetDirectory();
      if (targetDir) fileTreeRef.current?.startCreatingNew(targetDir, true);
    }, [getTargetDirectory]);

    // Search result click
    const handleSearchResultClick = useCallback(
      (filePath: string, line: number) => {
        if (onFileSelectWithLine) {
          onFileSelectWithLine(filePath, line);
        } else {
          onFileSelect(filePath);
        }
      },
      [onFileSelect, onFileSelectWithLine]
    );

    // ============================================
    // Action buttons
    // ============================================
    const { filesActions, searchActions } = useExplorerActions({
      showFilterFiles: filterState.showFilterFiles,
      onToggleFilterFiles: filterState.handleToggleFilterFiles,
      onRefresh,
      filesRefreshLoading: loading,
      onCollapseAll: hasVisibleFileTreeItems ? onCollapseAll : undefined,
      onAddFile: handleAddFile,
      onAddFolder: handleAddFolder,
      showSearchFilters,
      onToggleSearchFilters: handleToggleSearchFilters,
      onSearchCollapseAll: handleSearchCollapseAll,
      onOpenSearchTab: handleOpenSearchTab,
    });
    // ============================================
    // Text
    // ============================================
    const filterPlaceholder = t(HUMANTOOLS_TEXT_KEYS.placeholders.filterFiles);
    const emptyMessage =
      viewMode === "search"
        ? t(HUMANTOOLS_TEXT_KEYS.placeholders.noResults)
        : t(HUMANTOOLS_TEXT_KEYS.placeholders.noFilesFound);
    const noResultsMessage = hasActiveFilter
      ? t(HUMANTOOLS_TEXT_KEYS.placeholders.noFilesMatchingFilter, {
          query: filterState.filterQuery,
        })
      : emptyMessage;

    // ============================================
    // Memoized content
    // ============================================
    const fileTreeContent = useMemo(
      () => (
        <FileTreeContent
          ref={fileTreeRef}
          treeData={displayData}
          selectedPath={effectiveSelectedPath}
          repoPath={repoPath}
          onSelectNode={handleSelectNode}
          onToggleDirectory={onDirectoryToggle}
          filterQuery={filterState.filterQuery}
          onFilterChange={filterState.handleFilterChange}
          filterPlaceholder={filterPlaceholder}
          showFilter={viewMode === "files" ? filterState.showFilterFiles : true}
          loading={loading || searchLoading}
          error={error}
          emptyMessage={emptyMessage}
          noResultsMessage={noResultsMessage}
          revealPath={revealRequest?.path ?? null}
          revealKey={revealRequest?.timestamp ?? null}
          isMultiRoot={isMultiRoot}
        />
      ),
      [
        displayData,
        effectiveSelectedPath,
        repoPath,
        handleSelectNode,
        onDirectoryToggle,
        filterState.filterQuery,
        filterState.handleFilterChange,
        filterPlaceholder,
        viewMode,
        filterState.showFilterFiles,
        loading,
        searchLoading,
        error,
        emptyMessage,
        noResultsMessage,
        revealRequest,
        isMultiRoot,
      ]
    );

    const testingPanelContent = useMemo(
      () => (
        <TestingContent
          repoPath={repoPath}
          onFileClick={onFileSelect}
          isActive={viewMode === "testing"}
          showFilter={showTestingFilter}
        />
      ),
      [repoPath, onFileSelect, viewMode, showTestingFilter]
    );

    // ============================================
    // Tab configs
    // ============================================
    const filesTab = useFilesTabConfig({
      repoName,
      fileTreeContent,
      onSymbolClick,
      loading,
      selectedCommitSha,
      repoId,
      repoPath,
      onTimelineCommitClick,
      filesActions,
    });

    const searchTab = useSearchTabConfig({
      repoPath,
      onResultClick: handleSearchResultClick,
      showFilters: showSearchFilters,
      searchPanelRef,
      actions: searchActions,
      onBack: handleBackToFiles,
      onOpenInTab: handleOpenSearchTab,
    });

    const testingTab = useTestingTabConfig({
      testingPanelContent,
      repoPath,
      isActive: viewMode === "testing",
      showFilter: showTestingFilter,
      onBack: handleBackToFiles,
      onToggleFilter: handleToggleTestingFilter,
    });

    const allTabs = useMemo(
      () => [filesTab, searchTab, testingTab],
      [filesTab, searchTab, testingTab]
    );

    return (
      <PrimarySidebarLayoutWithSections
        tabs={allTabs}
        activeTab={viewMode}
        onTabChange={handleTabChange}
        tabIconOnly={iconOnly}
        hideTabs
      />
    );
  }
);

EditorPrimarySidebar.displayName = "EditorPrimarySidebar";

export default EditorPrimarySidebar;

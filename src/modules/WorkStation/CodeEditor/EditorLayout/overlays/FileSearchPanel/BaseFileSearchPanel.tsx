/**
 * BaseFileSearchPanel Component
 *
 * Shared base component for file search panels with fuzzy matching.
 * Features keyboard navigation and quick file selection.
 * (This is a file picker like Ctrl+P, not a code search panel)
 *
 * Used by:
 * - FileSearchPanel (sidebar variant)
 * - SingleFileSearchPanel (with spinner and close button)
 */
import React, { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";

import FolderIcon from "@src/assets/fileTypeIcons/folder-base.svg";
import FileTypeIcon from "@src/components/FileTypeIcon";
import { Placeholder } from "@src/components/Placeholder";
import { SPINNER_TOKENS } from "@src/config/spinnerTokens";
import { useListNavigation } from "@src/hooks/keyboard/useListNavigation";
import { Cancel01Icon, HugeiconsIcon, Loading03Icon } from "@src/icons";
import type { FileSearchResult } from "@src/modules/WorkStation/CodeEditor/hooks/useCodeEditor";

import { SearchInput } from "../../../Panels/shared";

const FILE_SEARCH_ROW_HEIGHT = 57;
const FILE_SEARCH_MAX_HEIGHT = 400;

// ============================================
// Types
// ============================================

export interface FileSearchPanelProps {
  /** Whether the panel is visible */
  visible: boolean;
  /** Search query */
  searchQuery: string;
  /** Search results */
  searchResults: FileSearchResult[];
  /** Loading state */
  loading: boolean;
  /** Repository path (for relative paths) */
  repoPath: string;
  /** Callback when search query changes */
  onSearchChange: (query: string) => void;
  /** Callback when a file is selected */
  onFileSelect: (path: string) => void;
  /** Callback to close the panel */
  onClose: () => void;
}

export interface BaseFileSearchPanelProps extends FileSearchPanelProps {
  /** Show loading spinner in header */
  showLoadingSpinner?: boolean;
  /** Show explicit close button in header */
  showCloseButton?: boolean;
  /** SearchInput variant */
  searchInputVariant?: "panel" | "sidebar";
}

// ============================================
// Helper Functions
// ============================================

/**
 * Get relative path from repo root
 */
function getRelativePath(filePath: string, repoPath: string): string {
  if (!filePath || !repoPath) return filePath;

  const normalizedFile = filePath.replace(/\\/g, "/");
  const normalizedRepo = repoPath.replace(/\\/g, "/");

  if (normalizedFile.startsWith(normalizedRepo)) {
    return normalizedFile.slice(normalizedRepo.length).replace(/^\//, "");
  }

  return filePath;
}

/**
 * Get directory path from full path
 */
function getDirectoryPath(filePath: string): string {
  const parts = filePath.split("/");
  parts.pop(); // Remove filename
  return parts.join("/") || "/";
}

// ============================================
// Main Component
// ============================================

export const BaseFileSearchPanel: React.FC<BaseFileSearchPanelProps> = memo(
  ({
    visible,
    searchQuery,
    searchResults,
    loading,
    repoPath,
    onSearchChange,
    onFileSelect,
    onClose,
    // Configurable options
    showLoadingSpinner = false,
    showCloseButton = false,
    searchInputVariant = "panel",
  }) => {
    const { t } = useTranslation();
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [prevResultsLength, setPrevResultsLength] = useState(
      searchResults.length
    );
    const inputRef = React.useRef<HTMLInputElement>(null);
    const virtuosoRef = React.useRef<VirtuosoHandle>(null);

    // Reset selectedIndex when results change (getDerivedStateFromProps pattern)
    if (prevResultsLength !== searchResults.length) {
      setPrevResultsLength(searchResults.length);
      setSelectedIndex(0);
    }

    // Clamp selected index to valid range
    const currentSelectedIndex = Math.min(
      selectedIndex,
      Math.max(0, searchResults.length - 1)
    );

    // Handle result click
    const handleResultClick = useCallback(
      (result: FileSearchResult) => {
        if (result.type === "file") {
          onFileSelect(result.path);
          onClose();
        }
      },
      [onFileSelect, onClose]
    );

    // Convert results to ListItem format for useListNavigation
    const listItems = useMemo(() => {
      if (!visible) return [];
      return searchResults.map((result) => ({
        ...result,
        // Only file items are selectable
        _isFile: result.type === "file",
      }));
    }, [searchResults, visible]);

    // Use unified list navigation hook
    const { handleKeyDown: _handleKeyDown } = useListNavigation({
      items: listItems,
      selectedIndex: currentSelectedIndex,
      onSelectedIndexChange: setSelectedIndex,
      onSelect: (item) => {
        if (item._isFile) {
          onFileSelect(item.path as string);
          onClose();
        }
      },
      onClose,
      isItemSelectable: (item) => item._isFile === true,
      // Virtual rows outside the viewport do not have DOM nodes for the
      // generic querySelector-based auto-scroll. Drive Virtuoso directly.
      enableAutoScroll: false,
      enableGlobalListener: visible,
      inputRef,
    });

    useEffect(() => {
      if (!visible) return;
      if (currentSelectedIndex < 0) return;
      virtuosoRef.current?.scrollIntoView({
        index: currentSelectedIndex,
        behavior: "auto",
      });
    }, [currentSelectedIndex, visible]);

    // Focus input when panel opens
    useEffect(() => {
      if (visible && inputRef.current) {
        inputRef.current.focus();
      }
    }, [visible]);

    if (!visible) return null;

    // Determine if we need the complex header layout (with spinner/close button)
    const needsComplexHeader = showLoadingSpinner || showCloseButton;

    return (
      <>
        {/* Backdrop */}
        <div className="fixed inset-0 z-40 bg-black/30" onClick={onClose} />

        {/* Search panel */}
        <div className="fixed top-[15%] left-1/2 z-50 w-[600px] max-w-[90vw] -translate-x-1/2 rounded-lg border border-border-2 bg-bg-2 shadow-xl">
          {/* Search input header */}
          {needsComplexHeader ? (
            <div className="flex items-center border-b border-border-2 pr-2">
              <div className="flex-1">
                <SearchInput
                  variant={searchInputVariant}
                  value={searchQuery}
                  onChange={onSearchChange}
                  placeholder={t("placeholders.searchFiles")}
                  inputRef={inputRef}
                />
              </div>
              {showLoadingSpinner && loading && (
                <div className="px-2">
                  <HugeiconsIcon
                    icon={Loading03Icon}
                    data-icon="loader-2"
                    size={SPINNER_TOKENS.default}
                    className="animate-spin text-text-3"
                  />
                </div>
              )}
              {showCloseButton && (
                <button
                  onClick={onClose}
                  className="flex items-center justify-center rounded p-1 text-text-3 transition-colors hover:bg-fill-3"
                  title={t("tooltips.closeEsc")}
                >
                  <HugeiconsIcon icon={Cancel01Icon} data-icon="x" size={14} />
                </button>
              )}
            </div>
          ) : (
            <div className="border-b border-border-2">
              <SearchInput
                variant={searchInputVariant}
                value={searchQuery}
                onChange={onSearchChange}
                placeholder={t("placeholders.searchFiles")}
                inputRef={inputRef}
                onClose={onClose}
              />
            </div>
          )}

          {/* Results list */}
          <div className="max-h-[400px] overflow-hidden">
            {searchResults.length > 0 ? (
              <Virtuoso
                ref={virtuosoRef}
                className="scrollbar-hide"
                style={{
                  height: Math.min(
                    FILE_SEARCH_MAX_HEIGHT,
                    searchResults.length * FILE_SEARCH_ROW_HEIGHT
                  ),
                }}
                data={searchResults}
                computeItemKey={(_index, result) => result.path}
                fixedItemHeight={FILE_SEARCH_ROW_HEIGHT}
                overscan={FILE_SEARCH_ROW_HEIGHT * 6}
                itemContent={(index, result) => {
                  const isSelected = index === currentSelectedIndex;
                  const relativePath = getRelativePath(result.path, repoPath);
                  const directory = getDirectoryPath(relativePath);

                  return (
                    <div
                      data-spotlight-item-index={index}
                      className={`flex h-[57px] cursor-pointer items-center gap-3 border-b border-border-2 px-4 transition-colors ${
                        isSelected ? "bg-fill-1" : "hover:bg-fill-3"
                      }`}
                      onClick={() => handleResultClick(result)}
                      onMouseEnter={() => setSelectedIndex(index)}
                      onMouseLeave={() => setSelectedIndex(-1)}
                    >
                      {result.type === "folder" ? (
                        <FolderIcon
                          width={16}
                          height={16}
                          className="shrink-0"
                        />
                      ) : (
                        <FileTypeIcon
                          fileName={result.filename}
                          size="medium"
                          className="shrink-0"
                        />
                      )}

                      <div className="min-w-0 flex-1">
                        <div
                          className={`truncate text-[13px] ${
                            isSelected
                              ? "font-medium text-text-1"
                              : "text-text-2"
                          }`}
                          title={result.filename}
                        >
                          {result.filename}
                        </div>
                        <div
                          className="truncate text-[11px] text-text-4"
                          title={directory}
                        >
                          {directory}
                        </div>
                      </div>
                    </div>
                  );
                }}
              />
            ) : searchQuery.trim() && !loading ? (
              <Placeholder
                variant="no-results"
                title={t("placeholders.noFilesFound")}
              />
            ) : !searchQuery.trim() ? (
              <Placeholder
                variant="empty"
                title={t("placeholders.typeToSearchFiles")}
              />
            ) : null}
          </div>
        </div>
      </>
    );
  }
);

BaseFileSearchPanel.displayName = "BaseFileSearchPanel";

export default BaseFileSearchPanel;

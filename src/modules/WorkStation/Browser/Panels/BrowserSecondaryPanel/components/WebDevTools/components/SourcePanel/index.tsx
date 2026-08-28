/**
 * SourcePanel - Display source location information for selected element
 *
 * Shows:
 * - Component name
 * - Definition location (from AST-based component index)
 * - Usage locations
 * - "Find Component" button when index lookup fails
 */
import React, { memo, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { Placeholder } from "@src/components/Placeholder";
import { SPINNER_TOKENS } from "@src/config/spinnerTokens";
import { createLogger } from "@src/hooks/logger";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  FileScriptIcon,
  HugeiconsIcon,
  Layers01Icon,
  Loading03Icon,
  Search01Icon,
  SquareArrowUpRightIcon,
} from "@src/icons";
import type { ComponentSearchResult } from "@src/modules/WorkStation/Browser/hooks/useSourceNavigation";
import type { SourceLocation } from "@src/modules/WorkStation/Browser/hooks/useWebviewInspector";
import { HEADER_BUTTON } from "@src/modules/WorkStation/shared/tokens";

import { CollapsibleSection } from "../DesignPanel/CollapsibleSection";

const log = createLogger("SourcePanel");

// ============================================
// Types
// ============================================

export interface SourcePanelProps {
  /** Source location info (null if not detected) */
  sourceLocation: SourceLocation | null;
  /** Callback to open a file at a specific line */
  onOpenFile?: (path: string, line?: number) => Promise<boolean>;
  /** Callback to search for component files (returns path + optional line) */
  onSearchComponent?: (
    sourceLocation: SourceLocation
  ) => Promise<ComponentSearchResult[]>;
  /** Whether component search is available */
  canSearchComponent?: boolean;
  /** Component definition location */
  definition?: { path: string; line?: number } | null;
  /** Component usage locations */
  usages?: Array<{ path: string; line?: number }>;
  /** Whether the lookup is still loading */
  isLoading?: boolean;
  /** Callback to build the component index */
  onBuildIndex?: () => void;
  /** Whether the component index is built */
  isIndexBuilt?: boolean;
  /** Force all sections to collapse (increments to trigger) */
  collapseAllKey?: number;
  /** Force all sections to expand (increments to trigger) */
  expandAllKey?: number;
}

// ============================================
// Helper Functions
// ============================================

function getFilenameFromPath(filepath: string): string {
  const parts = filepath.split("/");
  return parts[parts.length - 1] || filepath;
}

function getRelativePath(filepath: string): string {
  // Try to extract a reasonable relative path
  const srcIndex = filepath.lastIndexOf("/src/");
  if (srcIndex !== -1) {
    return filepath.substring(srcIndex + 1);
  }
  const parts = filepath.split("/");
  // Return last 3 parts
  return parts.slice(-3).join("/");
}

// ============================================
// Main Component
// ============================================

export const SourcePanel: React.FC<SourcePanelProps> = memo(
  ({
    sourceLocation,
    onOpenFile,
    onSearchComponent,
    canSearchComponent = false,
    definition,
    usages = [],
    isLoading = false,
    onBuildIndex,
    isIndexBuilt = false,
    collapseAllKey,
    expandAllKey,
  }) => {
    const { t } = useTranslation();
    const [searchResults, setSearchResults] = useState<ComponentSearchResult[]>(
      []
    );
    const [isSearching, setIsSearching] = useState(false);
    const [hasSearched, setHasSearched] = useState(false);
    const [showAllUsages, setShowAllUsages] = useState(false);

    const handleSearchComponent = useCallback(async () => {
      if (!sourceLocation || !onSearchComponent) return;

      setIsSearching(true);
      setHasSearched(true);
      try {
        const results = await onSearchComponent(sourceLocation);
        setSearchResults(results);
      } catch (error) {
        log.error("[SourcePanel] Search failed:", error);
        setSearchResults([]);
      } finally {
        setIsSearching(false);
      }
    }, [sourceLocation, onSearchComponent]);

    const handleOpenSearchResult = useCallback(
      (result: ComponentSearchResult) => {
        if (onOpenFile) {
          onOpenFile(result.path, result.line || 1);
        }
      },
      [onOpenFile]
    );

    // Reset search and usages view when source location changes
    React.useEffect(() => {
      setSearchResults([]);
      setHasSearched(false);
      setShowAllUsages(false);
    }, [sourceLocation?.componentName]);

    // Handler for opening a file at a specific line
    const handleOpenFile = useCallback(
      (path: string, line?: number) => {
        if (onOpenFile) {
          onOpenFile(path, line);
        }
      },
      [onOpenFile]
    );

    // No source detected
    if (!sourceLocation) {
      return (
        <Placeholder
          variant="empty"
          title={
            isIndexBuilt
              ? t("placeholders.noSourceDetected")
              : t("placeholders.notIndexed")
          }
          subtitle={
            isIndexBuilt
              ? t("placeholders.indexedInspectElement")
              : t("placeholders.buildIndexToStart")
          }
          action={
            onBuildIndex ? { label: "Index", onClick: onBuildIndex } : undefined
          }
        />
      );
    }

    // Check if we have a definition (either from index or need to search)
    const hasDefinition = !!definition;

    return (
      <div className="flex h-full flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto px-3 py-2 scrollbar-hide">
          {/* Component Name Section */}
          {sourceLocation.componentName && (
            <CollapsibleSection
              title={t("workstation.componentLabel")}
              collapseAllKey={collapseAllKey}
              expandAllKey={expandAllKey}
            >
              <div className="flex items-center gap-1.5 rounded px-3 py-1.5 text-[11px]">
                <HugeiconsIcon
                  icon={Layers01Icon}
                  data-icon="layers"
                  size={12}
                  className="shrink-0 text-primary-6"
                />
                <span className="font-medium text-primary-6">
                  &lt;{sourceLocation.componentName}&gt;
                </span>
              </div>
            </CollapsibleSection>
          )}

          {/* Loading indicator for index lookup */}
          {isLoading && (
            <span className="mb-3 flex items-center gap-2 text-[11px] text-text-3">
              <HugeiconsIcon
                icon={Loading03Icon}
                data-icon="loader-2"
                size={SPINNER_TOKENS.small}
                className="animate-spin"
              />
              Looking up component...
            </span>
          )}

          {/* Definition Section (from component index) */}
          {definition && (
            <CollapsibleSection
              title={t("workstation.definitionLabel")}
              collapseAllKey={collapseAllKey}
              expandAllKey={expandAllKey}
            >
              <div
                className="flex cursor-pointer items-start gap-2 rounded px-3 py-1.5 hover:bg-fill-1"
                onClick={() => handleOpenFile(definition.path, definition.line)}
              >
                <HugeiconsIcon
                  icon={FileScriptIcon}
                  data-icon="file-code"
                  size={14}
                  className="mt-0.5 shrink-0 text-success-6"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[11px] font-medium text-text-1">
                    {getFilenameFromPath(definition.path)}
                    {definition.line && (
                      <span className="text-text-3">:{definition.line}</span>
                    )}
                  </div>
                  <div
                    className="truncate text-[10px] text-text-3"
                    title={definition.path}
                  >
                    {getRelativePath(definition.path)}
                  </div>
                </div>
                <HugeiconsIcon
                  icon={SquareArrowUpRightIcon}
                  data-icon="square-arrow-out-up-right"
                  size={10}
                  className="mt-1 shrink-0 text-text-3"
                />
              </div>
            </CollapsibleSection>
          )}

          {/* Usages Section (from component index) */}
          {usages.length > 0 && (
            <CollapsibleSection
              title={`Usages (${usages.length})`}
              collapseAllKey={collapseAllKey}
              expandAllKey={expandAllKey}
              headerActions={
                usages.length > 3 && (
                  <button
                    onClick={() => setShowAllUsages(!showAllUsages)}
                    className={HEADER_BUTTON.action}
                    title={showAllUsages ? "Show less" : "Show all"}
                  >
                    {showAllUsages ? (
                      <HugeiconsIcon
                        icon={ArrowDown01Icon}
                        data-icon="chevron-down"
                        size={12}
                      />
                    ) : (
                      <HugeiconsIcon
                        icon={ArrowRight01Icon}
                        data-icon="chevron-right"
                        size={12}
                      />
                    )}
                  </button>
                )
              }
            >
              <div className="overflow-hidden rounded">
                {(showAllUsages ? usages : usages.slice(0, 3)).map(
                  (usage, index) => (
                    <div
                      key={index}
                      className="flex cursor-pointer items-start gap-2 border-b border-border-1 px-3 py-1.5 last:border-b-0 hover:bg-fill-1"
                      onClick={() => handleOpenFile(usage.path, usage.line)}
                    >
                      <HugeiconsIcon
                        icon={FileScriptIcon}
                        data-icon="file-code"
                        size={14}
                        className="mt-0.5 shrink-0 text-warning-6"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[11px] font-medium text-text-1">
                          {getFilenameFromPath(usage.path)}
                          {usage.line && (
                            <span className="text-text-3">:{usage.line}</span>
                          )}
                        </div>
                        <div
                          className="truncate text-[10px] text-text-3"
                          title={usage.path}
                        >
                          {getRelativePath(usage.path)}
                        </div>
                      </div>
                      <HugeiconsIcon
                        icon={SquareArrowUpRightIcon}
                        data-icon="square-arrow-out-up-right"
                        size={10}
                        className="mt-1 shrink-0 text-text-3"
                      />
                    </div>
                  )
                )}
              </div>
            </CollapsibleSection>
          )}

          {/* Search for Component (when no definition found) */}
          {!hasDefinition &&
            (sourceLocation.componentName || sourceLocation.searchHint) && (
              <CollapsibleSection
                title={t("workstation.findSource")}
                collapseAllKey={collapseAllKey}
                expandAllKey={expandAllKey}
              >
                <div className="overflow-hidden rounded">
                  <div className="p-2 text-[10px] leading-relaxed text-text-3">
                    Source file path not available. Use search to find the
                    component file in your project.
                  </div>

                  {/* Search Button */}
                  {onSearchComponent && canSearchComponent && (
                    <Button
                      variant="tertiary"
                      size="small"
                      icon={
                        <HugeiconsIcon
                          icon={Search01Icon}
                          data-icon="search"
                          size={12}
                          className={isSearching ? "animate-pulse" : ""}
                        />
                      }
                      onClick={handleSearchComponent}
                      disabled={isSearching}
                      loading={isSearching}
                      long
                      className="border-t border-border-1 bg-primary-6/10 text-primary-6 hover:bg-primary-6/20"
                    >
                      {isSearching
                        ? "Searching..."
                        : `Find "${sourceLocation.searchHint || sourceLocation.componentName}"`}
                    </Button>
                  )}

                  {/* Search Results */}
                  {hasSearched && searchResults.length > 0 && (
                    <div className="border-t border-border-1">
                      <div className="px-3 py-1 text-[10px] font-medium text-text-3">
                        Found {searchResults.length} file(s):
                      </div>
                      {searchResults.map((result, index) => (
                        <Button
                          key={index}
                          variant="tertiary"
                          size="small"
                          onClick={() => handleOpenSearchResult(result)}
                          long
                          className="justify-start border-t border-border-1 px-3 py-1.5 text-left"
                        >
                          <HugeiconsIcon
                            icon={FileScriptIcon}
                            data-icon="file-code"
                            size={12}
                            className="shrink-0 text-warning-6"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[11px] font-medium text-text-1">
                              {getFilenameFromPath(result.path)}
                              {result.line && (
                                <span className="ml-1 text-success-6">
                                  :{result.line}
                                </span>
                              )}
                            </div>
                            <div className="truncate text-[10px] text-text-3">
                              {getRelativePath(result.path)}
                            </div>
                          </div>
                          <HugeiconsIcon
                            icon={SquareArrowUpRightIcon}
                            data-icon="square-arrow-out-up-right"
                            size={10}
                            className="shrink-0 text-text-3"
                          />
                        </Button>
                      ))}
                    </div>
                  )}

                  {/* No Results */}
                  {hasSearched &&
                    searchResults.length === 0 &&
                    !isSearching && (
                      <Placeholder
                        variant="no-results"
                        title={t("placeholders.noMatchingFilesFound")}
                      />
                    )}
                </div>
              </CollapsibleSection>
            )}
        </div>
      </div>
    );
  }
);

SourcePanel.displayName = "SourcePanel";

export default SourcePanel;

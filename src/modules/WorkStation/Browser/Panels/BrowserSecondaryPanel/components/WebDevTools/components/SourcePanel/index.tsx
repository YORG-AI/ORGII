/**
 * SourcePanel - Display source metadata for the selected element.
 *
 * Direct framework/debug metadata is shown immediately. When only a component
 * name is available, users can run the bounded filename/content search.
 */
import React, { memo, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { Placeholder } from "@src/components/Placeholder";
import { createLogger } from "@src/hooks/logger";
import {
  FileScriptIcon,
  HugeiconsIcon,
  Layers01Icon,
  Search01Icon,
  SquareArrowUpRight02Icon,
} from "@src/icons";
import type { ComponentSearchResult } from "@src/modules/WorkStation/Browser/hooks/useSourceNavigation";
import type { SourceLocation } from "@src/modules/WorkStation/Browser/hooks/useWebviewInspector";

import { CollapsibleSection } from "../DesignPanel/CollapsibleSection";

const log = createLogger("SourcePanel");

interface SourcePanelProps {
  sourceLocation: SourceLocation | null;
  onOpenFile?: (path: string, line?: number) => Promise<boolean>;
  onSearchComponent?: (
    sourceLocation: SourceLocation
  ) => Promise<ComponentSearchResult[]>;
  canSearchComponent?: boolean;
  collapseAllKey?: number;
  expandAllKey?: number;
}

function getFilenameFromPath(filepath: string): string {
  const parts = filepath.split("/");
  return parts[parts.length - 1] || filepath;
}

function getRelativePath(filepath: string): string {
  const srcIndex = filepath.lastIndexOf("/src/");
  if (srcIndex !== -1) {
    return filepath.substring(srcIndex + 1);
  }
  return filepath.split("/").slice(-3).join("/");
}

export const SourcePanel: React.FC<SourcePanelProps> = memo(
  ({
    sourceLocation,
    onOpenFile,
    onSearchComponent,
    canSearchComponent = false,
    collapseAllKey,
    expandAllKey,
  }) => {
    const { t } = useTranslation();
    const [searchResults, setSearchResults] = useState<ComponentSearchResult[]>(
      []
    );
    const [isSearching, setIsSearching] = useState(false);
    const [hasSearched, setHasSearched] = useState(false);

    const handleSearchComponent = useCallback(async () => {
      if (!sourceLocation || !onSearchComponent) return;

      setIsSearching(true);
      setHasSearched(true);
      try {
        setSearchResults(await onSearchComponent(sourceLocation));
      } catch (error) {
        log.error("[SourcePanel] Search failed:", error);
        setSearchResults([]);
      } finally {
        setIsSearching(false);
      }
    }, [sourceLocation, onSearchComponent]);

    const handleOpenFile = useCallback(
      (path: string, line?: number) => {
        void onOpenFile?.(path, line);
      },
      [onOpenFile]
    );

    if (!sourceLocation) {
      return (
        <Placeholder
          variant="empty"
          title={t("placeholders.noSourceDetected")}
        />
      );
    }

    const directSourcePath = sourceLocation.path;
    const canRunSearch =
      !directSourcePath &&
      canSearchComponent &&
      Boolean(sourceLocation.componentName || sourceLocation.searchHint);

    return (
      <div className="flex h-full flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto px-3 py-2 scrollbar-hide">
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

          {directSourcePath && (
            <CollapsibleSection
              title={t("workstation.definitionLabel")}
              collapseAllKey={collapseAllKey}
              expandAllKey={expandAllKey}
            >
              <Button
                variant="tertiary"
                size="small"
                onClick={() =>
                  handleOpenFile(directSourcePath, sourceLocation.line ?? 1)
                }
                long
                className="justify-start px-3 py-1.5 text-left"
              >
                <HugeiconsIcon
                  icon={FileScriptIcon}
                  data-icon="file-code"
                  size={14}
                  className="shrink-0 text-success-6"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[11px] font-medium text-text-1">
                    {getFilenameFromPath(directSourcePath)}
                    {sourceLocation.line && (
                      <span className="text-text-3">
                        :{sourceLocation.line}
                      </span>
                    )}
                  </div>
                  <div
                    className="truncate text-[10px] text-text-3"
                    title={directSourcePath}
                  >
                    {getRelativePath(directSourcePath)}
                  </div>
                </div>
                <HugeiconsIcon
                  icon={SquareArrowUpRight02Icon}
                  data-icon="square-arrow-out-up-right"
                  size={10}
                  className="shrink-0 text-text-3"
                />
              </Button>
            </CollapsibleSection>
          )}

          {canRunSearch && (
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
                {onSearchComponent && (
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

                {hasSearched && searchResults.length > 0 && (
                  <div className="border-t border-border-1">
                    <div className="px-3 py-1 text-[10px] font-medium text-text-3">
                      Found {searchResults.length} file(s):
                    </div>
                    {searchResults.map((result) => (
                      <Button
                        key={`${result.path}:${result.line ?? 1}`}
                        variant="tertiary"
                        size="small"
                        onClick={() =>
                          handleOpenFile(result.path, result.line ?? 1)
                        }
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
                          icon={SquareArrowUpRight02Icon}
                          data-icon="square-arrow-out-up-right"
                          size={10}
                          className="shrink-0 text-text-3"
                        />
                      </Button>
                    ))}
                  </div>
                )}

                {hasSearched && searchResults.length === 0 && !isSearching && (
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

/**
 * ContextMenu Section & Panel Components
 *
 * Higher-level panel components: recent files, search results,
 * and second layer panels (files, terminals, sessions, browser).
 */
import React, { memo, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import FolderIcon from "@src/assets/fileTypeIcons/folder-base.svg";
import DropdownHeader from "@src/components/Dropdown/DropdownHeader";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
} from "@src/components/Dropdown/tokens";
import FileTreePreview from "@src/components/FileTreePreview";
import FileTypeIcon from "@src/components/FileTypeIcon";
import { HugeiconsIcon } from "@src/icons";

import {
  ResultItemIcon,
  SearchLoadingOrEmpty,
  SecondLayerEmptyState,
} from "./ResultItems";
import {
  ICON_CONFIG,
  SECOND_LAYER_CONFIG,
  STYLE_CONFIG,
  getFileName,
} from "./config";
import type { RecentFile, SecondLayerId } from "./config";
import type { SearchResultItem } from "./types";

// ============================================
// Constants
// ============================================

/** Tree panel width (220px) + gap (8px ml-2) */
const TREE_PANEL_RESERVED = 228;

function normalizePathForDisplay(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
}

function getWorkspaceRelativeDisplayPath(item: SearchResultItem): string {
  const normalizedPath = normalizePathForDisplay(item.path);
  const normalizedRootPath = item.repoPath
    ? normalizePathForDisplay(item.repoPath)
    : undefined;
  const rootName =
    item.repoName ||
    (normalizedRootPath ? getFileName(normalizedRootPath) : undefined);

  if (!normalizedRootPath || !rootName) return normalizedPath;
  if (normalizedPath === normalizedRootPath) return rootName;

  const rootPrefix = `${normalizedRootPath}/`;
  if (!normalizedPath.startsWith(rootPrefix)) return normalizedPath;

  return `${rootName}/${normalizedPath.slice(rootPrefix.length)}`;
}

// ============================================
// Recent Files Section
// ============================================

interface RecentFilesSectionProps {
  files: RecentFile[];
  onSelect: (path: string) => void;
  activeIndex: number;
  baseIndex: number;
  onHover: (index: number) => void;
  onHoverEnd: () => void;
}

export const RecentFilesSection: React.FC<RecentFilesSectionProps> = memo(
  ({ files, onSelect, activeIndex, baseIndex, onHover, onHoverEnd }) => {
    const [expanded, setExpanded] = useState(false);
    if (files.length === 0) return null;

    const maxVisible = STYLE_CONFIG.recentSectionMaxItems;
    const visibleFiles = expanded ? files : files.slice(0, maxVisible);
    const hiddenCount = files.length - maxVisible;

    return (
      <div className={DROPDOWN_CLASSES.sectionContainer}>
        <div className={DROPDOWN_CLASSES.sectionLabel}>Recent</div>
        {visibleFiles.map((file, idx) => {
          const rowActive = activeIndex === baseIndex + idx;
          return (
            <div
              key={file.path}
              className={`${DROPDOWN_CLASSES.item} group cursor-pointer ${
                rowActive
                  ? DROPDOWN_CLASSES.itemActive
                  : DROPDOWN_CLASSES.itemHover
              }`}
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onSelect(file.path);
              }}
              onMouseEnter={() => onHover(baseIndex + idx)}
              onMouseLeave={onHoverEnd}
            >
              {file.type === "folder" ? (
                <FolderIcon
                  width={DROPDOWN_ITEM.iconSize}
                  height={DROPDOWN_ITEM.iconSize}
                  className="flex-shrink-0 text-text-2"
                />
              ) : (
                <FileTypeIcon
                  fileName={file.name}
                  size="small"
                  className="flex-shrink-0 text-text-2"
                />
              )}
              <span className="truncate text-[13px] text-text-1">
                {file.name}
              </span>
            </div>
          );
        })}
        {!expanded && hiddenCount > 0 && (
          <div
            className={`${DROPDOWN_CLASSES.item} cursor-pointer text-text-3 hover:text-text-2`}
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setExpanded(true);
            }}
          >
            <span className="text-[13px]">Show {hiddenCount} more</span>
          </div>
        )}
      </div>
    );
  }
);
RecentFilesSection.displayName = "RecentFilesSection";

// ============================================
// Result Item Row (shared by SearchResults & SecondLayer)
// ============================================

interface ResultItemRowProps {
  item: SearchResultItem;
  index: number;
  activeIndex: number;
  onSelect: (path: string) => void;
  onHover: (index: number) => void;
  onHoverEnd: () => void;
  itemRef: (el: HTMLDivElement | null) => void;
}

const ResultItemRow: React.FC<ResultItemRowProps> = memo(
  ({ item, index, activeIndex, onSelect, onHover, onHoverEnd, itemRef }) => {
    const displayName = item.name || getFileName(item.path);
    const displayPath = getWorkspaceRelativeDisplayPath(item);
    const showDisplayPath = item.iconType !== "session";
    const rowActive = activeIndex === index;
    return (
      <div
        ref={itemRef}
        className={`${DROPDOWN_CLASSES.item} group cursor-pointer ${
          rowActive ? DROPDOWN_CLASSES.itemActive : DROPDOWN_CLASSES.itemHover
        }`}
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onSelect(item.path);
        }}
        onMouseEnter={() => onHover(index)}
        onMouseLeave={onHoverEnd}
      >
        <ResultItemIcon item={item} displayName={displayName} />
        <span className="min-w-0 shrink-0 truncate text-[13px] text-text-1">
          {displayName}
        </span>
        {showDisplayPath && (
          <span className="min-w-0 flex-1 truncate text-right text-[12px] text-text-3">
            {displayPath}
          </span>
        )}
      </div>
    );
  }
);
ResultItemRow.displayName = "ResultItemRow";

// ============================================
// Tree Preview (shared positioning logic)
// ============================================

interface TreePreviewProps {
  item: SearchResultItem;
  repoPath?: string;
  treePosition: "left" | "right";
  position: "absolute" | "inline";
}

const TreePreview: React.FC<TreePreviewProps> = memo(
  ({ item, repoPath, treePosition, position }) => {
    if (position === "absolute") {
      return (
        <div
          className={`absolute top-0 ${treePosition === "left" ? "right-full mr-2" : "left-full ml-2"}`}
          style={{ pointerEvents: "auto" }}
        >
          <FileTreePreview
            path={item.path}
            itemType={item.type}
            repoPath={item.repoPath ?? repoPath}
          />
        </div>
      );
    }
    return (
      <div className="flex-shrink-0">
        <FileTreePreview
          path={item.path}
          itemType={item.type}
          repoPath={item.repoPath ?? repoPath}
          width={`${TREE_PANEL_RESERVED - 8}px`}
        />
      </div>
    );
  }
);
TreePreview.displayName = "TreePreview";

// ============================================
// Search Results Panel
// ============================================

export interface SearchResultsPanelProps {
  searchQuery: string;
  results: SearchResultItem[];
  loading: boolean;
  activeIndex: number;
  onSelect: (path: string) => void;
  onHover: (index: number) => void;
  onHoverEnd: () => void;
  repoPath?: string;
  treePosition?: "left" | "right";
}

export const SearchResultsPanel: React.FC<SearchResultsPanelProps> = memo(
  ({
    searchQuery,
    results,
    loading,
    activeIndex,
    onSelect,
    onHover,
    onHoverEnd,
    repoPath,
    treePosition = "right",
  }) => {
    const activeItem = results[activeIndex];
    const showTreePanel = results.length > 0 && activeItem;
    const itemRefs = useRef<(HTMLDivElement | null)[]>([]);

    useEffect(() => {
      if (itemRefs.current[activeIndex]) {
        itemRefs.current[activeIndex]?.scrollIntoView({
          block: "nearest",
          behavior: "smooth",
        });
      }
    }, [activeIndex]);

    return (
      <div className="relative">
        {showTreePanel && (
          <TreePreview
            item={activeItem}
            repoPath={repoPath}
            treePosition={treePosition}
            position="absolute"
          />
        )}

        <div
          className={`relative ${DROPDOWN_CLASSES.panel}`}
          style={{ width: "100%" }}
        >
          <div
            className={DROPDOWN_CLASSES.optionsContainer}
            style={{ maxHeight: STYLE_CONFIG.maxHeight }}
          >
            {results.length === 0 && !loading ? (
              <SearchLoadingOrEmpty searchQuery={searchQuery} loading={false} />
            ) : (
              results.map((item, idx) => (
                <ResultItemRow
                  key={item.path}
                  item={item}
                  index={idx}
                  activeIndex={activeIndex}
                  onSelect={onSelect}
                  onHover={onHover}
                  onHoverEnd={onHoverEnd}
                  itemRef={(el) => {
                    itemRefs.current[idx] = el;
                  }}
                />
              ))
            )}
          </div>
        </div>
      </div>
    );
  }
);
SearchResultsPanel.displayName = "SearchResultsPanel";

// ============================================
// Second Layer Panel
// ============================================

export interface SecondLayerPanelProps {
  layerId: SecondLayerId;
  results: SearchResultItem[];
  loading: boolean;
  activeIndex: number;
  onSelect: (path: string) => void;
  onHover: (index: number) => void;
  onHoverEnd: () => void;
  onBack: () => void;
  repoPath?: string;
  treePosition?: "left" | "right";
  /** Override the default layer title (used for drill-down breadcrumb) */
  titleOverride?: string;
  /** Recent files to show at the top when layerId === "files" */
  recentFiles?: RecentFile[];
}

export const SecondLayerPanel: React.FC<SecondLayerPanelProps> = memo(
  ({
    layerId,
    results,
    loading,
    activeIndex,
    onSelect,
    onHover,
    onHoverEnd,
    onBack,
    repoPath,
    treePosition = "right",
    titleOverride,
    recentFiles = [],
  }) => {
    const { t } = useTranslation("sessions");
    const [recentExpanded, setRecentExpanded] = useState(false);
    const config = SECOND_LAYER_CONFIG[layerId];
    const activeItem = results[activeIndex];
    const showTreePanel =
      layerId === "files" && results.length > 0 && activeItem;
    const itemRefs = useRef<(HTMLDivElement | null)[]>([]);

    useEffect(() => {
      if (itemRefs.current[activeIndex]) {
        itemRefs.current[activeIndex]?.scrollIntoView({
          block: "nearest",
          behavior: "smooth",
        });
      }
    }, [activeIndex]);

    return (
      <div className="relative">
        {showTreePanel && (
          <TreePreview
            item={activeItem}
            repoPath={repoPath}
            treePosition={treePosition}
            position="absolute"
          />
        )}

        <div
          className={`relative ${DROPDOWN_CLASSES.panel}`}
          style={{ width: "100%" }}
        >
          {/* Header with back button */}
          <DropdownHeader>
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                onBack();
              }}
              className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-text-2 transition-colors hover:text-text-1 ${DROPDOWN_CLASSES.itemHover}`}
              aria-label={t("creator.contextMenu.back")}
            >
              <HugeiconsIcon
                icon={ICON_CONFIG.arrowBack}
                size={DROPDOWN_ITEM.iconSize}
                strokeWidth={1.75}
              />
            </button>
            <span className="flex min-h-5 min-w-0 flex-1 items-center truncate text-[13px] font-medium leading-5 text-text-1">
              {titleOverride ||
                t(config.translationKey, { defaultValue: config.title })}
            </span>
          </DropdownHeader>

          {/* Results */}
          <div
            className={DROPDOWN_CLASSES.optionsContainer}
            style={{ maxHeight: STYLE_CONFIG.maxHeight }}
          >
            {/* Recent files section — only shown in the files second layer */}
            {layerId === "files" && recentFiles.length > 0 && (
              <div className={DROPDOWN_CLASSES.sectionContainer}>
                <div className={DROPDOWN_CLASSES.sectionLabel}>
                  {t("creator.contextMenu.recent")}
                </div>
                {(recentExpanded
                  ? recentFiles
                  : recentFiles.slice(0, STYLE_CONFIG.recentSectionMaxItems)
                ).map((file) => (
                  <div
                    key={file.path}
                    className={`${DROPDOWN_CLASSES.item} group cursor-pointer ${DROPDOWN_CLASSES.itemHover}`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onSelect(file.path);
                    }}
                  >
                    {file.type === "folder" ? (
                      <FolderIcon
                        width={DROPDOWN_ITEM.iconSize}
                        height={DROPDOWN_ITEM.iconSize}
                        className="flex-shrink-0 text-text-2"
                      />
                    ) : (
                      <FileTypeIcon
                        fileName={file.name}
                        size="small"
                        className="flex-shrink-0 text-text-2"
                      />
                    )}
                    <span className="min-w-0 flex-1 truncate text-[13px] text-text-1">
                      {file.name}
                    </span>
                  </div>
                ))}
                {!recentExpanded &&
                  recentFiles.length > STYLE_CONFIG.recentSectionMaxItems && (
                    <div
                      className={`${DROPDOWN_CLASSES.item} cursor-pointer text-text-3 hover:text-text-2`}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setRecentExpanded(true);
                      }}
                    >
                      <span className="text-[13px]">
                        {t("creator.contextMenu.showMore", {
                          remaining:
                            recentFiles.length -
                            STYLE_CONFIG.recentSectionMaxItems,
                        })}
                      </span>
                    </div>
                  )}
              </div>
            )}

            {loading ? (
              <SearchLoadingOrEmpty searchQuery="" loading />
            ) : results.length === 0 && recentFiles.length === 0 ? (
              <SecondLayerEmptyState layerId={layerId} />
            ) : (
              results.map((item, idx) => (
                <ResultItemRow
                  key={item.path}
                  item={item}
                  index={idx}
                  activeIndex={activeIndex}
                  onSelect={onSelect}
                  onHover={onHover}
                  onHoverEnd={onHoverEnd}
                  itemRef={(el) => {
                    itemRefs.current[idx] = el;
                  }}
                />
              ))
            )}
          </div>
        </div>
      </div>
    );
  }
);
SecondLayerPanel.displayName = "SecondLayerPanel";

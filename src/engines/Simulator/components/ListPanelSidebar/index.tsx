/**
 * ListPanelSidebar Component
 *
 * Reusable left panel sidebar with Tab | Filter | List structure.
 * Matches the styling from git status page exactly.
 *
 * Also exports ListPanelContent - the tab-free body (filter + list)
 * for use inside other containers like PrimarySidebarLayoutWithSections.
 *
 * PERFORMANCE: Uses virtualization for lists > 50 items
 */
import { Circle, Search } from "lucide-react";
import React, { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Virtuoso } from "react-virtuoso";

import Checkbox from "@src/components/Checkbox";
import FileTypeIcon from "@src/components/FileTypeIcon";
import Input from "@src/components/Input";
import { Placeholder } from "@src/components/Placeholder";
import TabPill from "@src/components/TabPill";
// ============================================
// Status Badge Helpers
// ============================================
import { type GitFileStatus } from "@src/config/gitStatus";
import { SURFACE_TOKENS } from "@src/config/surfaceTokens";
import { AGENT_DOT_TOKENS } from "@src/engines/Simulator/config";

import type {
  ListPanelContentProps,
  ListPanelItem,
  ListPanelSidebarProps,
} from "./types";

type ItemStatus = GitFileStatus | "untracked";

// Use centralized config for VSCode-style consistency
const STATUS_CONFIG: Record<ItemStatus, { label: string; colorClass: string }> =
  {
    modified: { label: "M", colorClass: "text-warning-6" },
    added: { label: "U", colorClass: "text-success-6" },
    deleted: { label: "D", colorClass: "text-danger-6" },
    renamed: { label: "R", colorClass: "text-success-6" },
    conflict: { label: "C", colorClass: "text-danger-6" },
    untracked: { label: "U", colorClass: "text-success-6" },
    ignored: { label: "I", colorClass: "text-text-4" },
  };

/** Get status badge info from item */
function getStatusBadge(item: ListPanelItem): {
  label: string;
  colorClass: string;
} | null {
  // Use explicit statusBadge if provided
  if (item.statusBadge) {
    return {
      label: item.statusBadge,
      colorClass: item.statusBadgeClass || "text-text-2",
    };
  }

  // Use predefined status if provided
  if (item.status && STATUS_CONFIG[item.status]) {
    return STATUS_CONFIG[item.status];
  }

  return null;
}

// ============================================
// Path Formatting (matches git status)
// ============================================

/** Smart path formatting: directory (truncatable, grayed) + filename (bold) */
const formatPath = (path: string) => {
  const lastSlashIndex = path.lastIndexOf("/");

  // No directory, just filename
  if (lastSlashIndex === -1) {
    return <span className="font-medium">{path}</span>;
  }

  const directory = path.substring(0, lastSlashIndex + 1);
  const filename = path.substring(lastSlashIndex + 1);

  return (
    <span className="flex min-w-0 items-baseline overflow-hidden">
      <span className="shrink truncate font-normal text-text-3">
        {directory}
      </span>
      <span className="flex-shrink-0 font-medium">{filename}</span>
    </span>
  );
};

// ============================================
// Default Item Renderer (matches git status exactly)
// ============================================

interface DefaultItemProps {
  item: ListPanelItem;
  isSelected: boolean;
  onClick: () => void;
  showCheckbox?: boolean;
  onCheckChange?: (checked: boolean) => void;
  showStatusBadge?: boolean;
  showAgentIndicator?: boolean;
}

const DefaultListItem: React.FC<DefaultItemProps> = ({
  item,
  isSelected,
  onClick,
  showCheckbox,
  onCheckChange,
  showStatusBadge = true,
  showAgentIndicator = true,
}) => {
  const statusBadge = showStatusBadge ? getStatusBadge(item) : null;
  const showAgentDot = showAgentIndicator && item.isAgentSelected;

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      // Don't trigger row selection if clicking on checkbox
      const target = e.target as HTMLElement;
      if (
        !target.closest(".simple-checkbox") &&
        !target.closest("[data-checkbox]")
      ) {
        onClick();
      }
    },
    [onClick]
  );

  const handleCheckChange = useCallback(
    (checked: boolean) => {
      onCheckChange?.(checked);
    },
    [onCheckChange]
  );

  // Build full path for display
  const displayPath = item.secondaryText
    ? `${item.secondaryText}/${item.name}`
    : item.name;

  return (
    <div
      className={`flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 transition-colors ${
        isSelected
          ? `${SURFACE_TOKENS.selected} text-primary-6 ${SURFACE_TOKENS.selectedHover}`
          : `text-text-1 ${SURFACE_TOKENS.hover}`
      }`}
      onClick={handleClick}
    >
      {/* Checkbox (optional) */}
      {showCheckbox && (
        <Checkbox
          checked={item.checked ?? false}
          onCheckedChange={handleCheckChange}
          size="small"
        />
      )}

      {/* Current indicator (when no checkbox) */}
      {!showCheckbox && item.isCurrent && (
        <Circle size={8} className="fill-current text-primary-6" />
      )}

      {/* Icon - custom or file type based */}
      {item.icon ? (
        <span className="flex-shrink-0">{item.icon}</span>
      ) : (
        <FileTypeIcon
          fileName={item.fileName || item.name}
          size="medium"
          className="flex-shrink-0"
        />
      )}

      {/* Content: path + status badge */}
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
        <div className="min-w-0 flex-1 truncate text-[13px]">
          {formatPath(displayPath)}
        </div>

        {/* Status badge (optional) */}
        {statusBadge && (
          <div
            className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-[11px] font-bold ${statusBadge.colorClass}`}
          >
            {statusBadge.label}
          </div>
        )}

        {/* Agent selection indicator (blue dot - 6x6px) */}
        {showAgentDot && (
          <div className={AGENT_DOT_TOKENS.container}>
            <div className={AGENT_DOT_TOKENS.dot} />
          </div>
        )}
      </div>
    </div>
  );
};

// ============================================
// ListPanelContent - Tab-free body (filter + list)
// ============================================

export function ListPanelContent({
  filterQuery,
  onFilterChange,
  filterPlaceholder,
  items,
  selectedId,
  onSelectItem,
  renderItem,
  loading = false,
  emptyMessage,
  noResultsMessage,
  showCheckbox = false,
  onItemCheckChange,
  showSelectAll = false,
  onSelectAllChange,
  itemLabel = "item",
  showStatusBadge = true,
  showAgentIndicator = true,
  footer,
  showFooter = true,
}: ListPanelContentProps) {
  const { t } = useTranslation("sessions");
  const effectiveFilterPlaceholder =
    filterPlaceholder || t("common:actions.search") + "...";
  const effectiveEmptyMessage = emptyMessage || t("common:status.empty");
  const effectiveNoResultsMessage =
    noResultsMessage || t("common:status.noResults");
  // Filter items based on query
  const filteredItems = useMemo(() => {
    if (!filterQuery.trim()) return items;
    const query = filterQuery.toLowerCase();
    return items.filter(
      (item) =>
        item.name.toLowerCase().includes(query) ||
        item.secondaryText?.toLowerCase().includes(query)
    );
  }, [items, filterQuery]);

  const hasFilter = filterQuery.trim().length > 0;

  // Checkbox state calculations
  const checkedCount = useMemo(
    () => items.filter((item) => item.checked).length,
    [items]
  );
  const allChecked = items.length > 0 && checkedCount === items.length;
  const someChecked = checkedCount > 0 && checkedCount < items.length;

  // Virtualization threshold - use virtualization for lists > 50 items
  const useVirtualization = filteredItems.length > 50;

  // Item renderer for both virtual and non-virtual lists
  const renderListItem = useCallback(
    (item: ListPanelItem) => {
      const isSelected = selectedId === item.id;
      if (renderItem) {
        return (
          <div key={item.id} onClick={() => onSelectItem(item.id)}>
            {renderItem(item, isSelected)}
          </div>
        );
      }
      return (
        <DefaultListItem
          key={item.id}
          item={item}
          isSelected={isSelected}
          onClick={() => onSelectItem(item.id)}
          showCheckbox={showCheckbox}
          showStatusBadge={showStatusBadge}
          showAgentIndicator={showAgentIndicator}
          onCheckChange={
            onItemCheckChange
              ? (checked) => onItemCheckChange(item.id, checked)
              : undefined
          }
        />
      );
    },
    [
      selectedId,
      renderItem,
      onSelectItem,
      showCheckbox,
      showStatusBadge,
      showAgentIndicator,
      onItemCheckChange,
    ]
  );

  return (
    <>
      {/* Search Input - 40px container, 28px input, vertically centered */}
      <div className="flex h-[40px] flex-shrink-0 items-center px-3">
        <Input
          prefix={<Search size={14} strokeWidth={1.75} />}
          placeholder={effectiveFilterPlaceholder}
          value={filterQuery}
          onChange={onFilterChange}
          size="small"
        />
      </div>

      {/* Item count / Select All header */}
      {!loading && filteredItems.length > 0 && (
        <div className="flex h-[36px] flex-shrink-0 items-center gap-2 px-3">
          {showSelectAll && showCheckbox && onSelectAllChange && (
            <Checkbox
              checked={allChecked}
              indeterminate={someChecked}
              onCheckedChange={onSelectAllChange}
              size="small"
            />
          )}
          <span className="text-[13px] font-normal text-text-2">
            {hasFilter && filteredItems.length !== items.length
              ? t("listPanel.showingOf", {
                  filtered: filteredItems.length,
                  total: items.length,
                })
              : showCheckbox && checkedCount > 0
                ? t("listPanel.selectedOf", {
                    selected: checkedCount,
                    total: items.length,
                  })
                : `${filteredItems.length} ${itemLabel}${filteredItems.length !== 1 ? "s" : ""}`}
          </span>
        </div>
      )}

      {/* List content */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 scrollbar-hide">
        {/* Loading State */}
        {loading && (
          <div className="flex min-h-0 min-h-full w-full flex-1 flex-col">
            <Placeholder
              variant="loading"
              placement="detail-panel"
              fillParentHeight
            />
          </div>
        )}

        {/* Empty State */}
        {!loading && items.length === 0 && (
          <div className="flex min-h-0 min-h-full w-full flex-1 flex-col">
            <Placeholder
              variant="empty"
              placement="detail-panel"
              fillParentHeight
              title={effectiveEmptyMessage}
            />
          </div>
        )}

        {/* No Results State */}
        {!loading && items.length > 0 && filteredItems.length === 0 && (
          <div className="flex min-h-0 min-h-full w-full flex-1 flex-col">
            <Placeholder
              variant="no-results"
              placement="detail-panel"
              fillParentHeight
              title={effectiveNoResultsMessage}
            />
          </div>
        )}

        {/* Items List */}
        {!loading && filteredItems.length > 0 && (
          <>
            {useVirtualization ? (
              <div className="min-h-0 min-w-0 flex-1">
                {/* Virtualized list for large item counts */}
                <Virtuoso
                  style={{ height: "100%", paddingBottom: "0.5rem" }}
                  data={filteredItems}
                  itemContent={(_index, item) => (
                    <div className="py-0.25 px-0.5">{renderListItem(item)}</div>
                  )}
                  components={{
                    List: Object.assign(
                      React.forwardRef<
                        HTMLDivElement,
                        React.HTMLAttributes<HTMLDivElement>
                      >(function VirtuosoListPanelSidebarList(props, ref) {
                        return (
                          <div
                            ref={ref}
                            {...props}
                            className="flex flex-col gap-0.5"
                          />
                        );
                      }),
                      { displayName: "VirtuosoListPanelSidebarList" }
                    ),
                  }}
                />
              </div>
            ) : (
              <div className="flex flex-col gap-0.5 pb-2">
                {filteredItems.map((item) => renderListItem(item))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Footer (optional - e.g. commit section) */}
      {footer && showFooter && !loading && filteredItems.length > 0 && (
        <div className="flex-shrink-0 border-t border-border-2">{footer}</div>
      )}
    </>
  );
}

// ============================================
// ListPanelSidebar - Full component with tabs
// ============================================

export function ListPanelSidebar<TTab extends string = string>({
  tabs,
  activeTab,
  onTabChange,
  widthClass = "w-72",
  width,
  tabsFillWidth = true,
  ...contentProps
}: ListPanelSidebarProps<TTab>) {
  // Use dynamic width if provided, otherwise use widthClass
  const containerStyle = width ? { width: `${width}px` } : undefined;
  const containerWidthClass = width ? "" : widthClass;

  return (
    <div
      className={`ide-file-sidebar flex h-full ${containerWidthClass} shrink-0 flex-col bg-bg-1`}
      style={containerStyle}
    >
      {/* Header with Tabs */}
      <div className="flex h-[40px] flex-shrink-0 items-center px-3">
        <div className="flex flex-1 items-stretch gap-1">
          <TabPill
            activeTab={activeTab}
            tabs={tabs}
            onChange={(key) => onTabChange(key as TTab)}
            variant="pill"
            color="fill"
            className="flex-1"
            fillWidth={tabsFillWidth}
          />
        </div>
      </div>

      {/* Body: filter + list */}
      <ListPanelContent {...contentProps} />
    </div>
  );
}

export default ListPanelSidebar;
export type {
  ListPanelContentProps,
  ListPanelItem,
  ListPanelSidebarProps,
  TabConfig,
} from "./types";

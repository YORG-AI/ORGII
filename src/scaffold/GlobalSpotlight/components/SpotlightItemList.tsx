/**
 * SpotlightItemList Component
 *
 * Renders the list of spotlight items with:
 * - Virtual scrolling for performance (renders only visible items)
 * - Loading indicator for infinite scroll
 * - Empty state
 *
 * Row rendering is delegated to SpotlightItemRow.
 */
import { ChevronDown } from "lucide-react";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { Placeholder } from "@src/components/Placeholder";
import { useKeyboardMouseMode } from "@src/hooks/keyboard";

import type { SpotlightItem } from "../types";
import { ITEM_HEIGHT, SpotlightItemRow } from "./SpotlightItemRow";

// ============ TYPES ============

export interface SpotlightItemListProps {
  /** Items to render */
  items: SpotlightItem[];
  /** Currently selected index */
  selectedIndex: number;
  /** Handler for item selection */
  onItemSelect: (item: SpotlightItem) => void;
  /** Handler for mouse enter (hover selection) */
  onItemHover: (index: number) => void;
  /** Handler for mouse leave (clear hover selection) */
  onItemHoverEnd?: () => void;
  /** Current search query (for empty state message) */
  searchQuery: string;
  /** Whether more items are loading (default: false) */
  isLoadingMore?: boolean;
  /** Whether there are more items to load (default: false) */
  hasMore?: boolean;
  /** Container height for virtual scrolling (default: 400px) */
  containerHeight?: number;
  /** External scroll handler for pagination */
  onScrollExternal?: (e: React.UIEvent<HTMLDivElement>) => void;
  /** Whether initial items are loading (shows loading state instead of empty) */
  isLoadingInitial?: boolean;
  /** Custom loading message (e.g., "Loading repositories...", "Loading branches...") */
  loadingMessage?: string;
  /** Use fixed height instead of maxHeight (prevents layout shift when items change) */
  fixedHeight?: boolean;
}

// ============ CONSTANTS ============

const OVERSCAN_COUNT = 5;
const EMPTY_STATE_DELAY_MS = 350;

// ============ MAIN COMPONENT ============

export const SpotlightItemList: React.FC<SpotlightItemListProps> = ({
  items,
  selectedIndex,
  onItemSelect,
  onItemHover,
  onItemHoverEnd,
  searchQuery,
  isLoadingMore = false,
  hasMore = false,
  containerHeight = 400,
  onScrollExternal,
  isLoadingInitial = false,
  loadingMessage,
  fixedHeight = false,
}) => {
  const { t } = useTranslation();
  const resolvedLoadingMessage = loadingMessage ?? t("status.loading");
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);

  const { isKeyboardMode, handleMouseMove, dataKeyboardMode } =
    useKeyboardMouseMode();
  const [showEmptyState, setShowEmptyState] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const resetId = window.setTimeout(() => {
      if (!cancelled) setShowEmptyState(false);
    }, 0);

    if (items.length > 0 || isLoadingInitial) {
      return () => {
        cancelled = true;
        window.clearTimeout(resetId);
      };
    }

    const revealId = window.setTimeout(() => {
      if (!cancelled) setShowEmptyState(true);
    }, EMPTY_STATE_DELAY_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(resetId);
      window.clearTimeout(revealId);
    };
  }, [items.length, isLoadingInitial, searchQuery]);

  // Virtual scrolling parameters
  const totalHeight = items.length * ITEM_HEIGHT;
  const visibleCount = Math.ceil(containerHeight / ITEM_HEIGHT);
  const startIndex = Math.max(
    0,
    Math.floor(scrollTop / ITEM_HEIGHT) - OVERSCAN_COUNT
  );
  const endIndex = Math.min(
    items.length,
    startIndex + visibleCount + OVERSCAN_COUNT * 2
  );

  const visibleItems = useMemo(() => {
    return items.slice(startIndex, endIndex);
  }, [items, startIndex, endIndex]);

  const handleScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      setScrollTop(event.currentTarget.scrollTop);
      onScrollExternal?.(event);
    },
    [onScrollExternal]
  );

  // Scroll selected item into view when selection changes via keyboard
  useEffect(() => {
    if (isKeyboardMode && containerRef.current && selectedIndex >= 0) {
      const selectedElement = containerRef.current.querySelector(
        `[data-spotlight-item-index="${selectedIndex}"]`
      ) as HTMLElement;

      if (selectedElement) {
        selectedElement.scrollIntoView({
          block: "nearest",
          behavior: "smooth",
        });
      }
    }
  }, [selectedIndex, isKeyboardMode]);

  // Virtualization with a single ITEM_HEIGHT causes drift for mixed-height rows,
  // so we only virtualize when all items are uniform or the caller opts in via fixedHeight.
  const hasMixedHeights = useMemo(() => {
    if (items.length === 0) return false;
    const firstHasDesc = Boolean(items[0].desc);
    return items.some((item) => Boolean(item.desc) !== firstHasDesc);
  }, [items]);

  const useVirtualization =
    fixedHeight || (items.length > 30 && !hasMixedHeights);

  const nonVirtualizedContainerRef = useRef<HTMLDivElement>(null);

  // Scroll selected item into view for non-virtualized lists
  useEffect(() => {
    if (
      !useVirtualization &&
      isKeyboardMode &&
      nonVirtualizedContainerRef.current &&
      selectedIndex >= 0
    ) {
      const container = nonVirtualizedContainerRef.current;
      const selectedElement = container.querySelector(
        `[data-spotlight-item-index="${selectedIndex}"]`
      ) as HTMLElement;

      if (selectedElement) {
        selectedElement.scrollIntoView({
          behavior: "smooth",
          block: "nearest",
        });
      }
    }
  }, [selectedIndex, isKeyboardMode, useVirtualization]);

  // Empty state — AFTER all hooks are called
  if (items.length === 0) {
    const hasSearchQuery = searchQuery.trim().length > 0;
    const emptyContent =
      isLoadingInitial || !showEmptyState ? (
        <Placeholder
          variant="loading"
          title={resolvedLoadingMessage}
          placement="sidebar"
          fillParentHeight
        />
      ) : (
        <Placeholder
          variant={hasSearchQuery ? "no-results" : "empty"}
          title={
            hasSearchQuery
              ? t("common:common.noResults")
              : t("placeholders.noItemsAvailable")
          }
          subtitle={
            hasSearchQuery ? t("placeholders.noResultsSubtitle") : undefined
          }
          placement="sidebar"
          fillParentHeight
        />
      );

    return (
      <div
        className={
          fixedHeight
            ? "spotlight-scrollable overflow-y-auto"
            : "flex min-h-[180px] flex-col"
        }
        style={fixedHeight ? { height: containerHeight } : undefined}
      >
        {emptyContent}
      </div>
    );
  }

  // Non-virtualized rendering for small / mixed-height lists
  if (!useVirtualization) {
    return (
      <div
        ref={nonVirtualizedContainerRef}
        className="spotlight-scrollable overflow-y-auto"
        style={{ maxHeight: containerHeight }}
        onScroll={onScrollExternal}
        onMouseMove={handleMouseMove}
        data-keyboard-mode={dataKeyboardMode}
      >
        {items.map((item, idx) => (
          <SpotlightItemRow
            key={item.id}
            item={item}
            index={idx}
            isSelected={selectedIndex === idx}
            isKeyboardMode={isKeyboardMode}
            onSelect={onItemSelect}
            onHover={onItemHover}
            onHoverEnd={onItemHoverEnd}
            searchQuery={searchQuery}
          />
        ))}

        {isLoadingMore && (
          <div className="flex items-center justify-center gap-2 py-4">
            <div className="h-4 w-4 rounded-full border-2 border-primary-6 border-t-transparent" />
            <span className="text-[12px] text-text-2">
              {t("placeholders.loadingMore")}
            </span>
          </div>
        )}

        {hasMore && !isLoadingMore && (
          <div className="flex items-center justify-center gap-1 py-3">
            <ChevronDown className="text-text-4" size={14} />
            <span className="text-[11px] text-text-4">
              {t("placeholders.scrollForMore")}
            </span>
          </div>
        )}
      </div>
    );
  }

  // Virtual scrolling for large lists
  return (
    <div
      ref={containerRef}
      className="spotlight-scrollable overflow-y-auto"
      style={{ height: containerHeight }}
      onScroll={handleScroll}
      onMouseMove={handleMouseMove}
      data-keyboard-mode={dataKeyboardMode}
    >
      <div style={{ height: totalHeight, position: "relative" }}>
        <div
          style={{
            position: "absolute",
            top: startIndex * ITEM_HEIGHT,
            left: 0,
            right: 0,
          }}
        >
          {visibleItems.map((item, idx) => {
            const actualIndex = startIndex + idx;
            return (
              <SpotlightItemRow
                key={item.id}
                item={item}
                index={actualIndex}
                isSelected={selectedIndex === actualIndex}
                isKeyboardMode={isKeyboardMode}
                onSelect={onItemSelect}
                onHover={onItemHover}
                onHoverEnd={onItemHoverEnd}
                searchQuery={searchQuery}
              />
            );
          })}
        </div>
      </div>

      {isLoadingMore && (
        <div className="flex items-center justify-center gap-2 py-4">
          <div className="h-4 w-4 rounded-full border-2 border-primary-6 border-t-transparent" />
          <span className="text-[12px] text-text-2">
            {t("placeholders.loadingMore")}
          </span>
        </div>
      )}

      {hasMore && !isLoadingMore && (
        <div className="flex items-center justify-center gap-1 py-3">
          <ChevronDown className="text-text-4" size={14} />
          <span className="text-[11px] text-text-4">
            {t("placeholders.scrollForMore")}
          </span>
        </div>
      )}
    </div>
  );
};

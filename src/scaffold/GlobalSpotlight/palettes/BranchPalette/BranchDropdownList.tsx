import React, { useCallback } from "react";

import {
  DROPDOWN_CLASSES,
  DROPDOWN_PANEL,
} from "@src/components/Dropdown/tokens";

import { usePickerVirtualization } from "../../hooks/usePickerVirtualization";

interface Props<T> {
  items: readonly T[];
  getKey: (item: T) => string | number;
  estimateHeight: (item: T) => number;
  renderItem: (item: T, index: number) => React.ReactNode;
  selectedIndex: number;
  keyboardNavigated: boolean;
  searchQuery: string;
  onLoadMore?: () => void;
}

/** Shared by the compact branch and PR views; only visible rows are mounted. */
export function BranchDropdownList<T>({
  items,
  getKey,
  estimateHeight,
  renderItem,
  selectedIndex,
  keyboardNavigated,
  searchQuery,
  onLoadMore,
}: Props<T>) {
  const getItemKey = useCallback(
    (index: number) => getKey(items[index]),
    [items, getKey]
  );
  const estimateSize = useCallback(
    (index: number) => estimateHeight(items[index]),
    [items, estimateHeight]
  );
  const {
    containerRef,
    rows: virtualRows,
    totalSize,
    handleScroll,
    measureElement,
  } = usePickerVirtualization({
    count: items.length,
    getItemKey,
    estimateSize,
    gap: DROPDOWN_PANEL.itemsGap,
    containerHeight: 360,
    scrollPadding: DROPDOWN_PANEL.padding,
    selectedIndex,
    keyboardNavigated,
    searchQuery,
    onLoadMore,
  });

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className={DROPDOWN_CLASSES.optionsContainerOverlay}
      style={{
        height: Math.min(360, totalSize + DROPDOWN_PANEL.padding * 2),
      }}
    >
      <div className="relative w-full shrink-0" style={{ height: totalSize }}>
        {virtualRows.map((row) => (
          <div
            key={row.key}
            ref={measureElement}
            data-index={row.index}
            className="absolute top-0 left-0 w-full"
            style={{ transform: `translateY(${row.start}px)` }}
          >
            {renderItem(items[row.index], row.index)}
          </div>
        ))}
      </div>
    </div>
  );
}

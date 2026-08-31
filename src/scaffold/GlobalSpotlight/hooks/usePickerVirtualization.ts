import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useLayoutEffect, useRef } from "react";

interface Options {
  count: number;
  getItemKey: (index: number) => string | number;
  estimateSize: (index: number) => number;
  containerHeight: number;
  selectedIndex: number;
  keyboardNavigated: boolean;
  searchQuery: string;
  enabled?: boolean;
  gap?: number;
  scrollPadding?: number;
  onScrollExternal?: (event: React.UIEvent<HTMLDivElement>) => void;
  onLoadMore?: () => void;
}

/** One scrolling owner for branch/PR rows in both picker presentations. */
export function usePickerVirtualization({
  count,
  getItemKey,
  estimateSize,
  containerHeight,
  selectedIndex,
  keyboardNavigated,
  searchQuery,
  enabled = true,
  gap = 0,
  scrollPadding = 0,
  onScrollExternal,
  onLoadMore,
}: Options) {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack's imperative instance stays inside this hook; consumers receive a rendered snapshot.
  const virtualizer = useVirtualizer({
    count,
    getItemKey,
    estimateSize,
    getScrollElement: () => containerRef.current,
    overscan: 5,
    enabled: enabled && count > 0,
    initialRect: { width: 0, height: containerHeight },
    gap,
    scrollPaddingStart: scrollPadding,
    scrollPaddingEnd: scrollPadding,
  });

  useLayoutEffect(() => {
    if (enabled) virtualizer.scrollToOffset(0);
  }, [searchQuery, enabled, virtualizer]);

  useLayoutEffect(() => {
    // Off-screen rows have no DOM node yet. Footer action indices are excluded.
    if (
      enabled &&
      keyboardNavigated &&
      selectedIndex >= 0 &&
      selectedIndex < count
    ) {
      virtualizer.scrollToIndex(selectedIndex, { align: "auto" });
    }
  }, [selectedIndex, keyboardNavigated, count, enabled, virtualizer]);

  const handleScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      onScrollExternal?.(event);
      const node = event.currentTarget;
      // Appending rows does not recursively drain a repository. Loading is
      // driven by scrolling (including keyboard scrolling), never an idle poll.
      if (
        node.scrollTop > 0 &&
        node.scrollHeight - node.scrollTop - node.clientHeight < 100
      ) {
        onLoadMore?.();
      }
    },
    [onScrollExternal, onLoadMore]
  );

  return {
    containerRef,
    rows: virtualizer.getVirtualItems(),
    totalSize: virtualizer.getTotalSize(),
    measureElement: virtualizer.measureElement,
    handleScroll,
  };
}

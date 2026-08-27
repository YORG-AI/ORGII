/**
 * VirtualizedListBase Component
 *
 * Shared virtualization component with scroll preservation patterns.
 * Used by virtualized tree/list views for consistent behavior.
 *
 * Features:
 * - Stable Virtuoso components (prevents scroll reset on state changes)
 * - Scroll position tracking via refs
 * - Scroll restoration when list structure changes
 * - Configurable item rendering and key computation
 *
 * PERFORMANCE PATTERNS:
 * - Uses refs for scroll position tracking (no re-renders)
 * - Stable virtuosoComponents via useMemo with empty deps
 * - Tracks first visible item for scroll restoration
 */
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";
import { Virtuoso, VirtuosoHandle } from "react-virtuoso";

import { TREE_ROW_HEIGHT } from "./config";

// ============================================
// Types
// ============================================

export interface VirtualizedListBaseHandle {
  /** Scroll to a specific index */
  scrollToIndex: (index: number, behavior?: "auto" | "smooth") => void;
  /** Get current scroll position */
  getScrollTop: () => number;
  /** Get virtuoso ref for advanced operations */
  getVirtuosoRef: () => VirtuosoHandle | null;
}

export interface VirtualizedListBaseProps<T> {
  /** Flattened list of items to render */
  items: T[];
  /** Render function for each item */
  renderItem: (item: T, index: number) => React.ReactNode;
  /** Compute stable key for each item */
  computeItemKey: (item: T, index: number) => string | number;
  /** Get unique path/id for scroll restoration (optional) */
  getItemPath?: (item: T) => string;
  /** Default item height (defaults to TREE_ROW_HEIGHT) */
  itemHeight?: number;
  /** Number of items to render outside viewport (defaults to 30) */
  overscan?: number;
  /** Called when scrolling near end */
  onEndReached?: () => void;
  /** Additional class name */
  className?: string;
  /** Whether to auto-scroll to new items (defaults to false) */
  followOutput?: boolean;
  /** Top padding for sticky headers etc */
  paddingTop?: number;
  /**
   * Initial scroll position (in pixels) to restore on mount.
   * Used when external state (Jotai atom) needs to survive remounting.
   */
  initialScrollTop?: number;
  /** Callback when scroll position changes - for external state sync */
  onScrollPositionChange?: (scrollTop: number) => void;
}

/**
 * Resolve Virtuoso's `initialTopMostItemIndex` from a saved scroll offset.
 *
 * MUST return a number, never `undefined`. Virtuoso normalizes this prop with
 *
 *   const e = typeof t === "number" ? { index: t } : t;
 *   e.align || (e.align = "start");
 *
 * so an explicit `undefined` is not treated as "prop absent" — it falls into
 * the object branch and throws `undefined is not an object (evaluating
 * 'e.align')` on mount. 0 is the prop's own default and the correct "start at
 * the top" value.
 */
export function resolveInitialTopMostItemIndex(
  initialScrollTop: number,
  itemHeight: number
): number {
  if (!Number.isFinite(initialScrollTop) || initialScrollTop <= 0) return 0;
  if (!Number.isFinite(itemHeight) || itemHeight <= 0) return 0;
  return Math.max(0, Math.floor(initialScrollTop / itemHeight));
}

// ============================================
// Component
// ============================================

function VirtualizedListBaseInner<T>(
  {
    items,
    renderItem,
    computeItemKey,
    getItemPath,
    itemHeight = TREE_ROW_HEIGHT,
    overscan = 30,
    onEndReached,
    className = "h-full scrollbar-hide",
    followOutput = false,
    paddingTop,
    initialScrollTop = 0,
    onScrollPositionChange,
  }: VirtualizedListBaseProps<T>,
  ref: React.ForwardedRef<VirtualizedListBaseHandle>
) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  // SCROLL PRESERVATION: Track scroll position and first visible item
  // Initialize from external state if provided (survives remounting)
  const lastScrollTopRef = useRef(initialScrollTop);
  const firstVisiblePathRef = useRef<string | null>(null);
  const isRestoringScrollRef = useRef(false);
  const prevItemsLengthRef = useRef(items.length);
  const hasRestoredInitialScrollRef = useRef(false);

  // Keep items in ref for scroll handler access
  const itemsRef = useRef(items);
  itemsRef.current = items;

  // Scroll handler ref for stable virtuosoComponents
  const scrollHandlerRef = useRef<
    ((event: React.UIEvent<HTMLDivElement>) => void) | undefined
  >(undefined);

  // Ref to the actual scroller element for direct scroll control
  const scrollerElementRef = useRef<HTMLDivElement | null>(null);

  // Keep callback in ref for stable virtuosoComponents
  const onScrollPositionChangeRef = useRef(onScrollPositionChange);
  onScrollPositionChangeRef.current = onScrollPositionChange;

  // STABLE virtuosoComponents - critical for scroll preservation
  const virtuosoComponents = useMemo(() => {
    const Scroller = React.forwardRef<
      HTMLDivElement,
      React.HTMLAttributes<HTMLDivElement>
    >((props, scrollerRef) => {
      // Combine the forwarded ref with our internal ref
      const setRefs = useCallback(
        (element: HTMLDivElement | null) => {
          scrollerElementRef.current = element;
          if (typeof scrollerRef === "function") {
            scrollerRef(element);
          } else if (scrollerRef) {
            scrollerRef.current = element;
          }
        },
        [scrollerRef]
      );

      return (
        <div
          {...props}
          ref={setRefs}
          onScroll={(event) => {
            props.onScroll?.(event);
            // Track scroll position via ref - no state update = no re-render
            const scrollTop = event.currentTarget.scrollTop;
            lastScrollTopRef.current = scrollTop;
            scrollHandlerRef.current?.(event);
            // Notify external state (Jotai atom) of scroll changes
            onScrollPositionChangeRef.current?.(scrollTop);
          }}
        />
      );
    });
    Scroller.displayName = "VirtualizedListScroller";
    return { Scroller };
  }, []); // Empty deps - keeps component stable

  // Update scroll handler to track first visible item
  useEffect(() => {
    if (!getItemPath) return;

    scrollHandlerRef.current = () => {
      // Skip during scroll restoration
      if (isRestoringScrollRef.current) return;

      const currentItems = itemsRef.current;
      if (currentItems.length === 0) return;

      const visibleIndex = Math.min(
        currentItems.length - 1,
        Math.max(0, Math.floor(lastScrollTopRef.current / itemHeight))
      );
      firstVisiblePathRef.current = getItemPath(currentItems[visibleIndex]);
    };
  }, [getItemPath, itemHeight]);

  // SCROLL RESTORATION: When items change, restore scroll position
  useEffect(() => {
    const prevLength = prevItemsLengthRef.current;
    const currentLength = items.length;
    prevItemsLengthRef.current = currentLength;

    // Only restore if structure actually changed
    if (prevLength === currentLength) return;
    if (!getItemPath || !firstVisiblePathRef.current) return;
    if (!virtuosoRef.current) return;

    // Find the previously visible item in the new list
    const prevPath = firstVisiblePathRef.current;
    const newIndex = items.findIndex((item) => getItemPath(item) === prevPath);

    if (newIndex !== -1) {
      const expectedScrollTop = newIndex * itemHeight;
      const currentScrollTop = lastScrollTopRef.current;

      // Only restore if scroll position would be significantly different
      if (Math.abs(expectedScrollTop - currentScrollTop) > itemHeight) {
        isRestoringScrollRef.current = true;

        requestAnimationFrame(() => {
          virtuosoRef.current?.scrollToIndex({
            index: newIndex,
            align: "start",
            behavior: "auto",
          });

          // Re-enable tracking after restoration
          setTimeout(() => {
            isRestoringScrollRef.current = false;
          }, 50);
        });
      }
    }
  }, [items, getItemPath, itemHeight]);

  // SCROLL PRESERVATION: Restore initial scroll position on mount
  // This handles the case where external state (Jotai atom) has a saved position
  React.useLayoutEffect(() => {
    if (hasRestoredInitialScrollRef.current) return;
    if (initialScrollTop <= 0) return;

    const scroller = scrollerElementRef.current;
    if (!scroller) return;

    // Mark as restoring to prevent interference
    isRestoringScrollRef.current = true;
    hasRestoredInitialScrollRef.current = true;

    // Use requestAnimationFrame to ensure Virtuoso has rendered
    requestAnimationFrame(() => {
      if (scrollerElementRef.current) {
        scrollerElementRef.current.scrollTop = initialScrollTop;
      }
      // Also update our internal ref
      lastScrollTopRef.current = initialScrollTop;

      setTimeout(() => {
        isRestoringScrollRef.current = false;
      }, 50);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initialScrollTop is a mount-time restoration snapshot; later scroll ownership lives in lastScrollTopRef
  }, []);

  // SCROLL PRESERVATION: After any render, check if scroll was reset and restore
  // Uses useLayoutEffect to run before paint
  React.useLayoutEffect(() => {
    const scroller = scrollerElementRef.current;
    if (!scroller) return;
    if (isRestoringScrollRef.current) return;

    // If we had a scroll position but the scroller is now at 0, restore it
    const expectedScrollTop = lastScrollTopRef.current;
    const actualScrollTop = scroller.scrollTop;

    if (expectedScrollTop > itemHeight && actualScrollTop === 0) {
      isRestoringScrollRef.current = true;
      scroller.scrollTop = expectedScrollTop;
      requestAnimationFrame(() => {
        isRestoringScrollRef.current = false;
      });
    }
  });

  // Expose handle methods
  useImperativeHandle(
    ref,
    () => ({
      scrollToIndex: (
        index: number,
        behavior: "auto" | "smooth" = "smooth"
      ) => {
        virtuosoRef.current?.scrollToIndex({
          index,
          align: "center",
          behavior,
        });
      },
      getScrollTop: () => lastScrollTopRef.current,
      getVirtuosoRef: () => virtuosoRef.current,
    }),
    []
  );

  // Memoized render function
  const itemContent = useCallback(
    (index: number) => {
      const item = items[index];
      if (!item) return null;
      return renderItem(item, index);
    },
    [items, renderItem]
  );

  // Memoized key function
  const itemKey = useCallback(
    (index: number) => {
      const item = items[index];
      if (!item) return index;
      return computeItemKey(item, index);
    },
    [items, computeItemKey]
  );

  if (items.length === 0) {
    return null;
  }

  // Calculate initial item index from scroll position for more reliable restoration
  const initialItemIndex = resolveInitialTopMostItemIndex(
    initialScrollTop,
    itemHeight
  );

  return (
    <Virtuoso
      ref={virtuosoRef}
      totalCount={items.length}
      itemContent={itemContent}
      computeItemKey={itemKey}
      defaultItemHeight={itemHeight}
      overscan={overscan}
      endReached={onEndReached}
      className={`tree-guide-scope ${className}`}
      components={virtuosoComponents}
      followOutput={followOutput}
      style={paddingTop ? { paddingTop } : undefined}
      // Use initialTopMostItemIndex for reliable scroll restoration on mount
      // This is more reliable than trying to set scrollTop after render.
      // Always a number — see resolveInitialTopMostItemIndex.
      initialTopMostItemIndex={initialItemIndex}
    />
  );
}

// Export with proper typing for generics
export const VirtualizedListBase = forwardRef(VirtualizedListBaseInner) as <T>(
  props: VirtualizedListBaseProps<T> & {
    ref?: React.ForwardedRef<VirtualizedListBaseHandle>;
  }
) => React.ReactElement | null;

export default VirtualizedListBase;

/**
 * VirtualizedStickyTree Component
 *
 * Reusable virtualized tree with VS Code-style sticky scroll.
 *
 * Features:
 * - Virtualized rendering with react-virtuoso
 * - VS Code-style sticky headers with position-based clipping
 * - Scroll preservation when tree structure changes
 * - Generic - works with any tree node type
 *
 * @example
 * ```tsx
 * <VirtualizedStickyTree
 *   flattenedNodes={flattenedNodes}
 *   rowHeight={28}
 *   renderItem={(item) => <MyTreeRow node={item.node} depth={item.depth} />}
 *   renderStickyItem={(stickyNode, onClick) => (
 *     <MyStickyRow node={stickyNode.node} onClick={onClick} />
 *   )}
 * />
 * ```
 */
import { useAtomValue } from "jotai";
import React, {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Virtuoso, VirtuosoHandle } from "react-virtuoso";

import { Placeholder } from "@src/components/Placeholder";
import { useElementDimensions } from "@src/hooks/ui/layout/useElementDimensions";
import { editorShowTreeIndentGuidesAtom } from "@src/store/ui/editorSettingsAtom";

import { StickyHeadersContainer } from "./StickyHeadersContainer";
import {
  DEFAULT_MAX_STICKY_HEIGHT_RATIO,
  DEFAULT_MAX_STICKY_ITEMS,
  DEFAULT_OVERSCAN,
  DEFAULT_VIEWPORT_BUFFER,
} from "./config";
import { useScrollPreservation, useStickyScroll } from "./hooks";
import type { TreeNodeBase, VirtualizedStickyTreeProps } from "./types";

// Re-export types and hooks for external consumers
export type {
  FlattenedTreeNode,
  StickyScrollNode,
  TreeNodeBase,
  VirtualizedStickyTreeProps,
} from "./types";
export { useStickyScroll, useScrollPreservation } from "./hooks";
export { STICKY_ROW, CHEVRON_SIZE, stickyRowPadding } from "./tokens";

/**
 * Custom Scroller for Virtuoso with scroll event forwarding.
 * Defined outside component to prevent recreation on each render.
 * Also populates `scrollerDomRef` so useScrollPreservation can access the
 * real scroll container directly instead of using document.querySelector.
 */
const createScrollerComponent = (
  scrollHandlerRef: React.MutableRefObject<
    ((event: React.UIEvent<HTMLDivElement>) => void) | undefined
  >,
  scrollerDomRef: React.MutableRefObject<HTMLDivElement | null>
) => {
  const Scroller = React.forwardRef<
    HTMLDivElement,
    React.HTMLAttributes<HTMLDivElement>
  >((props, forwardedRef) => (
    <div
      {...props}
      ref={(node) => {
        scrollerDomRef.current = node;
        if (typeof forwardedRef === "function") {
          forwardedRef(node);
        } else if (forwardedRef) {
          forwardedRef.current = node;
        }
      }}
      onScroll={(event) => {
        props.onScroll?.(event);
        scrollHandlerRef.current?.(event);
      }}
    />
  ));
  Scroller.displayName = "VirtualizedStickyTreeScroller";
  return Scroller;
};

/**
 * Handle exposed by VirtualizedStickyTree
 */
export interface VirtualizedStickyTreeHandle {
  scrollToIndex: (
    index: number,
    options?: {
      align?: "start" | "center" | "end";
      behavior?: "auto" | "smooth";
    }
  ) => void;
  scrollToPath: (
    path: string,
    options?: {
      align?: "start" | "center" | "end";
      behavior?: "smooth" | "auto";
    }
  ) => void;
}

function VirtualizedStickyTreeInner<TNode extends TreeNodeBase>(
  {
    flattenedNodes,
    rowHeight,
    renderItem,
    renderStickyItem,
    onStickyHeaderClick,
    maxStickyItems = DEFAULT_MAX_STICKY_ITEMS,
    maxStickyHeightRatio = DEFAULT_MAX_STICKY_HEIGHT_RATIO,
    overscan = DEFAULT_OVERSCAN,
    increaseViewportBy = DEFAULT_VIEWPORT_BUFFER,
    className = "",
    stickyBgClass,
    loading = false,
    error = null,
    emptyMessage = "No items",
    virtuosoRef: externalVirtuosoRef,
    onEndReached,
  }: VirtualizedStickyTreeProps<TNode>,
  ref: React.ForwardedRef<VirtualizedStickyTreeHandle>
): React.ReactElement {
  const internalVirtuosoRef = useRef<VirtuosoHandle>(null);
  const virtuosoRef = externalVirtuosoRef || internalVirtuosoRef;
  const containerRef = useRef<HTMLDivElement>(null);
  const viewportHeight = useElementDimensions(containerRef, {
    dimension: "height",
  });
  const showIndentGuides = useAtomValue(editorShowTreeIndentGuidesAtom);

  // Scroll state
  const [scrollTop, setScrollTop] = useState(0);
  const lastScrollTopRef = useRef(0);
  const scrollThrottleRef = useRef<NodeJS.Timeout | null>(null);

  // Scroll handler ref for stable Scroller component
  const scrollHandlerRef = useRef<
    ((event: React.UIEvent<HTMLDivElement>) => void) | undefined
  >(undefined);

  // Direct ref to the Virtuoso scroller DOM element — used by
  // useScrollPreservation for precise scrollTop adjustment so we don't
  // need document.querySelector(".scrollbar-hide").
  const scrollerDomRef = useRef<HTMLDivElement | null>(null);

  // Scroll preservation for tree changes (VSCode anchor pattern)
  const { updateAnchor, isRestoringRef } = useScrollPreservation({
    flattenedNodes,
    virtuosoRef,
    lastScrollTopRef,
    rowHeight,
    scrollerDomRef,
  });

  // Scroll handler - update scrollTop immediately for smooth clipping animation
  const handleScrollerScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      const newScrollTop = event.currentTarget.scrollTop;
      lastScrollTopRef.current = newScrollTop;

      // Update scrollTop immediately for smooth sticky clipping animation
      setScrollTop(newScrollTop);

      // Throttle the anchor tracking for scroll preservation
      if (scrollThrottleRef.current) return;

      scrollThrottleRef.current = setTimeout(() => {
        // Update anchor (hook handles restoration check internally)
        updateAnchor();
        scrollThrottleRef.current = null;
      }, 16);
    },
    [updateAnchor]
  );

  // Update scroll handler ref in effect
  useEffect(() => {
    scrollHandlerRef.current = handleScrollerScroll;
  }, [handleScrollerScroll]);

  // Cleanup throttle
  useEffect(() => {
    return () => {
      if (scrollThrottleRef.current) clearTimeout(scrollThrottleRef.current);
    };
  }, []);

  // Stable Scroller component - passing ref objects (not .current) is safe
  // as they're only accessed in event handlers, not during render
  const virtuosoComponents = useMemo(
    /* eslint-disable react-hooks/refs */
    () => ({
      Scroller: createScrollerComponent(scrollHandlerRef, scrollerDomRef),
    }),
    /* eslint-enable react-hooks/refs */
    []
  );

  // Sticky scroll with VS Code-style clipping (skip if no renderStickyItem)
  const stickyEnabled = !!renderStickyItem;
  const { stickyNodes, stickyHeight } = useStickyScroll({
    flattenedNodes,
    viewportHeight,
    scrollTop,
    rowHeight,
    maxStickyItems: stickyEnabled ? maxStickyItems : 0,
    maxStickyHeightRatio: stickyEnabled ? maxStickyHeightRatio : 0,
  });

  // Handle Virtuoso range changes - update anchor for scroll preservation
  // Note: This is a backup update source; primary updates happen in scroll handler
  const handleRangeChanged = useCallback(
    (_range: { startIndex: number; endIndex: number }) => {
      // Skip if restoring to avoid overwriting anchor during restoration
      if (isRestoringRef.current) return;

      // Update anchor from current scroll position
      updateAnchor();
    },
    [updateAnchor, isRestoringRef]
  );

  // Pre-built path→index Map for O(1) lookups in click/scroll handlers
  const pathIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    for (let idx = 0; idx < flattenedNodes.length; idx++) {
      map.set(flattenedNodes[idx].node.path, idx);
    }
    return map;
  }, [flattenedNodes]);

  // Handle sticky header click — VS Code pattern:
  // Instant scroll, positioning node just below the remaining sticky widget
  const handleStickyHeaderClick = useCallback(
    (nodePath: string, node: TNode) => {
      const index = pathIndexMap.get(nodePath);
      if (index === undefined) return;

      const nodeTop = index * rowHeight;
      const depth = flattenedNodes[index].depth;
      const stickyOffset = Math.min(depth, maxStickyItems) * rowHeight;
      virtuosoRef.current?.scrollTo({
        top: Math.max(0, nodeTop - stickyOffset),
        behavior: "auto",
      });

      onStickyHeaderClick?.(nodePath, node);
    },
    [
      flattenedNodes,
      pathIndexMap,
      rowHeight,
      maxStickyItems,
      virtuosoRef,
      onStickyHeaderClick,
    ]
  );

  // Expose handle for imperative operations
  useImperativeHandle(
    ref,
    () => ({
      scrollToIndex: (index, options) => {
        virtuosoRef.current?.scrollToIndex({
          index,
          align: options?.align ?? "start",
          behavior: options?.behavior ?? "auto",
        });
      },
      scrollToPath: (path, options) => {
        const index = pathIndexMap.get(path);
        if (index !== undefined) {
          virtuosoRef.current?.scrollToIndex({
            index,
            align: options?.align ?? "start",
            behavior: options?.behavior ?? "auto",
          });
        }
      },
    }),
    [pathIndexMap, virtuosoRef]
  );

  const hasNodes = flattenedNodes.length > 0;

  // Stable Virtuoso callbacks so its internal itemContent memo keeps working
  // when parent renders happen but the flattened list is unchanged.
  const handleItemContent = useCallback(
    (index: number) => renderItem(flattenedNodes[index], index),
    [renderItem, flattenedNodes]
  );
  const handleComputeItemKey = useCallback(
    (index: number) => flattenedNodes[index].node.path,
    [flattenedNodes]
  );

  return (
    <div
      ref={containerRef}
      className={`tree-guide-scope relative h-full overflow-hidden ${className}`}
    >
      {/* Sticky headers — always mounted to avoid DOM insertion flash on first stick */}
      {stickyEnabled && hasNodes && (
        <StickyHeadersContainer
          stickyNodes={stickyNodes}
          stickyHeight={stickyHeight}
          renderStickyItem={renderStickyItem}
          onHeaderClick={handleStickyHeaderClick}
          showIndentGuides={showIndentGuides}
          stickyBgClass={stickyBgClass}
        />
      )}

      {loading && !hasNodes && <Placeholder variant="loading" />}

      {error && !hasNodes && <Placeholder variant="error" title={error} />}

      {!loading && !error && !hasNodes && (
        <Placeholder variant="empty" title={emptyMessage} />
      )}

      {/* Virtualized list */}
      {hasNodes && (
        <div className="h-full pb-2">
          <Virtuoso
            ref={virtuosoRef}
            totalCount={flattenedNodes.length}
            itemContent={handleItemContent}
            computeItemKey={handleComputeItemKey}
            overscan={overscan}
            increaseViewportBy={increaseViewportBy}
            className="h-full scrollbar-hide"
            followOutput={false}
            defaultItemHeight={rowHeight}
            components={virtuosoComponents}
            rangeChanged={handleRangeChanged}
            endReached={onEndReached}
          />
        </div>
      )}
    </div>
  );
}

// Export with forwardRef and memo
export const VirtualizedStickyTree = memo(
  forwardRef(VirtualizedStickyTreeInner)
) as <TNode extends TreeNodeBase>(
  props: VirtualizedStickyTreeProps<TNode> & {
    ref?: React.ForwardedRef<VirtualizedStickyTreeHandle>;
  }
) => React.ReactElement;

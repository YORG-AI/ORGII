/**
 * useChatPagination Hook
 *
 * Manages activity pagination:
 * - Reads hasMore / isLoading / loadMore from global atoms
 * - Prefetch when scrolling near the end
 * - End-reached handler
 * - Auto-load when the initial list is too short to scroll
 */
import { useAtomValue, useSetAtom } from "jotai";
import React, { useCallback, useEffect, useRef } from "react";

import { useDebouncedCallback } from "@src/hooks/perf";
import {
  ACTIVITY_PREFETCH_CONFIG,
  hasLoadedMoreActivitiesAtom,
  hasMoreActivitiesAtom,
  isLoadingMoreActivitiesAtom,
  loadMoreActivitiesCallbackAtom,
} from "@src/store/ui/sessionPaginationAtom";

// ============================================
// Types
// ============================================

export interface UseChatPaginationOptions {
  optimizedChatHistoryLength: number;
  setVisibleRange: React.Dispatch<
    React.SetStateAction<{ startIndex: number; endIndex: number }>
  >;
  /** Optional ref updated immediately on every range change (no debounce).
   *  Callers that need the latest endIndex without waiting for the
   *  debounced state update can read this ref. */
  visibleRangeEndRef?: React.MutableRefObject<number>;
}

export interface UseChatPaginationReturn {
  isLoadingMore: boolean;
  handleRangeChanged: (range: { startIndex: number; endIndex: number }) => void;
  handleEndReached: () => void;
}

// ============================================
// Hook
// ============================================

const MAX_AUTO_LOAD_ATTEMPTS = 10;

/** Debounce interval for setVisibleRange state updates.
 *  Prevents scroll → re-render → scroll feedback loops while adjacent
 *  group headers are near the viewport top. */
const RANGE_DEBOUNCE_MS = 150;

export function useChatPagination({
  optimizedChatHistoryLength,
  setVisibleRange,
  visibleRangeEndRef,
}: UseChatPaginationOptions): UseChatPaginationReturn {
  const hasMoreActivities = useAtomValue(hasMoreActivitiesAtom);
  const isLoadingMore = useAtomValue(isLoadingMoreActivitiesAtom);
  const loadMoreActivities = useAtomValue(loadMoreActivitiesCallbackAtom);
  const setHasLoadedMoreActivities = useSetAtom(hasLoadedMoreActivitiesAtom);

  const loadMorePagedActivities = useCallback(() => {
    setHasLoadedMoreActivities(true);
    loadMoreActivities?.();
  }, [loadMoreActivities, setHasLoadedMoreActivities]);

  const debouncedSetVisibleRange = useDebouncedCallback(
    (range: { startIndex: number; endIndex: number }) => {
      setVisibleRange((previousRange) => {
        if (
          previousRange.startIndex === range.startIndex &&
          previousRange.endIndex === range.endIndex
        ) {
          return previousRange;
        }
        return range;
      });
    },
    RANGE_DEBOUNCE_MS
  );

  const handleRangeChanged = useCallback(
    (range: { startIndex: number; endIndex: number }) => {
      // Update ref immediately so auto-scroll logic stays responsive.
      if (visibleRangeEndRef) {
        visibleRangeEndRef.current = range.endIndex;
      }

      // Debounce the state update to avoid re-render jitter during
      // sticky-header transitions (the "kissing" bounce).
      debouncedSetVisibleRange(range);

      if (ACTIVITY_PREFETCH_CONFIG.enabled) {
        const itemsFromEnd = optimizedChatHistoryLength - 1 - range.endIndex;
        const shouldPrefetch =
          itemsFromEnd <= ACTIVITY_PREFETCH_CONFIG.thresholdItemsFromEnd;

        if (
          shouldPrefetch &&
          hasMoreActivities &&
          !isLoadingMore &&
          loadMoreActivities
        ) {
          loadMorePagedActivities();
        }
      }
    },
    [
      debouncedSetVisibleRange,
      visibleRangeEndRef,
      optimizedChatHistoryLength,
      hasMoreActivities,
      isLoadingMore,
      loadMoreActivities,
      loadMorePagedActivities,
    ]
  );

  // Handle scroll to bottom — load more (newer) activities
  const handleEndReached = useCallback(() => {
    if (optimizedChatHistoryLength === 0) return;
    if (hasMoreActivities && !isLoadingMore && loadMoreActivities) {
      loadMorePagedActivities();
    }
  }, [
    hasMoreActivities,
    isLoadingMore,
    loadMoreActivities,
    optimizedChatHistoryLength,
    loadMorePagedActivities,
  ]);

  // Auto-load counter — reset when chat history is cleared (new session)
  const autoLoadAttemptsRef = useRef(0);

  useEffect(() => {
    if (optimizedChatHistoryLength === 0) {
      autoLoadAttemptsRef.current = 0;
      setHasLoadedMoreActivities(false);
    }
  }, [optimizedChatHistoryLength, setHasLoadedMoreActivities]);

  // Auto-load when list is too short to scroll but has more data
  useEffect(() => {
    if (
      optimizedChatHistoryLength > 0 &&
      optimizedChatHistoryLength < 15 &&
      hasMoreActivities &&
      !isLoadingMore &&
      loadMoreActivities &&
      autoLoadAttemptsRef.current < MAX_AUTO_LOAD_ATTEMPTS
    ) {
      autoLoadAttemptsRef.current += 1;
      const timer = setTimeout(() => {
        loadMorePagedActivities();
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [
    optimizedChatHistoryLength,
    hasMoreActivities,
    isLoadingMore,
    loadMoreActivities,
    loadMorePagedActivities,
  ]);

  return {
    isLoadingMore,
    handleRangeChanged,
    handleEndReached,
  };
}

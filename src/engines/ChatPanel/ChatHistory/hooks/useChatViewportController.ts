import { useCallback, useEffect, useRef, useState } from "react";

import type {
  BrowserAddToConversationNavState,
  FollowAgentNavState,
  ScrollNavState,
} from "../ChatHistory.types";
import { getChatContentBottomDistance } from "../config/chatFooterSpacer";
import type { UseChatEmptyStateReturn } from "./useChatEmptyState";
import { useChatFooterSpacer } from "./useChatFooterSpacer";
import type { UseChatHistoryStateReturn } from "./useChatHistoryState";
import { useChatPagination } from "./useChatPagination";
import { useChatScroll } from "./useChatScroll";
import { useChatScrollPin } from "./useChatScrollPin";

const SCROLL_NAV_SHOW_THRESHOLD_PX = 48;
const FLOATING_MINIMAP_IDLE_DELAY_MS = 1_200;

interface UseChatViewportControllerOptions {
  activeId: string | null;
  activeProjectionHistoryLength: number;
  atBottom: UseChatHistoryStateReturn["atBottom"];
  bottomInset: number;
  browserAddToConversationNav: BrowserAddToConversationNavState;
  currentPageIndex: number;
  disableTailCollapse: boolean;
  displayGroupCounts: number[];
  displayLastGroupFirstFlatIndex: number | null;
  displayTotalFlatItems: number;
  followAgentNav: FollowAgentNavState;
  isPendingCancelRef: UseChatEmptyStateReturn["isPendingCancelRef"];
  latestGroupIsLocalSubmit: boolean;
  onScrollNavChange?: (state: ScrollNavState) => void;
  planningIndicatorCount: 0 | 1;
  sessionLoadStatus: UseChatHistoryStateReturn["sessionLoadStatus"];
  setAtBottom: UseChatHistoryStateReturn["setAtBottom"];
  setIsChatScrolledToBottom: UseChatHistoryStateReturn["setIsChatScrolledToBottom"];
  setVisibleRange: UseChatHistoryStateReturn["setVisibleRange"];
  tailFollowKey: string;
  totalFlatItems: number;
  turnPaginationEnabled: boolean;
}

/**
 * Coordinates pagination range tracking, footer measurement, bottom-follow,
 * pinning and the external scroll-navigation controls around one scroll root.
 */
export function useChatViewportController({
  activeId,
  activeProjectionHistoryLength,
  atBottom,
  bottomInset,
  browserAddToConversationNav,
  currentPageIndex,
  disableTailCollapse,
  displayGroupCounts,
  displayLastGroupFirstFlatIndex,
  displayTotalFlatItems,
  followAgentNav,
  isPendingCancelRef,
  latestGroupIsLocalSubmit,
  onScrollNavChange,
  planningIndicatorCount,
  sessionLoadStatus,
  setAtBottom,
  setIsChatScrolledToBottom,
  setVisibleRange,
  tailFollowKey,
  totalFlatItems,
  turnPaginationEnabled,
}: UseChatViewportControllerOptions) {
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const staticScrollerRef = useRef<HTMLDivElement>(null);
  const visibleRangeEndRef = useRef(0);
  const pinLastGroupRef = useRef(false);
  const manualScrollAtRef = useRef(0);
  const programmaticScrollAtRef = useRef(0);
  const turnCollapseInteractionAtRef = useRef(0);
  const [reservePinToTop, setReservePinToTop] = useState(false);
  const handlePinToTopChange = useCallback((active: boolean) => {
    setReservePinToTop(active);
  }, []);

  const { isLoadingMore, handleRangeChanged, handleEndReached } =
    useChatPagination({
      optimizedChatHistoryLength: totalFlatItems,
      setVisibleRange,
      visibleRangeEndRef,
    });
  const { footerSpacerHeight, virtuosoScrollerRef, isContentOverflowingRef } =
    useChatFooterSpacer({
      scrollAreaRef,
      optimizedChatHistoryLength: activeProjectionHistoryLength,
      totalFlatItems: displayTotalFlatItems,
      planningIndicatorCount,
      lastGroupFirstFlatIndex: displayLastGroupFirstFlatIndex,
      bottomInset,
      reservePinToTop,
      manualScrollAtRef,
    });
  const [isBottomSentinelVisible, setIsBottomSentinelVisible] = useState(true);

  useEffect(() => {
    if (displayTotalFlatItems <= 0) return;
    const root = staticScrollerRef.current ?? virtuosoScrollerRef.current;
    if (!root) {
      const rafId = requestAnimationFrame(() => {
        setIsBottomSentinelVisible(false);
      });
      return () => cancelAnimationFrame(rafId);
    }

    let rafId = 0;
    let lastMeasurementKey = "";
    const updateBottomLineVisibility = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const measurementKey = [
          root.scrollTop,
          root.scrollHeight,
          root.clientHeight,
          footerSpacerHeight,
        ].join(":");
        if (measurementKey === lastMeasurementKey) return;
        lastMeasurementKey = measurementKey;

        const nextVisible =
          getChatContentBottomDistance({
            scrollTop: root.scrollTop,
            scrollHeight: root.scrollHeight,
            clientHeight: root.clientHeight,
            footerSpacerHeight,
            bottomInset,
          }) <= SCROLL_NAV_SHOW_THRESHOLD_PX;
        setIsBottomSentinelVisible((previousVisible) =>
          previousVisible === nextVisible ? previousVisible : nextVisible
        );
      });
    };

    updateBottomLineVisibility();
    root.addEventListener("scroll", updateBottomLineVisibility, {
      passive: true,
    });
    const resizeObserver = new ResizeObserver(updateBottomLineVisibility);
    resizeObserver.observe(root);
    if (root.firstElementChild) resizeObserver.observe(root.firstElementChild);

    return () => {
      cancelAnimationFrame(rafId);
      root.removeEventListener("scroll", updateBottomLineVisibility);
      resizeObserver.disconnect();
    };
  }, [
    activeId,
    bottomInset,
    displayTotalFlatItems,
    footerSpacerHeight,
    virtuosoScrollerRef,
  ]);

  const { handleAtBottomStateChange, scrollToBottom } = useChatScroll({
    optimizedChatHistoryLength: displayTotalFlatItems,
    virtuosoScrollerRef,
    atBottom,
    setAtBottom,
    setIsChatScrolledToBottom,
    isPendingCancelRef,
    visibleRangeEndRef,
    pinLastGroupRef,
    manualScrollAtRef,
    programmaticScrollAtRef,
    turnCollapseInteractionAtRef,
    isContentOverflowingRef,
    activeSessionId: activeId,
    staticScrollerRef,
    footerSpacerHeight,
    bottomInset,
    tailFollowKey,
    alwaysFollowTail: disableTailCollapse,
  });
  const [conversationMinimapScrolling, setConversationMinimapScrolling] =
    useState(false);
  const conversationMinimapIdleTimerRef = useRef<number | null>(null);
  const handleChatListScrollStateChange = useCallback(
    (nextAtBottom: boolean) => {
      handleAtBottomStateChange(nextAtBottom);
      setConversationMinimapScrolling(true);
      if (conversationMinimapIdleTimerRef.current !== null) {
        window.clearTimeout(conversationMinimapIdleTimerRef.current);
      }
      conversationMinimapIdleTimerRef.current = window.setTimeout(() => {
        conversationMinimapIdleTimerRef.current = null;
        setConversationMinimapScrolling(false);
      }, FLOATING_MINIMAP_IDLE_DELAY_MS);
    },
    [handleAtBottomStateChange]
  );
  useEffect(
    () => () => {
      if (conversationMinimapIdleTimerRef.current !== null) {
        window.clearTimeout(conversationMinimapIdleTimerRef.current);
      }
    },
    []
  );

  useEffect(() => {
    if (!disableTailCollapse || displayTotalFlatItems <= 0) return;
    const handle = window.requestAnimationFrame(() => scrollToBottom());
    return () => window.cancelAnimationFrame(handle);
  }, [
    disableTailCollapse,
    activeId,
    currentPageIndex,
    displayTotalFlatItems,
    scrollToBottom,
  ]);

  useChatScrollPin({
    activeId,
    groupCounts: displayGroupCounts,
    totalFlatItems: displayTotalFlatItems,
    footerSpacerHeight,
    bottomInset,
    sessionLoadStatus,
    virtuosoScrollerRef,
    atBottom,
    isPendingCancelRef,
    isContentOverflowingRef,
    optimizedChatHistoryLength: activeProjectionHistoryLength,
    latestGroupIsLocalSubmit,
    pinLastGroupRef,
    manualScrollAtRef,
    programmaticScrollAtRef,
    onPinToTopChange: handlePinToTopChange,
    staticScrollerRef,
  });

  const showScrollToBottom =
    displayTotalFlatItems > 0 && !isBottomSentinelVisible;
  useEffect(() => {
    onScrollNavChange?.({
      showScrollToBottom,
      onScrollToBottom: scrollToBottom,
      ...followAgentNav,
      ...browserAddToConversationNav,
    });
  }, [
    browserAddToConversationNav,
    followAgentNav,
    onScrollNavChange,
    scrollToBottom,
    showScrollToBottom,
  ]);

  const handleTurnPageEndReached = useCallback(() => {
    if (!turnPaginationEnabled) handleEndReached();
  }, [turnPaginationEnabled, handleEndReached]);

  return {
    conversationMinimapScrolling,
    footerSpacerHeight,
    handleChatListScrollStateChange,
    handleRangeChanged,
    handleTurnPageEndReached,
    scrollAreaRef,
    scrollToBottom,
    staticScrollerRef,
    turnCollapseInteractionAtRef,
    virtuosoScrollerRef,
    isLoadingMore,
  };
}

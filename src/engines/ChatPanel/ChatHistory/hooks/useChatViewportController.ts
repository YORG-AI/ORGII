import {
  type MutableRefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import type {
  BrowserAddToConversationNavState,
  FollowAgentNavState,
  ScrollNavState,
} from "../ChatHistory.types";
import type { ChatHistoryStartSignalSource } from "../components/ChatHistoryListTypes";
import { getChatContentBottomDistance } from "../config/chatFooterSpacer";
import type { UseChatEmptyStateReturn } from "./useChatEmptyState";
import { useChatFooterSpacer } from "./useChatFooterSpacer";
import type { UseChatHistoryStateReturn } from "./useChatHistoryState";
import { useChatPagination } from "./useChatPagination";
import { useChatScroll } from "./useChatScroll";
import { useChatScrollPin } from "./useChatScrollPin";

const SCROLL_NAV_SHOW_THRESHOLD_PX = 48;
const FLOATING_MINIMAP_IDLE_DELAY_MS = 1_200;
export const HISTORY_START_USER_BACKFILL_WINDOW_BUDGET = 4;

interface HistoryStartBackfillSignal {
  atStart: boolean;
  source: ChatHistoryStartSignalSource;
}

type HistoryStartBackfillReason = "bootstrap" | "user";
type HistoryStartBackfillResult = boolean | void;
type HistoryStartBackfillLoader = (
  reason: HistoryStartBackfillReason,
  windowIndex: number
) => Promise<HistoryStartBackfillResult> | HistoryStartBackfillResult;

interface HistoryViewportAnchor {
  kind: "item" | "group";
  key: string;
  offsetTop: number;
  fallbackGroupKey: string | null;
  fallbackGroupOffsetTop: number | null;
}

function captureHistoryViewportAnchor(
  scrollRoot: HTMLElement | null
): HistoryViewportAnchor | null {
  if (!scrollRoot) return null;
  const rootRect = scrollRoot.getBoundingClientRect();
  const findVisible = (selector: string) =>
    Array.from(scrollRoot.querySelectorAll<HTMLElement>(selector)).find(
      (element) => {
        const rect = element.getBoundingClientRect();
        return rect.bottom > rootRect.top + 1 && rect.top < rootRect.bottom - 1;
      }
    );
  const visibleItem = findVisible("[data-chat-item-key]");
  const visibleGroup =
    visibleItem?.closest<HTMLElement>("[data-chat-group-key]") ??
    findVisible("[data-chat-group-key]") ??
    null;
  const visibleElement = visibleItem ?? visibleGroup;
  const anchorKey =
    visibleItem?.dataset.chatItemKey ??
    visibleElement?.dataset.chatGroupKey ??
    null;
  if (!visibleElement || !anchorKey) return null;
  return {
    kind: visibleItem ? "item" : "group",
    key: anchorKey,
    offsetTop: visibleElement.getBoundingClientRect().top - rootRect.top,
    fallbackGroupKey: visibleGroup?.dataset.chatGroupKey ?? null,
    fallbackGroupOffsetTop: visibleGroup
      ? visibleGroup.getBoundingClientRect().top - rootRect.top
      : null,
  };
}

function findHistoryViewportAnchor(
  scrollRoot: HTMLElement,
  anchor: HistoryViewportAnchor
): HTMLElement | null {
  const selector =
    anchor.kind === "item" ? "[data-chat-item-key]" : "[data-chat-group-key]";
  const datasetKey = anchor.kind === "item" ? "chatItemKey" : "chatGroupKey";
  return (
    Array.from(scrollRoot.querySelectorAll<HTMLElement>(selector)).find(
      (element) => element.dataset[datasetKey] === anchor.key
    ) ?? null
  );
}

function restoreHistoryViewportAnchor(
  scrollRoot: HTMLElement,
  anchor: HistoryViewportAnchor
): boolean {
  const rootRect = scrollRoot.getBoundingClientRect();
  let anchorElement = findHistoryViewportAnchor(scrollRoot, anchor);
  let expectedOffset = anchor.offsetTop;
  if (
    !anchorElement &&
    anchor.fallbackGroupKey &&
    anchor.fallbackGroupOffsetTop !== null
  ) {
    anchorElement =
      Array.from(
        scrollRoot.querySelectorAll<HTMLElement>("[data-chat-group-key]")
      ).find(
        (element) => element.dataset.chatGroupKey === anchor.fallbackGroupKey
      ) ?? null;
    expectedOffset = anchor.fallbackGroupOffsetTop;
  }
  if (!anchorElement) return false;
  const currentOffset =
    anchorElement.getBoundingClientRect().top - rootRect.top;
  const correction = currentOffset - expectedOffset;
  if (Math.abs(correction) > 0.5) {
    scrollRoot.scrollTop += correction;
  }
  return true;
}

async function waitForHistoryLayout(): Promise<void> {
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve());
    });
  });
}

export interface HistoryStartBackfillGate {
  bootstrap: () => Promise<void>;
  reset: () => void;
  setLoadPrevious: (loadPrevious: HistoryStartBackfillLoader) => void;
  signal: (signal: HistoryStartBackfillSignal) => void;
}

/**
 * Serialize scroll-back reads while preserving one user gesture that arrives
 * during the current read.
 *
 * Trackpads keep emitting `wheel` at scrollTop=0 but browsers stop emitting
 * `scroll`. Without the queued bit, a fast gesture that overlaps the initial
 * bounded bootstrap is lost and the history remains stuck at two turns.
 */
export function createHistoryStartBackfillGate(
  loadPrevious: HistoryStartBackfillLoader
): HistoryStartBackfillGate {
  let currentLoadPrevious = loadPrevious;
  let generation = 0;
  let inFlight: Promise<void> | null = null;
  let activeReason: HistoryStartBackfillReason | null = null;
  let bootstrapComplete = false;
  let queuedUserBurst = false;
  let cancelActiveUserBurst = false;

  const start = (reason: HistoryStartBackfillReason): Promise<void> => {
    if (inFlight) return inFlight;
    const requestGeneration = generation;
    cancelActiveUserBurst = false;
    const windowBudget =
      reason === "user" ? HISTORY_START_USER_BACKFILL_WINDOW_BUDGET : 1;
    const load = (async () => {
      for (let windowIndex = 0; windowIndex < windowBudget; windowIndex += 1) {
        if (
          requestGeneration !== generation ||
          (reason === "user" && cancelActiveUserBurst)
        ) {
          break;
        }
        const progressed = await currentLoadPrevious(reason, windowIndex);
        if (progressed === false) break;
      }
    })();
    inFlight = load;
    activeReason = reason;
    const finish = () => {
      if (requestGeneration !== generation || inFlight !== load) return;
      inFlight = null;
      activeReason = null;
      cancelActiveUserBurst = false;
      if (!queuedUserBurst) return;
      queuedUserBurst = false;
      // A top-edge wheel that overlaps bootstrap still represents one real
      // scroll-back gesture. Run its bounded burst only after bootstrap has
      // advanced the cursor; repeated wheel ticks coalesce into this one job.
      void start("user").catch(() => {
        // The caller owns diagnostics. A failed queued page must still leave
        // the gate re-armed for the next explicit user gesture.
      });
    };
    void load.then(finish, finish);
    return load;
  };

  return {
    async bootstrap() {
      if (bootstrapComplete) return;
      const bootstrapGeneration = generation;
      await start("bootstrap");
      // A reset invalidates the completion and leaves the new episode free to
      // run its own bootstrap.
      if (bootstrapGeneration === generation) bootstrapComplete = true;
    },
    reset() {
      generation += 1;
      inFlight = null;
      activeReason = null;
      bootstrapComplete = false;
      queuedUserBurst = false;
      cancelActiveUserBurst = true;
    },
    setLoadPrevious(nextLoadPrevious) {
      currentLoadPrevious = nextLoadPrevious;
    },
    signal(signal) {
      if (!signal.atStart) {
        // A positive wheel is an explicit reversal by the user. Ordinary
        // scroll geometry may move away from zero while a prepend preserves
        // the viewport anchor, so it must not erase an already queued
        // top-edge wheel.
        if (signal.source === "wheel") {
          queuedUserBurst = false;
          cancelActiveUserBurst = true;
        }
        return;
      }
      // A data/layout refresh reports the new geometry, but it is not user
      // demand. In particular, prepending one bounded page changes the list
      // key and produces another layout signal; starting here would silently
      // chain through the full transcript without another wheel/scroll.
      if (signal.source === "layout" || signal.source === "programmatic") {
        return;
      }
      if (inFlight) {
        // A burst already contains several sequential bounded windows, so
        // wheel ticks emitted by that same trackpad gesture must not multiply
        // it. Only bootstrap needs to retain one user burst for afterwards.
        if (signal.source === "wheel" && activeReason === "bootstrap") {
          queuedUserBurst = true;
        }
        return;
      }
      void start("user").catch(() => {
        // The caller owns diagnostics. The gate only guarantees that a failed
        // page does not permanently disable the next user request.
      });
    },
  };
}

interface UseChatViewportControllerOptions {
  activeId: string | null;
  activeProjectionHistoryLength: number;
  atBottom: UseChatHistoryStateReturn["atBottom"];
  bottomInset: number;
  browserAddToConversationNav: BrowserAddToConversationNavState;
  currentPageIndex: number;
  disableTailCollapse: boolean;
  displayTurnIds: readonly (string | null)[];
  displayLastGroupFirstFlatIndex: number | null;
  displayTotalFlatItems: number;
  followAgentNav: FollowAgentNavState;
  isPendingCancelRef: UseChatEmptyStateReturn["isPendingCancelRef"];
  manualScrollAtRef?: MutableRefObject<number>;
  onHistoryStartReached?: () => Promise<HistoryStartBackfillResult>;
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
  displayTurnIds,
  displayLastGroupFirstFlatIndex,
  displayTotalFlatItems,
  followAgentNav,
  isPendingCancelRef,
  manualScrollAtRef: suppliedManualScrollAtRef,
  onHistoryStartReached,
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
  const fallbackManualScrollAtRef = useRef(0);
  const manualScrollAtRef =
    suppliedManualScrollAtRef ?? fallbackManualScrollAtRef;
  const programmaticScrollAtRef = useRef(0);
  const userBackfillAnchorRef = useRef<HistoryViewportAnchor | null>(null);
  const turnCollapseInteractionAtRef = useRef(0);
  const [reservePinToTop, setReservePinToTop] = useState(false);
  const handlePinToTopChange = useCallback((active: boolean) => {
    setReservePinToTop(active);
  }, []);

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
  const { isLoadingMore, handleRangeChanged, handleEndReached } =
    useChatPagination({
      optimizedChatHistoryLength: totalFlatItems,
      setVisibleRange,
      visibleRangeEndRef,
    });
  const loadPreviousPreservingViewport = useCallback(
    async (
      reason: HistoryStartBackfillReason,
      windowIndex: number
    ): Promise<HistoryStartBackfillResult> => {
      if (!onHistoryStartReached) return false;
      if (reason === "bootstrap") return onHistoryStartReached();

      const scrollRoot =
        staticScrollerRef.current ?? virtuosoScrollerRef.current;
      const previousScrollTop = scrollRoot?.scrollTop ?? 0;
      const previousScrollHeight = scrollRoot?.scrollHeight ?? 0;
      if (windowIndex === 0) {
        userBackfillAnchorRef.current =
          captureHistoryViewportAnchor(scrollRoot);
      }
      const viewportAnchor = userBackfillAnchorRef.current;
      const progressed = await onHistoryStartReached();
      if (!progressed || !scrollRoot?.isConnected) return progressed;

      // EventStore publication precedes React layout. Two frames let the
      // virtual list publish its new total height before restoring the visual
      // anchor that was at the top when this bounded page was requested.
      await waitForHistoryLayout();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const currentScrollRoot =
          staticScrollerRef.current ?? virtuosoScrollerRef.current;
        if (!currentScrollRoot) return progressed;
        programmaticScrollAtRef.current = performance.now();
        if (
          viewportAnchor &&
          restoreHistoryViewportAnchor(currentScrollRoot, viewportAnchor)
        ) {
          // ResizeObserver can publish one later virtual-row measurement after
          // the first correction. Recheck the stable provider/native group key
          // on the next layout frame instead of accumulating that error.
          await waitForHistoryLayout();
          continue;
        }
        const heightGrowth =
          currentScrollRoot.scrollHeight - previousScrollHeight;
        currentScrollRoot.scrollTop = Math.max(
          0,
          previousScrollTop + heightGrowth
        );
        await waitForHistoryLayout();
      }
      return progressed;
    },
    [onHistoryStartReached, virtuosoScrollerRef]
  );
  const [historyStartBackfillGate] = useState(() =>
    createHistoryStartBackfillGate(() => false)
  );
  const bootstrapRetryCountRef = useRef(0);
  const bootstrapRetryTimerRef = useRef<number | null>(null);
  const [bootstrapRetryRevision, setBootstrapRetryRevision] = useState(0);
  useEffect(() => {
    historyStartBackfillGate.setLoadPrevious(loadPreviousPreservingViewport);
  }, [historyStartBackfillGate, loadPreviousPreservingViewport]);
  useEffect(
    () => () => {
      historyStartBackfillGate.reset();
    },
    [
      activeId,
      historyStartBackfillGate,
      sessionLoadStatus,
      turnPaginationEnabled,
    ]
  );
  useEffect(() => {
    if (
      turnPaginationEnabled ||
      !activeId ||
      sessionLoadStatus !== "loaded" ||
      !onHistoryStartReached
    ) {
      bootstrapRetryCountRef.current = 0;
      return;
    }

    let cancelled = false;
    void historyStartBackfillGate
      .bootstrap()
      .then(() => {
        if (!cancelled) bootstrapRetryCountRef.current = 0;
      })
      .catch(() => {
        if (cancelled || bootstrapRetryCountRef.current >= 2) return;
        bootstrapRetryCountRef.current += 1;
        if (bootstrapRetryTimerRef.current !== null) {
          window.clearTimeout(bootstrapRetryTimerRef.current);
        }
        bootstrapRetryTimerRef.current = window.setTimeout(() => {
          bootstrapRetryTimerRef.current = null;
          setBootstrapRetryRevision((revision) => revision + 1);
        }, 500);
      });

    return () => {
      cancelled = true;
      if (bootstrapRetryTimerRef.current !== null) {
        window.clearTimeout(bootstrapRetryTimerRef.current);
        bootstrapRetryTimerRef.current = null;
      }
    };
  }, [
    activeId,
    bootstrapRetryRevision,
    historyStartBackfillGate,
    onHistoryStartReached,
    sessionLoadStatus,
    turnPaginationEnabled,
  ]);
  const handleAtStartStateChange = useCallback(
    (
      atStart: boolean,
      _canScroll: boolean,
      source: ChatHistoryStartSignalSource
    ) => {
      if (!onHistoryStartReached) return;
      historyStartBackfillGate.signal({ atStart, source });
    },
    [historyStartBackfillGate, onHistoryStartReached]
  );
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
    groupTurnIds: displayTurnIds,
    totalFlatItems: displayTotalFlatItems,
    footerSpacerHeight,
    bottomInset,
    sessionLoadStatus,
    virtuosoScrollerRef,
    atBottom,
    isPendingCancelRef,
    isContentOverflowingRef,
    optimizedChatHistoryLength: activeProjectionHistoryLength,
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
    handleAtStartStateChange,
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

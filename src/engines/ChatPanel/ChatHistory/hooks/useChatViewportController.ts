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
export const HISTORY_START_INITIAL_USER_WINDOW_BUDGET = 4;
export const HISTORY_START_MAX_USER_WINDOW_BUDGET = 12;
export const HISTORY_START_MAX_USER_IPC_BYTES = 16 * 1024 * 1024;
const HISTORY_START_FINAL_ANCHOR_SETTLE_PASSES = 4;

interface HistoryStartBackfillSignal {
  atStart: boolean;
  source: ChatHistoryStartSignalSource;
}

type HistoryStartBackfillReason = "bootstrap" | "user";
export interface HistoryStartBackfillProgress {
  ipcBytes: number;
  progressed: boolean;
}
type HistoryStartBackfillResult = HistoryStartBackfillProgress | boolean | void;
type HistoryStartBackfillLoader = (
  reason: HistoryStartBackfillReason,
  windowIndex: number
) => Promise<HistoryStartBackfillResult> | HistoryStartBackfillResult;

interface HistoryStartBackfillLifecycle {
  onBurstEnd?: (
    reason: HistoryStartBackfillReason,
    loadedWindows: number,
    cancelled: boolean
  ) => Promise<void> | void;
  onBurstStart?: (reason: HistoryStartBackfillReason) => void;
  onWindowLoaded?: (
    reason: HistoryStartBackfillReason,
    windowIndex: number
  ) => Promise<void> | void;
}

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

function resolveConnectedHistoryScrollRoot(
  staticScrollRoot: HTMLElement | null,
  virtualScrollRoot: HTMLElement | null
): HTMLElement | null {
  if (staticScrollRoot?.isConnected) return staticScrollRoot;
  if (virtualScrollRoot?.isConnected) return virtualScrollRoot;
  return null;
}

export interface HistoryStartBackfillGate {
  bootstrap: () => Promise<void>;
  reset: () => void;
  setLifecycle: (lifecycle: HistoryStartBackfillLifecycle) => void;
  setLoadPrevious: (loadPrevious: HistoryStartBackfillLoader) => void;
  signal: (signal: HistoryStartBackfillSignal) => void;
}

export function shouldForwardHistoryStartSignal(
  turnPaginationEnabled: boolean,
  source: ChatHistoryStartSignalSource
): boolean {
  // Selecting a bounded Round replaces the rendered list and can emit a
  // browser `scroll` at physical top even though the user did not request the
  // unread prefix. In pagination mode, wait for the explicit upward wheel
  // signal; otherwise that layout reset can immediately overwrite the exact
  // anchored turn window with a continuation slice.
  return !(turnPaginationEnabled && source === "scroll");
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
  loadPrevious: HistoryStartBackfillLoader,
  lifecycle: HistoryStartBackfillLifecycle = {}
): HistoryStartBackfillGate {
  let currentLoadPrevious = loadPrevious;
  let currentLifecycle = lifecycle;
  let generation = 0;
  let inFlight: Promise<void> | null = null;
  let activeReason: HistoryStartBackfillReason | null = null;
  let bootstrapComplete = false;
  let queuedUserWindows = 0;
  let cancelActiveUserBurst = false;
  let requestedUserWindows = HISTORY_START_INITIAL_USER_WINDOW_BUDGET;

  const normalizeLoadResult = (
    result: HistoryStartBackfillResult
  ): HistoryStartBackfillProgress => {
    if (typeof result !== "object" || result === null) {
      return {
        ipcBytes: 0,
        progressed: result !== false,
      };
    }
    return {
      ipcBytes:
        Number.isFinite(result.ipcBytes) && result.ipcBytes > 0
          ? result.ipcBytes
          : 0,
      progressed: result.progressed,
    };
  };

  const start = (
    reason: HistoryStartBackfillReason,
    initialUserWindowBudget = HISTORY_START_INITIAL_USER_WINDOW_BUDGET
  ): Promise<void> => {
    if (inFlight) return inFlight;
    const requestGeneration = generation;
    cancelActiveUserBurst = false;
    requestedUserWindows =
      reason === "user"
        ? Math.min(
            HISTORY_START_MAX_USER_WINDOW_BUDGET,
            Math.max(
              HISTORY_START_INITIAL_USER_WINDOW_BUDGET,
              initialUserWindowBudget
            )
          )
        : HISTORY_START_INITIAL_USER_WINDOW_BUDGET;
    const load = (async () => {
      let accumulatedIpcBytes = 0;
      let loadedWindows = 0;
      currentLifecycle.onBurstStart?.(reason);
      try {
        for (
          let windowIndex = 0;
          windowIndex < (reason === "user" ? requestedUserWindows : 1);
          windowIndex += 1
        ) {
          if (
            requestGeneration !== generation ||
            (reason === "user" && cancelActiveUserBurst)
          ) {
            break;
          }
          const result = normalizeLoadResult(
            await currentLoadPrevious(reason, windowIndex)
          );
          if (!result.progressed) break;
          loadedWindows += 1;
          accumulatedIpcBytes += result.ipcBytes;
          await currentLifecycle.onWindowLoaded?.(reason, windowIndex);
          if (
            reason === "user" &&
            accumulatedIpcBytes >= HISTORY_START_MAX_USER_IPC_BYTES
          ) {
            break;
          }
        }
      } finally {
        await currentLifecycle.onBurstEnd?.(
          reason,
          loadedWindows,
          requestGeneration !== generation ||
            (reason === "user" && cancelActiveUserBurst)
        );
      }
    })();
    inFlight = load;
    activeReason = reason;
    const finish = () => {
      if (requestGeneration !== generation || inFlight !== load) return;
      inFlight = null;
      activeReason = null;
      cancelActiveUserBurst = false;
      if (queuedUserWindows === 0) return;
      const queuedWindowBudget = queuedUserWindows;
      queuedUserWindows = 0;
      // A top-edge gesture can overlap the initial bounded bootstrap on a
      // large session. Preserve its capped momentum and run it only after the
      // bootstrap advances the cursor.
      void start("user", queuedWindowBudget).catch(() => {
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
      queuedUserWindows = 0;
      cancelActiveUserBurst = true;
    },
    setLoadPrevious(nextLoadPrevious) {
      currentLoadPrevious = nextLoadPrevious;
    },
    setLifecycle(nextLifecycle) {
      currentLifecycle = nextLifecycle;
    },
    signal(signal) {
      if (!signal.atStart) {
        // A positive wheel is an explicit reversal by the user. Ordinary
        // scroll geometry may move away from zero while a prepend preserves
        // the viewport anchor, so it must not erase an already queued
        // top-edge wheel.
        if (signal.source === "wheel") {
          queuedUserWindows = 0;
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
        if (signal.source === "wheel" && activeReason === "bootstrap") {
          queuedUserWindows =
            queuedUserWindows === 0
              ? HISTORY_START_INITIAL_USER_WINDOW_BUDGET
              : Math.min(
                  HISTORY_START_MAX_USER_WINDOW_BUDGET,
                  queuedUserWindows + 1
                );
        } else if (
          signal.source === "wheel" &&
          activeReason === "user" &&
          requestedUserWindows < HISTORY_START_MAX_USER_WINDOW_BUDGET
        ) {
          // Trackpad momentum is real continued demand. Grow the current
          // serialized burst instead of discarding every tick that arrives
          // while one bounded page is in flight.
          requestedUserWindows += 1;
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
  const userBackfillViewportRef = useRef<{
    anchor: HistoryViewportAnchor | null;
    previousScrollHeight: number;
    previousScrollTop: number;
  } | null>(null);
  const anchorRestoreFrameRef = useRef<number | null>(null);
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
  const loadPreviousWindow = useCallback(
    async (): Promise<HistoryStartBackfillResult> =>
      onHistoryStartReached ? onHistoryStartReached() : false,
    [onHistoryStartReached]
  );
  const restoreUserBackfillViewport = useCallback(() => {
    const viewport = userBackfillViewportRef.current;
    const scrollRoot = resolveConnectedHistoryScrollRoot(
      staticScrollerRef.current,
      virtuosoScrollerRef.current
    );
    if (!viewport || !scrollRoot) return;
    programmaticScrollAtRef.current = performance.now();
    if (
      viewport.anchor &&
      restoreHistoryViewportAnchor(scrollRoot, viewport.anchor)
    ) {
      return;
    }
    const heightGrowth =
      scrollRoot.scrollHeight - viewport.previousScrollHeight;
    scrollRoot.scrollTop = Math.max(
      0,
      viewport.previousScrollTop + heightGrowth
    );
  }, [virtuosoScrollerRef]);
  const scheduleUserBackfillViewportRestore = useCallback(() => {
    if (anchorRestoreFrameRef.current !== null) return;
    anchorRestoreFrameRef.current = window.requestAnimationFrame(() => {
      anchorRestoreFrameRef.current = window.requestAnimationFrame(() => {
        anchorRestoreFrameRef.current = null;
        restoreUserBackfillViewport();
      });
    });
  }, [restoreUserBackfillViewport]);
  const [historyStartBackfillGate] = useState(() =>
    createHistoryStartBackfillGate(() => false)
  );
  useEffect(() => {
    historyStartBackfillGate.setLifecycle({
      onBurstStart(reason) {
        if (reason !== "user") return;
        const scrollRoot = resolveConnectedHistoryScrollRoot(
          staticScrollerRef.current,
          virtuosoScrollerRef.current
        );
        userBackfillViewportRef.current = {
          anchor: captureHistoryViewportAnchor(scrollRoot),
          previousScrollHeight: scrollRoot?.scrollHeight ?? 0,
          previousScrollTop: scrollRoot?.scrollTop ?? 0,
        };
      },
      async onWindowLoaded(reason) {
        if (reason !== "user") return;
        scheduleUserBackfillViewportRestore();
        // EventStore publication and the replay read are sequential, but
        // React layout is not. Yield one two-frame layout generation between
        // windows so a fast gesture does not queue the entire burst ahead of
        // Virtuoso and freeze the renderer in one oversized commit.
        await waitForHistoryLayout();
      },
      async onBurstEnd(reason, loadedWindows, cancelled) {
        if (reason !== "user") return;
        if (!cancelled && loadedWindows > 0) {
          if (anchorRestoreFrameRef.current !== null) {
            window.cancelAnimationFrame(anchorRestoreFrameRef.current);
            anchorRestoreFrameRef.current = null;
          }
          // React publishes each bounded window before Virtuoso finishes
          // measuring the inserted rows. Keep per-window work coalesced, then
          // converge only once at the end of the gesture across a few layout
          // generations. This avoids the old stop/start correction after
          // every page without letting a late ResizeObserver update displace
          // the user's original visible item.
          for (
            let pass = 0;
            pass < HISTORY_START_FINAL_ANCHOR_SETTLE_PASSES;
            pass += 1
          ) {
            await waitForHistoryLayout();
            restoreUserBackfillViewport();
          }
        }
        userBackfillViewportRef.current = null;
      },
    });
    return () => historyStartBackfillGate.setLifecycle({});
  }, [
    historyStartBackfillGate,
    restoreUserBackfillViewport,
    scheduleUserBackfillViewportRestore,
    virtuosoScrollerRef,
  ]);
  const bootstrapRetryCountRef = useRef(0);
  const bootstrapRetryTimerRef = useRef<number | null>(null);
  const [bootstrapRetryRevision, setBootstrapRetryRevision] = useState(0);
  useEffect(() => {
    historyStartBackfillGate.setLoadPrevious(loadPreviousWindow);
  }, [historyStartBackfillGate, loadPreviousWindow]);
  useEffect(
    () => () => {
      if (anchorRestoreFrameRef.current !== null) {
        window.cancelAnimationFrame(anchorRestoreFrameRef.current);
        anchorRestoreFrameRef.current = null;
      }
      userBackfillViewportRef.current = null;
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
      if (!shouldForwardHistoryStartSignal(turnPaginationEnabled, source)) {
        return;
      }
      historyStartBackfillGate.signal({ atStart, source });
    },
    [historyStartBackfillGate, onHistoryStartReached, turnPaginationEnabled]
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

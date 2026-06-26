import {
  type MutableRefObject,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";

export interface UseChatScrollPinOptions {
  activeId: string | null;
  groupCounts: number[];
  totalFlatItems: number;
  sessionLoadStatus: string;
  virtuosoScrollerRef: RefObject<HTMLElement | null>;
  atBottom: boolean;
  isPendingCancelRef: MutableRefObject<boolean>;
  isContentOverflowingRef: MutableRefObject<boolean>;
  optimizedChatHistoryLength: number;
  /**
   * Shared ref owned by the parent. Both useChatScroll and useChatScrollPin
   * read/write this ref so they coordinate pin intent without re-renders.
   */
  pinLastGroupRef: MutableRefObject<boolean>;
  /** Updated when the scroller receives a real user scroll, not a programmatic correction. */
  manualScrollAtRef?: MutableRefObject<number>;
  onPinToTopChange?: (active: boolean) => void;
  /**
   * Fallback scroll container for the static rendering path.
   */
  staticScrollerRef?: MutableRefObject<HTMLDivElement | null>;
}

export interface UseChatScrollPinReturn {
  scrollToEnd: () => void;
  programmaticScrollAtRef: MutableRefObject<number>;
}

/**
 * Manages three scroll-pin behaviours for ChatHistory:
 *
 * 1. Re-pin last item when footer spacer converges or history grows.
 *    Always scrolls to end on session switch.
 * 2. Pin the latest user-message group to the viewport top when a new
 *    group is added. Re-fires as the temporary footer
 *    reserve grows so the first scroll lands at the correct offset.
 * 3. Breaks pin intent on user-initiated scroll. Distinguishes programmatic
 *    scrolls (ignored) from user scrolls (releases pin) via a time window.
 *    The listener is mounted once and reads live state via refs — it is NOT
 *    re-registered on every new message, eliminating monitoring gaps.
 */
export function useChatScrollPin({
  activeId,
  groupCounts,
  totalFlatItems: _totalFlatItems,
  sessionLoadStatus: _sessionLoadStatus,
  virtuosoScrollerRef,
  atBottom: _atBottom,
  isPendingCancelRef: _isPendingCancelRef,
  isContentOverflowingRef: _isContentOverflowingRef,
  optimizedChatHistoryLength,
  pinLastGroupRef,
  manualScrollAtRef,
  onPinToTopChange,
  staticScrollerRef,
}: UseChatScrollPinOptions): UseChatScrollPinReturn {
  const programmaticScrollAtRef = useRef(0);
  const fallbackManualScrollAtRef = useRef(0);
  const effectiveManualScrollAtRef =
    manualScrollAtRef ?? fallbackManualScrollAtRef;

  // Keep a ref to onPinToTopChange so Effect 3's listener doesn't need
  // it in the dependency array (avoids re-registering the scroll listener
  // every time the callback identity changes).
  const onPinToTopChangeRef = useRef(onPinToTopChange);
  useEffect(() => {
    onPinToTopChangeRef.current = onPinToTopChange;
  }, [onPinToTopChange]);

  const scrollToEnd = useCallback(() => {
    const scrollRoot =
      virtuosoScrollerRef.current ?? staticScrollerRef?.current;
    if (scrollRoot) {
      scrollRoot.scrollTo({
        top: Math.max(0, scrollRoot.scrollHeight - scrollRoot.clientHeight),
        behavior: "auto",
      });
    }
  }, [staticScrollerRef, virtuosoScrollerRef]);

  const scheduleFollowToEnd = useCallback(() => {
    effectiveManualScrollAtRef.current = 0;
    programmaticScrollAtRef.current = performance.now();
    let secondFrameId = 0;
    const firstFrameId = requestAnimationFrame(() => {
      programmaticScrollAtRef.current = performance.now();
      scrollToEnd();
      secondFrameId = requestAnimationFrame(() => {
        programmaticScrollAtRef.current = performance.now();
        scrollToEnd();
      });
    });
    return () => {
      cancelAnimationFrame(firstFrameId);
      cancelAnimationFrame(secondFrameId);
    };
  }, [effectiveManualScrollAtRef, scrollToEnd]);

  // Effect 1: always scroll to end on session switch.
  // New-event tail following is owned by useChatScroll;
  // doing it here as well makes flushed event batches fight layout anchoring
  // and produces visible up/down bounce.
  const prevActiveIdForScrollRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (optimizedChatHistoryLength === 0) return;
    const sessionChanged = prevActiveIdForScrollRef.current !== activeId;
    prevActiveIdForScrollRef.current = activeId ?? null;

    if (sessionChanged) {
      // Reset the programmatic-scroll timestamp so the first scroll event on
      // the new session is never mistaken for a continuation of the previous
      // session's last programmatic scroll.
      programmaticScrollAtRef.current = 0;
      pinLastGroupRef.current = false;
      onPinToTopChange?.(false);
      return scheduleFollowToEnd();
    }
  }, [
    activeId,
    optimizedChatHistoryLength,
    scheduleFollowToEnd,
    onPinToTopChange,
    pinLastGroupRef,
  ]);

  // Effect 2: scroll to bottom only when a new user-message group is added.
  const prevGroupLenRef = useRef(groupCounts.length);

  useEffect(() => {
    const prevGroupLen = prevGroupLenRef.current;
    prevGroupLenRef.current = groupCounts.length;

    const newGroupAdded = groupCounts.length > prevGroupLen;
    if (!newGroupAdded) return;

    pinLastGroupRef.current = false;
    onPinToTopChange?.(false);
    return scheduleFollowToEnd();
  }, [
    groupCounts.length,
    onPinToTopChange,
    pinLastGroupRef,
    scheduleFollowToEnd,
  ]);

  // Effect 3: break pin intent on user-initiated scroll.
  //
  // Mounted once per scroller element change — intentionally does NOT
  // depend on totalFlatItems or sessionLoadStatus. Those changes used to
  // force a remove+re-add cycle that created a short window where user
  // scrolls went undetected. Live values are accessed via refs instead.
  useEffect(() => {
    const el = virtuosoScrollerRef.current;
    if (!el) return;
    const PROGRAMMATIC_WINDOW_MS = 250;
    const handleScroll = (): void => {
      const now = performance.now();
      const elapsed = now - programmaticScrollAtRef.current;
      if (elapsed < PROGRAMMATIC_WINDOW_MS) return;
      effectiveManualScrollAtRef.current = now;
      if (!pinLastGroupRef.current) return;
      pinLastGroupRef.current = false;
      onPinToTopChangeRef.current?.(false);
    };
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", handleScroll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [virtuosoScrollerRef, pinLastGroupRef]);

  return { scrollToEnd, programmaticScrollAtRef };
}

import {
  type MutableRefObject,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";

import { getChatContentBottomScrollTop } from "../config/chatFooterSpacer";

export interface UseChatScrollPinOptions {
  activeId: string | null;
  groupCounts: number[];
  totalFlatItems: number;
  footerSpacerHeight: number;
  bottomInset: number;
  sessionLoadStatus: string;
  virtuosoScrollerRef: RefObject<HTMLElement | null>;
  atBottom: boolean;
  isPendingCancelRef: MutableRefObject<boolean>;
  isContentOverflowingRef: MutableRefObject<boolean>;
  optimizedChatHistoryLength: number;
  /** The newest group is this surface's optimistic, still-pending submit. */
  latestGroupIsLocalSubmit: boolean;
  /**
   * Shared ref owned by the parent. Both useChatScroll and useChatScrollPin
   * read/write this ref so they coordinate pin intent without re-renders.
   */
  pinLastGroupRef: MutableRefObject<boolean>;
  /** Updated when the scroller receives a real user scroll, not a programmatic correction. */
  manualScrollAtRef?: MutableRefObject<number>;
  /** Updated before any programmatic scroll correction. */
  programmaticScrollAtRef: MutableRefObject<number>;
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

function isScrollbarPointerDown(
  event: PointerEvent,
  element: HTMLElement
): boolean {
  if (event.button !== 0) return false;
  const rect = element.getBoundingClientRect();
  const nativeScrollbarWidth = Math.max(
    0,
    element.offsetWidth - element.clientWidth
  );
  const hitWidth = Math.max(12, nativeScrollbarWidth);
  return event.clientX >= rect.right - hitWidth;
}

const KEYBOARD_SCROLL_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
  "Spacebar",
]);

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(
      "input, textarea, select, [contenteditable='true'], [role='textbox']"
    ) !== null
  );
}

function isKeyboardScrollIntent(event: KeyboardEvent): boolean {
  return (
    !event.defaultPrevented &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !isEditableKeyboardTarget(event.target) &&
    KEYBOARD_SCROLL_KEYS.has(event.key)
  );
}

/**
 * Manages three scroll-pin behaviours for ChatHistory:
 *
 * 1. Re-pin last item when footer spacer converges or history grows.
 *    Always scrolls to end on session switch.
 * 2. Pin the latest user-message group to the viewport top when a new
 *    group is added. Re-fires as the temporary footer
 *    reserve grows so the first scroll lands at the correct offset.
 * 3. Breaks pin intent on explicit user scroll input. A plain `scroll` event
 *    is deliberately insufficient: virtualizer remeasurement and projection
 *    replacement also emit trusted scroll events, and treating those as user
 *    intent strands a streaming conversation at the top.
 */
export function useChatScrollPin({
  activeId,
  groupCounts,
  totalFlatItems: _totalFlatItems,
  footerSpacerHeight,
  bottomInset,
  sessionLoadStatus: _sessionLoadStatus,
  virtuosoScrollerRef,
  atBottom: _atBottom,
  isPendingCancelRef: _isPendingCancelRef,
  isContentOverflowingRef: _isContentOverflowingRef,
  optimizedChatHistoryLength,
  latestGroupIsLocalSubmit,
  pinLastGroupRef,
  manualScrollAtRef,
  programmaticScrollAtRef,
  onPinToTopChange,
  staticScrollerRef,
}: UseChatScrollPinOptions): UseChatScrollPinReturn {
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
        top: getChatContentBottomScrollTop({
          scrollHeight: scrollRoot.scrollHeight,
          clientHeight: scrollRoot.clientHeight,
          footerSpacerHeight,
          bottomInset,
        }),
        behavior: "auto",
      });
    }
  }, [bottomInset, footerSpacerHeight, staticScrollerRef, virtuosoScrollerRef]);

  const scheduleFollowToEnd = useCallback(() => {
    // eslint-disable-next-line react-hooks/immutability -- These caller-owned refs are the documented mutable coordination channel between the scroll hooks.
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
  }, [effectiveManualScrollAtRef, programmaticScrollAtRef, scrollToEnd]);

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
    programmaticScrollAtRef,
  ]);

  // Effect 2: a local optimistic submit explicitly re-arms bottom follow.
  // Remote groups continue following only while the viewer has not paused by
  // scrolling up; their arrival must not steal the viewport from older text.
  const prevGroupLenRef = useRef(groupCounts.length);

  useEffect(() => {
    const prevGroupLen = prevGroupLenRef.current;
    prevGroupLenRef.current = groupCounts.length;

    const newGroupAdded = groupCounts.length > prevGroupLen;
    if (!newGroupAdded) return;
    if (effectiveManualScrollAtRef.current > 0 && !latestGroupIsLocalSubmit) {
      return;
    }

    pinLastGroupRef.current = false;
    onPinToTopChange?.(false);
    return scheduleFollowToEnd();
  }, [
    groupCounts.length,
    latestGroupIsLocalSubmit,
    effectiveManualScrollAtRef,
    onPinToTopChange,
    pinLastGroupRef,
    scheduleFollowToEnd,
  ]);

  // Effect 3: break follow/pin intent only on explicit user input. Layout and
  // TanStack Virtual corrections use the same native `scroll` event as a
  // wheel gesture, so listening to `scroll` itself cannot distinguish intent.
  useEffect(() => {
    const el = virtuosoScrollerRef.current ?? staticScrollerRef?.current;
    if (!el) return;
    const markManualScroll = (): void => {
      effectiveManualScrollAtRef.current = performance.now();
      if (!pinLastGroupRef.current) return;
      pinLastGroupRef.current = false;
      onPinToTopChangeRef.current?.(false);
    };
    const handlePointerDown = (event: PointerEvent): void => {
      if (isScrollbarPointerDown(event, el)) markManualScroll();
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (isKeyboardScrollIntent(event)) markManualScroll();
    };
    el.addEventListener("wheel", markManualScroll, { passive: true });
    el.addEventListener("touchmove", markManualScroll, { passive: true });
    el.addEventListener("pointerdown", handlePointerDown);
    el.addEventListener("keydown", handleKeyDown);
    return () => {
      el.removeEventListener("wheel", markManualScroll);
      el.removeEventListener("touchmove", markManualScroll);
      el.removeEventListener("pointerdown", handlePointerDown);
      el.removeEventListener("keydown", handleKeyDown);
    };
  }, [
    virtuosoScrollerRef,
    pinLastGroupRef,
    effectiveManualScrollAtRef,
    staticScrollerRef,
  ]);

  return { scrollToEnd, programmaticScrollAtRef };
}

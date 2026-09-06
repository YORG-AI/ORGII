/**
 * useChatScroll Hook
 *
 * Manages scroll-to-bottom behaviour for the chat list:
 * - atBottom state change handler (syncs to parent)
 * - scrollToBottom action
 * - auto-scroll when new content arrives and the user
 *   is at (or near) the content bottom
 *
 * The chat footer renders a fixed spacer after the content. Scroll-to-bottom
 * paths use the browser's physical scroll bottom (`scrollHeight - clientHeight`)
 * so the footer spacer remains visible below the latest event.
 */
import {
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
} from "react";

import { useDebouncedCallback } from "@src/hooks/perf";

import { getChatContentBottomScrollTop } from "../config/chatFooterSpacer";

// ============================================
// Types
// ============================================

export interface UseChatScrollOptions {
  optimizedChatHistoryLength: number;
  virtuosoScrollerRef: RefObject<HTMLElement | null>;
  atBottom: boolean;
  setAtBottom: Dispatch<SetStateAction<boolean>>;
  setIsChatScrolledToBottom: (bottom: boolean) => void;
  /** When true, a user-initiated cancel is in flight. Auto-scroll is
   *  suppressed to prevent the viewport from jumping upward as content
   *  shrinks (events finalizing, planning footer collapsing). */
  isPendingCancelRef: MutableRefObject<boolean>;
  /** Ref tracking the rendered visibleRange.endIndex — used to detect
   *  "near content bottom" independently of atBottom (which uses a
   *  small threshold and won't be true when the spacer is below). */
  visibleRangeEndRef: MutableRefObject<number>;
  /** When true, the latest user-message group is pinned to the top of
   *  the viewport; new-message auto-scroll stands down so the pin sticks.
   *  Cleared by `ChatHistory` on manual scroll / session switch. */
  pinLastGroupRef: MutableRefObject<boolean>;
  /** Timestamp of the latest user scroll on the chat scroller. Used to keep
   *  auto-follow from fighting trackpad/wheel momentum near the bottom. */
  manualScrollAtRef?: MutableRefObject<number>;
  /** Timestamp of the latest programmatic scroll correction. */
  programmaticScrollAtRef: MutableRefObject<number>;
  /** Timestamp of the latest user-triggered turn collapse/expand. During
   *  this short window, structural list-size changes must preserve the
   *  user's local viewport instead of following the virtualized tail. */
  turnCollapseInteractionAtRef: MutableRefObject<number>;
  /** `true` only when rendered chat content is taller than the viewport.
   *  When `false`, all auto-scroll-to-bottom paths bail — scrolling would
   *  just drag content upward without revealing anything new. */
  isContentOverflowingRef: MutableRefObject<boolean>;
  /** Active session ID — used to reset internal counters on session switch. */
  activeSessionId: string | null | undefined;
  /** Static renderer scroll root used when Virtuoso is not mounted. */
  staticScrollerRef?: MutableRefObject<HTMLDivElement | null>;
  /** Height of the reserved footer spacer after the last rendered chat row. */
  footerSpacerHeight: number;
  /** Height of the overlapping composer/input area. */
  bottomInset: number;
  /** Changes when tail content streams without adding/removing list items. */
  tailFollowKey: string;
  /** When true, bypass the `isContentOverflowingRef` guard so auto-scroll
   *  engages even in small viewports (subagent monitor cells). */
  alwaysFollowTail?: boolean;
}

export interface UseChatScrollReturn {
  handleAtBottomStateChange: (bottom: boolean) => void;
  scrollToBottom: () => void;
}

// ============================================
// Hook
// ============================================

/** Debounce for atBottom state updates.  Prevents rapid true/false
 *  toggling at the scroll boundary from triggering re-render bounce.
 *  Aligned with RANGE_DEBOUNCE_MS in useChatPagination (150ms) so
 *  showScrollToBottom — which reads both atBottom and visibleRange —
 *  transitions without flickering from desynchronised updates. */
const AT_BOTTOM_DEBOUNCE_MS = 150;
const MANUAL_SCROLL_AUTO_FOLLOW_SUPPRESS_MS = 450;
const TURN_COLLAPSE_AUTO_FOLLOW_SUPPRESS_MS = 700;
const FOLLOW_SETTLE_FRAME_COUNT = 4;

/**
 * `atBottom` is geometry, not user intent. A virtualizer remeasure or an
 * async projection swap can temporarily move a tail-following viewport away
 * from the bottom without any user input. Only an explicit manual scroll
 * should suspend streaming follow in that state.
 */
function isTailFollowPaused(
  atBottom: boolean,
  manualScrollAt: number
): boolean {
  return !atBottom && manualScrollAt > 0;
}

export function useChatScroll({
  optimizedChatHistoryLength,
  virtuosoScrollerRef,
  atBottom,
  setAtBottom,
  setIsChatScrolledToBottom,
  isPendingCancelRef: _isPendingCancelRef,
  visibleRangeEndRef,
  pinLastGroupRef,
  manualScrollAtRef,
  programmaticScrollAtRef,
  turnCollapseInteractionAtRef,
  isContentOverflowingRef,
  activeSessionId,
  staticScrollerRef,
  footerSpacerHeight,
  bottomInset,
  tailFollowKey,
  alwaysFollowTail = false,
}: UseChatScrollOptions): UseChatScrollReturn {
  const atBottomRef = useRef(true);
  const fallbackManualScrollAtRef = useRef(0);
  const effectiveManualScrollAtRef =
    manualScrollAtRef ?? fallbackManualScrollAtRef;

  const chatHistoryLengthRef = useRef(optimizedChatHistoryLength);
  useEffect(() => {
    chatHistoryLengthRef.current = optimizedChatHistoryLength;
  }, [optimizedChatHistoryLength]);

  const scheduledFollowCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    const scheduledFollowCleanupRefForCleanup = scheduledFollowCleanupRef;
    return () => {
      scheduledFollowCleanupRefForCleanup.current?.();
      scheduledFollowCleanupRefForCleanup.current = null;
    };
  }, []);

  const debouncedSetAtBottom = useDebouncedCallback((bottom: boolean) => {
    setAtBottom((previousAtBottom) =>
      previousAtBottom === bottom ? previousAtBottom : bottom
    );
    setIsChatScrolledToBottom(bottom);
  }, AT_BOTTOM_DEBOUNCE_MS);

  const handleAtBottomStateChange = useCallback(
    (bottom: boolean) => {
      if (bottom) {
        // Reaching the tail explicitly re-arms follow after the user has read
        // older content and scrolled back down.
        // eslint-disable-next-line react-hooks/immutability -- This caller-owned ref is the scroll hooks' existing non-rendering intent channel.
        effectiveManualScrollAtRef.current = 0;
      }
      if (atBottomRef.current === bottom) return;
      atBottomRef.current = bottom;
      debouncedSetAtBottom(bottom);
    },
    [debouncedSetAtBottom, effectiveManualScrollAtRef]
  );

  const scrollElementToBottom = useCallback(
    (behavior: ScrollBehavior = "auto") => {
      const el = staticScrollerRef?.current ?? virtuosoScrollerRef.current;
      if (!el) return false;
      programmaticScrollAtRef.current = performance.now();
      el.scrollTo({
        top: getChatContentBottomScrollTop({
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          footerSpacerHeight,
          bottomInset,
        }),
        behavior,
      });
      return true;
    },
    [
      bottomInset,
      footerSpacerHeight,
      programmaticScrollAtRef,
      staticScrollerRef,
      virtuosoScrollerRef,
    ]
  );

  const scheduleSettledFollow = useCallback(() => {
    scheduledFollowCleanupRef.current?.();
    const frameIds: number[] = [];
    const runFrame = (remainingFrames: number) => {
      const frameId = requestAnimationFrame(() => {
        scrollElementToBottom();
        if (remainingFrames > 1) {
          runFrame(remainingFrames - 1);
        }
      });
      frameIds.push(frameId);
    };
    scrollElementToBottom();
    runFrame(FOLLOW_SETTLE_FRAME_COUNT);
    const cleanup = () => {
      for (const frameId of frameIds) {
        cancelAnimationFrame(frameId);
      }
    };
    scheduledFollowCleanupRef.current = cleanup;
    return cleanup;
  }, [scrollElementToBottom]);

  const scrollToBottom = useCallback(() => {
    pinLastGroupRef.current = false;
    if (manualScrollAtRef) {
      manualScrollAtRef.current = 0;
    } else {
      fallbackManualScrollAtRef.current = 0;
    }
    atBottomRef.current = true;
    setAtBottom(true);
    setIsChatScrolledToBottom(true);
    scheduleSettledFollow();
  }, [
    fallbackManualScrollAtRef,
    manualScrollAtRef,
    pinLastGroupRef,
    scheduleSettledFollow,
    setAtBottom,
    setIsChatScrolledToBottom,
  ]);

  useEffect(() => {
    const scrollRoot =
      staticScrollerRef?.current ?? virtuosoScrollerRef.current;
    if (!scrollRoot) return;

    let frameId = 0;
    const followIfPinnedToTail = () => {
      cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(() => {
        if (pinLastGroupRef.current) return;
        if (
          !alwaysFollowTail &&
          performance.now() - effectiveManualScrollAtRef.current <
            MANUAL_SCROLL_AUTO_FOLLOW_SUPPRESS_MS
        ) {
          return;
        }
        if (
          !alwaysFollowTail &&
          isTailFollowPaused(
            atBottomRef.current,
            effectiveManualScrollAtRef.current
          )
        ) {
          return;
        }
        scheduleSettledFollow();
      });
    };

    const resizeObserver = new ResizeObserver(followIfPinnedToTail);
    resizeObserver.observe(scrollRoot);
    if (scrollRoot.firstElementChild) {
      resizeObserver.observe(scrollRoot.firstElementChild);
    }

    return () => {
      cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
    };
  }, [
    activeSessionId,
    alwaysFollowTail,
    effectiveManualScrollAtRef,
    pinLastGroupRef,
    scheduleSettledFollow,
    staticScrollerRef,
    virtuosoScrollerRef,
  ]);

  useEffect(() => {
    if (!tailFollowKey) return;
    if (pinLastGroupRef.current) return;
    if (
      !alwaysFollowTail &&
      isTailFollowPaused(
        atBottomRef.current,
        effectiveManualScrollAtRef.current
      )
    ) {
      return;
    }
    if (
      performance.now() - effectiveManualScrollAtRef.current <
      MANUAL_SCROLL_AUTO_FOLLOW_SUPPRESS_MS
    ) {
      return;
    }
    return scheduleSettledFollow();
  }, [
    alwaysFollowTail,
    effectiveManualScrollAtRef,
    pinLastGroupRef,
    scheduleSettledFollow,
    tailFollowKey,
  ]);

  // Auto-scroll when new messages arrive if user was at content bottom.
  // Stands down while the latest group is pinned to top — the pin is the
  // caller's explicit override of bottom-follow behaviour.
  // Also stands down when content still fits in the viewport (no overflow):
  // scrolling in that case would only drag content upward without revealing
  // anything new below.
  const prevMessageCountRef = useRef(optimizedChatHistoryLength);

  // Reset on session switch so the "new items arrived" heuristic doesn't
  // carry stale counts from the previous session.
  const prevSessionIdRef = useRef(activeSessionId);
  useEffect(() => {
    if (activeSessionId !== prevSessionIdRef.current) {
      prevSessionIdRef.current = activeSessionId;
      prevMessageCountRef.current = optimizedChatHistoryLength;
    }
  }, [activeSessionId, optimizedChatHistoryLength]);

  useEffect(() => {
    const prevCount = prevMessageCountRef.current;
    const currentCount = optimizedChatHistoryLength;
    prevMessageCountRef.current = currentCount;

    if (pinLastGroupRef.current) return;
    if (
      performance.now() - effectiveManualScrollAtRef.current <
      MANUAL_SCROLL_AUTO_FOLLOW_SUPPRESS_MS
    ) {
      return;
    }
    if (
      performance.now() - turnCollapseInteractionAtRef.current <
      TURN_COLLAPSE_AUTO_FOLLOW_SUPPRESS_MS
    ) {
      return;
    }
    if (!alwaysFollowTail && !isContentOverflowingRef.current) return;

    const isNearContentBottom = visibleRangeEndRef.current >= currentCount - 1;

    if (
      staticScrollerRef?.current &&
      currentCount > prevCount &&
      (alwaysFollowTail || atBottom || isNearContentBottom)
    ) {
      const timer = setTimeout(() => {
        if (pinLastGroupRef.current) return;
        if (
          performance.now() - effectiveManualScrollAtRef.current <
          MANUAL_SCROLL_AUTO_FOLLOW_SUPPRESS_MS
        ) {
          return;
        }
        if (
          performance.now() - turnCollapseInteractionAtRef.current <
          TURN_COLLAPSE_AUTO_FOLLOW_SUPPRESS_MS
        ) {
          return;
        }
        if (!alwaysFollowTail && !isContentOverflowingRef.current) return;
        scheduleSettledFollow();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [
    optimizedChatHistoryLength,
    atBottom,
    scheduleSettledFollow,
    visibleRangeEndRef,
    pinLastGroupRef,
    effectiveManualScrollAtRef,
    turnCollapseInteractionAtRef,
    isContentOverflowingRef,
    staticScrollerRef,
    alwaysFollowTail,
  ]);

  return {
    handleAtBottomStateChange,
    scrollToBottom,
  };
}

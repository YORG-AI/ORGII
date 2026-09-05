import { useAtomValue, useSetAtom } from "jotai";
import { type RefObject, useEffect, useRef, useState } from "react";

import {
  activeChatPanelTabCanGoBackAtom,
  activeChatPanelTabCanGoForwardAtom,
  goBackChatPanelTabAtom,
  goForwardChatPanelTabAtom,
} from "@src/store/chatPanel/chatPanelTabNavigationAtoms";

import {
  IDLE_SWIPE_STATE,
  SWIPE_IDLE_RESET_MS,
  type SwipeDirection,
  type SwipeGestureState,
  canAncestorScrollHorizontally,
  reduceSwipeWheel,
  resolveSwipeProgress,
} from "./sessionSwipeGesture";

export interface SessionSwipeIndicatorState {
  direction: SwipeDirection | null;
  /** 0..1 — how far the swipe has built toward triggering. */
  progress: number;
}

const IDLE_INDICATOR: SessionSwipeIndicatorState = {
  direction: null,
  progress: 0,
};
/** How long the fully-lit indicator lingers after a navigation fires. */
const TRIGGERED_LINGER_MS = 260;

/**
 * Two-finger horizontal swipe over the chat pane walks the active tab's
 * session history, with an edge indicator that fills in as the gesture
 * builds. Wheel events are observed passively — nothing is prevented — and
 * any horizontally scrollable content under the pointer keeps its scroll.
 */
export function useSessionSwipeNavigation(
  containerRef: RefObject<HTMLElement | null>
): SessionSwipeIndicatorState {
  const canGoBack = useAtomValue(activeChatPanelTabCanGoBackAtom);
  const canGoForward = useAtomValue(activeChatPanelTabCanGoForwardAtom);
  const goBack = useSetAtom(goBackChatPanelTabAtom);
  const goForward = useSetAtom(goForwardChatPanelTabAtom);
  const [indicator, setIndicator] =
    useState<SessionSwipeIndicatorState>(IDLE_INDICATOR);

  const availabilityRef = useRef({ canGoBack, canGoForward });
  useEffect(() => {
    availabilityRef.current = { canGoBack, canGoForward };
  }, [canGoBack, canGoForward]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    let gesture: SwipeGestureState = IDLE_SWIPE_STATE;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const clearIndicatorSoon = (delay: number) => {
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimer = null;
        setIndicator(IDLE_INDICATOR);
      }, delay);
    };

    const handleWheel = (event: WheelEvent) => {
      // Pinch-zoom arrives as ctrl+wheel; leave it alone.
      if (event.ctrlKey) return;
      if (
        canAncestorScrollHorizontally(
          event.target as Element | null,
          container,
          event.deltaX
        )
      ) {
        gesture = IDLE_SWIPE_STATE;
        setIndicator(IDLE_INDICATOR);
        return;
      }

      const { state, trigger } = reduceSwipeWheel(
        gesture,
        { deltaX: event.deltaX, deltaY: event.deltaY, now: event.timeStamp },
        availabilityRef.current
      );
      gesture = state;

      if (trigger) {
        if (trigger === "back") goBack();
        else goForward();
        setIndicator({ direction: trigger, progress: 1 });
        clearIndicatorSoon(TRIGGERED_LINGER_MS);
        return;
      }

      if (state.consumed) return;
      const progress = state.direction
        ? resolveSwipeProgress(state.distance)
        : 0;
      setIndicator(
        progress > 0 && state.direction
          ? { direction: state.direction, progress }
          : IDLE_INDICATOR
      );
      clearIndicatorSoon(SWIPE_IDLE_RESET_MS);
    };

    container.addEventListener("wheel", handleWheel, { passive: true });
    return () => {
      container.removeEventListener("wheel", handleWheel);
      if (idleTimer !== null) clearTimeout(idleTimer);
    };
  }, [containerRef, goBack, goForward]);

  return indicator;
}

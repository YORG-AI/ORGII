import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import {
  getPhysicalDistanceFromBottom,
  getPhysicalScrollBottom,
  isWithinTailFollowThreshold,
} from "@src/hooks/ui/tailFollowPolicy";

export interface UseMobileChatScrollOptions {
  sessionId: string;
  contentKey: string;
  enabled: boolean;
  /** Changes when the local user submits a new turn. */
  forceFollowKey?: string;
}

export interface UseMobileChatScrollResult {
  contentRef: RefObject<HTMLDivElement | null>;
  scrollRef: RefObject<HTMLDivElement | null>;
  scrollToBottom: () => void;
  showScrollToBottom: boolean;
}

/**
 * Mobile counterpart of the desktop ChatPanel tail-follow policy.
 *
 * The transcript follows new content while the reader is near the bottom,
 * force-follows a locally submitted turn, and stands down while the reader is
 * reviewing earlier history. A ResizeObserver covers streaming Markdown and
 * viewport/composer size changes without polling.
 */
export function useMobileChatScroll({
  sessionId,
  contentKey,
  enabled,
  forceFollowKey,
}: UseMobileChatScrollOptions): UseMobileChatScrollResult {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followTailRef = useRef(true);
  const scrollNavScopeKey = `${sessionId}:${forceFollowKey ?? ""}`;
  const [scrollNavState, setScrollNavState] = useState({
    scopeKey: scrollNavScopeKey,
    show: false,
  });
  const followFrameRef = useRef<number | null>(null);
  const measureFrameRef = useRef<number | null>(null);
  const previousSessionIdRef = useRef<string | null>(null);
  const previousContentKeyRef = useRef("");
  const previousForceFollowKeyRef = useRef<string | undefined>(undefined);
  const previousEnabledRef = useRef(false);

  const scrollToBottom = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = getPhysicalScrollBottom(element);
  }, []);

  const scheduleFollow = useCallback(() => {
    if (!followTailRef.current) return;
    scrollToBottom();
    if (followFrameRef.current !== null) {
      cancelAnimationFrame(followFrameRef.current);
    }
    followFrameRef.current = requestAnimationFrame(() => {
      followFrameRef.current = null;
      if (followTailRef.current) scrollToBottom();
    });
  }, [scrollToBottom]);

  useLayoutEffect(() => {
    const sessionChanged = previousSessionIdRef.current !== sessionId;
    const contentChanged = previousContentKeyRef.current !== contentKey;
    const localTurnSubmitted =
      Boolean(forceFollowKey) &&
      previousForceFollowKeyRef.current !== forceFollowKey;
    const becameVisible = enabled && !previousEnabledRef.current;

    previousSessionIdRef.current = sessionId;
    previousContentKeyRef.current = contentKey;
    previousForceFollowKeyRef.current = forceFollowKey;
    previousEnabledRef.current = enabled;

    if (sessionChanged || localTurnSubmitted || becameVisible) {
      followTailRef.current = true;
    }
    if (
      (sessionChanged ||
        contentChanged ||
        localTurnSubmitted ||
        becameVisible) &&
      followTailRef.current
    ) {
      scheduleFollow();
    }
  }, [contentKey, enabled, forceFollowKey, scheduleFollow, sessionId]);

  useEffect(() => {
    if (!enabled) return;
    const scrollRoot = scrollRef.current;
    if (!scrollRoot) return;

    const measureFollowState = () => {
      // A real scroll takes precedence over the settle frame queued by the
      // previous content update. This is what keeps tail-follow from fighting
      // a reader who starts moving upward immediately after a new token lands.
      followTailRef.current = false;
      if (followFrameRef.current !== null) {
        cancelAnimationFrame(followFrameRef.current);
        followFrameRef.current = null;
      }
      if (measureFrameRef.current !== null) {
        cancelAnimationFrame(measureFrameRef.current);
      }
      measureFrameRef.current = requestAnimationFrame(() => {
        measureFrameRef.current = null;
        const nearBottom = isWithinTailFollowThreshold(
          getPhysicalDistanceFromBottom(scrollRoot)
        );
        const showButton = !nearBottom;
        followTailRef.current = nearBottom;
        setScrollNavState((current) =>
          current.scopeKey === scrollNavScopeKey && current.show === showButton
            ? current
            : { scopeKey: scrollNavScopeKey, show: showButton }
        );
      });
    };

    scrollRoot.addEventListener("scroll", measureFollowState, {
      passive: true,
    });

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            if (followTailRef.current) scheduleFollow();
          });
    resizeObserver?.observe(scrollRoot);
    if (contentRef.current) resizeObserver?.observe(contentRef.current);

    return () => {
      scrollRoot.removeEventListener("scroll", measureFollowState);
      resizeObserver?.disconnect();
      if (measureFrameRef.current !== null) {
        cancelAnimationFrame(measureFrameRef.current);
        measureFrameRef.current = null;
      }
    };
  }, [enabled, scheduleFollow, scrollNavScopeKey, sessionId]);

  useEffect(
    () => () => {
      if (followFrameRef.current !== null) {
        cancelAnimationFrame(followFrameRef.current);
      }
    },
    []
  );

  const resumeTailFollow = useCallback(() => {
    followTailRef.current = true;
    setScrollNavState({ scopeKey: scrollNavScopeKey, show: false });
    scheduleFollow();
  }, [scheduleFollow, scrollNavScopeKey]);

  return {
    contentRef,
    scrollRef,
    scrollToBottom: resumeTailFollow,
    showScrollToBottom:
      scrollNavState.scopeKey === scrollNavScopeKey && scrollNavState.show,
  };
}

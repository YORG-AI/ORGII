import { type RefObject, useEffect, useRef } from "react";

import {
  applySearchTextHighlight,
  clearSearchTextHighlights,
} from "./chatSearchHighlightDom";
import {
  clearSearchActiveMarkers,
  findSearchTargetElement,
  scrollSearchTargetIntoView,
} from "./chatSearchTargetDom";
import { useChatSearchSyncState } from "./useChatSearchSyncState";

export interface UseChatSearchPanePresentationOptions {
  sessionId: string | null;
  /** DOM root that receives query substring highlighting. */
  highlightRootRef: RefObject<HTMLElement | null>;
  /** When set, scroll this container to the active search target. */
  scrollRootRef?: RefObject<HTMLElement | null>;
  /** Station replay lists set this to avoid snapping back to bottom. */
  suppressFollowBottomRef?: RefObject<boolean>;
  /** Fires when the shared active event id changes (e.g. clear local selection). */
  onActiveEventChange?: (eventId: string | null) => void;
  /** Extra deps that should re-run scroll/highlight after layout (pagination, view mode). */
  layoutKey?: string | number;
}

/**
 * Single presentation hook for every chat-search surface (ChatHistory, Station, …).
 * Reads shared sync atoms; applies highlight + optional scroll/follow overrides.
 */
export function useChatSearchPanePresentation({
  sessionId,
  highlightRootRef,
  scrollRootRef,
  suppressFollowBottomRef,
  onActiveEventChange,
  layoutKey = 0,
}: UseChatSearchPanePresentationOptions) {
  const { isOpen, query, trimmedQuery, activeEventId, enabled } =
    useChatSearchSyncState(sessionId);
  const lastNotifiedEventIdRef = useRef<string | null>(null);

  useEffect(() => {
    const container = highlightRootRef.current;
    if (!container) return;

    clearSearchTextHighlights(container);
    if (!enabled) return;

    const timeoutId = window.setTimeout(() => {
      applySearchTextHighlight(container, trimmedQuery, true);
    }, 50);

    return () => {
      window.clearTimeout(timeoutId);
      clearSearchTextHighlights(container);
      clearSearchActiveMarkers(container);
    };
  }, [enabled, highlightRootRef, layoutKey, trimmedQuery]);

  useEffect(() => {
    if (!isOpen) {
      if (lastNotifiedEventIdRef.current !== null) {
        lastNotifiedEventIdRef.current = null;
        onActiveEventChange?.(null);
      }
      return;
    }

    if (lastNotifiedEventIdRef.current === activeEventId) return;
    lastNotifiedEventIdRef.current = activeEventId;
    onActiveEventChange?.(activeEventId);
  }, [activeEventId, isOpen, onActiveEventChange]);

  useEffect(() => {
    if (!enabled || !activeEventId || !scrollRootRef) return;
    const scrollRoot = scrollRootRef.current;
    if (!scrollRoot) return;

    if (suppressFollowBottomRef) {
      suppressFollowBottomRef.current = false;
    }

    const frameId = window.requestAnimationFrame(() => {
      const target = findSearchTargetElement(scrollRoot, {
        eventId: activeEventId,
      });
      if (target) {
        scrollSearchTargetIntoView(scrollRoot, target, "auto");
      }
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [
    activeEventId,
    enabled,
    layoutKey,
    scrollRootRef,
    suppressFollowBottomRef,
  ]);

  return {
    isOpen,
    query,
    activeEventId: isOpen ? activeEventId : null,
    enabled,
  };
}

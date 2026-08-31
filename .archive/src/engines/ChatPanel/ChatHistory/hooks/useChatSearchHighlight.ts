import { type RefObject, useEffect } from "react";

import { applySearchTextHighlight } from "./chatSearch/chatSearchHighlightDom";

export {
  SEARCH_TEXT_HIGHLIGHT_ACTIVE_CLASS,
  SEARCH_TEXT_HIGHLIGHT_CLASS,
  applySearchTextHighlight,
  clearSearchTextHighlights,
} from "./chatSearch/chatSearchHighlightDom";

/** @deprecated Prefer `useChatSearchPanePresentation` (shared sync atoms). */
export function useChatSearchHighlight(
  containerRef: RefObject<HTMLElement | null>,
  query: string,
  enabled: boolean
) {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const trimmedQuery = query.trim();
    const timeoutId = window.setTimeout(() => {
      applySearchTextHighlight(container, trimmedQuery, enabled);
    }, 50);

    return () => {
      window.clearTimeout(timeoutId);
      applySearchTextHighlight(container, "", false);
    };
  }, [containerRef, enabled, query]);
}

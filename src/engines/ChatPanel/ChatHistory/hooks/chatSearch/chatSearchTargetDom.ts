export const CHAT_ITEM_ID_ATTR = "data-chat-item-id";
export const CHAT_EVENT_IDS_ATTR = "data-chat-event-ids";
export const CHAT_FLAT_INDEX_ATTR = "data-chat-flat-index";

/** Shared row marker for chat history + station message surfaces. */
export const SEARCH_TARGET_MESSAGE_ID_ATTR = "data-search-target-message-id";
export const SEARCH_TARGET_EVENT_ID_ATTR = "data-search-target-event-id";
export const SEARCH_ACTIVE_ATTR = "data-search-active";

/** @deprecated Prefer SEARCH_TARGET_* — kept for in-flight DOM queries. */
export const STATION_MESSAGE_ID_ATTR = SEARCH_TARGET_MESSAGE_ID_ATTR;
export const STATION_EVENT_ID_ATTR = SEARCH_TARGET_EVENT_ID_ATTR;

export interface ChatSearchDomTarget {
  eventId?: string;
  itemId?: string;
  flatIndex?: number;
}

function escapeSelectorValue(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function formatChatEventIdsAttribute(
  eventIds: readonly string[]
): string {
  return eventIds.join(" ");
}

export function isSearchTargetActive(
  target: { messageId: string; eventId: string },
  activeEventId: string | null | undefined
): boolean {
  return Boolean(
    activeEventId &&
    (target.messageId === activeEventId || target.eventId === activeEventId)
  );
}

export function buildSearchTargetRowProps(
  target: { messageId: string; eventId: string },
  activeEventId: string | null | undefined
) {
  return {
    [SEARCH_TARGET_MESSAGE_ID_ATTR]: target.messageId,
    [SEARCH_TARGET_EVENT_ID_ATTR]: target.eventId,
    ...(isSearchTargetActive(target, activeEventId)
      ? { [SEARCH_ACTIVE_ATTR]: "true" as const }
      : {}),
  };
}

export function findChatSearchTargetElement(
  scrollRoot: HTMLElement,
  target: ChatSearchDomTarget
): HTMLElement | null {
  if (target.eventId) {
    const escaped = escapeSelectorValue(target.eventId);
    const byEventIds = scrollRoot.querySelector<HTMLElement>(
      `[${CHAT_EVENT_IDS_ATTR}~="${escaped}"]`
    );
    if (byEventIds) return byEventIds;
    const byEventId = scrollRoot.querySelector<HTMLElement>(
      `[${CHAT_EVENT_IDS_ATTR}="${escaped}"]`
    );
    if (byEventId) return byEventId;
    const bySharedEventId = scrollRoot.querySelector<HTMLElement>(
      `[${SEARCH_TARGET_EVENT_ID_ATTR}="${escaped}"]`
    );
    if (bySharedEventId) return bySharedEventId;
  }

  if (target.itemId) {
    const byItemId = scrollRoot.querySelector<HTMLElement>(
      `[${CHAT_ITEM_ID_ATTR}="${escapeSelectorValue(target.itemId)}"]`
    );
    if (byItemId) return byItemId;
  }

  if (target.flatIndex !== undefined) {
    const byFlatIndex = scrollRoot.querySelector<HTMLElement>(
      `[${CHAT_FLAT_INDEX_ATTR}="${target.flatIndex}"]`
    );
    if (byFlatIndex) return byFlatIndex;
    const byLegacyFlatIndex = scrollRoot.querySelector<HTMLElement>(
      `[data-item-index="${target.flatIndex}"]`
    );
    if (byLegacyFlatIndex) return byLegacyFlatIndex;
  }

  return null;
}

export function findSearchTargetElement(
  scrollRoot: HTMLElement,
  target: ChatSearchDomTarget
): HTMLElement | null {
  const fromChat = findChatSearchTargetElement(scrollRoot, target);
  if (fromChat) return fromChat;

  if (!target.eventId) return null;
  const escaped = escapeSelectorValue(target.eventId);
  return scrollRoot.querySelector<HTMLElement>(
    `[${SEARCH_TARGET_MESSAGE_ID_ATTR}="${escaped}"]`
  );
}

const SEARCH_SCROLL_IN_VIEW_PADDING_PX = 48;

export function scrollSearchTargetIntoView(
  scrollRoot: HTMLElement,
  element: HTMLElement,
  behavior: ScrollBehavior = "auto"
) {
  const rootRect = scrollRoot.getBoundingClientRect();
  const elRect = element.getBoundingClientRect();
  const padding = SEARCH_SCROLL_IN_VIEW_PADDING_PX;

  if (
    elRect.top >= rootRect.top + padding &&
    elRect.bottom <= rootRect.bottom - padding
  ) {
    return;
  }

  const elementTop = elRect.top - rootRect.top + scrollRoot.scrollTop;
  let targetTop = scrollRoot.scrollTop;

  if (elRect.top < rootRect.top + padding) {
    targetTop = elementTop - padding;
  } else if (elRect.bottom > rootRect.bottom - padding) {
    targetTop = elementTop + elRect.height - scrollRoot.clientHeight + padding;
  }

  scrollRoot.scrollTo({
    top: Math.max(0, targetTop),
    behavior,
  });
}

export function resolveVisibleSearchResultIndex(
  scrollRoot: HTMLElement,
  resultEventIds: readonly string[]
): number | null {
  if (resultEventIds.length === 0) return null;

  const rootRect = scrollRoot.getBoundingClientRect();
  const centerY = rootRect.top + rootRect.height * 0.35;
  let bestIndex: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  resultEventIds.forEach((eventId, index) => {
    const element = findSearchTargetElement(scrollRoot, { eventId });
    if (!element) return;

    const rect = element.getBoundingClientRect();
    if (rect.bottom < rootRect.top || rect.top > rootRect.bottom) return;

    const distance = Math.abs(rect.top + rect.height / 2 - centerY);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });

  return bestIndex;
}

export function clearSearchActiveMarkers(container: HTMLElement) {
  container
    .querySelectorAll(`[${SEARCH_ACTIVE_ATTR}="true"]`)
    .forEach((node) => {
      node.removeAttribute(SEARCH_ACTIVE_ATTR);
    });
}

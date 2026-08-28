import {
  findSearchTargetElement,
  scrollSearchTargetIntoView,
} from "./chatSearchTargetDom";

export {
  SEARCH_TEXT_HIGHLIGHT_CLASS,
  SEARCH_TEXT_HIGHLIGHT_ACTIVE_CLASS,
  applySearchTextHighlight,
  clearSearchTextHighlights,
} from "./chatSearchHighlightDom";
export {
  CHAT_EVENT_IDS_ATTR,
  CHAT_FLAT_INDEX_ATTR,
  CHAT_ITEM_ID_ATTR,
  SEARCH_ACTIVE_ATTR,
  SEARCH_TARGET_EVENT_ID_ATTR,
  SEARCH_TARGET_MESSAGE_ID_ATTR,
  buildSearchTargetRowProps,
  clearSearchActiveMarkers,
  findChatSearchTargetElement,
  findSearchTargetElement,
  formatChatEventIdsAttribute,
  isSearchTargetActive,
  resolveVisibleSearchResultIndex,
  scrollSearchTargetIntoView,
} from "./chatSearchTargetDom";
export type { ChatSearchDomTarget } from "./chatSearchTargetDom";
export {
  EMPTY_CHAT_SEARCH_SYNC,
  buildChatSearchSyncState,
  resolveChatSearchActiveEventId,
  writeChatSearchSyncState,
} from "./chatSearchSyncWrite";
export { useChatSearchPanePresentation } from "./useChatSearchPanePresentation";
export type { UseChatSearchPanePresentationOptions } from "./useChatSearchPanePresentation";
export { useChatSearchSyncState } from "./useChatSearchSyncState";

/** @deprecated Alias for scrollSearchTargetIntoView */
export const scrollElementIntoView = scrollSearchTargetIntoView;

/** @deprecated Alias for findSearchTargetElement({ eventId }) */
export function findStationMessageElement(
  scrollRoot: HTMLElement,
  eventId: string
): HTMLElement | null {
  return findSearchTargetElement(scrollRoot, { eventId });
}

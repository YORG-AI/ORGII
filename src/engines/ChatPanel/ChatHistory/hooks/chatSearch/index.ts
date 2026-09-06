import { scrollSearchTargetIntoView } from "./chatSearchTargetDom";

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
  buildSearchTargetRowProps,
  findChatSearchTargetElement,
  formatChatEventIdsAttribute,
  resolveVisibleSearchResultIndex,
  scrollSearchTargetIntoView,
} from "./chatSearchTargetDom";

export {
  EMPTY_CHAT_SEARCH_SYNC,
  buildChatSearchSyncState,
  writeChatSearchSyncState,
} from "./chatSearchSyncWrite";
export { useChatSearchPanePresentation } from "./useChatSearchPanePresentation";

export { useChatSearchSyncState } from "./useChatSearchSyncState";

/** @deprecated Alias for scrollSearchTargetIntoView */
export const scrollElementIntoView = scrollSearchTargetIntoView;

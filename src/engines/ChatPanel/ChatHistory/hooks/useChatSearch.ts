/**
 * useChatSearch — Rust-backed search with projection-aware DOM scrolling.
 */
import { invoke } from "@tauri-apps/api/core";
import { useAtom, useSetAtom } from "jotai";
import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useEventNavigation } from "@src/engines/SessionCore";
import { useDebouncedCallback } from "@src/hooks/perf";
import {
  chatFindInChatOpenAtomFamily,
  chatSearchSyncAtomFamily,
} from "@src/store/ui/chatPanelAtom";
import {
  setCollapseStateAtom,
  setTurnCollapseOverrideAtom,
} from "@src/store/ui/collapseStateAtom";

import type { OptimizedChatItem } from "../chatItemPipeline/types";
import type { ChatHistoryListHandle } from "../components/ChatHistoryList";
import {
  EMPTY_CHAT_SEARCH_SYNC,
  buildChatSearchSyncState,
  useChatSearchPanePresentation,
  writeChatSearchSyncState,
} from "./chatSearch";
import { resolveVisibleSearchResultIndex } from "./chatSearchDom";
import {
  type ChatSearchModes,
  DEFAULT_CHAT_SEARCH_MODES,
  type MappedSearchResult,
  type RustSearchResult,
  mapRustResultsToSearchResults,
  searchChatHistoryLocally,
  wrapNextSearchResultIndex,
} from "./chatSearchHelpers";
import {
  buildEventIdProjectionIndex,
  resolvePageIndexForFlatIndex,
  toDisplayFlatIndex,
} from "./chatSearchProjection";
import type { ChatGroupMeta } from "./useChatGroups";
import type { ChatTurnPage } from "./useChatTurnPagination";

export type SearchResult = MappedSearchResult;

interface TurnPageSelection {
  pageIndex: number | null;
  sessionId: string | null;
}

export interface UseChatSearchOptions {
  sessionId: string | null;
  chatHistory: MappedSearchResult["item"][];
  flatItems: OptimizedChatItem[];
  groupCounts: number[];
  groupMeta: ChatGroupMeta[];
  pages: ChatTurnPage[];
  turnPaginationEnabled: boolean;
  currentPageIndex: number;
  setTurnPageSelection: Dispatch<SetStateAction<TurnPageSelection>>;
  virtualListRef: RefObject<ChatHistoryListHandle | null>;
  chatContainerRef: RefObject<HTMLDivElement | null>;
  debounceMs?: number;
  maxResults?: number;
}

export interface UseChatSearchReturn {
  query: string;
  setQuery: (query: string) => void;
  results: SearchResult[];
  isSearching: boolean;
  isSearchActive: boolean;
  isSearchVisible: boolean;
  closeSearch: () => void;
  currentResultIndex: number;
  resultCount: number;
  nextResult: () => void;
  prevResult: () => void;
  caseSensitive: boolean;
  toggleCaseSensitive: () => void;
  useRegex: boolean;
  toggleRegex: () => void;
  wholeWord: boolean;
  toggleWholeWord: () => void;
}

async function fetchChatSearchResults(
  sessionId: string,
  chatHistory: UseChatSearchOptions["chatHistory"],
  query: string,
  modes: ChatSearchModes,
  maxResults: number
): Promise<SearchResult[]> {
  const trimmedQuery = query.trim();
  let rustResults: RustSearchResult[] = [];

  try {
    rustResults = await invoke<RustSearchResult[]>("es_search_chat_events", {
      sessionId,
      options: {
        query: trimmedQuery,
        caseSensitive: modes.caseSensitive,
        useRegex: modes.useRegex,
        wholeWord: modes.wholeWord,
        maxResults,
      },
    });
  } catch {
    return searchChatHistoryLocally(
      chatHistory,
      trimmedQuery,
      modes,
      maxResults
    );
  }

  const mapped = mapRustResultsToSearchResults(rustResults, chatHistory);
  if (mapped.length > 0) return mapped;

  return searchChatHistoryLocally(chatHistory, trimmedQuery, modes, maxResults);
}

function resolveScrollContainer(
  chatContainerRef: RefObject<HTMLDivElement | null>
): HTMLElement | null {
  const container = chatContainerRef.current;
  if (!container) return null;
  return (
    container.querySelector<HTMLElement>(
      '[data-testid="chat-history-scroll-container"]'
    ) ?? container
  );
}

export function useChatSearch(
  options: UseChatSearchOptions
): UseChatSearchReturn {
  const {
    sessionId,
    chatHistory,
    flatItems,
    groupCounts,
    groupMeta,
    pages,
    turnPaginationEnabled,
    currentPageIndex,
    setTurnPageSelection,
    virtualListRef,
    chatContainerRef,
    debounceMs = 150,
    maxResults = 100,
  } = options;

  const sessionKey = sessionId ?? "";
  const [isSearchVisible, setIsSearchVisible] = useAtom(
    chatFindInChatOpenAtomFamily(sessionKey)
  );
  const setChatSearchSync = useSetAtom(chatSearchSyncAtomFamily(sessionKey));

  const [query, setQueryState] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [currentResultIndex, setCurrentResultIndex] = useState(0);
  const [modes, setModes] = useState<ChatSearchModes>(
    DEFAULT_CHAT_SEARCH_MODES
  );

  const searchGenerationRef = useRef(0);
  const queryRef = useRef(query);
  queryRef.current = query;
  const modesRef = useRef(modes);
  modesRef.current = modes;
  const suppressScrollSyncRef = useRef(false);
  const pendingScrollResultRef = useRef<SearchResult | null>(null);
  const pendingScrollNeedsLayoutRef = useRef(false);

  const { navigateToEvent } = useEventNavigation();
  const setTurnCollapseOverride = useSetAtom(setTurnCollapseOverrideAtom);
  const setCollapseState = useSetAtom(setCollapseStateAtom);

  const projectionIndex = useMemo(
    () => buildEventIdProjectionIndex(flatItems, groupCounts, groupMeta),
    [flatItems, groupCounts, groupMeta]
  );
  const projectionIndexRef = useRef(projectionIndex);
  projectionIndexRef.current = projectionIndex;

  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const currentPageIndexRef = useRef(currentPageIndex);
  currentPageIndexRef.current = currentPageIndex;

  const resetLocalSearch = useCallback(() => {
    setQueryState("");
    setResults([]);
    setCurrentResultIndex(0);
    setModes(DEFAULT_CHAT_SEARCH_MODES);
    writeChatSearchSyncState(setChatSearchSync, EMPTY_CHAT_SEARCH_SYNC);
    searchGenerationRef.current += 1;
  }, [setChatSearchSync]);

  const finishPendingScroll = useCallback(
    (result: SearchResult) => {
      const eventId = result.item.id || result.item.chunk_id || "";
      const projection = eventId
        ? projectionIndexRef.current.get(eventId)
        : undefined;

      let targetPageIndex = currentPageIndexRef.current;
      if (turnPaginationEnabled && projection) {
        const resolvedPage = resolvePageIndexForFlatIndex(
          projection.globalFlatIndex,
          pagesRef.current
        );
        if (resolvedPage !== null) {
          targetPageIndex = resolvedPage;
        }
      }

      // Non-paginated view renders the full flat list; passing a turn page
      // slice here would clip indices outside the first page to null.
      const targetPage = turnPaginationEnabled
        ? pagesRef.current[targetPageIndex]
        : undefined;
      const displayFlatIndex = projection
        ? toDisplayFlatIndex(projection.globalFlatIndex, targetPage)
        : null;

      virtualListRef.current?.scrollToChatTarget({
        eventId,
        itemId: projection?.itemChunkId,
        flatIndex: displayFlatIndex ?? undefined,
        behavior: "auto",
      });

      window.setTimeout(() => {
        suppressScrollSyncRef.current = false;
      }, 80);
    },
    [turnPaginationEnabled, virtualListRef]
  );

  const scrollToSearchResult = useCallback(
    (result: SearchResult) => {
      const eventId = result.item.id || result.item.chunk_id || "";
      const projection = eventId
        ? projectionIndexRef.current.get(eventId)
        : undefined;
      const resolvedPage =
        turnPaginationEnabled && projection
          ? resolvePageIndexForFlatIndex(
              projection.globalFlatIndex,
              pagesRef.current
            )
          : null;
      const needsFlatItemsLayout =
        Boolean(projection?.turnId) ||
        (resolvedPage !== null && resolvedPage !== currentPageIndexRef.current);

      if (projection?.turnId) {
        setTurnCollapseOverride({
          turnId: projection.turnId,
          collapsed: false,
        });
      }
      if (eventId) {
        setCollapseState({ eventId, collapsed: false });
        navigateToEvent(eventId);
      }
      if (resolvedPage !== null && sessionId) {
        setTurnPageSelection({
          pageIndex: resolvedPage,
          sessionId,
        });
      }

      suppressScrollSyncRef.current = true;

      if (needsFlatItemsLayout) {
        pendingScrollResultRef.current = result;
        pendingScrollNeedsLayoutRef.current = true;
        return;
      }

      window.requestAnimationFrame(() => {
        finishPendingScroll(result);
      });
    },
    [
      finishPendingScroll,
      navigateToEvent,
      sessionId,
      setCollapseState,
      setTurnCollapseOverride,
      setTurnPageSelection,
      turnPaginationEnabled,
    ]
  );

  useEffect(() => {
    if (!pendingScrollNeedsLayoutRef.current) return;
    const result = pendingScrollResultRef.current;
    if (!result) return;

    pendingScrollNeedsLayoutRef.current = false;
    pendingScrollResultRef.current = null;

    window.requestAnimationFrame(() => {
      finishPendingScroll(result);
    });
  }, [currentPageIndex, finishPendingScroll, flatItems, groupCounts]);

  const performSearch = useCallback(
    async (
      searchQuery: string,
      searchModes: ChatSearchModes = modesRef.current
    ) => {
      const trimmedQuery = searchQuery.trim();
      if (!trimmedQuery || chatHistory.length === 0 || !sessionId) {
        setResults([]);
        setCurrentResultIndex(0);
        setIsSearching(false);
        return;
      }

      setIsSearching(true);
      const generation = ++searchGenerationRef.current;

      try {
        const searchResults = await fetchChatSearchResults(
          sessionId,
          chatHistory,
          trimmedQuery,
          searchModes,
          maxResults
        );

        if (generation !== searchGenerationRef.current) return;

        setResults(searchResults);
        setCurrentResultIndex(0);
        setIsSearching(false);

        const first = searchResults[0];
        if (first) scrollToSearchResult(first);
      } catch {
        if (generation !== searchGenerationRef.current) return;
        setResults([]);
        setCurrentResultIndex(0);
        setIsSearching(false);
      }
    },
    [chatHistory, maxResults, scrollToSearchResult, sessionId]
  );

  const debouncedPerformSearch = useDebouncedCallback(
    (q: string) => performSearch(q),
    debounceMs
  );

  useEffect(() => {
    resetLocalSearch();
    debouncedPerformSearch.cancel();
  }, [sessionId, resetLocalSearch, debouncedPerformSearch]);

  const handleQueryChange = useCallback(
    (newQuery: string) => {
      setQueryState(newQuery);
      if (!newQuery.trim()) {
        debouncedPerformSearch.cancel();
        setResults([]);
        setCurrentResultIndex(0);
        setIsSearching(false);
        return;
      }
      debouncedPerformSearch(newQuery);
    },
    [debouncedPerformSearch]
  );

  const navigateToResult = useCallback(
    (resultIndex: number) => {
      const result = results[resultIndex];
      if (!result) return;
      setCurrentResultIndex(resultIndex);
      scrollToSearchResult(result);
    },
    [results, scrollToSearchResult]
  );

  const nextResult = useCallback(() => {
    if (results.length === 0) return;
    navigateToResult(
      wrapNextSearchResultIndex(currentResultIndex, results.length, 1)
    );
  }, [currentResultIndex, navigateToResult, results.length]);

  const prevResult = useCallback(() => {
    if (results.length === 0) return;
    navigateToResult(
      wrapNextSearchResultIndex(currentResultIndex, results.length, -1)
    );
  }, [currentResultIndex, navigateToResult, results.length]);

  const closeSearch = useCallback(() => {
    debouncedPerformSearch.cancel();
    resetLocalSearch();
    setIsSearchVisible(false);
  }, [debouncedPerformSearch, resetLocalSearch, setIsSearchVisible]);

  const toggleSearchMode = useCallback(
    (key: keyof ChatSearchModes) => {
      setModes((previous) => {
        const next = { ...previous, [key]: !previous[key] };
        if (queryRef.current.trim()) {
          void performSearch(queryRef.current, next);
        }
        return next;
      });
    },
    [performSearch]
  );

  useChatSearchPanePresentation({
    sessionId,
    highlightRootRef: chatContainerRef,
  });

  useEffect(() => {
    writeChatSearchSyncState(
      setChatSearchSync,
      buildChatSearchSyncState({
        isOpen: isSearchVisible,
        query,
        results,
        currentResultIndex,
      })
    );
  }, [currentResultIndex, isSearchVisible, query, results, setChatSearchSync]);

  useEffect(() => {
    if (!isSearchVisible || results.length === 0) return;

    const scrollRoot = resolveScrollContainer(chatContainerRef);
    if (!scrollRoot) return;

    let frame = 0;
    const handleScroll = () => {
      if (suppressScrollSyncRef.current) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const visibleIndex = resolveVisibleSearchResultIndex(
          scrollRoot,
          results.map((result) => result.item.id || result.item.chunk_id || "")
        );
        if (visibleIndex !== null) {
          setCurrentResultIndex(visibleIndex);
        }
      });
    };

    scrollRoot.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      scrollRoot.removeEventListener("scroll", handleScroll);
      cancelAnimationFrame(frame);
    };
  }, [chatContainerRef, isSearchVisible, results]);

  return {
    query,
    setQuery: handleQueryChange,
    results,
    isSearching,
    isSearchActive: query.trim().length > 0,
    isSearchVisible,
    closeSearch,
    currentResultIndex,
    resultCount: results.length,
    nextResult,
    prevResult,
    caseSensitive: modes.caseSensitive,
    toggleCaseSensitive: () => toggleSearchMode("caseSensitive"),
    useRegex: modes.useRegex,
    toggleRegex: () => toggleSearchMode("useRegex"),
    wholeWord: modes.wholeWord,
    toggleWholeWord: () => toggleSearchMode("wholeWord"),
  };
}

export default useChatSearch;

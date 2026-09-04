/**
 * useContextMenu Hook
 *
 * Description: Manages state and keyboard navigation for the unified context menu.
 *
 * Features:
 * - Keyboard navigation (up/down/left/right/enter/escape)
 * - Multi-level menu support
 * - Native file search integration
 * - Search query management
 */
import {
  KEYBOARD_CONFIG,
  MenuItemId,
  SecondLayerId,
} from "@/src/scaffold/ContextMenu/config";
import type {
  SearchResultItem,
  UseContextMenuOptions,
  UseContextMenuReturn,
} from "@/src/scaffold/ContextMenu/types";
import { useAtomValue } from "jotai";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { org2CloudAuthAtom } from "@src/features/Org2Cloud/org2CloudAuthAtom";
import { sidebarActiveCloudOrgIdAtom } from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import { org2CloudRemoteSessionsAtom } from "@src/features/Org2Cloud/org2CloudRemoteSessionsAtom";
import { teamSessionMentionResults } from "@src/features/Org2Cloud/teamSessionMentionResults";
import { createLogger } from "@src/hooks/logger";
import {
  DEBOUNCE_DELAYS,
  useDebouncedCallback,
} from "@src/hooks/perf/useDebouncedCallback";
import { sessionsAtom } from "@src/store/session/sessionAtom";
import { workspaceFoldersAtom } from "@src/store/ui/workspaceFoldersAtom";
import { activeWorkspaceRootAtom } from "@src/store/workspace";
import { LatestRequestGuard } from "@src/util/core/latestRequestGuard";

import { searchFiles, searchSessions } from "./contextMenuSearchHandlers";
import {
  attachSearchRootMetadata,
  buildContextMenuSearchRoots,
  buildRootSearchResult,
  mergeSearchResultsByRoot,
} from "./contextMenuSearchRoots";

const log = createLogger("ContextMenu");

// Default configuration
const DEFAULT_OPTIONS: UseContextMenuOptions = {
  repoPath: undefined,
  onSelect: undefined,
  onClose: undefined,
};

/**
 * Hook for managing context menu state and navigation
 */
export function useContextMenu(
  options: UseContextMenuOptions = {}
): UseContextMenuReturn {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  // Store callbacks in refs to avoid stale closures
  const onSelectRef = useRef(opts.onSelect);
  const onCloseRef = useRef(opts.onClose);

  // Keep refs up to date
  onSelectRef.current = opts.onSelect;
  onCloseRef.current = opts.onClose;

  const activeWorkspaceRoot = useAtomValue(activeWorkspaceRootAtom);
  const currentRepo = useMemo(
    () =>
      activeWorkspaceRoot
        ? { name: activeWorkspaceRoot.name, path: activeWorkspaceRoot.path }
        : null,
    [activeWorkspaceRoot]
  );
  const workspaceFolders = useAtomValue(workspaceFoldersAtom);
  const searchRoots = useMemo(
    () =>
      buildContextMenuSearchRoots({
        repoPath: opts.repoPath,
        currentRepo,
        workspaceFolders,
      }),
    [currentRepo, opts.repoPath, workspaceFolders]
  );

  // Get all sessions for @sessions search
  const allSessions = useAtomValue(sessionsAtom);
  // Team sessions ride the ALREADY-CACHED listing: opening a menu must not
  // put an RPC on the wire, so `useCloudOrgRemoteSessions` (which fetches)
  // is deliberately not used here.
  const cloudRemoteSessions = useAtomValue(org2CloudRemoteSessionsAtom);
  const activeCloudOrgId = useAtomValue(sidebarActiveCloudOrgIdAtom);
  const cloudAuth = useAtomValue(org2CloudAuthAtom);
  const localSessionIdSet = useMemo(
    () => new Set(allSessions.map((session) => session.session_id)),
    [allSessions]
  );

  // State is owned by the menu for both + and @ entry points.
  const [activeIndex, setActiveIndex] = useState(0);
  const [keyboardNavigated, setKeyboardNavigated] = useState(true);
  const [internalSecondLayer, setInternalSecondLayer] =
    useState<SecondLayerId | null>(null);
  const [searchResults, setSearchResults] = useState<SearchResultItem[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [secondLayerActiveIndex, setSecondLayerActiveIndex] = useState(0);
  const hasMovedMainHighlightRef = useRef(false);
  const hasMovedSecondLayerHighlightRef = useRef(false);
  const searchRequestGuardRef = useRef<LatestRequestGuard | null>(null);
  if (searchRequestGuardRef.current === null) {
    searchRequestGuardRef.current = new LatestRequestGuard();
  }

  useEffect(() => {
    return () => {
      searchRequestGuardRef.current!.invalidate();
    };
  }, []);

  const secondLayer = internalSecondLayer;
  const searchQuery = opts.searchQuery ?? "";
  const isMainFileSearch =
    secondLayer === null &&
    Boolean(opts.searchFilesFromMain) &&
    searchQuery.trim().length > 0;
  const effectiveSearchLayer: SecondLayerId | null =
    secondLayer ?? (isMainFileSearch ? "files" : null);

  const setSecondLayer = setInternalSecondLayer;

  const mainItemCount = opts.mainItemCount ?? 0;
  const onMainItemIndexSelect = opts.onMainItemIndexSelect;
  const menuItemsCount =
    mainItemCount + (isMainFileSearch ? searchResults.length : 0);

  useEffect(() => {
    hasMovedMainHighlightRef.current = true;
    setKeyboardNavigated(true);
    setActiveIndex(0);
  }, [mainItemCount, searchQuery]);

  useEffect(() => {
    hasMovedSecondLayerHighlightRef.current = true;
  }, [secondLayer, searchResults.length]);

  // Helper: set search results AND reset active index in one batch
  // (React 18 batches these into a single render)
  const updateSearchResults = useCallback((results: SearchResultItem[]) => {
    setSearchResults(results);
    setSecondLayerActiveIndex(0);
  }, []);

  const performSearch = useCallback(
    async (query: string, type: SecondLayerId, allowEmpty: boolean = false) => {
      const request = searchRequestGuardRef.current!.issue();
      if (!query.trim() && !allowEmpty) {
        updateSearchResults([]);
        setSearchLoading(false);
        return;
      }
      setSearchLoading(true);
      try {
        let results: SearchResultItem[];
        if (type === "files") {
          const perRootResults = await Promise.all(
            searchRoots.map(async (root) =>
              attachSearchRootMetadata(
                await searchFiles(query, root.path),
                root
              )
            )
          );
          const rootResults = searchRoots.map(buildRootSearchResult);
          const fileResults = mergeSearchResultsByRoot(perRootResults, 20);
          results = [...rootResults, ...fileResults].slice(0, 20);
        } else if (type === "sessions") {
          // Teammates' sessions sit after the viewer's own: the local list
          // is what @ has always meant, and team rows extend it.
          results = [
            ...searchSessions(query, allSessions),
            ...teamSessionMentionResults({
              query,
              rows: activeCloudOrgId
                ? cloudRemoteSessions[activeCloudOrgId]?.rows
                : undefined,
              selfUserId: cloudAuth?.userId ?? null,
              localSessionIds: localSessionIdSet,
            }),
          ];
        } else {
          results = [];
        }
        if (request.isCurrent()) {
          updateSearchResults(results);
        }
      } catch (error) {
        if (request.isCurrent()) {
          log.error("[ContextMenu] Search failed:", error);
          updateSearchResults([]);
        }
      } finally {
        if (request.isCurrent()) {
          setSearchLoading(false);
        }
      }
    },
    [
      searchRoots,
      allSessions,
      updateSearchResults,
      activeCloudOrgId,
      cloudAuth?.userId,
      cloudRemoteSessions,
      localSessionIdSet,
    ]
  );

  // Debounced context menu search — leading: true fires first call immediately
  // so entering a layer shows results without waiting for the debounce delay
  const debouncedContextSearch = useDebouncedCallback(
    (query: string, layer: SecondLayerId, showAll: boolean) => {
      performSearch(query, layer, showAll);
    },
    DEBOUNCE_DELAYS.SEARCH,
    { leading: true }
  );

  // Handle search query changes with debounce.
  // NOTE: `performSearch` is intentionally NOT in the deps — it changes
  // whenever editorTerminalSessions change, which
  // would trigger spurious re-searches.  The ref-based callback inside
  // useDebouncedCallback keeps the function fresh.
  useEffect(() => {
    if (effectiveSearchLayer) {
      // Invalidate immediately when the user's search intent changes. The next
      // debounced search issues its own ticket; until then, an older request
      // must not commit results for the previous query or menu invocation.
      searchRequestGuardRef.current!.invalidate();
      // When entering files layer without query, still search to show all files
      debouncedContextSearch(
        searchQuery,
        effectiveSearchLayer,
        Boolean(secondLayer) && !searchQuery
      );
    } else if (!searchQuery) {
      debouncedContextSearch.cancel();
      searchRequestGuardRef.current!.invalidate();
      updateSearchResults([]);
      setSearchLoading(false);
    }
  }, [
    searchQuery,
    secondLayer,
    effectiveSearchLayer,
    debouncedContextSearch,
    updateSearchResults,
  ]);

  // Handle item selection - uses refs to avoid stale closures
  const handleSelect = useCallback(
    (type: MenuItemId, value?: string, displayName?: string) => {
      onSelectRef.current?.(type, value, displayName);
      onCloseRef.current?.();
    },
    []
  );

  // Go back from a second layer to the main menu.
  const goBack = useCallback(() => {
    setSecondLayer(null);
    updateSearchResults([]);
  }, [updateSearchResults, setSecondLayer]);

  // Reset state
  const reset = useCallback(() => {
    searchRequestGuardRef.current!.invalidate();
    setActiveIndex(0);
    setKeyboardNavigated(true);
    setSecondLayer(null);
    updateSearchResults([]);
    setSearchLoading(false);
  }, [updateSearchResults, setSecondLayer]);

  const selectSearchResult = useCallback(
    (selected: SearchResultItem, layer: SecondLayerId) => {
      let selectType: MenuItemId = layer;
      if (selected.iconType === "repo") {
        selectType = "repo";
      } else if (selected.iconType === "project") {
        selectType = "project";
      } else if (selected.iconType === "workitem") {
        selectType = "workitem";
      } else if (selected.iconType === "browser") {
        selectType = "browser";
      } else if (selected.iconType === "cloudSession") {
        selectType = "cloudSession";
      } else if (layer === "files" && selected.type === "folder") {
        selectType = "folder";
      }
      handleSelect(selectType, selected.path, selected.name);
    },
    [handleSelect]
  );

  // Handle keyboard navigation - returns true if the event was handled
  const handleKeyDown = useCallback(
    (e: KeyboardEvent): boolean => {
      const { key } = e;

      // Handle escape - go back or close
      if (key === KEYBOARD_CONFIG.escape) {
        e.preventDefault();
        e.stopPropagation();
        if (secondLayer) {
          goBack();
        } else {
          onCloseRef.current?.();
        }
        return true;
      }

      // In second-layer mode after a main-menu context category is selected.
      if (secondLayer) {
        switch (key) {
          case KEYBOARD_CONFIG.up:
            e.preventDefault();
            e.stopPropagation();
            if (searchResults.length > 0) {
              setKeyboardNavigated(true);
              hasMovedSecondLayerHighlightRef.current = true;
              setSecondLayerActiveIndex((prev) =>
                prev > 0 ? prev - 1 : searchResults.length - 1
              );
            }
            return true;

          case KEYBOARD_CONFIG.down:
            e.preventDefault();
            e.stopPropagation();
            if (searchResults.length > 0) {
              setKeyboardNavigated(true);
              if (hasMovedSecondLayerHighlightRef.current) {
                setSecondLayerActiveIndex((prev) =>
                  prev < searchResults.length - 1 ? prev + 1 : 0
                );
              } else {
                setSecondLayerActiveIndex((prev) => (prev >= 0 ? prev : 0));
              }
              hasMovedSecondLayerHighlightRef.current = true;
            }
            return true;

          case KEYBOARD_CONFIG.enter:
            e.preventDefault();
            e.stopPropagation();
            if (searchResults.length > 0) {
              const selected = searchResults[secondLayerActiveIndex];
              selectSearchResult(selected, secondLayer);
            }
            return true;

          case KEYBOARD_CONFIG.left:
            // Left arrow goes back to main menu
            e.preventDefault();
            e.stopPropagation();
            goBack();
            return true;

          case KEYBOARD_CONFIG.tab:
            e.preventDefault();
            e.stopPropagation();
            if (searchResults.length > 0) {
              setKeyboardNavigated(true);
              hasMovedSecondLayerHighlightRef.current = true;
              setSecondLayerActiveIndex((prev) =>
                prev < searchResults.length - 1 ? prev + 1 : 0
              );
            }
            return true;
        }
        // Don't capture other keys (like right arrow for cursor movement)
        return false;
      }

      // In main menu
      switch (key) {
        case KEYBOARD_CONFIG.up:
          e.preventDefault();
          e.stopPropagation();
          if (menuItemsCount === 0) return true;
          setKeyboardNavigated(true);
          hasMovedMainHighlightRef.current = true;
          setActiveIndex((prev) => (prev > 0 ? prev - 1 : menuItemsCount - 1));
          return true;

        case KEYBOARD_CONFIG.down:
          e.preventDefault();
          e.stopPropagation();
          if (menuItemsCount === 0) return true;
          setKeyboardNavigated(true);
          if (hasMovedMainHighlightRef.current) {
            setActiveIndex((prev) =>
              prev < menuItemsCount - 1 ? prev + 1 : 0
            );
          } else {
            setActiveIndex((prev) => (prev >= 0 ? prev : 0));
          }
          hasMovedMainHighlightRef.current = true;
          return true;

        case KEYBOARD_CONFIG.right:
        case KEYBOARD_CONFIG.enter: {
          e.preventDefault();
          e.stopPropagation();
          if (activeIndex >= 0 && activeIndex < mainItemCount) {
            onMainItemIndexSelect?.(activeIndex);
            return true;
          }
          const result = searchResults[activeIndex - mainItemCount];
          if (isMainFileSearch && result) {
            selectSearchResult(result, "files");
          }
          return true;
        }

        case KEYBOARD_CONFIG.tab:
          e.preventDefault();
          e.stopPropagation();
          // Tab cycles through items
          setKeyboardNavigated(true);
          hasMovedMainHighlightRef.current = true;
          setActiveIndex((prev) => (prev < menuItemsCount - 1 ? prev + 1 : 0));
          return true;
      }

      return false;
    },
    [
      secondLayer,
      searchResults,
      secondLayerActiveIndex,
      activeIndex,
      isMainFileSearch,
      menuItemsCount,
      mainItemCount,
      selectSearchResult,
      goBack,
      onMainItemIndexSelect,
    ]
  );

  return {
    activeIndex,
    setActiveIndex,
    keyboardNavigated,
    setKeyboardNavigated,
    secondLayer,
    setSecondLayer,
    searchResults,
    searchLoading,
    secondLayerActiveIndex,
    setSecondLayerActiveIndex,
    handleKeyDown,
    handleSelect,
    reset,
  };
}

export default useContextMenu;

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
  MENU_ITEMS,
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

import { createLogger } from "@src/hooks/logger";
import {
  DEBOUNCE_DELAYS,
  useDebouncedCallback,
} from "@src/hooks/perf/useDebouncedCallback";
import { sessionsAtom } from "@src/store/session/sessionAtom";
import { workspaceFoldersAtom } from "@src/store/ui/workspaceFoldersAtom";
import { activeWorkspaceRootAtom } from "@src/store/workspace";

import {
  type DrilledProject,
  searchFiles,
  searchProjects,
  searchSessions,
} from "./contextMenuSearchHandlers";
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
  const effectiveRepoPath = opts.repoPath || activeWorkspaceRoot?.path || "";

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

  const drilledProjectRef = useRef<DrilledProject | null>(null);
  const [drilledProjectName, setDrilledProjectName] = useState<string | null>(
    null
  );

  // State — internal (used when user clicks menu items, NOT for inline @query)
  const [activeIndex, setActiveIndex] = useState(0);
  const [keyboardNavigated, setKeyboardNavigated] = useState(false);
  const [internalSecondLayer, setInternalSecondLayer] =
    useState<SecondLayerId | null>(null);
  const [internalSearchQuery, setInternalSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResultItem[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [secondLayerActiveIndex, setSecondLayerActiveIndex] = useState(0);
  const hasMovedMainHighlightRef = useRef(false);
  const hasMovedSecondLayerHighlightRef = useRef(false);

  // Derive effective values — when externalSearchQuery is provided, override
  // without any setState.  This eliminates the 2-setState cascade that was
  // previously done via a useEffect in ContextMenu/index.tsx.
  const hasExternalQuery =
    opts.externalSearchQuery !== undefined &&
    (opts.inlineSearchOnEmpty || opts.externalSearchQuery.length > 0);
  const secondLayer: SecondLayerId | null = hasExternalQuery
    ? (internalSecondLayer ?? "files")
    : internalSecondLayer;
  const searchQuery: string =
    opts.externalSearchQuery !== undefined
      ? opts.externalSearchQuery
      : internalSearchQuery;

  // Expose setters that write to the internal state
  const setSecondLayer = setInternalSecondLayer;
  const setSearchQuery = setInternalSearchQuery;

  const recentCount = opts.recentCount ?? 0;
  const customMentionCount = opts.customMentionCount ?? 0;
  const onCustomMentionIndexSelect = opts.onCustomMentionIndexSelect;
  const customMentionStartIndex = recentCount;
  const menuStartIndex = recentCount + customMentionCount;

  // Get total menu items count
  const menuItemsCount = menuStartIndex + MENU_ITEMS.length;

  useEffect(() => {
    hasMovedMainHighlightRef.current = opts.keyboardOpened ?? false;
  }, [opts.keyboardOpened, menuItemsCount, opts.externalSearchQuery]);

  useEffect(() => {
    hasMovedSecondLayerHighlightRef.current = opts.keyboardOpened ?? false;
  }, [
    secondLayer,
    searchResults.length,
    opts.externalSearchQuery,
    opts.keyboardOpened,
  ]);

  // Helper: set search results AND reset active index in one batch
  // (React 18 batches these into a single render)
  const updateSearchResults = useCallback((results: SearchResultItem[]) => {
    setSearchResults(results);
    setSecondLayerActiveIndex(0);
  }, []);

  const performSearch = useCallback(
    async (query: string, type: SecondLayerId, allowEmpty: boolean = false) => {
      if (!query.trim() && !allowEmpty) {
        updateSearchResults([]);
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
          results = searchSessions(query, allSessions);
        } else if (type === "projects") {
          results = await searchProjects(
            query,
            effectiveRepoPath,
            drilledProjectRef.current
          );
        } else {
          results = [];
        }
        updateSearchResults(results);
      } catch (error) {
        log.error("[ContextMenu] Search failed:", error);
        updateSearchResults([]);
      } finally {
        setSearchLoading(false);
      }
    },
    [effectiveRepoPath, searchRoots, allSessions, updateSearchResults]
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
    if (secondLayer) {
      // When entering files layer without query, still search to show all files
      debouncedContextSearch(searchQuery, secondLayer, !searchQuery);
    } else if (!searchQuery) {
      debouncedContextSearch.cancel();
      updateSearchResults([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, secondLayer, debouncedContextSearch]);

  // Handle item selection - uses refs to avoid stale closures
  // Intercepts "project" clicks in the projects layer to drill in
  const handleSelect = useCallback(
    (type: MenuItemId, value?: string, displayName?: string) => {
      if (
        type === "project" &&
        secondLayer === "projects" &&
        !drilledProjectRef.current &&
        value
      ) {
        drilledProjectRef.current = {
          slug: value,
          name: displayName || value,
        };
        setDrilledProjectName(displayName || value);
        setSecondLayerActiveIndex(0);
        // Bypass debounce — drill-down must fire immediately
        performSearch("", "projects", true);
        return;
      }
      onSelectRef.current?.(type, value, displayName);
      onCloseRef.current?.();
    },
    [secondLayer, performSearch] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Go back — from drilled project to project list, or from project list to main menu
  const goBack = useCallback(() => {
    if (drilledProjectRef.current) {
      drilledProjectRef.current = null;
      setDrilledProjectName(null);
      setSecondLayerActiveIndex(0);
      // Bypass debounce — back navigation must fire immediately
      performSearch("", "projects", true);
    } else {
      setSecondLayer(null);
      setSearchQuery("");
      updateSearchResults([]);
    }
  }, [updateSearchResults, setSearchQuery, setSecondLayer, performSearch]);

  // Reset state
  const reset = useCallback(() => {
    setActiveIndex(0);
    setKeyboardNavigated(false);
    setSecondLayer(null);
    setSearchQuery("");
    updateSearchResults([]);
    setSearchLoading(false);
    drilledProjectRef.current = null;
    setDrilledProjectName(null);
  }, [updateSearchResults, setSearchQuery, setSecondLayer]);

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

      // In second layer mode (secondLayer is set when user clicks a menu item or types after @)
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
            if (
              hasExternalQuery &&
              activeIndex >= customMentionStartIndex &&
              activeIndex < menuStartIndex
            ) {
              onCustomMentionIndexSelect?.(
                activeIndex - customMentionStartIndex
              );
              return true;
            }
            if (searchResults.length > 0) {
              const selected = searchResults[secondLayerActiveIndex];
              // Use iconType for project/work items, otherwise secondLayer.
              let selectType: MenuItemId = secondLayer;
              if (selected.iconType === "repo") {
                selectType = "repo";
              } else if (selected.iconType === "project") {
                selectType = "project";
              } else if (selected.iconType === "workitem") {
                selectType = "workitem";
              } else if (selected.iconType === "browser") {
                selectType = "browser";
              } else if (
                secondLayer === "files" &&
                selected.type === "folder"
              ) {
                selectType = "folder";
              }
              handleSelect(selectType, selected.path, selected.name);
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
          setKeyboardNavigated(true);
          hasMovedMainHighlightRef.current = true;
          setActiveIndex((prev) => (prev > 0 ? prev - 1 : menuItemsCount - 1));
          return true;

        case KEYBOARD_CONFIG.down:
          e.preventDefault();
          e.stopPropagation();
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
          if (
            activeIndex >= customMentionStartIndex &&
            activeIndex < menuStartIndex
          ) {
            onCustomMentionIndexSelect?.(activeIndex - customMentionStartIndex);
            return true;
          }
          const menuIndex = activeIndex - menuStartIndex;
          const item = MENU_ITEMS[menuIndex];
          if (!item) return true;
          if (item.hasSecondLayer) {
            setSecondLayer(item.id as SecondLayerId);
          } else {
            handleSelect(item.id);
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
      hasExternalQuery,
      menuItemsCount,
      customMentionStartIndex,
      menuStartIndex,
      handleSelect,
      goBack,
      setSecondLayer,
      onCustomMentionIndexSelect,
    ]
  );

  return {
    activeIndex,
    setActiveIndex,
    keyboardNavigated,
    setKeyboardNavigated,
    secondLayer,
    setSecondLayer,
    searchQuery,
    setSearchQuery,
    searchResults,
    searchLoading,
    secondLayerActiveIndex,
    setSecondLayerActiveIndex,
    handleKeyDown,
    handleSelect,
    goBack,
    reset,
    drilledProjectName,
  };
}

export default useContextMenu;

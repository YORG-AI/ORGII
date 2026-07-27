/**
 * useEditorCache Hook (v3)
 *
 * Manages FILE-tab caches for the currently presented WorkStation workspace.
 * Repository identity is nested beneath workspace identity, so two sessions on
 * the same repository retain independent file tabs and active repo selection.
 * Shared resource tabs stay in the compatibility layout during repo switches.
 *
 * Created: 2026-01-29
 */
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useMemo } from "react";

import {
  // Types
  type EditorRepoCache,
  // Constants
  FILE_TAB_TYPES,
  MAX_EDITOR_CACHE_REPOS,
  MAX_FILE_TABS_PER_REPO,
  type WorkStationTab,
  activeEditorRepoAtom,
  activeRepoCacheAtom,
  clearAllEditorCacheAtom,
  clearRepoCacheAtom,
  // Editor cache atoms
  editorCacheAtom,
  editorCacheSizeAtom,
  mainPaneStateAtom,
  saveRepoCacheAtom,
  switchActiveRepoAtom,
  // Layout atoms
  workstationLayoutAtom,
} from "@src/store/workstation/tabs";

// ============================================
// Helpers
// ============================================

/**
 * Check if a tab is a file tab (cached per-repo)
 */
function isFileTab(tab: WorkStationTab): boolean {
  return FILE_TAB_TYPES.includes(tab.type as (typeof FILE_TAB_TYPES)[number]);
}

/**
 * Check if a tab is a tool tab (global, not cached)
 */
function isToolTab(tab: WorkStationTab): boolean {
  return !isFileTab(tab);
}

// ============================================
// Types
// ============================================

export interface UseEditorCacheReturn {
  // State
  activeRepoPath: string | null;
  activeRepoCache: EditorRepoCache | undefined;
  cacheSize: number;
  maxCacheRepos: number;
  maxFileTabsPerRepo: number;

  // Cache Operations
  saveCurrentFileTabs: () => void;
  restoreFileTabs: (repoPath: string) => WorkStationTab[] | null;
  clearRepoCache: (repoPath: string) => void;
  clearAllCache: () => void;

  // Repo Switching
  switchRepo: (newRepoPath: string) => void;

  // Cache Queries
  hasCache: (repoPath: string) => boolean;
  getCachedFileTabs: (repoPath: string) => WorkStationTab[] | undefined;

  // Tab Filtering
  getFileTabs: (tabs: WorkStationTab[]) => WorkStationTab[];
  getToolTabs: (tabs: WorkStationTab[]) => WorkStationTab[];
}

// ============================================
// Hook Implementation
// ============================================

export function useEditorCache(): UseEditorCacheReturn {
  // State
  const cache = useAtomValue(editorCacheAtom);
  const activeRepoPath = useAtomValue(activeEditorRepoAtom);
  const activeRepoCache = useAtomValue(activeRepoCacheAtom);
  const cacheSize = useAtomValue(editorCacheSizeAtom);

  const [editorLayout, setEditorLayout] = useAtom(workstationLayoutAtom);
  const mainPaneState = useAtomValue(mainPaneStateAtom);

  // Action atoms
  const saveToCache = useSetAtom(saveRepoCacheAtom);
  const clearRepoFromCache = useSetAtom(clearRepoCacheAtom);
  const clearAll = useSetAtom(clearAllEditorCacheAtom);
  const switchActiveRepo = useSetAtom(switchActiveRepoAtom);

  // ========================================
  // Tab Filtering
  // ========================================

  const getFileTabs = useCallback(
    (tabs: WorkStationTab[]): WorkStationTab[] => tabs.filter(isFileTab),
    []
  );

  const getToolTabs = useCallback(
    (tabs: WorkStationTab[]): WorkStationTab[] => tabs.filter(isToolTab),
    []
  );

  // ========================================
  // Cache Operations
  // ========================================

  /**
   * Save current FILE tabs to cache for the active repo
   * Tool tabs (terminal, browser) are NOT saved - they're global
   */
  const saveCurrentFileTabs = useCallback((): void => {
    if (!activeRepoPath) return;

    const currentTabs = mainPaneState?.tabs ?? [];
    const fileTabs = getFileTabs(currentTabs);
    const activeTabId = mainPaneState?.activeTabId ?? null;
    const firstFileTabId = fileTabs[0]?.id ?? null;

    // Only save if the active tab is a file tab
    const activeFileTabId = fileTabs.some((tab) => tab.id === activeTabId)
      ? activeTabId
      : firstFileTabId;

    saveToCache({
      repoPath: activeRepoPath,
      fileTabs,
      activeFileTabId,
      lastAccessedAt: Date.now(),
    });
  }, [activeRepoPath, mainPaneState, getFileTabs, saveToCache]);

  /**
   * Restore cached FILE tabs for a repo
   * Returns the file tabs if found, null otherwise
   */
  const restoreFileTabs = useCallback(
    (repoPath: string): WorkStationTab[] | null => {
      const cached = cache[repoPath];
      if (!cached) return null;
      return cached.fileTabs;
    },
    [cache]
  );

  /**
   * Clear cache for a specific repo
   */
  const clearRepoCache = useCallback(
    (repoPath: string): void => {
      clearRepoFromCache(repoPath);
    },
    [clearRepoFromCache]
  );

  /**
   * Clear all cached editor states
   */
  const clearAllCache = useCallback((): void => {
    clearAll();
  }, [clearAll]);

  // ========================================
  // Repo Switching
  // ========================================

  /**
   * Switch to a different repo
   *
   * What happens:
   * 1. Save current FILE tabs to cache
   * 2. Keep TOOL tabs (terminal, browser) in place
   * 3. Restore cached FILE tabs for new repo (if any)
   * 4. Merge: tool tabs + new file tabs
   */
  const switchRepo = useCallback(
    (newRepoPath: string): void => {
      // Don't do anything if same repo
      if (newRepoPath === activeRepoPath) return;

      const currentTabs = mainPaneState?.tabs ?? [];
      const currentActiveId = mainPaneState?.activeTabId ?? null;

      // Save current file tabs before switching
      if (activeRepoPath) {
        const fileTabs = getFileTabs(currentTabs);
        const fallbackFileTabId = fileTabs[0]?.id ?? null;
        const activeFileTabId = fileTabs.some(
          (tab) => tab.id === currentActiveId
        )
          ? currentActiveId
          : fallbackFileTabId;

        saveToCache({
          repoPath: activeRepoPath,
          fileTabs,
          activeFileTabId,
          lastAccessedAt: Date.now(),
        });
      }

      // Update active repo
      switchActiveRepo(newRepoPath);

      // Get tool tabs (these stay in place)
      const toolTabs = getToolTabs(currentTabs);

      // Get cached file tabs for new repo (or empty)
      const cached = cache[newRepoPath];
      const newFileTabs = cached?.fileTabs ?? [];
      const newActiveFileTabId = cached?.activeFileTabId ?? null;

      // Merge: tool tabs + new file tabs
      const newTabs = [...toolTabs, ...newFileTabs];

      // Determine new active tab
      // If current active was a tool tab, keep it
      // Otherwise, use the cached active file tab or first file tab
      const wasActiveToolTab = toolTabs.some(
        (tab) => tab.id === currentActiveId
      );
      const firstNewFileTabId = newFileTabs[0]?.id ?? null;
      const firstToolTabId = toolTabs[0]?.id ?? null;
      const newActiveId = wasActiveToolTab
        ? currentActiveId
        : (newActiveFileTabId ?? firstNewFileTabId ?? firstToolTabId);

      if (editorLayout) {
        setEditorLayout({
          ...editorLayout,
          mainPane: {
            tabs: newTabs,
            activeTabId: newActiveId,
          },
        });
      }
    },
    [
      activeRepoPath,
      mainPaneState,
      getFileTabs,
      getToolTabs,
      saveToCache,
      switchActiveRepo,
      cache,
      editorLayout,
      setEditorLayout,
    ]
  );

  // ========================================
  // Cache Queries
  // ========================================

  const hasCache = useCallback(
    (repoPath: string): boolean => {
      return repoPath in cache;
    },
    [cache]
  );

  const getCachedFileTabs = useCallback(
    (repoPath: string): WorkStationTab[] | undefined => {
      return cache[repoPath]?.fileTabs;
    },
    [cache]
  );

  // ========================================
  // Return
  // ========================================

  return useMemo(
    () => ({
      // State
      activeRepoPath,
      activeRepoCache,
      cacheSize,
      maxCacheRepos: MAX_EDITOR_CACHE_REPOS,
      maxFileTabsPerRepo: MAX_FILE_TABS_PER_REPO,

      // Cache Operations
      saveCurrentFileTabs,
      restoreFileTabs,
      clearRepoCache,
      clearAllCache,

      // Repo Switching
      switchRepo,

      // Cache Queries
      hasCache,
      getCachedFileTabs,

      // Tab Filtering
      getFileTabs,
      getToolTabs,
    }),
    [
      activeRepoPath,
      activeRepoCache,
      cacheSize,
      saveCurrentFileTabs,
      restoreFileTabs,
      clearRepoCache,
      clearAllCache,
      switchRepo,
      hasCache,
      getCachedFileTabs,
      getFileTabs,
      getToolTabs,
    ]
  );
}

export default useEditorCache;

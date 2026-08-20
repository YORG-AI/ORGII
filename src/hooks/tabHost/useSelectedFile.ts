/**
 * useSelectedFile Hook
 *
 * SINGLE SOURCE OF TRUTH for file selection across the editor.
 *
 * The active editor tab is THE source of truth for which file is selected.
 * All panels (Explorer, Source Control, Search) should use this hook to:
 * 1. Read the currently selected file
 * 2. Select a new file (which opens a tab)
 *
 * This eliminates the old pattern of multiple competing states:
 * - workStationState.selectedFile (removed as source of truth)
 * - activeFilePath prop drilling (replaced with this hook)
 * - various local selections in panels (should all sync to this)
 *
 * Uses workstationLayoutAtom as single source of truth.
 */
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useMemo } from "react";

import {
  type WorkStationLayoutState,
  activeWorkStationFilePathAtom,
  createFileTab,
  openTab as openTabHelper,
  workstationLayoutAtom,
} from "@src/store/workstation/tabs";

export interface UseSelectedFileOptions {
  /** Callback when file content should be loaded (for useCodeEditor integration) */
  onLoadFileContent?: (filePath: string) => void;
}

export interface UseSelectedFileReturn {
  /** Currently selected file path (from active tab in the unified mainPane) */
  selectedFilePath: string | null;

  /** Select a file by opening a tab for it */
  selectFile: (filePath: string) => void;

  /** Drive the unified Source Control tab into Focus mode on a specific file */
  selectGitDiff: (filePath: string) => void;

  /** Check if a file path is currently selected */
  isSelected: (filePath: string) => boolean;
}

/**
 * Hook providing the single source of truth for file selection.
 *
 * Usage:
 * ```tsx
 * const { selectedFilePath, selectFile, isSelected } = useSelectedFile();
 *
 * // In file tree:
 * <TreeItem
 *   selected={isSelected(file.path)}
 *   onClick={() => selectFile(file.path)}
 * />
 * ```
 */
export function useSelectedFile(
  options: UseSelectedFileOptions = {}
): UseSelectedFileReturn {
  const { onLoadFileContent } = options;

  const focusedFilePath = useAtomValue(activeWorkStationFilePathAtom);
  const setLayout = useSetAtom(workstationLayoutAtom);

  const selectFile = useCallback(
    (filePath: string) => {
      if (!filePath) return;
      const tab = createFileTab(filePath);
      setLayout((layout: WorkStationLayoutState) => ({
        ...layout,
        mainPane: openTabHelper(
          layout?.mainPane ?? { tabs: [], activeTabId: null },
          tab
        ),
      }));
      onLoadFileContent?.(filePath);
    },
    [setLayout, onLoadFileContent]
  );

  /**
   * Drive the unified pinned Source Control tab into Focus mode for the
   * given file path. No new tab is spawned — we mutate the singleton tab's
   * `data.mode` / `data.focusPath` and bring it to the front.
   */
  const selectGitDiff = useCallback(
    (filePath: string) => {
      if (!filePath) return;
      setLayout((layout: WorkStationLayoutState) => {
        const state = layout?.mainPane;
        if (!state) return layout;
        const tabIndex = state.tabs.findIndex(
          (item) => item.type === "source-control"
        );
        if (tabIndex === -1) return layout;
        const existing = state.tabs[tabIndex];
        const nextTabs = [...state.tabs];
        nextTabs[tabIndex] = {
          ...existing,
          data: {
            ...existing.data,
            mode: "focus",
            focusPath: filePath,
          },
        };
        return {
          ...layout,
          mainPane: { tabs: nextTabs, activeTabId: existing.id },
        };
      });
    },
    [setLayout]
  );

  const isSelected = useCallback(
    (filePath: string): boolean => {
      return focusedFilePath === filePath;
    },
    [focusedFilePath]
  );

  return useMemo(
    () => ({
      selectedFilePath: focusedFilePath,
      selectFile,
      selectGitDiff,
      isSelected,
    }),
    [focusedFilePath, selectFile, selectGitDiff, isSelected]
  );
}

export default useSelectedFile;

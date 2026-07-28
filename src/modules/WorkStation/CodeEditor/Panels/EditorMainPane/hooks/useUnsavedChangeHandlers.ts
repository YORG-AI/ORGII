/**
 * useUnsavedChangeHandlers
 *
 * Pane-state writers that flip `hasUnsavedChanges` on the active tab for the
 * two content surfaces that manage their own dirty state (the git-diff /
 * source-control inline editor, and binary/CSV-style editors on `file` tabs).
 *
 * Extracted verbatim from `EditorMainPane` — no behavior change.
 */
import { useCallback } from "react";

import type { PanelState } from "@src/store/workstation/tabs";

export interface UseUnsavedChangeHandlersOptions {
  /** Currently active tab ID */
  activeTabId: string | null;
  /** Generic pane state updater */
  updatePaneState: (updater: (state: PanelState) => PanelState) => void;
}

export interface UseUnsavedChangeHandlersReturn {
  /** Dirty-state writer for `git-diff` / `source-control` tabs */
  handleGitDiffUnsavedChange: (hasUnsaved: boolean) => void;
  /** Dirty-state writer for `file` tabs owning their own editor state */
  handleBinaryUnsavedChange: (hasUnsaved: boolean) => void;
}

export function useUnsavedChangeHandlers({
  activeTabId,
  updatePaneState,
}: UseUnsavedChangeHandlersOptions): UseUnsavedChangeHandlersReturn {
  const handleGitDiffUnsavedChange = useCallback(
    (hasUnsaved: boolean) => {
      updatePaneState((state) => {
        const currentId = activeTabId;
        if (!currentId) return state;
        const targetTab = state.tabs.find((tab) => tab.id === currentId);
        if (!targetTab) return state;
        if (
          targetTab.type !== "git-diff" &&
          targetTab.type !== "source-control"
        ) {
          return state;
        }
        if (targetTab.hasUnsavedChanges === hasUnsaved) return state;
        return {
          ...state,
          tabs: state.tabs.map((tab) =>
            tab.id === currentId
              ? { ...tab, hasUnsavedChanges: hasUnsaved }
              : tab
          ),
        };
      });
    },
    [updatePaneState, activeTabId]
  );

  const handleBinaryUnsavedChange = useCallback(
    (hasUnsaved: boolean) => {
      updatePaneState((state) => {
        const currentId = activeTabId;
        if (!currentId) return state;
        const targetTab = state.tabs.find((tab) => tab.id === currentId);
        if (!targetTab || targetTab.type !== "file") return state;
        if (targetTab.hasUnsavedChanges === hasUnsaved) return state;
        return {
          ...state,
          tabs: state.tabs.map((tab) =>
            tab.id === currentId
              ? { ...tab, hasUnsavedChanges: hasUnsaved }
              : tab
          ),
        };
      });
    },
    [activeTabId, updatePaneState]
  );

  return { handleGitDiffUnsavedChange, handleBinaryUnsavedChange };
}

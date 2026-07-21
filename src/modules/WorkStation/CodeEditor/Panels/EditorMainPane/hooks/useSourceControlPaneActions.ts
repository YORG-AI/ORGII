/**
 * useSourceControlPaneActions
 *
 * Owns every Source-Control-flavoured interaction the editor host exposes:
 * refresh (with spin state), Focus/All-Changes mode switching, collapse-all
 * signalling, focus dismissal, review prev/next navigation, opening a history
 * entry (commit or stash) in its own tab, and the empty-state quick actions
 * that navigate the sidebar between Source Control destinations.
 *
 * Extracted verbatim from `EditorMainPane` — no behavior change.
 */
import type { TFunction } from "i18next";
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useMemo, useState } from "react";

import { useRefreshSpin } from "@src/hooks/ui";
import type { QuickAction } from "@src/modules/WorkStation/shared";
import type { SourceControlFilterMode } from "@src/modules/WorkStation/shared/SidebarModules";
import { workStationPrimarySidebarCollapsedPersistAtom } from "@src/store/ui/workStationAtom";
import {
  type GitReviewNavigationSnapshot,
  gitReviewNavigationAtom,
} from "@src/store/workstation/codeEditor/gitReviewNavigationAtom";
import { sourceControlFilterModeHandlerAtom } from "@src/store/workstation/codeEditor/sourceControlFilterModeAtom";
import {
  type PanelState,
  type SourceControlHistorySelection,
  createGitCommitDetailTab,
  createStashDetailTab,
} from "@src/store/workstation/tabs";

import {
  type SourceControlDestination,
  createSourceControlQuickActions,
} from "../config";

export interface UseSourceControlPaneActionsOptions {
  t: TFunction;
  /** Generic pane state updater */
  updatePaneState: (updater: (state: PanelState) => PanelState) => void;
  /** Git status force-refresh (drives the refresh button) */
  forceRefresh: () => Promise<void>;
  /** Whether a git diff load is in flight (drives the continuous spin) */
  gitDiffLoading: boolean;
  /** Active Source Control sidebar filter mode */
  sourceControlFilterMode: SourceControlFilterMode;
}

export interface UseSourceControlPaneActionsReturn {
  sourceControlRefreshSpinClass: string | undefined;
  handleSourceControlRefresh: () => void;
  /** Monotonic counter — bumping it tells All Changes to collapse every group */
  sourceControlCollapseAllSignal: number;
  handleSourceControlModeChange: (mode: "focus" | "all-changes") => void;
  handleSourceControlCollapseAll: () => void;
  handleSourceControlCloseFocus: () => void;
  /** Current review-sequence snapshot (`{ current, total }`) */
  gitReviewNavigation: GitReviewNavigationSnapshot;
  handleReviewPrevFile: () => void;
  handleReviewNextFile: () => void;
  handleOpenSourceControlHistoryInNewTab: (
    selection: SourceControlHistorySelection
  ) => void;
  sourceControlQuickActions: QuickAction[];
}

export function useSourceControlPaneActions({
  t,
  updatePaneState,
  forceRefresh,
  gitDiffLoading,
  sourceControlFilterMode,
}: UseSourceControlPaneActionsOptions): UseSourceControlPaneActionsReturn {
  const refreshSourceControl = useCallback(() => {
    void forceRefresh();
  }, [forceRefresh]);
  const {
    spinClass: sourceControlRefreshSpinClass,
    handleClick: handleSourceControlRefresh,
  } = useRefreshSpin(
    refreshSourceControl,
    gitDiffLoading,
    "source-control-main"
  );

  const sourceControlFilterModeHandler = useAtomValue(
    sourceControlFilterModeHandlerAtom
  );
  const setSidebarCollapsed = useSetAtom(
    workStationPrimarySidebarCollapsedPersistAtom
  );

  const [sourceControlCollapseAllSignal, setSourceControlCollapseAllSignal] =
    useState(0);

  const handleSourceControlModeChange = useCallback(
    (mode: "focus" | "all-changes") => {
      updatePaneState((state) => {
        const tabIndex = state.tabs.findIndex(
          (item) => item.type === "source-control"
        );
        if (tabIndex === -1) return state;
        const existing = state.tabs[tabIndex];
        if (existing.data.mode === mode && !existing.data.historySelection) {
          return state;
        }
        const nextTabs = [...state.tabs];
        nextTabs[tabIndex] = {
          ...existing,
          data: {
            ...existing.data,
            mode,
            historySelection: null,
          },
        };
        return { ...state, tabs: nextTabs };
      });
    },
    [updatePaneState]
  );

  const handleSourceControlCollapseAll = useCallback(() => {
    setSourceControlCollapseAllSignal((prev) => prev + 1);
  }, []);

  const handleSourceControlCloseFocus = useCallback(() => {
    updatePaneState((state) => {
      const tabIndex = state.tabs.findIndex(
        (item) => item.type === "source-control"
      );
      if (tabIndex === -1) return state;

      const existing = state.tabs[tabIndex];
      if (!existing.data.focusPath) return state;

      const nextTabs = [...state.tabs];
      nextTabs[tabIndex] = {
        ...existing,
        data: {
          ...existing.data,
          focusPath: null,
        },
      };
      return { ...state, tabs: nextTabs };
    });
  }, [updatePaneState]);

  const gitReviewNavigation = useAtomValue(gitReviewNavigationAtom);

  const handleReviewPrevFile = useCallback(() => {
    document.dispatchEvent(new CustomEvent("review-prev-file"));
  }, []);

  const handleReviewNextFile = useCallback(() => {
    document.dispatchEvent(new CustomEvent("review-next-file"));
  }, []);

  const handleOpenSourceControlHistoryInNewTab = useCallback(
    (selection: SourceControlHistorySelection) => {
      if (selection.type === "pr" || selection.type === "issue") return;

      const nextTab =
        selection.type === "stash"
          ? createStashDetailTab(
              selection.stashIndex,
              selection.commitMessage,
              selection.stashCommitSha
            )
          : createGitCommitDetailTab(
              selection.commitSha,
              selection.shortSha,
              selection.commitMessage
            );

      updatePaneState((state) => {
        const existing = state.tabs.find((tab) => tab.id === nextTab.id);
        const tabs = existing ? state.tabs : [...state.tabs, nextTab];
        return { ...state, tabs, activeTabId: nextTab.id };
      });
    },
    [updatePaneState]
  );

  const handleSourceControlNavigation = useCallback(
    (destination: SourceControlDestination) => {
      sourceControlFilterModeHandler?.(destination);
      setSidebarCollapsed(false);
    },
    [setSidebarCollapsed, sourceControlFilterModeHandler]
  );

  const sourceControlQuickActions = useMemo(
    () =>
      createSourceControlQuickActions({
        t,
        activeMode: sourceControlFilterMode,
        onNavigate: handleSourceControlNavigation,
      }),
    [handleSourceControlNavigation, sourceControlFilterMode, t]
  );

  return {
    sourceControlRefreshSpinClass,
    handleSourceControlRefresh,
    sourceControlCollapseAllSignal,
    handleSourceControlModeChange,
    handleSourceControlCollapseAll,
    handleSourceControlCloseFocus,
    gitReviewNavigation,
    handleReviewPrevFile,
    handleReviewNextFile,
    handleOpenSourceControlHistoryInNewTab,
    sourceControlQuickActions,
  };
}

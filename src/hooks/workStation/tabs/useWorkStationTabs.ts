/**
 * Workstation tab hook — single backing store across every host.
 *
 * Every tab — whether code/file, browser session, project work item,
 * launchpad dashboard, etc. — lives in the lone
 * `workstationLayoutAtom.mainPane` and is mutated through this hook.
 */
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo } from "react";

import {
  type PanelState,
  type WorkStationLayoutState,
  type WorkStationTab,
  claimLegacyWorkstationSeedAtom,
  closeOtherTabs as closeOtherTabsMutation,
  closeSavedTabs as closeSavedTabsMutation,
  closeTab as closeTabMutation,
  mainPaneActiveTabIdAtom,
  mainPaneTabsAtom,
  openTab as openTabMutation,
  presentedWorkstationWorkspaceKeyAtom,
  reorderTabs as reorderTabsMutation,
  switchTab as switchTabMutation,
  updateTabData as updateTabDataMutation,
  workstationLayoutAtom,
} from "@src/store/workstation/tabs";

// ============================================
// Types
// ============================================

export interface UseWorkStationTabsReturn {
  tabs: WorkStationTab[];
  activeTabId: string | null;
  activeTab: WorkStationTab | null;

  openTab: (tab: WorkStationTab) => void;
  closeTab: (tabId: string) => void;
  switchTab: (tabId: string) => void;
  reorderTabs: (startIndex: number, endIndex: number) => void;

  closeOtherTabs: (keepTabId: string) => void;
  closeSavedTabs: () => void;
  closeAllTabs: () => void;

  updateTabData: (
    tabId: string,
    data: Partial<Record<string, unknown>>
  ) => void;
  updateTabMeta: (
    tabId: string,
    meta: Partial<Pick<WorkStationTab, "title" | "icon">>
  ) => void;
  setTabUnsaved: (tabId: string, hasUnsavedChanges: boolean) => void;

  tabBarProps: {
    tabs: WorkStationTab[];
    activeTabId: string | null;
    onTabClick: (tabId: string) => void;
    onTabClose: (tabId: string) => void;
    onTabReorder: (startIndex: number, endIndex: number) => void;
    onCloseOtherTabs: (tabId: string) => void;
    onCloseSavedTabs: () => void;
  };
}

const EMPTY_PANE_STATE: PanelState = { tabs: [], activeTabId: null };

// ============================================
// Main Hook
// ============================================

export function useWorkStationTabs(): UseWorkStationTabsReturn {
  const tabs = useAtomValue(mainPaneTabsAtom);
  const activeTabId = useAtomValue(mainPaneActiveTabIdAtom);
  const workspaceKey = useAtomValue(presentedWorkstationWorkspaceKeyAtom);
  const setLayout = useSetAtom(workstationLayoutAtom);
  const claimLegacySeed = useSetAtom(claimLegacyWorkstationSeedAtom);

  // A legacy v2 task workspace is claimed only after a user has explicitly
  // entered a WorkStation session. Cold-start Global Workspace never claims it.
  useEffect(() => {
    claimLegacySeed();
  }, [claimLegacySeed, workspaceKey]);

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? null,
    [tabs, activeTabId]
  );

  const updatePane = useCallback(
    (updater: (state: PanelState) => PanelState) => {
      setLayout((prev: WorkStationLayoutState) => {
        const currentPane = prev?.mainPane ?? EMPTY_PANE_STATE;
        const nextPane = updater(currentPane);
        if (nextPane === currentPane) return prev;
        return {
          ...prev,
          mainPane: nextPane,
        };
      });
    },
    [setLayout]
  );

  const openTab = useCallback(
    (tab: WorkStationTab) => updatePane((state) => openTabMutation(state, tab)),
    [updatePane]
  );

  const closeTab = useCallback(
    (tabId: string) => updatePane((state) => closeTabMutation(state, tabId)),
    [updatePane]
  );

  const switchTab = useCallback(
    (tabId: string) => updatePane((state) => switchTabMutation(state, tabId)),
    [updatePane]
  );

  const reorderTabs = useCallback(
    (startIndex: number, endIndex: number) =>
      updatePane((state) => reorderTabsMutation(state, startIndex, endIndex)),
    [updatePane]
  );

  const closeOtherTabs = useCallback(
    (keepTabId: string) =>
      updatePane((state) => closeOtherTabsMutation(state, keepTabId)),
    [updatePane]
  );

  const closeSavedTabs = useCallback(
    () => updatePane((state) => closeSavedTabsMutation(state)),
    [updatePane]
  );

  const closeAllTabs = useCallback(
    () =>
      updatePane((state) => {
        if (state.tabs.length === 0 && state.activeTabId === null) return state;
        return { tabs: [], activeTabId: null };
      }),
    [updatePane]
  );

  const updateTabData = useCallback(
    (tabId: string, data: Partial<Record<string, unknown>>) => {
      updatePane((state) => updateTabDataMutation(state, tabId, data));
    },
    [updatePane]
  );

  const updateTabMeta = useCallback(
    (tabId: string, meta: Partial<Pick<WorkStationTab, "title" | "icon">>) => {
      updatePane((state) => {
        const target = state.tabs.find((tab) => tab.id === tabId);
        if (!target) return state;
        const nextTitle = meta.title ?? target.title;
        const nextIcon = meta.icon ?? target.icon;
        if (target.title === nextTitle && target.icon === nextIcon) {
          return state;
        }
        return {
          ...state,
          tabs: state.tabs.map((tab: WorkStationTab) =>
            tab.id === tabId
              ? { ...tab, title: nextTitle, icon: nextIcon }
              : tab
          ),
        };
      });
    },
    [updatePane]
  );

  const setTabUnsaved = useCallback(
    (tabId: string, hasUnsavedChanges: boolean) => {
      updatePane((state) => {
        const target = state.tabs.find((tab) => tab.id === tabId);
        if (!target || target.hasUnsavedChanges === hasUnsavedChanges) {
          return state;
        }
        return {
          ...state,
          tabs: state.tabs.map((tab: WorkStationTab) =>
            tab.id === tabId ? { ...tab, hasUnsavedChanges } : tab
          ),
        };
      });
    },
    [updatePane]
  );

  const tabBarProps = useMemo(
    () => ({
      tabs,
      activeTabId,
      onTabClick: switchTab,
      onTabClose: closeTab,
      onTabReorder: reorderTabs,
      onCloseOtherTabs: closeOtherTabs,
      onCloseSavedTabs: closeSavedTabs,
    }),
    [
      tabs,
      activeTabId,
      switchTab,
      closeTab,
      reorderTabs,
      closeOtherTabs,
      closeSavedTabs,
    ]
  );

  return {
    tabs,
    activeTabId,
    activeTab,
    openTab,
    closeTab,
    switchTab,
    reorderTabs,
    closeOtherTabs,
    closeSavedTabs,
    closeAllTabs,
    updateTabData,
    updateTabMeta,
    setTabUnsaved,
    tabBarProps,
  };
}

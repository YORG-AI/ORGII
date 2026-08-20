/**
 * useBrowserPaneState Hook
 *
 * Manages tab state for the browser pane:
 * - Tab switching, closing, reordering
 * - Close other tabs, close saved tabs
 *
 * Architecture matches useEditorPaneState:
 * - Reads from centralized browserTabsAtom
 * - Returns stable callbacks
 * - No local state
 */
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useMemo } from "react";

import {
  activeBrowserTabAtom,
  browserTabsAtom,
  closeBrowserTabAtom,
  closeOtherBrowserTabsAtom,
  closeSavedBrowserTabsAtom,
  openBrowserTabAtom,
  reorderBrowserTabsAtom,
  switchBrowserTabAtom,
  updateBrowserTabDataAtom,
  updateBrowserTabTitleAtom,
} from "@src/store/workstation/browser/tabs";
import type {
  PanelState,
  WorkStationTab,
} from "@src/store/workstation/tabs/types";

// ============================================
// Types
// ============================================

export interface UseBrowserPaneStateReturn {
  /** All tabs */
  tabs: WorkStationTab[];
  /** Currently active tab ID */
  activeTabId: string | null;
  /** Currently active tab object */
  activeTab: WorkStationTab | null;
  /** Current state */
  currentState: PanelState;
  /** Open or switch to a tab */
  openTab: (tab: WorkStationTab) => void;
  /** Switch to a tab by ID */
  switchToTab: (tabId: string) => void;
  /** Close a tab */
  closeTab: (tabId: string) => void;
  /** Reorder tabs */
  reorderTabs: (startIndex: number, endIndex: number) => void;
  /** Close all tabs except the specified one */
  closeOtherTabs: (tabId: string) => void;
  /** Close all tabs without unsaved changes */
  closeSavedTabs: () => void;
  /** Update tab data */
  updateTabData: (
    tabId: string,
    data: Partial<Record<string, unknown>>
  ) => void;
  /** Update tab title */
  updateTabTitle: (tabId: string, title: string) => void;

  /** Props to pass directly to TabBar component */
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

// ============================================
// Hook Implementation
// ============================================

export function useBrowserPaneState(): UseBrowserPaneStateReturn {
  // Read from atom
  const state = useAtomValue(browserTabsAtom);
  const activeTab = useAtomValue(activeBrowserTabAtom);

  // Action atoms
  const openTabAction = useSetAtom(openBrowserTabAtom);
  const switchTabAction = useSetAtom(switchBrowserTabAtom);
  const closeTabAction = useSetAtom(closeBrowserTabAtom);
  const reorderTabsAction = useSetAtom(reorderBrowserTabsAtom);
  const closeOtherTabsAction = useSetAtom(closeOtherBrowserTabsAtom);
  const closeSavedTabsAction = useSetAtom(closeSavedBrowserTabsAtom);
  const updateTabDataAction = useSetAtom(updateBrowserTabDataAtom);
  const updateTabTitleAction = useSetAtom(updateBrowserTabTitleAtom);

  // Stable callbacks
  const openTab = useCallback(
    (tab: WorkStationTab) => {
      openTabAction(tab);
    },
    [openTabAction]
  );

  const switchToTab = useCallback(
    (tabId: string) => {
      switchTabAction(tabId);
    },
    [switchTabAction]
  );

  const closeTab = useCallback(
    (tabId: string) => {
      closeTabAction(tabId);
    },
    [closeTabAction]
  );

  const reorderTabs = useCallback(
    (startIndex: number, endIndex: number) => {
      reorderTabsAction({ startIndex, endIndex });
    },
    [reorderTabsAction]
  );

  const closeOtherTabs = useCallback(
    (tabId: string) => {
      closeOtherTabsAction(tabId);
    },
    [closeOtherTabsAction]
  );

  const closeSavedTabs = useCallback(() => {
    closeSavedTabsAction();
  }, [closeSavedTabsAction]);

  const updateTabData = useCallback(
    (tabId: string, data: Partial<Record<string, unknown>>) => {
      updateTabDataAction({ tabId, data });
    },
    [updateTabDataAction]
  );

  const updateTabTitle = useCallback(
    (tabId: string, title: string) => {
      updateTabTitleAction({ tabId, title });
    },
    [updateTabTitleAction]
  );

  // Tab bar props (for easy passing to TabBar)
  const tabBarProps = useMemo(
    () => ({
      tabs: state.tabs,
      activeTabId: state.activeTabId,
      onTabClick: switchToTab,
      onTabClose: closeTab,
      onTabReorder: reorderTabs,
      onCloseOtherTabs: closeOtherTabs,
      onCloseSavedTabs: closeSavedTabs,
    }),
    [
      state.tabs,
      state.activeTabId,
      switchToTab,
      closeTab,
      reorderTabs,
      closeOtherTabs,
      closeSavedTabs,
    ]
  );

  return {
    tabs: state.tabs,
    activeTabId: state.activeTabId,
    activeTab,
    currentState: state,
    openTab,
    switchToTab,
    closeTab,
    reorderTabs,
    closeOtherTabs,
    closeSavedTabs,
    updateTabData,
    updateTabTitle,
    tabBarProps,
  };
}

export default useBrowserPaneState;

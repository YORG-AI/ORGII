/**
 * Tab State Mutation Helpers
 *
 * Pure functions for mutating tab state within a pane.
 * All functions return new state objects (immutable).
 */
import {
  clearSearchTabSessionStates,
  deleteSearchTabSessionState,
} from "@src/store/workstation/codeEditor/search";

import { TAB_RETURN_TARGET_DATA_KEY } from "./types";
import type { PanelState, WorkStationTab } from "./types";

// ============================================
// Tab Mutations
// ============================================

function hasDataChanges(
  currentData: Record<string, unknown>,
  nextData: Partial<Record<string, unknown>>
): boolean {
  for (const [key, value] of Object.entries(nextData)) {
    if (!Object.is(currentData[key], value)) return true;
  }
  return false;
}

function mergeReopenedTab(
  existingTab: WorkStationTab,
  incomingTab: WorkStationTab
): WorkStationTab {
  const nextUnsaved =
    existingTab.hasUnsavedChanges || incomingTab.hasUnsavedChanges || undefined;

  if (
    existingTab.title === incomingTab.title &&
    existingTab.icon === incomingTab.icon &&
    existingTab.hasUnsavedChanges === nextUnsaved &&
    !hasDataChanges(existingTab.data, incomingTab.data)
  ) {
    return existingTab;
  }

  return {
    ...existingTab,
    title: incomingTab.title,
    icon: incomingTab.icon,
    data: { ...existingTab.data, ...incomingTab.data },
    hasUnsavedChanges: nextUnsaved,
  };
}

/**
 * Open or switch to a tab
 */
export function openTab(state: PanelState, tab: WorkStationTab): PanelState {
  // Safety check for uninitialized state
  const tabs = state?.tabs ?? [];
  const existingIndex = tabs.findIndex((tabItem) => tabItem.id === tab.id);

  if (existingIndex !== -1) {
    const mergedTab = mergeReopenedTab(tabs[existingIndex], tab);
    if (mergedTab === tabs[existingIndex] && state?.activeTabId === tab.id) {
      return state;
    }

    const updatedTabs = [...tabs];
    updatedTabs[existingIndex] = mergedTab;
    return {
      tabs: updatedTabs,
      activeTabId: tab.id,
    };
  }

  // Create new tab
  return {
    tabs: [...tabs, tab],
    activeTabId: tab.id,
  };
}

/**
 * Close a tab. Pinned / non-closable tabs are protected — `closeTab` is a
 * no-op for them so context-menu shortcuts and keyboard close commands
 * cannot remove fixtures like the Diff tab.
 */
export function closeTab(state: PanelState, tabId: string): PanelState {
  // Safety check for uninitialized state
  const tabs = state?.tabs ?? [];
  const closedIndex = tabs.findIndex((tab) => tab.id === tabId);
  if (closedIndex === -1) return state ?? { tabs: [], activeTabId: null };
  const target = tabs[closedIndex];
  const newTabs = tabs.filter((tab) => tab.id !== tabId);
  if (tabId.startsWith("search:")) {
    deleteSearchTabSessionState(tabId);
  }

  // If closing the active tab, select another
  let newActiveTabId = state?.activeTabId ?? null;
  if (state?.activeTabId === tabId) {
    const returnTabId = target.data[TAB_RETURN_TARGET_DATA_KEY];
    const canReturnToTab =
      typeof returnTabId === "string" &&
      newTabs.some((tab) => tab.id === returnTabId);

    if (canReturnToTab) {
      newActiveTabId = returnTabId;
    } else if (newTabs.length === 0) {
      newActiveTabId = null;
    } else {
      // Switch to next tab, or previous if it was the last
      const newActiveIndex = Math.min(closedIndex, newTabs.length - 1);
      newActiveTabId = newTabs[newActiveIndex]?.id ?? null;
    }
  }

  return {
    tabs: newTabs,
    activeTabId: newActiveTabId,
  };
}

/**
 * Switch to a tab
 */
export function switchTab(state: PanelState, tabId: string): PanelState {
  // Safety check for uninitialized state
  const tabs = state?.tabs ?? [];
  // Only switch if tab exists
  const exists = tabs.find((tabItem) => tabItem.id === tabId);
  if (!exists) return state ?? { tabs: [], activeTabId: null };
  if (state?.activeTabId === tabId) return state;

  return {
    tabs,
    activeTabId: tabId,
  };
}

/**
 * Reorder tabs
 */
export function reorderTabs(
  state: PanelState,
  startIndex: number,
  endIndex: number
): PanelState {
  // Safety check for uninitialized state
  const tabs = state?.tabs ?? [];
  if (tabs.length === 0) return state ?? { tabs: [], activeTabId: null };
  if (startIndex === endIndex) return state;
  if (
    startIndex < 0 ||
    endIndex < 0 ||
    startIndex >= tabs.length ||
    endIndex >= tabs.length
  ) {
    return state;
  }

  const newTabs = [...tabs];
  const [movedTab] = newTabs.splice(startIndex, 1);
  newTabs.splice(endIndex, 0, movedTab);

  const currentActiveTabId = state?.activeTabId ?? null;
  return {
    tabs: newTabs,
    activeTabId: currentActiveTabId,
  };
}

/**
 * Update tab data
 */
export function updateTabData(
  state: PanelState,
  tabId: string,
  data: Partial<Record<string, unknown>>
): PanelState {
  // Safety check for uninitialized state
  const tabs = state?.tabs ?? [];
  const targetIndex = tabs.findIndex((tab) => tab.id === tabId);
  if (targetIndex === -1) return state ?? { tabs: [], activeTabId: null };

  const targetTab = tabs[targetIndex];
  if (!hasDataChanges(targetTab.data, data)) return state;

  const updatedTabs = [...tabs];
  updatedTabs[targetIndex] = {
    ...targetTab,
    data: { ...targetTab.data, ...data },
  };

  return {
    tabs: updatedTabs,
    activeTabId: state?.activeTabId ?? null,
  };
}

/**
 * Close every tab. The empty pool re-seeds a Launchpad tab (see
 * `useLaunchpadTab`).
 */
export function closeAllTabs(state: PanelState): PanelState {
  const hadSearchTabs = (state?.tabs ?? []).some((tab) =>
    tab.id.startsWith("search:")
  );
  if (hadSearchTabs) {
    clearSearchTabSessionStates();
  }
  return {
    tabs: [],
    activeTabId: null,
  };
}

/**
 * Close all tabs except the specified one.
 */
export function closeOtherTabs(state: PanelState, tabId: string): PanelState {
  // Safety check for uninitialized state
  const tabs = state?.tabs ?? [];
  const targetTab = tabs.find((tab) => tab.id === tabId);
  if (!targetTab) return state ?? { tabs: [], activeTabId: null };

  for (const tab of tabs) {
    if (tab.id !== tabId && tab.id.startsWith("search:")) {
      deleteSearchTabSessionState(tab.id);
    }
  }

  return {
    tabs: [targetTab],
    activeTabId: tabId,
  };
}

/**
 * Close all saved tabs (tabs without unsaved changes).
 */
export function closeSavedTabs(state: PanelState): PanelState {
  // Safety check for uninitialized state
  const tabs = state?.tabs ?? [];

  const keptTabs = tabs.filter((tab) => tab.hasUnsavedChanges === true);

  // If active tab was closed, select first remaining tab or null
  let newActiveTabId = state?.activeTabId ?? null;
  const activeTabKept = keptTabs.find((tab) => tab.id === newActiveTabId);
  if (!activeTabKept) {
    newActiveTabId = keptTabs[0]?.id ?? null;
  }

  for (const tab of tabs) {
    const keptTab = keptTabs.find((kept) => kept.id === tab.id);
    if (!keptTab && tab.id.startsWith("search:")) {
      deleteSearchTabSessionState(tab.id);
    }
  }

  return {
    tabs: keptTabs,
    activeTabId: newActiveTabId,
  };
}

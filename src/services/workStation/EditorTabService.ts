/**
 * EditorTabService - Singleton editor tab management service.
 *
 * Workspace-aware workstation tab service. Queries target the currently
 * presented WorkStation workspace; delayed callers may pass a frozen workspace
 * key to `openTab` so async completion cannot leak into another session.
 */
import {
  type PanelState,
  type WorkStationTab,
  type WorkstationWorkspaceKey,
  closeAllTabs as closeAllTabsHelper,
  closeOtherTabs as closeOtherTabsHelper,
  closeSavedTabs as closeSavedTabsHelper,
  closeWorkstationTabAtom,
  closeWorkstationTabsAtom,
  createExplorerTab,
  focusWorkstationTabAtom,
  openWorkstationTabAtom,
  presentedWorkstationWorkspaceKeyAtom,
  reorderWorkstationTabsAtom,
  selectWorkstationPanel,
  workstationTabsStateAtom,
} from "@src/store/workstation/tabs";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";

const getStore = () => getInstrumentedStore();

function currentWorkspace(): WorkstationWorkspaceKey {
  return getStore().get(presentedWorkstationWorkspaceKeyAtom);
}

function getMainPane(workspace = currentWorkspace()): PanelState {
  const store = getStore();
  return selectWorkstationPanel(store.get(workstationTabsStateAtom), workspace);
}

function closeFromMainPane(
  updater: (state: PanelState) => PanelState,
  workspace = currentWorkspace()
): void {
  const before = getMainPane(workspace);
  const after = updater(before);
  if (after === before) return;
  const store = getStore();
  const remainingIds = new Set(after.tabs.map((tab) => tab.id));
  const tabIds = before.tabs
    .filter((tab) => !remainingIds.has(tab.id))
    .map((tab) => tab.id);
  store.set(closeWorkstationTabsAtom, {
    workspace,
    tabIds,
    activeTabId: after.activeTabId,
  });
}

export const EditorTabService = {
  // Tab Query Operations
  getActiveTab(): WorkStationTab | null {
    const state = getMainPane();
    return state.tabs.find((tab) => tab.id === state.activeTabId) ?? null;
  },

  getTabs(): WorkStationTab[] {
    return getMainPane().tabs;
  },

  getActiveTabId(): string | null {
    return getMainPane().activeTabId;
  },

  findTab(tabId: string): { tab: WorkStationTab } | null {
    const state = getMainPane();
    const tab = state.tabs.find((paneTab) => paneTab.id === tabId);
    return tab ? { tab } : null;
  },

  hasTab(tabId: string): boolean {
    return this.findTab(tabId) !== null;
  },

  // Tab Close Operations
  closeCurrentTab(): boolean {
    const workspace = currentWorkspace();
    const state = getMainPane(workspace);
    if (!state.activeTabId) return false;
    getStore().set(closeWorkstationTabAtom, {
      workspace,
      tabId: state.activeTabId,
    });
    return true;
  },

  closeTab(tabId: string): boolean {
    const workspace = currentWorkspace();
    if (!getMainPane(workspace).tabs.some((tab) => tab.id === tabId)) {
      return false;
    }
    getStore().set(closeWorkstationTabAtom, { workspace, tabId });
    return true;
  },

  closeAllTabs(): boolean {
    closeFromMainPane(closeAllTabsHelper);
    return true;
  },

  closeOtherTabs(tabId: string): boolean {
    if (!this.hasTab(tabId)) return false;
    closeFromMainPane((paneState) => closeOtherTabsHelper(paneState, tabId));
    return true;
  },

  closeSavedTabs(): boolean {
    closeFromMainPane(closeSavedTabsHelper);
    return true;
  },

  // Tab Navigation Operations
  switchToTab(tabId: string): boolean {
    const workspace = currentWorkspace();
    if (!getMainPane(workspace).tabs.some((tab) => tab.id === tabId)) {
      return false;
    }
    getStore().set(focusWorkstationTabAtom, { workspace, tabId });
    return true;
  },

  switchToNextTab(): boolean {
    const state = getMainPane();
    if (state.tabs.length === 0) return false;
    const currentIndex = state.tabs.findIndex(
      (paneTab) => paneTab.id === state.activeTabId
    );
    const nextIndex = (currentIndex + 1) % state.tabs.length;
    const nextTabId = state.tabs[nextIndex]?.id;
    if (!nextTabId) return false;
    getStore().set(focusWorkstationTabAtom, {
      workspace: currentWorkspace(),
      tabId: nextTabId,
    });
    return true;
  },

  switchToPreviousTab(): boolean {
    const state = getMainPane();
    if (state.tabs.length === 0) return false;
    const currentIndex = state.tabs.findIndex(
      (paneTab) => paneTab.id === state.activeTabId
    );
    const prevIndex =
      currentIndex <= 0 ? state.tabs.length - 1 : currentIndex - 1;
    const prevTabId = state.tabs[prevIndex]?.id;
    if (!prevTabId) return false;
    getStore().set(focusWorkstationTabAtom, {
      workspace: currentWorkspace(),
      tabId: prevTabId,
    });
    return true;
  },

  getLastFileOrExplorerTabId(): string {
    const tabs = getMainPane().tabs;
    const lastFileTab = [...tabs]
      .reverse()
      .find((paneTab) => paneTab.type === "file" && !paneTab.pinned);
    return lastFileTab?.id ?? createExplorerTab().id;
  },

  switchToLastFileOrExplorer(): string | null {
    const targetTabId = this.getLastFileOrExplorerTabId();
    if (this.switchToTab(targetTabId)) return targetTabId;
    if (targetTabId === createExplorerTab().id) {
      return this.openTab(createExplorerTab()) ? targetTabId : null;
    }
    return null;
  },

  switchToTabByIndex(index: number): boolean {
    const tabs = getMainPane().tabs;
    if (index < 0 || index >= tabs.length) return false;
    const tabId = tabs[index]?.id;
    if (!tabId) return false;
    getStore().set(focusWorkstationTabAtom, {
      workspace: currentWorkspace(),
      tabId,
    });
    return true;
  },

  // Tab Open Operations
  openTab(tab: WorkStationTab, workspace = currentWorkspace()): boolean {
    getStore().set(openWorkstationTabAtom, { workspace, tab });
    return true;
  },

  // Tab Reorder Operations
  reorderTabs(fromIndex: number, toIndex: number): boolean {
    const workspace = currentWorkspace();
    const tabs = getMainPane(workspace).tabs;
    if (fromIndex < 0 || fromIndex >= tabs.length) return false;
    if (toIndex < 0 || toIndex >= tabs.length) return false;
    getStore().set(reorderWorkstationTabsAtom, {
      workspace,
      startIndex: fromIndex,
      endIndex: toIndex,
    });
    return true;
  },
};

/**
 * Derived join of every workstation tab + writer atoms that mutate the
 * single-pane `workstationLayoutAtom`.
 *
 * Invariants:
 * - `tabRegistryAtom` stays derived (no persistence).
 * - Writers never mutate the registry directly; they all route through
 *   `workstationLayoutAtom` so persistence and read paths stay coherent.
 */
import { type Getter, type Setter, atom } from "jotai";

import { chatPanelMaximizedAtom } from "@src/store/ui/chatPanelAtom";
import { stationModeAtom } from "@src/store/ui/simulatorAtom";

import {
  type PanelState,
  type WorkStationLayoutState,
  closeOtherTabs as closeOtherTabsMutation,
  closeSavedTabs as closeSavedTabsMutation,
  closeTab as closeTabMutation,
  closeWorkstationTabsAtom,
  presentedWorkstationWorkspaceKeyAtom,
  reorderTabs as reorderTabsMutation,
  switchTab as switchTabMutation,
  workstationLayoutAtom,
} from "../tabs";
import type {
  TabCloseOtherRequest,
  TabCloseRequest,
  TabFocusRequest,
  TabRegistryEntry,
  TabReorderRequest,
} from "./types";

// ============================================
// Read view
// ============================================

export const tabRegistryAtom = atom<TabRegistryEntry[]>((get) => {
  const layout = get(workstationLayoutAtom);
  const pane = layout?.mainPane;
  if (!pane) return [];
  return pane.tabs.map((tab) => ({
    tab,
    isActive: pane.activeTabId === tab.id,
  }));
});
tabRegistryAtom.debugLabel = "tabRegistryAtom";

// ============================================
// Writers
// ============================================

function setMainPane(
  layout: WorkStationLayoutState,
  next: PanelState
): WorkStationLayoutState {
  return { ...layout, mainPane: next };
}

function closePresentedTabs(
  get: Getter,
  set: Setter,
  nextPane: PanelState,
  previousPane: PanelState
): void {
  const nextIds = new Set(nextPane.tabs.map((tab) => tab.id));
  const tabIds = previousPane.tabs
    .filter((tab) => !nextIds.has(tab.id))
    .map((tab) => tab.id);
  if (tabIds.length === 0) return;
  set(closeWorkstationTabsAtom, {
    workspace: get(presentedWorkstationWorkspaceKeyAtom),
    tabIds,
    activeTabId: nextPane.activeTabId,
  });
}

export const focusTabAtom = atom(null, (get, set, request: TabFocusRequest) => {
  const layout = get(workstationLayoutAtom);
  if (!layout) return;
  if (!layout.mainPane.tabs.some((tab) => tab.id === request.tabId)) return;
  set(
    workstationLayoutAtom,
    setMainPane(layout, switchTabMutation(layout.mainPane, request.tabId))
  );
});
focusTabAtom.debugLabel = "focusTabAtom";

export const closeTabAtom = atom(null, (get, set, request: TabCloseRequest) => {
  const layout = get(workstationLayoutAtom);
  if (!layout) return;
  const closesSoleLaunchpad =
    get(stationModeAtom) === "my-station" &&
    layout.mainPane.tabs.length === 1 &&
    layout.mainPane.tabs[0]?.id === request.tabId &&
    layout.mainPane.tabs[0].type === "start";
  closePresentedTabs(
    get,
    set,
    closeTabMutation(layout.mainPane, request.tabId),
    layout.mainPane
  );
  if (closesSoleLaunchpad) {
    set(chatPanelMaximizedAtom, true);
  }
});
closeTabAtom.debugLabel = "closeTabAtom";

/**
 * Close the currently active tab. Returns `true` when a tab was closed,
 * `false` otherwise (e.g. when there is no active tab).
 */
export const closeActiveWorkStationTabAtom = atom(null, (get, set) => {
  const layout = get(workstationLayoutAtom);
  if (!layout) return false;
  const { activeTabId, tabs } = layout.mainPane;
  if (!activeTabId) return false;
  const active = tabs.find((tab) => tab.id === activeTabId);
  if (!active) return false;
  set(closeTabAtom, { tabId: active.id });
  return true;
});
closeActiveWorkStationTabAtom.debugLabel = "closeActiveWorkStationTabAtom";

/** Close every WorkStation surface whose durable payload belongs to an org. */
export const closeProjectOrgWorkStationTabsAtom = atom(
  null,
  (get, set, orgId: string) => {
    const layout = get(workstationLayoutAtom);
    if (!layout) return;
    const tabIds = layout.mainPane.tabs
      .filter((tab) => tab.data.orgId === orgId)
      .map((tab) => tab.id);
    if (tabIds.length === 0) return;

    let nextPane = layout.mainPane;
    for (const tabId of tabIds) {
      nextPane = closeTabMutation(nextPane, tabId);
    }
    closePresentedTabs(get, set, nextPane, layout.mainPane);
  }
);
closeProjectOrgWorkStationTabsAtom.debugLabel =
  "closeProjectOrgWorkStationTabsAtom";

export const reorderTabAtom = atom(
  null,
  (get, set, request: TabReorderRequest) => {
    const layout = get(workstationLayoutAtom);
    if (!layout) return;
    const state = layout.mainPane;
    const fromIndex = state.tabs.findIndex(
      (tab) => tab.id === request.fromTabId
    );
    const toIndex = state.tabs.findIndex((tab) => tab.id === request.toTabId);
    if (fromIndex === -1 || toIndex === -1) return;
    const fromTab = state.tabs[fromIndex];
    const toTab = state.tabs[toIndex];
    if (fromTab.pinned || toTab.pinned) return;
    set(
      workstationLayoutAtom,
      setMainPane(layout, reorderTabsMutation(state, fromIndex, toIndex))
    );
  }
);
reorderTabAtom.debugLabel = "reorderTabAtom";

export const closeOtherTabsAtom = atom(
  null,
  (get, set, request: TabCloseOtherRequest) => {
    const layout = get(workstationLayoutAtom);
    if (!layout) return;
    closePresentedTabs(
      get,
      set,
      closeOtherTabsMutation(layout.mainPane, request.keepTabId),
      layout.mainPane
    );
  }
);
closeOtherTabsAtom.debugLabel = "closeOtherTabsAtom";

export const closeSavedTabsAtom = atom(null, (get, set) => {
  const layout = get(workstationLayoutAtom);
  if (!layout) return;
  closePresentedTabs(
    get,
    set,
    closeSavedTabsMutation(layout.mainPane),
    layout.mainPane
  );
});
closeSavedTabsAtom.debugLabel = "closeSavedTabsAtom";

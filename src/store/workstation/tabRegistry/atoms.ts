/**
 * Derived join of every workstation tab + writer atoms that mutate the
 * single-pane `workstationLayoutAtom`.
 *
 * Invariants:
 * - `tabRegistryAtom` stays derived (no persistence).
 * - Writers never mutate the registry directly; they all route through
 *   `workstationLayoutAtom` so persistence and read paths stay coherent.
 */
import { atom } from "jotai";

import {
  type PanelState,
  type WorkStationLayoutState,
  closeOtherTabs as closeOtherTabsMutation,
  closeSavedTabs as closeSavedTabsMutation,
  closeTab as closeTabMutation,
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
  set(
    workstationLayoutAtom,
    setMainPane(layout, closeTabMutation(layout.mainPane, request.tabId))
  );
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
    set(
      workstationLayoutAtom,
      setMainPane(
        layout,
        closeOtherTabsMutation(layout.mainPane, request.keepTabId)
      )
    );
  }
);
closeOtherTabsAtom.debugLabel = "closeOtherTabsAtom";

export const closeSavedTabsAtom = atom(null, (get, set) => {
  const layout = get(workstationLayoutAtom);
  if (!layout) return;
  set(
    workstationLayoutAtom,
    setMainPane(layout, closeSavedTabsMutation(layout.mainPane))
  );
});
closeSavedTabsAtom.debugLabel = "closeSavedTabsAtom";

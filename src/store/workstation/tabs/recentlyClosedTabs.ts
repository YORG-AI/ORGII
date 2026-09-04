import { atom } from "jotai";

import {
  prependRecentlyClosedTabs,
  removeRecentlyClosedTab,
} from "@src/shared/tabs/recentlyClosedTabs";

import type { WorkStationTab } from "./types";

/** App-lifetime, bounded restore history for tabs explicitly closed by a user. */
export const recentlyClosedWorkstationTabsAtom = atom<WorkStationTab[]>([]);
recentlyClosedWorkstationTabsAtom.debugLabel =
  "recentlyClosedWorkstationTabsAtom";

export const recordRecentlyClosedWorkstationTabsAtom = atom(
  null,
  (_get, set, tabs: readonly WorkStationTab[]) => {
    if (tabs.length === 0) return;
    set(recentlyClosedWorkstationTabsAtom, (current) =>
      prependRecentlyClosedTabs(current, tabs)
    );
  }
);
recordRecentlyClosedWorkstationTabsAtom.debugLabel =
  "recordRecentlyClosedWorkstationTabsAtom";

export const removeRecentlyClosedWorkstationTabAtom = atom(
  null,
  (_get, set, tabId: string) => {
    set(recentlyClosedWorkstationTabsAtom, (current) =>
      removeRecentlyClosedTab(current, tabId)
    );
  }
);
removeRecentlyClosedWorkstationTabAtom.debugLabel =
  "removeRecentlyClosedWorkstationTabAtom";

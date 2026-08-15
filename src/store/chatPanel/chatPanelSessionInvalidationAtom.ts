import { atom } from "jotai";

import { buildDefaultLaunchpadTab } from "./chatPanelTabFactories";
import { activateChatPanelTabAtom } from "./chatPanelTabPresentationAtoms";
import { chatPanelTabsAtom } from "./chatPanelTabsState";

/** Remove every ChatPanel projection backed by one deleted agent session. */
export const invalidateSessionChatPanelTabsAtom = atom(
  null,
  (get, set, sessionId: string) => {
    const state = get(chatPanelTabsAtom);
    const removedTabIds = new Set(
      state.tabs
        .filter((tab) => tab.type === "session" && tab.sessionId === sessionId)
        .map((tab) => tab.id)
    );
    if (removedTabIds.size === 0) return;

    const activeWasRemoved = removedTabIds.has(state.activeTabId);
    const survivingTabs = state.tabs.filter(
      (tab) => !removedTabIds.has(tab.id)
    );
    const nextTabs =
      survivingTabs.length > 0 ? survivingTabs : [buildDefaultLaunchpadTab()];

    if (!activeWasRemoved) {
      set(chatPanelTabsAtom, { ...state, tabs: nextTabs });
      return;
    }

    const previousIndex = Math.max(
      0,
      state.tabs.findIndex((tab) => tab.id === state.activeTabId)
    );
    const nextTab =
      nextTabs[Math.min(Math.max(0, previousIndex - 1), nextTabs.length - 1)];
    set(chatPanelTabsAtom, {
      tabs: nextTabs,
      activeTabId: nextTab.id,
    });
    set(activateChatPanelTabAtom, nextTab.id);
  }
);
invalidateSessionChatPanelTabsAtom.debugLabel =
  "invalidateSessionChatPanelTabs";

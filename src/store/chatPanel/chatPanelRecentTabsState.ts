import { atom } from "jotai";

import { recordRecentTab, removeRecentTab } from "@src/shared/tabs/recentTabs";

import type { ChatPanelTab } from "./chatPanelTabsModel";

/** App-lifetime, bounded MRU history. Launchpad is already a primary menu action. */
export const recentChatPanelTabsAtom = atom<ChatPanelTab[]>([]);
recentChatPanelTabsAtom.debugLabel = "recentChatPanelTabsAtom";

interface ChatPanelTabTransition {
  previousTab: ChatPanelTab | null | undefined;
  nextTab: ChatPanelTab;
}

export function isSameRecentChatPanelTab(
  left: ChatPanelTab,
  right: ChatPanelTab
): boolean {
  if (left.type === "session" && right.type === "session") {
    return left.sessionId === right.sessionId;
  }
  return left.id === right.id;
}

function recordRecentChatPanelTab(
  current: readonly ChatPanelTab[],
  tab: ChatPanelTab
): ChatPanelTab[] {
  return recordRecentTab(
    current.filter((candidate) => !isSameRecentChatPanelTab(candidate, tab)),
    tab
  );
}

/** Record the tab being left and remove the destination from recent history. */
export const recordChatPanelTabTransitionAtom = atom(
  null,
  (_get, set, transition: ChatPanelTabTransition) => {
    const { previousTab, nextTab } = transition;
    set(recentChatPanelTabsAtom, (current) => {
      const withoutDestination = current.filter(
        (candidate) => !isSameRecentChatPanelTab(candidate, nextTab)
      );
      if (
        !previousTab ||
        isSameRecentChatPanelTab(previousTab, nextTab) ||
        previousTab.type === "start-page"
      ) {
        return withoutDestination;
      }
      return recordRecentChatPanelTab(withoutDestination, previousTab);
    });
  }
);
recordChatPanelTabTransitionAtom.debugLabel =
  "recordChatPanelTabTransitionAtom";

export const removeRecentChatPanelTabAtom = atom(
  null,
  (_get, set, tabId: string) => {
    set(recentChatPanelTabsAtom, (current) => removeRecentTab(current, tabId));
  }
);
removeRecentChatPanelTabAtom.debugLabel = "removeRecentChatPanelTabAtom";

export const recordRecentChatPanelTabAtom = atom(
  null,
  (_get, set, tab: ChatPanelTab) => {
    if (tab.type === "start-page") return;
    set(recentChatPanelTabsAtom, (current) =>
      recordRecentChatPanelTab(current, tab)
    );
  }
);
recordRecentChatPanelTabAtom.debugLabel = "recordRecentChatPanelTabAtom";

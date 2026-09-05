import { atom } from "jotai";

import {
  isSameRecentChatPanelTab,
  recentChatPanelTabsAtom,
  removeRecentChatPanelTabAtom,
} from "./chatPanelRecentTabsState";
import { addChatPanelTerminalTabAtom } from "./chatPanelTabOpen/session";
import {
  activateChatPanelTabAtom,
  appendAndActivateChatPanelTabAtom,
} from "./chatPanelTabPresentationAtoms";
import { chatPanelTabsAtom } from "./chatPanelTabsState";
import { createChatPanelTerminalAtom } from "./chatPanelTerminalAtom";

/** Focus an open recent tab or restore its saved payload when it was closed. */
export const openRecentChatPanelTabAtom = atom(
  null,
  (get, set, tabId: string): string | null => {
    const recentTab = get(recentChatPanelTabsAtom).find(
      (tab) => tab.id === tabId
    );
    if (!recentTab) return null;

    const openTab = get(chatPanelTabsAtom).tabs.find((tab) =>
      isSameRecentChatPanelTab(tab, recentTab)
    );
    let openedTabId = recentTab.id;

    if (openTab) {
      set(activateChatPanelTabAtom, openTab.id);
    } else if (recentTab.type === "terminal") {
      const terminalSessionId = set(
        createChatPanelTerminalAtom,
        recentTab.title
      );
      openedTabId = set(addChatPanelTerminalTabAtom, {
        terminalSessionId,
        title: recentTab.title,
        cliCommand: recentTab.cliCommand,
      });
    } else {
      set(appendAndActivateChatPanelTabAtom, { tab: recentTab });
    }

    set(removeRecentChatPanelTabAtom, tabId);
    return openedTabId;
  }
);
openRecentChatPanelTabAtom.debugLabel = "openRecentChatPanelTabAtom";

export { recentChatPanelTabsAtom } from "./chatPanelRecentTabsState";

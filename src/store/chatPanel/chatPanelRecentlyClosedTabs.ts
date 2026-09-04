import { atom } from "jotai";

import {
  prependRecentlyClosedTabs,
  removeRecentlyClosedTab,
} from "@src/shared/tabs/recentlyClosedTabs";

import { addChatPanelTerminalTabAtom } from "./chatPanelTabOpen/session";
import { appendAndActivateChatPanelTabAtom } from "./chatPanelTabPresentationAtoms";
import { activateChatPanelTabAtom } from "./chatPanelTabPresentationAtoms";
import type { ChatPanelTab } from "./chatPanelTabsModel";
import { chatPanelTabsAtom } from "./chatPanelTabsState";
import { createChatPanelTerminalAtom } from "./chatPanelTerminalAtom";

/** App-lifetime, bounded restore history for tabs explicitly closed by a user. */
export const recentlyClosedChatPanelTabsAtom = atom<ChatPanelTab[]>([]);
recentlyClosedChatPanelTabsAtom.debugLabel = "recentlyClosedChatPanelTabsAtom";

export const recordRecentlyClosedChatPanelTabsAtom = atom(
  null,
  (_get, set, tabs: readonly ChatPanelTab[]) => {
    if (tabs.length === 0) return;
    set(recentlyClosedChatPanelTabsAtom, (current) =>
      prependRecentlyClosedTabs(current, tabs)
    );
  }
);
recordRecentlyClosedChatPanelTabsAtom.debugLabel =
  "recordRecentlyClosedChatPanelTabsAtom";

/** Restore one tab and consume its history entry. Terminal tabs get a fresh PTY. */
export const restoreRecentlyClosedChatPanelTabAtom = atom(
  null,
  (get, set, tabId: string): string | null => {
    const closedTab = get(recentlyClosedChatPanelTabsAtom).find(
      (tab) => tab.id === tabId
    );
    if (!closedTab) return null;

    const openTab = get(chatPanelTabsAtom).tabs.find(
      (tab) => tab.id === closedTab.id
    );
    let restoredTabId = closedTab.id;

    if (openTab) {
      set(activateChatPanelTabAtom, openTab.id);
    } else if (closedTab.type === "terminal") {
      const terminalSessionId = set(
        createChatPanelTerminalAtom,
        closedTab.title
      );
      restoredTabId = set(addChatPanelTerminalTabAtom, {
        terminalSessionId,
        title: closedTab.title,
        cliCommand: closedTab.cliCommand,
      });
    } else {
      set(appendAndActivateChatPanelTabAtom, { tab: closedTab });
    }

    set(recentlyClosedChatPanelTabsAtom, (current) =>
      removeRecentlyClosedTab(current, tabId)
    );
    return restoredTabId;
  }
);
restoreRecentlyClosedChatPanelTabAtom.debugLabel =
  "restoreRecentlyClosedChatPanelTabAtom";

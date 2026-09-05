/**
 * Per-tab session navigation history for the Chat Panel.
 *
 * A chat tab behaves like a browser tab: normal navigation (sidebar click,
 * session reference card, fork header) repoints the tab at another session
 * instead of opening a sibling tab, and the tab remembers where it has been
 * so Back / Forward can walk that trail. History is in-memory only — chat
 * tabs never rehydrate across restarts, so neither does their history.
 */
import { type Getter, type Setter, atom } from "jotai";

import { sessionByIdAtom } from "@src/store/session/sessionAtom";

import { recordChatPanelTabTransitionAtom } from "./chatPanelRecentTabsState";
import { createSessionTab } from "./chatPanelTabFactories";
import { activateChatPanelTabAtom } from "./chatPanelTabPresentationAtoms";
import type { ChatPanelTab } from "./chatPanelTabsModel";
import {
  activeChatPanelTabAtom,
  chatPanelTabsAtom,
} from "./chatPanelTabsState";

export interface ChatPanelTabHistory {
  /** Visited session ids, oldest first. */
  entries: string[];
  /** Index of the entry the tab currently shows. */
  index: number;
}

/** Oldest entries are dropped past this many; a tab's trail stays bounded. */
export const CHAT_PANEL_TAB_HISTORY_LIMIT = 50;

export const chatPanelTabHistoriesAtom = atom<
  Record<string, ChatPanelTabHistory>
>({});
chatPanelTabHistoriesAtom.debugLabel = "chatPanelTabHistories";

/**
 * A session tab created before it ever navigated has an implicit one-entry
 * trail: the session it was minted with.
 */
function seedTabHistory(tab: ChatPanelTab): ChatPanelTabHistory {
  return tab.type === "session" && tab.sessionId
    ? { entries: [tab.sessionId], index: 0 }
    : { entries: [], index: -1 };
}

function resolveTabHistory(
  histories: Record<string, ChatPanelTabHistory>,
  tab: ChatPanelTab
): ChatPanelTabHistory {
  return histories[tab.id] ?? seedTabHistory(tab);
}

export function pushTabHistoryEntry(
  history: ChatPanelTabHistory,
  sessionId: string
): ChatPanelTabHistory {
  if (history.entries[history.index] === sessionId) return history;
  const entries = [...history.entries.slice(0, history.index + 1), sessionId];
  const overflow = Math.max(0, entries.length - CHAT_PANEL_TAB_HISTORY_LIMIT);
  const bounded = overflow > 0 ? entries.slice(overflow) : entries;
  return { entries: bounded, index: bounded.length - 1 };
}

export const activeChatPanelTabHistoryAtom = atom<ChatPanelTabHistory | null>(
  (get) => {
    const tab = get(activeChatPanelTabAtom);
    if (!tab) return null;
    return resolveTabHistory(get(chatPanelTabHistoriesAtom), tab);
  }
);
activeChatPanelTabHistoryAtom.debugLabel = "activeChatPanelTabHistory";

export const activeChatPanelTabCanGoBackAtom = atom((get) => {
  const history = get(activeChatPanelTabHistoryAtom);
  return history !== null && history.index > 0;
});
activeChatPanelTabCanGoBackAtom.debugLabel = "activeChatPanelTabCanGoBack";

export const activeChatPanelTabCanGoForwardAtom = atom((get) => {
  const history = get(activeChatPanelTabHistoryAtom);
  return history !== null && history.index < history.entries.length - 1;
});
activeChatPanelTabCanGoForwardAtom.debugLabel =
  "activeChatPanelTabCanGoForward";

/** Forget a closed tab's trail. */
export const dropChatPanelTabHistoryAtom = atom(
  null,
  (get, set, tabId: string) => {
    const histories = get(chatPanelTabHistoriesAtom);
    if (!(tabId in histories)) return;
    const { [tabId]: _dropped, ...rest } = histories;
    set(chatPanelTabHistoriesAtom, rest);
  }
);
dropChatPanelTabHistoryAtom.debugLabel = "dropChatPanelTabHistory";

export interface NavigateChatPanelTabToSessionOptions {
  tabId: string;
  sessionId: string;
  sessionName?: string;
  repoPath?: string;
  /**
   * Record the destination on the tab's trail. Back / Forward pass `false`
   * because they move the cursor instead of extending the trail.
   */
  record?: boolean;
}

/**
 * Repoint an existing session tab at another session and show it. The tab id
 * is stable across navigation, so anything keyed by tab id keeps working; the
 * session pipeline follows through the shared activation chain.
 */
export const navigateChatPanelTabToSessionAtom = atom(
  null,
  (
    get,
    set,
    {
      tabId,
      sessionId,
      sessionName,
      repoPath,
      record = true,
    }: NavigateChatPanelTabToSessionOptions
  ) => {
    const state = get(chatPanelTabsAtom);
    const tab = state.tabs.find((candidate) => candidate.id === tabId);
    if (!tab || tab.type !== "session") return false;

    if (tab.sessionId !== sessionId) {
      const session = get(sessionByIdAtom(sessionId));
      const title = sessionName ?? session?.name ?? "Chat";
      const now = new Date().toISOString();
      const nextTab: ChatPanelTab = {
        ...tab,
        sessionId,
        title,
        updatedAt: now,
      };
      // The session being left joins the recent-tabs list as its own
      // restorable payload. It gets a fresh id: the live tab keeps this id
      // and now shows another session, so sharing it would make the recent
      // entry collide with the open tab on restore.
      set(recordChatPanelTabTransitionAtom, {
        previousTab: tab.sessionId
          ? createSessionTab({ sessionId: tab.sessionId, title: tab.title })
          : null,
        nextTab,
      });
      set(chatPanelTabsAtom, {
        tabs: state.tabs.map((candidate) =>
          candidate.id === tabId ? nextTab : candidate
        ),
        activeTabId: tabId,
      });
    }

    if (record) {
      const histories = get(chatPanelTabHistoriesAtom);
      const next = pushTabHistoryEntry(
        resolveTabHistory(histories, tab),
        sessionId
      );
      set(chatPanelTabHistoriesAtom, { ...histories, [tabId]: next });
    }

    set(activateChatPanelTabAtom, { tabId, sessionName, repoPath });
    return true;
  }
);
navigateChatPanelTabToSessionAtom.debugLabel = "navigateChatPanelTabToSession";

function stepActiveTabHistory(
  get: Getter,
  set: Setter,
  delta: -1 | 1
): boolean {
  const tab = get(activeChatPanelTabAtom);
  if (!tab || tab.type !== "session") return false;
  const histories = get(chatPanelTabHistoriesAtom);
  const history = resolveTabHistory(histories, tab);
  const nextIndex = history.index + delta;
  if (nextIndex < 0 || nextIndex >= history.entries.length) return false;

  set(chatPanelTabHistoriesAtom, {
    ...histories,
    [tab.id]: { ...history, index: nextIndex },
  });
  return set(navigateChatPanelTabToSessionAtom, {
    tabId: tab.id,
    sessionId: history.entries[nextIndex],
    record: false,
  });
}

/** Show the previous session on the active tab's trail. */
export const goBackChatPanelTabAtom = atom(null, (get, set) =>
  stepActiveTabHistory(get, set, -1)
);
goBackChatPanelTabAtom.debugLabel = "goBackChatPanelTab";

/** Show the next session on the active tab's trail. */
export const goForwardChatPanelTabAtom = atom(null, (get, set) =>
  stepActiveTabHistory(get, set, 1)
);
goForwardChatPanelTabAtom.debugLabel = "goForwardChatPanelTab";

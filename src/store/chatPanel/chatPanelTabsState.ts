import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

import { WORK_MANAGEMENT_SECTION } from "@src/store/workstation/workstationTabBarAtoms";

import { buildInitialChatPanelTabsState } from "./chatPanelTabFactories";
import { type ChatPanelTabsState } from "./chatPanelTabsModel";

const STORAGE_KEY = "orgii:chatPanelTabs:v2";
const WRITE_DEBOUNCE_MS = 400;

let saveTimer: ReturnType<typeof setTimeout> | null = null;

const debouncedStorage = {
  getItem(key: string): ChatPanelTabsState {
    // On app restart, close all chat-pane tabs: never rehydrate persisted
    // tabs, always start from a fresh single Launchpad tab. The persisted
    // value is cleared so it can't leak back in through any other reader.
    try {
      localStorage.removeItem(key);
    } catch {
      // Ignore removal errors
    }
    return buildInitialChatPanelTabsState();
  },
  setItem(key: string, value: ChatPanelTabsState): void {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        // Ignore write errors
      }
    }, WRITE_DEBOUNCE_MS);
  },
  removeItem(key: string): void {
    localStorage.removeItem(key);
  },
  subscribe(
    _key: string,
    _callback: (value: ChatPanelTabsState) => void
  ): () => void {
    return () => undefined;
  },
};

export const chatPanelTabsAtom = atomWithStorage<ChatPanelTabsState>(
  STORAGE_KEY,
  buildInitialChatPanelTabsState(),
  debouncedStorage
);
chatPanelTabsAtom.debugLabel = "chatPanelTabs";

export const activeChatPanelTabAtom = atom((get) => {
  const state = get(chatPanelTabsAtom);
  return (
    state.tabs.find((tab) => tab.id === state.activeTabId) ??
    state.tabs[0] ??
    null
  );
});
activeChatPanelTabAtom.debugLabel = "activeChatPanelTab";

/**
 * Kanban content and sidebar selection are projections of the active
 * ChatPanel tab. Keeping this derived prevents tab chrome, content, and
 * sidebar state from drifting independently.
 */
export const activeWorkManagementSectionAtom = atom(
  (get) =>
    get(activeChatPanelTabAtom)?.managementSection ??
    WORK_MANAGEMENT_SECTION.KANBAN
);
activeWorkManagementSectionAtom.debugLabel = "activeWorkManagementSection";

export const chatPanelTabCountAtom = atom(
  (get) => get(chatPanelTabsAtom).tabs.length
);

/**
 * Active tab's type only. Primitive-valued so consumers that merely branch on
 * which kind of surface is showing (e.g. the floating side-chat launcher)
 * re-render on a real tab switch instead of on every title or payload patch
 * that rebuilds the tab objects.
 */
export const activeChatPanelTabTypeAtom = atom(
  (get) => get(activeChatPanelTabAtom)?.type ?? null
);
activeChatPanelTabTypeAtom.debugLabel = "activeChatPanelTabType";

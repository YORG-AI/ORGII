import { atom } from "jotai";

import type { SessionTabTransfer } from "@src/shared/dnd/sessionTabDrag";
import {
  chatPanelTabsAtom,
  closeChatPanelTabAtom,
  openOrFocusSessionInChatPanelTabAtom,
} from "@src/store/chatPanel/chatPanelTabsAtom";
import { chatPanelMaximizedAtom } from "@src/store/ui/chatPanelAtom";
import {
  closeTab,
  createChatSessionTab,
  openTab,
  workstationLayoutAtom,
} from "@src/store/workstation/tabs";

import { sessionByIdAtom } from "./sessionAtom";
import { claimPipelineSessionAtom, jumpToSessionAtom } from "./viewAtom";

export interface SessionContinuation {
  sessionId: string;
  sessionName?: string;
  repoPath?: string;
}

export interface OpenSessionInWorkstationOptions {
  sessionId: string;
  title?: string;
}

function getSessionTitle(
  sessionName: string | undefined,
  fallbackTitle: string
): string {
  const trimmedName = sessionName?.trim();
  return trimmedName || fallbackTitle || "Chat";
}

/**
 * Open one session in the canonical Workstation chat tab. Any Chat Panel pill
 * for the same session is removed so the live session keeps one visible owner.
 */
export const openSessionInWorkstationAtom = atom(
  null,
  (get, set, options: OpenSessionInWorkstationOptions): boolean => {
    const sessionId = options.sessionId.trim();
    if (!sessionId) return false;

    const session = get(sessionByIdAtom(sessionId));
    const title = getSessionTitle(session?.name, options.title ?? "Chat");
    const matchingChatTabIds = get(chatPanelTabsAtom)
      .tabs.filter(
        (tab) => tab.type === "session" && tab.sessionId === sessionId
      )
      .map((tab) => tab.id);
    for (const tabId of matchingChatTabIds) {
      set(closeChatPanelTabAtom, tabId);
    }

    const layout = get(workstationLayoutAtom);
    set(workstationLayoutAtom, {
      ...layout,
      mainPane: openTab(
        layout.mainPane,
        createChatSessionTab(sessionId, title)
      ),
    });
    set(chatPanelMaximizedAtom, false);
    set(claimPipelineSessionAtom, sessionId);
    return true;
  }
);
openSessionInWorkstationAtom.debugLabel = "openSessionInWorkstation";

/**
 * Move one session tab between the two visible tab owners. The session and
 * EventStore stay untouched; only the presentation owner changes.
 */
export const moveSessionTabAtom = atom(
  null,
  (get, set, transfer: SessionTabTransfer): boolean => {
    const session = get(sessionByIdAtom(transfer.sessionId));
    const title = getSessionTitle(session?.name, transfer.title);

    if (transfer.source === "chat-panel") {
      const sourceTab = get(chatPanelTabsAtom).tabs.find(
        (tab) => tab.id === transfer.sourceTabId
      );
      if (
        sourceTab?.type !== "session" ||
        sourceTab.sessionId !== transfer.sessionId
      ) {
        return false;
      }

      return set(openSessionInWorkstationAtom, {
        sessionId: transfer.sessionId,
        title,
      });
    }

    const layout = get(workstationLayoutAtom);
    const sourceTab = layout.mainPane.tabs.find(
      (tab) => tab.id === transfer.sourceTabId
    );
    if (
      sourceTab?.type !== "chat-session" ||
      sourceTab.data.sessionId !== transfer.sessionId
    ) {
      return false;
    }

    set(workstationLayoutAtom, {
      ...layout,
      mainPane: closeTab(layout.mainPane, sourceTab.id),
    });
    set(openOrFocusSessionInChatPanelTabAtom, {
      sessionId: transfer.sessionId,
      sessionName: title,
      repoPath: session?.repoPath,
    });
    return true;
  }
);
moveSessionTabAtom.debugLabel = "moveSessionTab";

interface RetargetChatPanelSessionTabOptions extends SessionContinuation {
  sourceSessionId: string;
  tabId: string;
}

/** Retarget the current Chat Panel session pill without opening another tab. */
export const retargetChatPanelSessionTabAtom = atom(
  null,
  (get, set, options: RetargetChatPanelSessionTabOptions): boolean => {
    const state = get(chatPanelTabsAtom);
    const sourceTab = state.tabs.find((tab) => tab.id === options.tabId);
    if (
      sourceTab?.type !== "session" ||
      sourceTab.sessionId !== options.sourceSessionId
    ) {
      return false;
    }

    const title = getSessionTitle(options.sessionName, sourceTab.title);
    set(chatPanelTabsAtom, {
      ...state,
      tabs: state.tabs.map((tab) =>
        tab.id === sourceTab.id
          ? {
              ...tab,
              title,
              sessionId: options.sessionId,
              updatedAt: new Date().toISOString(),
            }
          : tab
      ),
    });
    set(jumpToSessionAtom, {
      sessionId: options.sessionId,
      sessionName: title,
      repoPath: options.repoPath,
    });
    return true;
  }
);
retargetChatPanelSessionTabAtom.debugLabel = "retargetChatPanelSessionTab";

interface RetargetWorkstationSessionTabOptions extends SessionContinuation {
  sourceSessionId: string;
  tabId: string;
}

/** Retarget the current Workstation session pill without opening another tab. */
export const retargetWorkstationSessionTabAtom = atom(
  null,
  (get, set, options: RetargetWorkstationSessionTabOptions): boolean => {
    const layout = get(workstationLayoutAtom);
    const sourceIndex = layout.mainPane.tabs.findIndex(
      (tab) => tab.id === options.tabId
    );
    const sourceTab = layout.mainPane.tabs[sourceIndex];
    if (
      sourceTab?.type !== "chat-session" ||
      sourceTab.data.sessionId !== options.sourceSessionId
    ) {
      return false;
    }

    const title = getSessionTitle(options.sessionName, sourceTab.title);
    const replacement = createChatSessionTab(options.sessionId, title);
    const tabs = [...layout.mainPane.tabs];
    tabs[sourceIndex] = {
      ...replacement,
      data: {
        ...sourceTab.data,
        ...replacement.data,
      },
    };
    set(workstationLayoutAtom, {
      ...layout,
      mainPane: {
        tabs,
        activeTabId:
          layout.mainPane.activeTabId === sourceTab.id
            ? replacement.id
            : layout.mainPane.activeTabId,
      },
    });
    set(claimPipelineSessionAtom, options.sessionId);
    return true;
  }
);
retargetWorkstationSessionTabAtom.debugLabel = "retargetWorkstationSessionTab";

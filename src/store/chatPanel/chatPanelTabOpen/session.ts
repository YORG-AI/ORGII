/**
 * Session, terminal, runtime and run-group tab open atoms.
 */
import { atom } from "jotai";

import { sessionByIdAtom } from "@src/store/session/sessionAtom";

import { recordChatPanelTabTransitionAtom } from "../chatPanelRecentTabsState";
import {
  createRunGroupTab,
  createRuntimeTab,
  createSessionTab,
  createTerminalTab,
} from "../chatPanelTabFactories";
import { navigateChatPanelTabToSessionAtom } from "../chatPanelTabNavigationAtoms";
import {
  activateChatPanelTabAtom,
  appendAndActivateChatPanelTabAtom,
} from "../chatPanelTabPresentationAtoms";
import type { ChatPanelTab } from "../chatPanelTabsModel";
import { chatPanelTabsAtom } from "../chatPanelTabsState";

/** Open or focus the singleton Runtime tab. */
export const openRuntimeInChatPanelTabAtom = atom(
  null,
  (get, set, title: string = "Runtime") => {
    const existingTab = get(chatPanelTabsAtom).tabs.find(
      (tab) => tab.type === "runtime"
    );
    if (existingTab) {
      set(activateChatPanelTabAtom, existingTab.id);
      return existingTab.id;
    }

    const tab = createRuntimeTab({ title });
    set(appendAndActivateChatPanelTabAtom, { tab });
    return tab.id;
  }
);
openRuntimeInChatPanelTabAtom.debugLabel = "openRuntimeInChatPanelTab";

interface OpenSessionInNewChatTabOptions {
  sessionId: string;
  sessionName?: string;
  repoPath?: string;
}

/**
 * Open an existing session in a new chat panel tab and make it the active
 * WorkStation session.
 */
export const openSessionInNewChatTabAtom = atom(
  null,
  (_get, set, optionsOrSessionId: OpenSessionInNewChatTabOptions | string) => {
    const options =
      typeof optionsOrSessionId === "string"
        ? { sessionId: optionsOrSessionId }
        : optionsOrSessionId;
    const { sessionId, sessionName, repoPath } = options;
    const tab = createSessionTab({ sessionId, title: sessionName });
    set(appendAndActivateChatPanelTabAtom, {
      tab,
      sessionName,
      repoPath,
    });
    return tab.id;
  }
);
openSessionInNewChatTabAtom.debugLabel = "openSessionInNewChatTab";

/** Focus an existing tab for a session, or create one when none is open. */
export const openOrFocusSessionInChatPanelTabAtom = atom(
  null,
  (get, set, options: OpenSessionInNewChatTabOptions) => {
    const existingTab = get(chatPanelTabsAtom).tabs.find(
      (tab) => tab.type === "session" && tab.sessionId === options.sessionId
    );
    if (existingTab) {
      set(activateChatPanelTabAtom, {
        tabId: existingTab.id,
        sessionName: options.sessionName,
        repoPath: options.repoPath,
      });
      return existingTab.id;
    }

    return set(openSessionInNewChatTabAtom, options);
  }
);
openOrFocusSessionInChatPanelTabAtom.debugLabel =
  "openOrFocusSessionInChatPanelTab";

/**
 * The tab normal navigation reuses when the active tab cannot host a session
 * itself: the session tab most recently navigated, so one shared tab keeps
 * absorbing sidebar clicks instead of a new sibling appearing per click.
 */
function findSharedSessionTab(tabs: ChatPanelTab[]): ChatPanelTab | undefined {
  let shared: ChatPanelTab | undefined;
  for (const tab of tabs) {
    if (tab.type !== "session") continue;
    if (!shared || (tab.updatedAt ?? "") > (shared.updatedAt ?? "")) {
      shared = tab;
    }
  }
  return shared;
}

/**
 * Open a session from normal navigation, browser-style: the pane keeps one
 * shared session tab and repoints it. An already-open target is focused; the
 * active session tab (or the shared one, when a non-session surface is
 * active) navigates in place and records the hop on its Back / Forward
 * trail; an active Launchpad placeholder is consumed. A new sibling tab only
 * appears when no session tab exists at all — explicit "open in new tab"
 * paths use `openSessionInNewChatTabAtom` directly.
 */
export const openOrReplaceSessionInChatPanelTabAtom = atom(
  null,
  (get, set, options: OpenSessionInNewChatTabOptions) => {
    const state = get(chatPanelTabsAtom);
    const existingTab = state.tabs.find(
      (tab) => tab.type === "session" && tab.sessionId === options.sessionId
    );
    if (existingTab) {
      set(activateChatPanelTabAtom, {
        tabId: existingTab.id,
        sessionName: options.sessionName,
        repoPath: options.repoPath,
      });
      return existingTab.id;
    }

    const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
    const navigableTab =
      activeTab?.type === "session"
        ? activeTab
        : activeTab?.type === "start-page"
          ? undefined
          : findSharedSessionTab(state.tabs);
    if (navigableTab) {
      set(navigateChatPanelTabToSessionAtom, {
        tabId: navigableTab.id,
        sessionId: options.sessionId,
        sessionName: options.sessionName,
        repoPath: options.repoPath,
      });
      return navigableTab.id;
    }

    if (activeTab?.type !== "start-page") {
      return set(openSessionInNewChatTabAtom, options);
    }

    const session = get(sessionByIdAtom(options.sessionId));
    const title = options.sessionName ?? session?.name ?? "Chat";
    // Launchpad is the pane's replaceable "new session" placeholder. Mint a
    // real session tab in its position so no state-bearing tab is repurposed.
    const replacementTab = createSessionTab({
      sessionId: options.sessionId,
      title,
    });
    set(recordChatPanelTabTransitionAtom, {
      previousTab: activeTab,
      nextTab: replacementTab,
    });
    set(chatPanelTabsAtom, {
      tabs: state.tabs.map((tab) =>
        tab.id === activeTab.id ? replacementTab : tab
      ),
      activeTabId: replacementTab.id,
    });
    set(activateChatPanelTabAtom, {
      tabId: replacementTab.id,
      sessionName: options.sessionName,
      repoPath: options.repoPath,
    });
    return replacementTab.id;
  }
);
openOrReplaceSessionInChatPanelTabAtom.debugLabel =
  "openOrReplaceSessionInChatPanelTab";

interface AddTerminalTabOptions {
  terminalSessionId: string;
  title?: string;
  /** CLI binary command to write to the PTY once the shell is ready (e.g. "claude") */
  cliCommand?: string;
}

/** Add a new terminal tab, using the provided terminal session ID */
export const addChatPanelTerminalTabAtom = atom(
  null,
  (_get, set, optionsOrId: AddTerminalTabOptions | string) => {
    const {
      terminalSessionId,
      title = "Terminal",
      cliCommand,
    } = typeof optionsOrId === "string"
      ? { terminalSessionId: optionsOrId }
      : optionsOrId;
    const tab = createTerminalTab({ terminalSessionId, title, cliCommand });
    set(appendAndActivateChatPanelTabAtom, { tab });
    return tab.id;
  }
);
addChatPanelTerminalTabAtom.debugLabel = "addChatPanelTerminalTab";

/**
 * Open or focus the tab for one multi-runner fan-out.
 *
 * The launcher calls this instead of navigating into any single launched
 * session: with N sessions started at once, picking one of them to show would
 * be an arbitrary choice, and the comparison is the thing the user asked for.
 */
export const openRunGroupInChatPanelTabAtom = atom(
  null,
  (get, set, input: { runGroupId: string; title: string }) => {
    const existingTab = get(chatPanelTabsAtom).tabs.find(
      (tab) => tab.type === "run-group" && tab.runGroupId === input.runGroupId
    );
    if (existingTab) {
      set(activateChatPanelTabAtom, existingTab.id);
      return existingTab.id;
    }
    const tab = createRunGroupTab(input);
    set(appendAndActivateChatPanelTabAtom, { tab });
    return tab.id;
  }
);
openRunGroupInChatPanelTabAtom.debugLabel = "openRunGroupInChatPanelTab";

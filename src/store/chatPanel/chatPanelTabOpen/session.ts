/**
 * Session, terminal, runtime and run-group tab open atoms.
 */
import { atom } from "jotai";

import { sessionByIdAtom } from "@src/store/session/sessionAtom";

import {
  createRunGroupTab,
  createRuntimeTab,
  createSessionTab,
  createTerminalTab,
} from "../chatPanelTabFactories";
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
 * Open a session from the sidebar without stacking tabs during normal
 * navigation. An already-open target is focused; otherwise the active session
 * tab is repointed to the target. Non-session tabs are never replaced.
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
    if (activeTab?.type !== "session") {
      return set(openSessionInNewChatTabAtom, options);
    }

    const session = get(sessionByIdAtom(options.sessionId));
    const replacementTab: ChatPanelTab = {
      ...activeTab,
      title: options.sessionName ?? session?.name ?? "Chat",
      sessionId: options.sessionId,
      updatedAt: new Date().toISOString(),
    };
    set(chatPanelTabsAtom, {
      ...state,
      tabs: state.tabs.map((tab) =>
        tab.id === activeTab.id ? replacementTab : tab
      ),
    });
    set(activateChatPanelTabAtom, {
      tabId: activeTab.id,
      sessionName: options.sessionName,
      repoPath: options.repoPath,
    });
    return activeTab.id;
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

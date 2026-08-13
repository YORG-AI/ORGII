import { useAtomValue, useSetAtom } from "jotai";
import { useCallback } from "react";

import {
  activateChatPanelTabAtom,
  activeChatPanelTabAtom,
  addChatPanelTerminalTabAtom,
  chatPanelTabsAtom,
  openOrFocusChatPanelStartPageTabAtom,
  openWorkManagementChatPanelTabAtom,
} from "@src/store/chatPanel/chatPanelTabsAtom";
import { createChatPanelTerminalAtom } from "@src/store/chatPanel/chatPanelTerminalAtom";
import { WORK_MANAGEMENT_SECTION } from "@src/store/workstation";
import { terminalSessionsAtom } from "@src/store/workstation/codeEditor/terminal";

import type { ChatPanelCliTerminalLaunchOptions } from "../types";
import { findOpenCliTerminalTab } from "./chatPanelTerminalTabLookup";

interface UseChatPanelTabsControllerOptions {
  newSessionTitle: string;
  kanbanTitle: string;
  showSessionSurface: () => void;
}

export function useChatPanelTabsController({
  newSessionTitle,
  kanbanTitle,
  showSessionSurface,
}: UseChatPanelTabsControllerOptions) {
  const activeTab = useAtomValue(activeChatPanelTabAtom);
  const allTabs = useAtomValue(chatPanelTabsAtom).tabs;
  const terminalSessions = useAtomValue(terminalSessionsAtom);
  const openStartPageTab = useSetAtom(openOrFocusChatPanelStartPageTabAtom);
  const addTerminalTab = useSetAtom(addChatPanelTerminalTabAtom);
  const openKanbanTab = useSetAtom(openWorkManagementChatPanelTabAtom);
  const createTerminalSession = useSetAtom(createChatPanelTerminalAtom);
  const activateTab = useSetAtom(activateChatPanelTabAtom);

  const handleNewTerminalTab = useCallback(() => {
    const terminalSessionId = createTerminalSession("Terminal");
    addTerminalTab(terminalSessionId);
  }, [addTerminalTab, createTerminalSession]);

  const handleOpenCliTerminal = useCallback(
    (options: ChatPanelCliTerminalLaunchOptions) => {
      // A CLI resume (or a repeat "Launch" of the same agent/cwd) that's
      // already open in a terminal tab should be focused, not relaunched —
      // the backend mints a fresh managed session on every call, so without
      // this check a second click spawns a second CLI process against the
      // same resumed conversation.
      const existingTab = findOpenCliTerminalTab(allTabs, terminalSessions, {
        cliAgentType: options.cliAgentType,
        command: options.command,
        cwd: options.cwd,
      });
      if (existingTab) {
        activateTab(existingTab.id);
        showSessionSurface();
        return;
      }

      const terminalSessionId = createTerminalSession({
        name: options.title,
        cwd: options.cwd,
        cliAgentType: options.cliAgentType,
        agentCommand: options.command,
        expectedProcess: options.expectedProcess,
        agentSessionId: options.agentSessionId,
      });
      addTerminalTab({
        terminalSessionId,
        title: options.title,
        cliCommand: options.command,
      });
      showSessionSurface();
    },
    [
      activateTab,
      addTerminalTab,
      allTabs,
      createTerminalSession,
      showSessionSurface,
      terminalSessions,
    ]
  );

  // New-session and launchpad both open the singleton start page (Work
  // section), focusing the existing tab instead of stacking a new one.
  const handleNewSessionTab = useCallback(() => {
    openStartPageTab({ title: newSessionTitle });
  }, [newSessionTitle, openStartPageTab]);

  const handleOpenLaunchpadTab = useCallback(() => {
    openStartPageTab({ title: newSessionTitle });
  }, [newSessionTitle, openStartPageTab]);

  const handleOpenKanbanTab = useCallback(() => {
    openKanbanTab({
      section: WORK_MANAGEMENT_SECTION.KANBAN,
      title: kanbanTitle,
    });
  }, [kanbanTitle, openKanbanTab]);

  const isTerminalTabActive = activeTab?.type === "terminal";
  const terminalTabs = allTabs.filter(
    (tab) => tab.type === "terminal" && tab.terminalSessionId
  );

  return {
    activeTab,
    handleNewSessionTab,
    handleNewTerminalTab,
    handleOpenCliTerminal,
    handleOpenLaunchpadTab,
    handleOpenKanbanTab,
    isTerminalTabActive,
    terminalTabs,
  };
}

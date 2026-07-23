import { useAtomValue, useSetAtom } from "jotai";
import { useCallback } from "react";

import {
  activeChatPanelTabAtom,
  addChatPanelTerminalTabAtom,
  chatPanelTabsAtom,
  openChangelogInChatPanelTabAtom,
  openOrFocusChatPanelStartPageTabAtom,
  openWorkManagementChatPanelTabAtom,
} from "@src/store/chatPanel/chatPanelTabsAtom";
import { createChatPanelTerminalAtom } from "@src/store/chatPanel/chatPanelTerminalAtom";
import { WORK_MANAGEMENT_SECTION } from "@src/store/workstation";

import type { ChatPanelCliTerminalLaunchOptions } from "../types";

interface UseChatPanelTabsControllerOptions {
  launchpadTitle: string;
  kanbanTitle: string;
  changelogTitle: string;
  showSessionSurface: () => void;
}

export function useChatPanelTabsController({
  launchpadTitle,
  kanbanTitle,
  changelogTitle,
  showSessionSurface,
}: UseChatPanelTabsControllerOptions) {
  const activeTab = useAtomValue(activeChatPanelTabAtom);
  const allTabs = useAtomValue(chatPanelTabsAtom).tabs;
  const openStartPageTab = useSetAtom(openOrFocusChatPanelStartPageTabAtom);
  const addTerminalTab = useSetAtom(addChatPanelTerminalTabAtom);
  const openKanbanTab = useSetAtom(openWorkManagementChatPanelTabAtom);
  const openChangelogTab = useSetAtom(openChangelogInChatPanelTabAtom);
  const createTerminalSession = useSetAtom(createChatPanelTerminalAtom);

  const handleNewTerminalTab = useCallback(() => {
    const terminalSessionId = createTerminalSession("Terminal");
    addTerminalTab(terminalSessionId);
  }, [addTerminalTab, createTerminalSession]);

  const handleOpenCliTerminal = useCallback(
    (options: ChatPanelCliTerminalLaunchOptions) => {
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
    [addTerminalTab, createTerminalSession, showSessionSurface]
  );

  // New-session and launchpad both open the singleton start page (Work
  // section), focusing the existing tab instead of stacking a new one.
  const handleNewSessionTab = useCallback(() => {
    openStartPageTab({ title: launchpadTitle });
  }, [openStartPageTab, launchpadTitle]);

  const handleOpenLaunchpadTab = useCallback(() => {
    openStartPageTab({ title: launchpadTitle });
  }, [openStartPageTab, launchpadTitle]);

  const handleOpenKanbanTab = useCallback(() => {
    openKanbanTab({
      section: WORK_MANAGEMENT_SECTION.KANBAN,
      title: kanbanTitle,
    });
  }, [kanbanTitle, openKanbanTab]);

  const handleOpenChangelogTab = useCallback(() => {
    openChangelogTab(changelogTitle);
  }, [changelogTitle, openChangelogTab]);

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
    handleOpenChangelogTab,
    isTerminalTabActive,
    terminalTabs,
  };
}

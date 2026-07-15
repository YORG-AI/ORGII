import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect } from "react";

import { createLogger } from "@src/hooks/logger";
import {
  activeChatPanelTabAtom,
  addChatPanelTerminalTabAtom,
  chatPanelTabsAtom,
  openKanbanChatPanelTabAtom,
  openOrFocusChatPanelStartPageTabAtom,
  setChatPanelTabSessionIdAtom,
} from "@src/store/chatPanel/chatPanelTabsAtom";
import {
  createChatPanelTerminalAtom,
  updateTerminalSessionInfoAtom,
} from "@src/store/chatPanel/chatPanelTerminalAtom";
import { WORK_MANAGEMENT_SECTION } from "@src/store/workstation";
import { invokeTauri } from "@src/util/platform/tauri/init";

import type { ChatPanelCliTerminalLaunchOptions } from "../types";

const logger = createLogger("ChatPanelTabsController");

interface UseChatPanelTabsControllerOptions {
  currentSessionId: string | null;
  launchpadTitle: string;
  kanbanTitle: string;
  showSessionSurface: () => void;
}

export function useChatPanelTabsController({
  currentSessionId,
  launchpadTitle,
  kanbanTitle,
  showSessionSurface,
}: UseChatPanelTabsControllerOptions) {
  const setTabSessionId = useSetAtom(setChatPanelTabSessionIdAtom);
  const activeTab = useAtomValue(activeChatPanelTabAtom);
  const allTabs = useAtomValue(chatPanelTabsAtom).tabs;
  const openStartPageTab = useSetAtom(openOrFocusChatPanelStartPageTabAtom);
  const addTerminalTab = useSetAtom(addChatPanelTerminalTabAtom);
  const openKanbanTab = useSetAtom(openKanbanChatPanelTabAtom);
  const createTerminalSession = useSetAtom(createChatPanelTerminalAtom);
  const updateTerminalSession = useSetAtom(updateTerminalSessionInfoAtom);
  const activeTabId = activeTab?.id;
  const activeTabSessionId = activeTab?.sessionId;
  const activeTabType = activeTab?.type;

  useEffect(() => {
    if (!activeTabId || activeTabType !== "session") return;
    if (!activeTabSessionId && currentSessionId) {
      setTabSessionId({
        tabId: activeTabId,
        sessionId: currentSessionId,
      });
    }
  }, [
    activeTabId,
    activeTabSessionId,
    activeTabType,
    currentSessionId,
    setTabSessionId,
  ]);

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
      });
      void (async () => {
        if (options.cliAgentType === "hermes") {
          try {
            const env = await invokeTauri<Record<string, string>>(
              "hermes_hook_prepare",
              { terminalSessionId }
            );
            updateTerminalSession({
              sessionId: terminalSessionId,
              info: { env },
            });
          } catch (error) {
            // Hermes still launches with process-based status as a fallback.
            logger.warn("Failed to prepare Hermes lifecycle hook", error);
          }
        }
        addTerminalTab({
          terminalSessionId,
          title: options.title,
          cliCommand: options.command,
        });
        showSessionSurface();
      })();
    },
    [
      addTerminalTab,
      createTerminalSession,
      showSessionSurface,
      updateTerminalSession,
    ]
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

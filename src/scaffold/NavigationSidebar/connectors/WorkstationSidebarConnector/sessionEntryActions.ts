import { useCallback } from "react";

import type { GoToNewSessionOptions } from "@src/hooks/navigation/useAppNavigation";
import {
  CHAT_PANEL_CREATE_TARGET,
  CHAT_PANEL_SURFACE_KIND,
  type ChatPanelCreateTarget,
  type ChatPanelNavigateCommand,
} from "@src/store/ui/chatPanelAtom";

interface UseSessionEntryActionsParams {
  goToNewSession: (options?: GoToNewSessionOptions) => void;
  navigateChatPanel: (command: ChatPanelNavigateCommand) => void;
  openNewChatTab: () => void;
  setChatPanelCreateTarget: (target: ChatPanelCreateTarget) => void;
}

interface UseSessionEntryActionsResult {
  handleGoToNewSession: (options?: GoToNewSessionOptions) => void;
}

export function openNewChatFromSidebar(
  {
    goToNewSession,
    navigateChatPanel,
    openNewChatTab,
    setChatPanelCreateTarget,
  }: UseSessionEntryActionsParams,
  options?: GoToNewSessionOptions
): void {
  navigateChatPanel({ kind: CHAT_PANEL_SURFACE_KIND.SESSION });
  setChatPanelCreateTarget(CHAT_PANEL_CREATE_TARGET.AGENT_SESSION);
  goToNewSession(options);
  openNewChatTab();
}

export function useSessionEntryActions({
  goToNewSession,
  navigateChatPanel,
  openNewChatTab,
  setChatPanelCreateTarget,
}: UseSessionEntryActionsParams): UseSessionEntryActionsResult {
  const handleGoToNewSession = useCallback(
    (options?: GoToNewSessionOptions) => {
      openNewChatFromSidebar(
        {
          goToNewSession,
          navigateChatPanel,
          openNewChatTab,
          setChatPanelCreateTarget,
        },
        options
      );
    },
    [
      goToNewSession,
      navigateChatPanel,
      openNewChatTab,
      setChatPanelCreateTarget,
    ]
  );

  return { handleGoToNewSession };
}

import { useSetAtom } from "jotai";
import { useCallback } from "react";

import { clearSessionAtom } from "@src/engines/SessionCore/core/atoms";
import {
  openCreateTargetInChatPanelStartPageAtom,
  openExploreInChatPanelTabAtom,
} from "@src/store/chatPanel/chatPanelTabsAtom";
import {
  activeSessionIdAtom,
  workstationActiveSessionIdAtom,
} from "@src/store/session";
import {
  CHAT_PANEL_CREATE_TARGET,
  CHAT_PANEL_SURFACE_KIND,
  chatPanelNavigateAtom,
  chatPanelStartPageOpenAtom,
} from "@src/store/ui/chatPanelAtom";

export function useChatPanelNavigationActions() {
  const setStartPageOpen = useSetAtom(chatPanelStartPageOpenAtom);
  const navigateChatPanel = useSetAtom(chatPanelNavigateAtom);
  const openExploreTab = useSetAtom(openExploreInChatPanelTabAtom);
  const openCreateTargetInStartPage = useSetAtom(
    openCreateTargetInChatPanelStartPageAtom
  );
  const dispatchClearSession = useSetAtom(clearSessionAtom);
  const setWorkstationActiveSessionId = useSetAtom(
    workstationActiveSessionIdAtom
  );
  const setActiveSessionId = useSetAtom(activeSessionIdAtom);

  const resetActiveSession = useCallback(() => {
    dispatchClearSession();
    setWorkstationActiveSessionId(null);
    setActiveSessionId(null);
  }, [dispatchClearSession, setActiveSessionId, setWorkstationActiveSessionId]);

  const showSessionSurface = useCallback(() => {
    setStartPageOpen(false);
    navigateChatPanel({ kind: CHAT_PANEL_SURFACE_KIND.SESSION });
  }, [navigateChatPanel, setStartPageOpen]);

  const resetToSessionSurface = useCallback(() => {
    showSessionSurface();
    resetActiveSession();
  }, [resetActiveSession, showSessionSurface]);

  const openWorkItemCreate = useCallback(() => {
    openCreateTargetInStartPage({
      target: CHAT_PANEL_CREATE_TARGET.WORK_ITEM,
    });
    resetActiveSession();
  }, [openCreateTargetInStartPage, resetActiveSession]);

  const openWorkspaceExplore = useCallback(() => {
    openExploreTab();
    resetActiveSession();
  }, [openExploreTab, resetActiveSession]);

  return {
    dispatchClearSession,
    openWorkItemCreate,
    openWorkspaceExplore,
    resetActiveSession,
    resetToSessionSurface,
    setActiveSessionId,
    setStartPageOpen,
    setWorkstationActiveSessionId,
    showSessionSurface,
  };
}

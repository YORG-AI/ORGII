/**
 * Session-row interaction handlers for `WorkstationSidebarConnector`
 * (`index.tsx`): the cloud "My Conversations" pagination click (wrapping
 * `useWorkstationSidebarHandlers`' generic click routing), open-in-new-tab
 * / open-in-My-Station / open-linked-work-item-session, and the subagent
 * fork-thread expand/collapse toggle.
 */
import { useCallback } from "react";

import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import { loadMoreCategory } from "@src/store/session";
import {
  CHAT_PANEL_SURFACE_KIND,
  type ChatPanelNavigateCommand,
} from "@src/store/ui/chatPanelAtom";
import {
  getChatPanelTabIdFromTuiSessionId,
  isChatPanelTuiSessionId,
} from "@src/util/ui/terminal/chatPanelTuiSessionId";

import { loadUnifiedReadyCategories } from "../useSessionMenuItems/paginationHelpers";
import { useWorkstationSidebarHandlers } from "../useWorkstationSidebarHandlers";
import {
  CLOUD_MY_SESSIONS_LOAD_MORE_ID,
  CLOUD_SESSION_SECTION_PAGE_SIZE,
} from "./cloudScopedMenuItems";

type SidebarHandlersParams = Parameters<
  typeof useWorkstationSidebarHandlers
>[0];

interface UseWorkstationSidebarSessionInteractionHandlersParams {
  handleCloudSessionItemClick: (item: NavigationMenuItem) => boolean;
  cloudMySessionsVisibleCount: number;
  cloudMyPaginationScopeKey: string;
  setCloudMyPagination: (state: {
    scopeKey: string;
    visibleCount: number;
  }) => void;
  loadedCloudMySessionRowCount: number;
  sessionPagination: Parameters<
    typeof loadUnifiedReadyCategories
  >[0]["pagination"];
  activeSessionId: string;
  sessionMap: SidebarHandlersParams["sessionMap"];
  isLoadMoreId: SidebarHandlersParams["isLoadMoreId"];
  getLoadMoreGroupId: SidebarHandlersParams["getLoadMoreGroupId"];
  sessionRouteLabel: string;
  handleGoToNewSession: SidebarHandlersParams["goToNewSession"];
  navigateTo: SidebarHandlersParams["navigateTo"];
  openSession: SidebarHandlersParams["openSession"];
  promoteActiveSessionCreatorDraft: SidebarHandlersParams["promoteActiveSessionCreatorDraft"];
  setGroupVisibleCounts: SidebarHandlersParams["setGroupVisibleCounts"];
  tCommon: SidebarHandlersParams["tCommon"];
  activateChatPanelTab: (tabId: string) => void;
  openOrReplaceSessionInChatPanelTab: SidebarHandlersParams["onOpenSessionChatPanelTab"];
  closeAndDestroyChatPanelTab: SidebarHandlersParams["onCloseChatPanelTab"];
  activateMyStationRouteForProjectTabContent: () => void;
  navigateChatPanel: (command: ChatPanelNavigateCommand) => void;
  openSessionInNewChatTab: (options: {
    sessionId: string;
    sessionName?: string;
    repoPath?: string;
  }) => void;
  openSessionInWorkstation: (options: {
    sessionId: string;
    title?: string;
  }) => void;
  setExpandedSubagentParentIds: (
    updater: (previousIds: Set<string>) => Set<string>
  ) => void;
}

export function useWorkstationSidebarSessionInteractionHandlers({
  handleCloudSessionItemClick,
  cloudMySessionsVisibleCount,
  cloudMyPaginationScopeKey,
  setCloudMyPagination,
  loadedCloudMySessionRowCount,
  sessionPagination,
  activeSessionId,
  sessionMap,
  isLoadMoreId,
  getLoadMoreGroupId,
  sessionRouteLabel,
  handleGoToNewSession,
  navigateTo,
  openSession,
  promoteActiveSessionCreatorDraft,
  setGroupVisibleCounts,
  tCommon,
  activateChatPanelTab,
  openOrReplaceSessionInChatPanelTab,
  closeAndDestroyChatPanelTab,
  activateMyStationRouteForProjectTabContent,
  navigateChatPanel,
  openSessionInNewChatTab,
  openSessionInWorkstation,
  setExpandedSubagentParentIds,
}: UseWorkstationSidebarSessionInteractionHandlersParams) {
  const handleCloudSidebarItemClick = useCallback(
    (item: NavigationMenuItem): boolean => {
      if (handleCloudSessionItemClick(item)) return true;
      if (item.id !== CLOUD_MY_SESSIONS_LOAD_MORE_ID) return false;

      const nextVisibleCount =
        cloudMySessionsVisibleCount + CLOUD_SESSION_SECTION_PAGE_SIZE;
      setCloudMyPagination({
        scopeKey: cloudMyPaginationScopeKey,
        visibleCount: nextVisibleCount,
      });
      if (nextVisibleCount >= loadedCloudMySessionRowCount) {
        void loadUnifiedReadyCategories({
          pagination: sessionPagination,
          loadCategory: loadMoreCategory,
        });
      }
      return true;
    },
    [
      cloudMyPaginationScopeKey,
      cloudMySessionsVisibleCount,
      handleCloudSessionItemClick,
      loadedCloudMySessionRowCount,
      sessionPagination,
      setCloudMyPagination,
    ]
  );

  const {
    handleDeleteSession,
    handleExportMarkdown,
    handleMenuItemClick,
    handleTogglePin,
  } = useWorkstationSidebarHandlers({
    activeSessionId,
    sessionMap,
    isLoadMoreId,
    getLoadMoreGroupId,
    sessionRouteLabel,
    goToNewSession: handleGoToNewSession,
    navigateTo,
    openSession,
    promoteActiveSessionCreatorDraft,
    setGroupVisibleCounts,
    tCommon,
    onOpenChatPanelTab: activateChatPanelTab,
    onOpenSessionChatPanelTab: openOrReplaceSessionInChatPanelTab,
    onCloseChatPanelTab: closeAndDestroyChatPanelTab,
    onCloudSidebarItemClick: handleCloudSidebarItemClick,
  });
  const handleOpenInNewTab = useCallback(
    (sessionId: string) => {
      activateMyStationRouteForProjectTabContent();
      navigateChatPanel({ kind: CHAT_PANEL_SURFACE_KIND.SESSION });
      if (isChatPanelTuiSessionId(sessionId)) {
        const tabId = getChatPanelTabIdFromTuiSessionId(sessionId);
        if (tabId) activateChatPanelTab(tabId);
        return;
      }
      const session = sessionMap.get(sessionId);
      openSessionInNewChatTab({
        sessionId,
        sessionName: session?.name,
        repoPath: session?.repoPath,
      });
    },
    [
      activateChatPanelTab,
      activateMyStationRouteForProjectTabContent,
      navigateChatPanel,
      openSessionInNewChatTab,
      sessionMap,
    ]
  );
  const handleOpenInMyStation = useCallback(
    (sessionId: string) => {
      const session = sessionMap.get(sessionId);
      if (!session) return;
      activateMyStationRouteForProjectTabContent();
      openSessionInWorkstation({
        sessionId,
        title: session.name,
      });
    },
    [
      activateMyStationRouteForProjectTabContent,
      openSessionInWorkstation,
      sessionMap,
    ]
  );

  const handleOpenLinkedWorkItemSession = useCallback(
    (item: NavigationMenuItem) => {
      if (sessionMap.has(item.id)) {
        handleMenuItemClick(item.key, item);
        return;
      }
      activateMyStationRouteForProjectTabContent();
      openSessionInWorkstation({
        sessionId: item.id,
        title: item.label,
      });
    },
    [
      activateMyStationRouteForProjectTabContent,
      handleMenuItemClick,
      openSessionInWorkstation,
      sessionMap,
    ]
  );

  const handleToggleSubagentExpansion = useCallback(
    (sessionId: string) => {
      setExpandedSubagentParentIds((previousIds) => {
        const nextIds = new Set(previousIds);
        if (nextIds.has(sessionId)) {
          nextIds.delete(sessionId);
        } else {
          nextIds.add(sessionId);
        }
        return nextIds;
      });
    },
    [setExpandedSubagentParentIds]
  );

  return {
    handleDeleteSession,
    handleExportMarkdown,
    handleMenuItemClick,
    handleTogglePin,
    handleOpenInNewTab,
    handleOpenInMyStation,
    handleOpenLinkedWorkItemSession,
    handleToggleSubagentExpansion,
  };
}

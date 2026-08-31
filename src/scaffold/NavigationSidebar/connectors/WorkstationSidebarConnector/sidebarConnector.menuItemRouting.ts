/**
 * Menu-item row-wrapper selection and session-row click routing for
 * `WorkstationSidebarConnector` (`index.tsx`). Builds the session and
 * workstation row wrappers, the
 * Work Items submenu click handler (kanban, projects, Work, GitHub views),
 * and the top-level session-row click router that dispatches to work
 * management, runtime, chat-terminal, new-session, projects, or the
 * default open/replace handler.
 */
import type { TFunction } from "i18next";
import React, { useCallback } from "react";

import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import {
  WORK_MANAGEMENT_PROJECTS_VIEW,
  WORK_MANAGEMENT_SECTION,
  type WorkManagementProjectsView,
  type WorkManagementSection,
} from "@src/store/workstation";

import {
  KANBAN_MENU_ITEM_ID,
  NEW_SESSION_MENU_ITEM_ID,
  RUNTIME_MENU_ITEM_ID,
  TEAM_INBOX_MENU_ITEM_ID,
  WORK_ITEMS_GITHUB_ISSUES_MENU_ITEM_ID,
  WORK_ITEMS_GITHUB_PRS_MENU_ITEM_ID,
  WORK_ITEMS_MENU_ITEM_ID,
  WORK_ITEMS_PROJECTS_MENU_ITEM_ID,
  WORK_ITEMS_RUNS_MENU_ITEM_ID,
  getDraftIdFromMenuItemId,
  isWorkManagementMenuItemId,
} from "../sidebarConnectorUtils";
import {
  useRenderSessionMenuItemWrapper,
  useRenderWorkstationMenuItemWrapper,
} from "./menuItemWrappers";
import {
  getChatTerminalTabId,
  isChatTerminalSidebarItem,
} from "./sidebarMenuCollections";

type RenderWorkstationWrapperParams = Parameters<
  typeof useRenderWorkstationMenuItemWrapper
>[0];

interface UseWorkstationSidebarMenuItemRoutingParams {
  sessionMap: Parameters<typeof useRenderSessionMenuItemWrapper>[0];
  cloudRemoteRowMap: RenderWorkstationWrapperParams["cloudRemoteRowMap"];
  cloudRemoteViewerMap: RenderWorkstationWrapperParams["cloudRemoteViewerMap"];
  tSessions: TFunction<"sessions">;
  t: TFunction<"navigation">;
  setWorkManagementProjectsView: (view: WorkManagementProjectsView) => void;
  openWorkManagementTab: (options: {
    section: WorkManagementSection;
    title: string;
  }) => void;
  openRuntimeTab: (title: string) => void;
  runtimeLabel: string;
  openTeamInboxTab: (title: string) => void;
  activateChatPanelTab: (tabId: string) => void;
  handleMenuItemClick: (key: string, item: NavigationMenuItem) => void;
  workItemsContentVisible: boolean;
  handleProjectsMenuItemClick: (key: string, item: NavigationMenuItem) => void;
  handleOpenInNewTab: (sessionId: string) => void;
}

export function useWorkstationSidebarMenuItemRouting({
  sessionMap,
  cloudRemoteRowMap,
  cloudRemoteViewerMap,
  tSessions,
  t,
  setWorkManagementProjectsView,
  openWorkManagementTab,
  openRuntimeTab,
  runtimeLabel,
  openTeamInboxTab,
  activateChatPanelTab,
  handleMenuItemClick,
  workItemsContentVisible,
  handleProjectsMenuItemClick,
  handleOpenInNewTab,
}: UseWorkstationSidebarMenuItemRoutingParams) {
  const renderSessionMenuItemWrapper =
    useRenderSessionMenuItemWrapper(sessionMap);
  const renderWorkstationMenuItemWrapper = useRenderWorkstationMenuItemWrapper({
    cloudRemoteRowMap,
    cloudRemoteViewerMap,
    renderSessionMenuItemWrapper,
  });

  const handleWorkManagementMenuItemClick = useCallback(
    (_key: string, item: NavigationMenuItem) => {
      let section: WorkManagementSection = WORK_MANAGEMENT_SECTION.KANBAN;
      let title = tSessions("simulator.tabs.kanban");
      if (item.id === WORK_ITEMS_PROJECTS_MENU_ITEM_ID) {
        setWorkManagementProjectsView(WORK_MANAGEMENT_PROJECTS_VIEW.PROJECTS);
        section = WORK_MANAGEMENT_SECTION.PROJECTS;
        title = t("labels.projects");
      } else if (item.id === WORK_ITEMS_MENU_ITEM_ID) {
        setWorkManagementProjectsView(WORK_MANAGEMENT_PROJECTS_VIEW.WORK_ITEMS);
        section = WORK_MANAGEMENT_SECTION.PROJECTS;
        title = t("labels.workItems");
      } else if (item.id === WORK_ITEMS_GITHUB_ISSUES_MENU_ITEM_ID) {
        section = WORK_MANAGEMENT_SECTION.GITHUB_ISSUES;
        title = tSessions("kanban.sidebar.githubIssues");
      } else if (item.id === WORK_ITEMS_GITHUB_PRS_MENU_ITEM_ID) {
        section = WORK_MANAGEMENT_SECTION.GITHUB_PRS;
        title = tSessions("kanban.sidebar.githubPrs");
      } else if (item.id === WORK_ITEMS_RUNS_MENU_ITEM_ID) {
        section = WORK_MANAGEMENT_SECTION.RUNS;
        title = tSessions("kanban.sidebar.runs");
      } else if (item.id !== KANBAN_MENU_ITEM_ID) {
        return;
      }
      openWorkManagementTab({ section, title });
    },
    [openWorkManagementTab, setWorkManagementProjectsView, t, tSessions]
  );

  const handleSessionMenuItemClick = useCallback(
    (key: string, item: NavigationMenuItem, event: React.MouseEvent) => {
      if (isWorkManagementMenuItemId(item.id)) {
        handleWorkManagementMenuItemClick(key, item);
        return;
      }
      if (item.id === RUNTIME_MENU_ITEM_ID) {
        openRuntimeTab(runtimeLabel);
        return;
      }
      if (item.id === TEAM_INBOX_MENU_ITEM_ID) {
        openTeamInboxTab(item.label);
        return;
      }
      if (isChatTerminalSidebarItem(item.id)) {
        activateChatPanelTab(getChatTerminalTabId(item.id));
        return;
      }
      // "New conversation" (and draft sessions) are session actions even while
      // the Work Items submenu is expanded. Route them to the session handler
      // — which focuses the Launchpad Work tab — before the projects reroute
      // below, which would otherwise swallow the click.
      if (
        item.id === NEW_SESSION_MENU_ITEM_ID ||
        getDraftIdFromMenuItemId(item.id)
      ) {
        handleMenuItemClick(key, item);
        return;
      }
      if (workItemsContentVisible) {
        handleProjectsMenuItemClick(key, item);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && sessionMap.has(item.id)) {
        handleOpenInNewTab(item.id);
        return;
      }
      handleMenuItemClick(key, item);
    },
    [
      activateChatPanelTab,
      handleMenuItemClick,
      handleWorkManagementMenuItemClick,
      handleProjectsMenuItemClick,
      handleOpenInNewTab,
      openRuntimeTab,
      openTeamInboxTab,
      runtimeLabel,
      sessionMap,
      workItemsContentVisible,
    ]
  );

  const handleProjectsScopeMenuItemClick = useCallback(
    (key: string, item: NavigationMenuItem, event: React.MouseEvent) => {
      if (item.id === TEAM_INBOX_MENU_ITEM_ID) {
        handleSessionMenuItemClick(key, item, event);
        return;
      }
      handleProjectsMenuItemClick(key, item);
    },
    [handleProjectsMenuItemClick, handleSessionMenuItemClick]
  );

  return {
    renderWorkstationMenuItemWrapper,
    handleSessionMenuItemClick,
    handleProjectsScopeMenuItemClick,
  };
}

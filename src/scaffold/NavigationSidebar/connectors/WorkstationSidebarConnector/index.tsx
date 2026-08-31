import { useAtomValue, useSetAtom } from "jotai";
import React, { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";

import { ROUTES } from "@src/config/routes";
import { useAppNavigation } from "@src/hooks/navigation/useAppNavigation";
import { useSessionView } from "@src/hooks/ui/tabs/useSessionView";
import { Search01Icon } from "@src/icons";
import { teamInboxUnreadCountAtom } from "@src/modules/MainApp/TeamInbox/store";
import { useTeamInboxDataSource } from "@src/modules/MainApp/TeamInbox/useTeamInboxDataSource";
import {
  activeSessionCreatorDraftIdAtom,
  deleteSessionCreatorDraftAtom,
  promoteActiveSessionCreatorDraftAtom,
  sessionCreatorDraftListAtom,
  sessionLoadingAtom,
  sessionPaginationAtom,
  sessionsAtom,
  visitedSessionsAtom,
  workstationActiveSessionIdAtom,
} from "@src/store/session";
import { CHAT_PANEL_SURFACE_KIND } from "@src/store/ui/chatPanelAtom";
import {
  clearSessionSidebarRevealAtom,
  sessionSidebarRevealRequestAtom,
  sidebarCollapsedAtom,
} from "@src/store/ui/sidebarAtom";

import { SidebarBottomBar } from "../../blocks";
import SidebarSettingsMenuButton from "../../blocks/SidebarSettingsMenuButton";
import NavigationSidebar from "../../variants/NavigationSidebar";
import SidebarAccountButton from "../SidebarAccountButton";
import SidebarGuideButton from "../SidebarGuideButton";
import { useSessionMenuItems } from "../useSessionMenuItems";
import { DEFAULT_COLLAPSED_SECTION_IDS } from "../workstationSidebarData";
import { SidebarDialogs } from "./SidebarDialogs";
import { WorkItemsSidebarSkeleton } from "./WorkItemsSidebarSkeleton";
import {
  type WorkstationSidebarViewKey,
  WorkstationSidebarViewSwitcher,
} from "./WorkstationSidebarViewSwitcher";
import { openNewChatFromSidebar } from "./sessionEntryActions";
import { useWorkstationSidebarBottomActions } from "./sidebarConnector.bottomActions";
import { useWorkstationSidebarChatPanelAtoms } from "./sidebarConnector.chatPanelAtoms";
import { useWorkstationSidebarChrome } from "./sidebarConnector.chrome";
import { useWorkstationSidebarCloudMenuData } from "./sidebarConnector.cloudMenuData";
import { buildWorkstationSidebarLabels } from "./sidebarConnector.labels";
import { useWorkstationSidebarPinnedAndRevealData } from "./sidebarConnector.pinnedAndRevealData";
import { useWorkstationSidebarRevealNavigationEffects } from "./sidebarConnector.revealNavigationEffects";
import { useWorkstationSidebarRevealRequestState } from "./sidebarConnector.revealRequestState";
import { useWorkstationSidebarScopeAndPagination } from "./sidebarConnector.scopeAndPagination";
import { useWorkstationSidebarSelectionAndCollapse } from "./sidebarConnector.selectionAndCollapse";
import { useWorkstationSidebarSessionInteractionHandlers } from "./sidebarConnector.sessionInteractionHandlers";
import { SidebarSearchShortcutTooltip } from "./sidebarTabs";
import type { WorkstationSidebarKey } from "./types";
import { useSessionSidebarRowActions } from "./useSessionSidebarRowActions";
import { useSidebarGuide } from "./useSidebarGuide";
import { useSidebarStationNavigation } from "./useSidebarStationNavigation";
import { useWorkItemsSidebarSurface } from "./useWorkItemsSidebarSurface";
import { useWorkspaceGroupActions } from "./useWorkspaceGroupActions";

/**
 * Owns organization scope, cross-surface reveal/selection, and shared sidebar chrome.
 * Work-item state/actions, channel scope composition, session row actions/dialogs,
 * and guide workflows have dedicated owners. Every controller remains mounted
 * with this connector; switching views only changes the existing visibility gates.
 */
export const WorkstationSidebarConnector: React.FC = () => {
  const { t } = useTranslation("navigation");
  const { t: tProjects } = useTranslation("projects");
  const { t: tSessions } = useTranslation("sessions");
  const { t: tCommonRaw } = useTranslation();
  const tCommon = useCallback(
    (key: string, defaultValue?: string) => tCommonRaw(key, { defaultValue }),
    [tCommonRaw]
  );
  const location = useLocation();
  const navigate = useNavigate();
  const sessions = useAtomValue(sessionsAtom);
  useTeamInboxDataSource();
  const teamInboxUnreadCount = useAtomValue(teamInboxUnreadCountAtom);
  const sessionsLoading = useAtomValue(sessionLoadingAtom);
  const sessionPagination = useAtomValue(sessionPaginationAtom);
  const sessionSidebarRevealRequest = useAtomValue(
    sessionSidebarRevealRequestAtom
  );
  const clearSessionSidebarReveal = useSetAtom(clearSessionSidebarRevealAtom);
  const setSidebarCollapsed = useSetAtom(sidebarCollapsedAtom);
  const visitedSessions = useAtomValue(visitedSessionsAtom);
  const sessionCreatorDrafts = useAtomValue(sessionCreatorDraftListAtom);
  const activeSessionCreatorDraftId = useAtomValue(
    activeSessionCreatorDraftIdAtom
  );
  const promoteActiveSessionCreatorDraft = useSetAtom(
    promoteActiveSessionCreatorDraftAtom
  );
  const deleteSessionCreatorDraft = useSetAtom(deleteSessionCreatorDraftAtom);

  const {
    chatPanelContentMode,
    chatPanelCreateTarget,
    chatPanelSelectedWorkItem,
    chatPanelSelectedProject,
    setChatPanelCreateTarget,
    navigateChatPanel,
    setStationChatVisible,
    setStationMode,
    activeWorkManagementSection,
    workManagementProjectsView,
    setWorkManagementProjectsView,
    openWorkManagementTab,
    openOrganizationTab,
    openSessionInNewChatTab,
    openSessionInWorkstation,
    openOrReplaceSessionInChatPanelTab,
    activateChatPanelTab,
    openStartPageTab,
    openCreateTargetInStartPage,
    openRuntimeTab,
    openTeamInboxTab,
    closeAndDestroyChatPanelTab,
  } = useWorkstationSidebarChatPanelAtoms();

  const { openSession } = useSessionView();
  const activeSessionId = useAtomValue(workstationActiveSessionIdAtom) ?? "";
  const { goToNewSession, navigateTo } = useAppNavigation();
  const [activeSidebarKey, setActiveSidebarKey] =
    useState<WorkstationSidebarKey>("workstation");
  const [channelsOpen, setChannelsOpen] = useState(false);
  const [workItemsOpen, setWorkItemsOpen] = useState(false);
  const workItemsContentVisible =
    activeSidebarKey === "workstation" && workItemsOpen;
  const channelSidebarVisible =
    activeSidebarKey === "workstation" && channelsOpen;
  const handleViewChange = useCallback((key: WorkstationSidebarViewKey) => {
    setActiveSidebarKey("workstation");
    setChannelsOpen(key === "channels");
    setWorkItemsOpen(key === "work-items");
  }, []);
  const activeViewKey: WorkstationSidebarViewKey =
    activeSidebarKey === "projects" || workItemsContentVisible
      ? "work-items"
      : channelSidebarVisible
        ? "channels"
        : "sessions";

  const {
    sortedSessions,
    activeCloudOrgId,
    activeOrgId,
    activeProjectOrgId,
    cloudSessionFilter,
    cloudTaggedSessionIds,
    handleCloudSessionFilterChange,
    manageableCloudOrg,
    manageableLocalOrg,
    orgSelectorOptions,
    personalHiddenCloudTaggedIds,
    sessionFilterOrgIds,
    setSelectedOrgId,
    repoPathToName,
    groupByMode,
    setGroupByMode,
    includeExternal,
    setIncludeExternal,
    cloudMyPaginationScopeKey,
    cloudMySessionsVisibleCount,
    setCloudMyPagination,
    resetCloudMyPagination,
    cloudSignedInAvatarUrl,
    cloudSignedInIdentity,
    handleCloudSignIn,
  } = useWorkstationSidebarScopeAndPagination({ sessions });

  const [groupVisibleCounts, setGroupVisibleCounts] = useState<
    Map<string, number>
  >(new Map());
  const [expandedSubagentParentIds, setExpandedSubagentParentIds] = useState<
    Set<string>
  >(() => new Set());
  const [collapsedSectionIds, setCollapsedSectionIds] = useState<Set<string>>(
    () => new Set(DEFAULT_COLLAPSED_SECTION_IDS)
  );

  const { activeSessionSidebarRevealRequest, revealedSessionIds } =
    useWorkstationSidebarRevealRequestState({
      sessionSidebarRevealRequest,
      activeSessionId,
      clearSessionSidebarReveal,
    });

  const {
    untitledSession,
    newSessionLabel,
    pinFolderLabel,
    unpinFolderLabel,
    createProjectLabel,
    createWorkItemLabel,
    runtimeLabel,
    teamInboxLabel,
    importGithubIssuesLabel,
    addOrgLabel,
    manageOrgLabel,
    moreActionsLabel,
    pinWorkspaceLabel,
    unpinWorkspaceLabel,
    hideWorkspaceLabel,
    unhideWorkspaceLabel,
    revealWorkspaceLabel,
    workspaceUnavailableTitle,
    workspaceUnavailableMessage,
  } = buildWorkstationSidebarLabels({ t, tProjects, tSessions, tCommon });

  // Same entry point as the sidebar's own "+ New session", so a workspace
  // header `+` lands the user on the identical surface — it only pre-seeds
  // the creator's source with that workspace first.
  const openNewSessionFromSidebar = useCallback(() => {
    openNewChatFromSidebar({
      goToNewSession,
      navigateChatPanel,
      openNewChatTab: () => openStartPageTab({ title: t("routes.launchpad") }),
      setChatPanelCreateTarget,
    });
  }, [
    goToNewSession,
    navigateChatPanel,
    openStartPageTab,
    setChatPanelCreateTarget,
    t,
  ]);

  const workspaceGroupActions = useWorkspaceGroupActions({
    createSessionLabel: newSessionLabel,
    moreActionsLabel,
    pinLabel: pinWorkspaceLabel,
    unpinLabel: unpinWorkspaceLabel,
    hideLabel: hideWorkspaceLabel,
    unhideLabel: unhideWorkspaceLabel,
    revealLabel: revealWorkspaceLabel,
    unavailableTitle: workspaceUnavailableTitle,
    unavailableMessage: workspaceUnavailableMessage,
    openNewSession: openNewSessionFromSidebar,
    setCollapsedSectionIds,
  });

  const openCloudSessionAtDestination = useCallback(
    (
      destination: "new-tab" | "my-station",
      options: { sessionId: string; title: string }
    ) => {
      setStationMode("my-station");
      setStationChatVisible("my-station", true);
      if (location.pathname !== ROUTES.workStation.code.path) {
        navigate(ROUTES.workStation.code.path);
      }

      if (destination === "new-tab") {
        navigateChatPanel({ kind: CHAT_PANEL_SURFACE_KIND.SESSION });
        openSessionInNewChatTab({
          sessionId: options.sessionId,
          sessionName: options.title,
        });
        return;
      }

      openSessionInWorkstation({
        sessionId: options.sessionId,
        title: options.title,
      });
    },
    [
      location.pathname,
      navigate,
      navigateChatPanel,
      openSessionInNewChatTab,
      openSessionInWorkstation,
      setStationChatVisible,
      setStationMode,
    ]
  );

  const {
    cloudMenuItems,
    cloudSessionMenuItems,
    channelMenuItems,
    selectedCloudMenuItemId,
    handleCloudSessionItemClick,
    resetCloudTeamPagination,
    buildCloudRemoteItemMenuItems,
    cloudMemberFilterDropdown,
    cloudRemoteRowMap,
    cloudRemoteViewerMap,
    sessionListExcludedIds,
    cloudScopedExtraSessionIds,
    cloudChannelsDialogs,
    localChannelsDialogs,
  } = useWorkstationSidebarCloudMenuData({
    activeCloudOrgId,
    sessions,
    cloudSessionFilter,
    activeSessionId,
    cloudMySessionsVisibleCount,
    revealedCloudOrgId: activeSessionSidebarRevealRequest?.cloudOrgId,
    revealedSidebarItemId: activeSessionSidebarRevealRequest?.sidebarItemId,
    openSessionAtDestination: openCloudSessionAtDestination,
    handleCloudSessionFilterChange,
    personalHiddenCloudTaggedIds,
    cloudTaggedSessionIds,
  });

  const {
    menuItems,
    sessionMap,
    subagentParentIds,
    isLoadMoreId,
    getLoadMoreGroupId,
  } = useSessionMenuItems({
    sortedSessions,
    visitedSessions,
    repoPathToName,
    groupByMode,
    untitledSession,
    searchQuery: "",
    selectedOrgIds: sessionFilterOrgIds,
    extraSessionIds: cloudScopedExtraSessionIds,
    excludedSessionIds: sessionListExcludedIds,
    includeExternal,
    groupVisibleCounts,
    showAllLoadedGroupSessions: Boolean(activeCloudOrgId),
    expandedSubagentParentIds,
    revealedSessionIds,
    workspaceGroupActions,
  });

  const {
    rename,
    activeChatPanelTab,
    highlightedSessionId,
    pinnedMenuItems,
    sessionSidebarMenuItems,
    loadedCloudMySessionRowCount,
    revealCandidateMenuItems,
  } = useWorkstationSidebarPinnedAndRevealData({
    activeSessionId,
    cloudMenuItems,
    menuItems,
    sessionCreatorDrafts,
    activeViewKey,
    createProjectLabel,
    createWorkItemLabel,
    importGithubIssuesLabel,
    newSessionLabel,
    runtimeLabel,
    teamInboxLabel,
    teamInboxUnreadCount,
    t,
    tSessions,
  });

  const {
    resetWorkManagementStateForProjectsContent,
    activateMyStationRouteForProjectsContent,
    activateMyStationRouteForProjectTabContent,
    handleGoToNewSession,
  } = useSidebarStationNavigation({
    setStationMode,
    setStationChatVisible,
    openStartPageTab,
    navigateChatPanel,
    setChatPanelCreateTarget,
    goToNewSession,
    location,
    navigate,
    t,
  });

  const {
    handleDeleteSession,
    handleExportMarkdown,
    handleMenuItemClick,
    handleTogglePin,
    handleOpenInNewTab,
    handleOpenInMyStation,
    handleOpenLinkedWorkItemSession,
    handleToggleSubagentExpansion,
  } = useWorkstationSidebarSessionInteractionHandlers({
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
    sessionRouteLabel: t("routes.session"),
    handleGoToNewSession,
    navigateTo,
    openSession,
    promoteActiveSessionCreatorDraft,
    groupByMode,
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
  });

  const {
    moveToOrg,
    cloudSyncLevel,
    cloudShare,
    handleMenuItemContextMenu,
    menuItems: sessionMenuItems,
  } = useSessionSidebarRowActions({
    sessionMap,
    rename,
    handleDeleteSession,
    deleteSessionCreatorDraft,
    handleExportMarkdown,
    handleOpenInNewTab,
    handleOpenInMyStation,
    handleTogglePin,
    handleToggleSubagentExpansion,
    buildCloudRemoteItemMenuItems,
    t,
    tCommon,
    expandedSubagentParentIds,
    pinFolderLabel,
    unpinFolderLabel,
    subagentParentIds,
    cloudSessionMenuItems,
    sessionSidebarMenuItems,
    cloudMySessionsVisibleCount,
  });

  const workItems = useWorkItemsSidebarSurface({
    enabled: activeSidebarKey === "projects" || workItemsContentVisible,
    activeProjectOrgId,
    activateMyStationRouteForProjectTabContent,
    activateMyStationRouteForProjectsContent,
    resetWorkManagementStateForProjectsContent,
    handleOpenLinkedWorkItemSession,
  });
  const { selectedMenuItemId, handleSessionCollapsedSectionIdsChange } =
    useWorkstationSidebarSelectionAndCollapse({
      activeSessionCreatorDraftId,
      highlightedSessionId,
      activeSidebarKey,
      activeChatPanelTabType: activeChatPanelTab?.type ?? null,
      chatPanelContentMode,
      chatPanelCreateTarget,
      chatPanelSelectedProject,
      chatPanelSelectedWorkItem,
      projectsSelectedMenuItemId: workItems.selectedMenuItemId,
      sessionCreatorDrafts,
      workItemsContentVisible,
      activeWorkManagementSection,
      workManagementProjectsView,
      setGroupVisibleCounts,
      collapsedSectionIds,
      groupByMode,
      resetCloudTeamPagination,
      resetCloudMyPagination,
      setCollapsedSectionIds,
    });

  const projectsVisible =
    activeSidebarKey === "projects" || workItemsContentVisible;
  const sidebarMenuItems = projectsVisible
    ? workItems.menuItems
    : channelSidebarVisible
      ? channelMenuItems
      : sessionMenuItems;
  const resolvedCollapsedSectionIds = projectsVisible
    ? workItems.collapsedSectionIds
    : collapsedSectionIds;
  const resolvedOnCollapsedSectionIdsChange = projectsVisible
    ? workItems.onCollapsedSectionIdsChange
    : handleSessionCollapsedSectionIdsChange;

  useWorkstationSidebarRevealNavigationEffects({
    sessionSidebarRevealRequest,
    setSidebarCollapsed,
    setActiveSidebarKey,
    setWorkItemsOpen,
    setChannelsOpen,
    setSelectedOrgId,
    setExpandedSubagentParentIds,
    activeSessionSidebarRevealRequest,
    revealCandidateMenuItems,
    setCollapsedSectionIds,
  });

  const {
    handleOpenSpotlight,
    sidebarOrgSelector,
    resolvedMenuItemClick,
    resolvedMenuItemContextMenu,
    resolvedRenderMenuItemWrapper,
  } = useWorkstationSidebarChrome({
    activeOrgId,
    orgSelectorOptions,
    addOrgLabel,
    cloudSignedInIdentity,
    manageOrgLabel,
    handleCloudSignIn,
    activeSidebarKey,
    workItemsContentVisible,
    handleMenuItemContextMenu,
    resetWorkManagementStateForProjectsContent,
    setProjectsSelectedMenuItemId: workItems.setSelectedMenuItemId,
    openCreateTargetInStartPage,
    t,
    setSelectedOrgId,
    activeCloudOrgId,
    manageableCloudOrg,
    manageableLocalOrg,
    openOrganizationTab,
    sessionMap,
    cloudRemoteRowMap,
    cloudRemoteViewerMap,
    renderProjectsMenuItemWrapper: workItems.renderMenuItemWrapper,
    tSessions,
    setWorkManagementProjectsView,
    openWorkManagementTab,
    openRuntimeTab,
    runtimeLabel,
    openTeamInboxTab,
    activateChatPanelTab,
    handleMenuItemClick,
    handleProjectsMenuItemClick: workItems.onMenuItemClick,
    handleOpenInNewTab,
  });

  const { isLoading, sidebarBottomRightActions, resolvedSelectedMenuItemId } =
    useWorkstationSidebarBottomActions({
      sidebarMenuItems,
      resolvedOnCollapsedSectionIdsChange,
      sessions,
      workItemsContentVisible,
      channelSidebarVisible,
      activeSidebarKey,
      projectsWorkItemsLoading: workItems.loading,
      projectsSidebarMenuItems: workItems.menuItems,
      sessionsLoading,
      openRuntimeTab,
      runtimeLabel,
      groupByMode,
      includeExternal,
      setGroupByMode,
      setIncludeExternal,
      selectedCloudMenuItemId,
      selectedMenuItemId,
      activeSessionId,
      collapsedSectionIds,
      pinnedMenuItems,
    });

  const guide = useSidebarGuide({
    t,
    guideCloudOrg: manageableCloudOrg,
    activeOrgId,
    orgSelectorOptions,
    sessionCount: sessions.length,
    runtimeLabel,
  });

  return (
    <>
      <NavigationSidebar
        items={[]}
        activeKey={activeSidebarKey}
        onChange={() => undefined}
        menuItems={sidebarMenuItems}
        pinnedMenuItems={pinnedMenuItems}
        selectedKey={resolvedSelectedMenuItemId}
        onMenuItemClick={resolvedMenuItemClick}
        onMenuItemContextMenu={resolvedMenuItemContextMenu}
        renderMenuItemWrapper={resolvedRenderMenuItemWrapper}
        hostTopBarLeadingContent={sidebarOrgSelector}
        macTopBarFollowingContent={
          <div className="shrink-0 px-3 pt-1">{sidebarOrgSelector}</div>
        }
        preListContent={
          <WorkstationSidebarViewSwitcher
            activeKey={activeViewKey}
            onChange={handleViewChange}
          />
        }
        onAddNew={handleOpenSpotlight}
        addIcon={Search01Icon}
        addLabel={tCommon("actions.search")}
        addTooltipContent={
          <SidebarSearchShortcutTooltip
            searchLabel={tCommon("actions.search")}
          />
        }
        listTopPadding
        bottomContent={
          <SidebarBottomBar
            leftContent={
              <SidebarSettingsMenuButton
                onSignIn={
                  cloudSignedInIdentity === null ? handleCloudSignIn : undefined
                }
                renderTrigger={({ isOpen, onClick }) => (
                  <SidebarAccountButton
                    identity={cloudSignedInIdentity}
                    avatarUrl={cloudSignedInAvatarUrl}
                    menuOpen={isOpen}
                    onClick={onClick}
                  />
                )}
              />
            }
            rightActions={
              <>
                <SidebarGuideButton
                  {...guide}
                  onStartSession={handleGoToNewSession}
                />
                {sidebarBottomRightActions}
              </>
            }
          />
        }
        isLoading={isLoading}
        loadingContent={
          workItemsContentVisible || activeSidebarKey === "projects" ? (
            <WorkItemsSidebarSkeleton
              loadingLabel={tCommon("status.loading", "Loading")}
            />
          ) : undefined
        }
        collapsibleSections
        collapsedSectionIds={resolvedCollapsedSectionIds}
        onCollapsedSectionsChange={resolvedOnCollapsedSectionIdsChange}
        revealMenuItemRequest={
          activeSessionSidebarRevealRequest
            ? {
                key:
                  activeSessionSidebarRevealRequest.sidebarItemId ??
                  activeSessionSidebarRevealRequest.sessionId,
                requestId: activeSessionSidebarRevealRequest.requestId,
              }
            : undefined
        }
      />
      <SidebarDialogs
        cloudChannelsDialogs={cloudChannelsDialogs}
        localChannelsDialogs={localChannelsDialogs}
        cloudMemberFilterDropdown={cloudMemberFilterDropdown}
        cloudShare={cloudShare}
        cloudSyncLevel={cloudSyncLevel}
        moveToOrg={moveToOrg}
        rename={rename}
        sessionMap={sessionMap}
      />
    </>
  );
};

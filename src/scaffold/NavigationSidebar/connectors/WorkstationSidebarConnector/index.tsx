import { useAtomValue, useSetAtom } from "jotai";
import { Search } from "lucide-react";
import React, { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";

import { useAppNavigation } from "@src/hooks/navigation/useAppNavigation";
import { useSessionView } from "@src/hooks/ui/tabs/useSessionView";
import { teamInboxUnreadCountAtom } from "@src/modules/MainApp/TeamInbox/store";
import { useTeamInboxDataSource } from "@src/modules/MainApp/TeamInbox/useTeamInboxDataSource";
import {
  activeSessionCreatorDraftIdAtom,
  deleteSessionCreatorDraftAtom,
  loadSessionRoster,
  promoteActiveSessionCreatorDraftAtom,
  sessionCreatorDraftListAtom,
  sessionLoadingAtom,
  sessionPaginationAtom,
  sessionsAtom,
  visitedSessionsAtom,
  workstationActiveSessionIdAtom,
} from "@src/store/session";
import {
  clearSessionSidebarRevealAtom,
  sessionSidebarRevealRequestAtom,
  sidebarCollapsedAtom,
} from "@src/store/ui/sidebarAtom";

import { SidebarBottomBar, SidebarMenuSearchInput } from "../../blocks";
import SidebarSettingsMenuButton from "../../blocks/SidebarSettingsMenuButton";
import NavigationSidebar from "../../variants/NavigationSidebar";
import { DEFAULT_COLLAPSED_SECTION_IDS } from "../workstationSidebarData";
import { SidebarDialogs } from "./SidebarDialogs";
import { useWorkstationSidebarBottomActions } from "./sidebarConnector.bottomActions";
import { useWorkstationSidebarChatPanelAtoms } from "./sidebarConnector.chatPanelAtoms";
import { useWorkstationSidebarChrome } from "./sidebarConnector.chrome";
import { useWorkstationSidebarCloudMenuData } from "./sidebarConnector.cloudMenuData";
import { buildWorkstationSidebarLabels } from "./sidebarConnector.labels";
import { useWorkstationSidebarMenuDecoration } from "./sidebarConnector.menuDecoration";
import { useWorkstationSidebarPinnedAndRevealData } from "./sidebarConnector.pinnedAndRevealData";
import { useWorkstationSidebarRevealNavigationEffects } from "./sidebarConnector.revealNavigationEffects";
import { useWorkstationSidebarRevealRequestState } from "./sidebarConnector.revealRequestState";
import { useWorkstationSidebarScopeAndPagination } from "./sidebarConnector.scopeAndPagination";
import { useWorkstationSidebarSelectionAndNavigation } from "./sidebarConnector.selectionAndNavigation";
import { useWorkstationSidebarSessionAndProjectMenuItems } from "./sidebarConnector.sessionAndProjectMenuItems";
import { useWorkstationSidebarSessionInteractionHandlers } from "./sidebarConnector.sessionInteractionHandlers";
import { SidebarSearchShortcutTooltip } from "./sidebarTabs";
import type { WorkstationSidebarKey } from "./types";

/**
 * Workstation sidebar coordinator. The bulk of this connector's state,
 * effects, and derived data live in sibling `sidebarConnector.*` modules
 * (see each file's own header comment) — this component wires them
 * together in the same order they used to run inline and renders the
 * result. `cloudSessionsSection.tsx` supplies the cloud "Team sessions"
 * data consumed here via `sidebarConnector.cloudMenuData`.
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
  const [activeSessionMoreMenuId, setActiveSessionMoreMenuId] = useState("");
  const [projectsSelectedMenuItemId, setProjectsSelectedMenuItemId] =
    useState("");
  const [workItemsOpen, setWorkItemsOpen] = useState(false);
  const workItemsContentVisible =
    activeSidebarKey === "workstation" && workItemsOpen;
  const projectsSidebarVisible =
    activeSidebarKey === "projects" || workItemsContentVisible;
  const activeSidebarSearchKey: WorkstationSidebarKey = workItemsContentVisible
    ? "projects"
    : activeSidebarKey;
  const [sidebarSearchQueries, setSidebarSearchQueries] = useState<
    Record<WorkstationSidebarKey, string>
  >({ workstation: "", projects: "" });
  const handleSidebarLayerChange = useCallback((key: WorkstationSidebarKey) => {
    setActiveSidebarKey(key);
  }, []);

  const handleSidebarSearchChange = useCallback(
    (value: string) => {
      setSidebarSearchQueries((currentQueries) => ({
        ...currentQueries,
        [activeSidebarSearchKey]: value,
      }));
      if (activeSidebarSearchKey === "workstation") {
        void loadSessionRoster();
      }
    },
    [activeSidebarSearchKey]
  );

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
    cloudSignedInIdentity,
    handleCloudSignIn,
  } = useWorkstationSidebarScopeAndPagination({
    sessions,
    workstationSearchQuery: sidebarSearchQueries.workstation,
  });

  const [groupVisibleCounts, setGroupVisibleCounts] = useState<
    Map<string, number>
  >(new Map());
  const [expandedSubagentParentIds, setExpandedSubagentParentIds] = useState<
    Set<string>
  >(() => new Set());
  const [projectsGroupVisibleCounts, setProjectsGroupVisibleCounts] = useState<
    Map<string, number>
  >(new Map());
  const [collapsedSectionIds, setCollapsedSectionIds] = useState<Set<string>>(
    () => new Set(DEFAULT_COLLAPSED_SECTION_IDS)
  );
  const [projectsCollapsedSectionIds, setProjectsCollapsedSectionIds] =
    useState<Set<string>>(() => new Set());

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
    workItemsLabel,
    runtimeLabel,
    teamInboxLabel,
    importGithubIssuesLabel,
    addOrgLabel,
    manageOrgLabel,
    searchPlaceholder,
    noSearchResultsTitle,
  } = buildWorkstationSidebarLabels({ t, tProjects, tSessions, tCommon });

  const {
    cloudMenuItems,
    selectedCloudMenuItemId,
    handleCloudSessionItemClick,
    resetCloudTeamPagination,
    handleCloudRemoteItemRemove,
    cloudMemberFilterDropdown,
    cloudRemoteRowMap,
    cloudRemoteViewerMap,
    sessionListExcludedIds,
    cloudScopedExtraSessionIds,
  } = useWorkstationSidebarCloudMenuData({
    activeCloudOrgId,
    sessions,
    cloudSessionFilter,
    activeSessionId,
    cloudMySessionsVisibleCount,
    revealedCloudOrgId: activeSessionSidebarRevealRequest?.cloudOrgId,
    revealedSidebarItemId: activeSessionSidebarRevealRequest?.sidebarItemId,
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
    projectsWorkItemMenuItems,
    projectsProjectMap,
    projectsWorkItemMap,
    projectsLinearWorkItemMap,
    projectsLocalOrgMap,
    projectsLinearOrgMap,
    projectsWorkItemsLoading,
    projectsLinkedSessionIds,
    getProjectsLoadMoreGroupId,
    loadProjectsLinearOrgWorkItems,
    toChatPanelProject,
    toChatPanelWorkItem,
    openProjectsLinearOrg,
    openProjectsLinearWorkItem,
  } = useWorkstationSidebarSessionAndProjectMenuItems({
    sortedSessions,
    visitedSessions,
    repoPathToName,
    groupByMode,
    untitledSession,
    workstationSearchQuery: sidebarSearchQueries.workstation,
    sessionFilterOrgIds,
    cloudScopedExtraSessionIds,
    sessionListExcludedIds,
    includeExternal,
    groupVisibleCounts,
    activeCloudOrgId,
    expandedSubagentParentIds,
    revealedSessionIds,
    activeSidebarKey,
    workItemsContentVisible,
    projectsGroupVisibleCounts,
    projectsSearchQuery: sidebarSearchQueries.projects,
    activeProjectOrgId,
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
    projectsSidebarVisible,
    activeSidebarKey,
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

  useWorkstationSidebarRevealNavigationEffects({
    sessionSidebarRevealRequest,
    setSidebarCollapsed,
    setActiveSidebarKey,
    setWorkItemsOpen,
    setSelectedOrgId,
    setSidebarSearchQueries,
    setExpandedSubagentParentIds,
    activeSessionSidebarRevealRequest,
    revealCandidateMenuItems,
    setCollapsedSectionIds,
  });

  const {
    resetWorkManagementStateForProjectsContent,
    projectsSidebarMenuItems,
    selectedMenuItemId,
    resolvedCollapsedSectionIds,
    resolvedOnCollapsedSectionIdsChange,
    activateMyStationRouteForProjectsContent,
    activateMyStationRouteForProjectTabContent,
    handleGoToNewSession,
  } = useWorkstationSidebarSelectionAndNavigation({
    setStationMode,
    setStationChatVisible,
    openStartPageTab,
    t,
    projectsWorkItemMenuItems,
    activeSessionCreatorDraftId,
    highlightedSessionId,
    activeSidebarKey,
    activeChatPanelTabType: activeChatPanelTab?.type ?? null,
    chatPanelContentMode,
    chatPanelCreateTarget,
    chatPanelSelectedProject,
    chatPanelSelectedWorkItem,
    projectsSelectedMenuItemId,
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
    setProjectsGroupVisibleCounts,
    projectsCollapsedSectionIds,
    setProjectsCollapsedSectionIds,
    location,
    navigate,
    goToNewSession,
    navigateChatPanel,
    setChatPanelCreateTarget,
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
    sidebarMenuItems,
    handleProjectsMenuItemClick,
  } = useWorkstationSidebarMenuDecoration({
    sessionMap,
    rename,
    handleDeleteSession,
    deleteSessionCreatorDraft,
    handleExportMarkdown,
    handleOpenInNewTab,
    handleOpenInMyStation,
    handleTogglePin,
    handleToggleSubagentExpansion,
    handleCloudRemoteItemRemove,
    t,
    tCommon,
    activeSessionMoreMenuId,
    expandedSubagentParentIds,
    pinFolderLabel,
    unpinFolderLabel,
    setActiveSessionMoreMenuId,
    subagentParentIds,
    cloudMenuItems,
    sessionSidebarMenuItems,
    cloudMySessionsVisibleCount,
    activeSidebarKey,
    workItemsContentVisible,
    projectsSidebarMenuItems,
    activateMyStationRouteForProjectTabContent,
    activateMyStationRouteForProjectsContent,
    getProjectsLoadMoreGroupId,
    loadProjectsLinearOrgWorkItems,
    openProjectsLinearOrg,
    openProjectsLinearWorkItem,
    projectsLinearOrgMap,
    projectsLinearWorkItemMap,
    projectsLocalOrgMap,
    projectsProjectMap,
    projectsWorkItemMap,
    projectsLinkedSessionIds,
    handleOpenLinkedWorkItemSession,
    resetWorkManagementStateForProjectsContent,
    setProjectsGroupVisibleCounts,
    setProjectsSelectedMenuItemId,
    toChatPanelProject,
    toChatPanelWorkItem,
  });

  const {
    handleOpenSpotlight,
    handleSubmenuOpenChange,
    sidebarLayerHeader,
    sidebarOrgSelector,
    resolvedMenuItemClick,
    resolvedMenuItemContextMenu,
    resolvedRenderMenuItemWrapper,
  } = useWorkstationSidebarChrome({
    setWorkItemsOpen,
    handleSidebarLayerChange,
    projectsSidebarVisible,
    workItemsLabel,
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
    setProjectsSelectedMenuItemId,
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
    projectsLinearWorkItemMap,
    projectsWorkItemMap,
    tSessions,
    setWorkManagementProjectsView,
    openWorkManagementTab,
    openRuntimeTab,
    runtimeLabel,
    openTeamInboxTab,
    teamInboxLabel,
    activateChatPanelTab,
    handleMenuItemClick,
    handleProjectsMenuItemClick,
    handleOpenInNewTab,
  });

  const { isLoading, sidebarBottomRightActions, resolvedSelectedMenuItemId } =
    useWorkstationSidebarBottomActions({
      sidebarMenuItems,
      resolvedOnCollapsedSectionIdsChange,
      sessions,
      workItemsContentVisible,
      activeSidebarKey,
      projectsWorkItemsLoading,
      projectsSidebarMenuItems,
      sessionsLoading,
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
        onSubmenuOpenChange={handleSubmenuOpenChange}
        onMenuItemContextMenu={resolvedMenuItemContextMenu}
        renderMenuItemWrapper={resolvedRenderMenuItemWrapper}
        preListContent={
          <>
            <div className="shrink-0 px-3 pt-1">{sidebarOrgSelector}</div>
            {sidebarLayerHeader}
          </>
        }
        onAddNew={handleOpenSpotlight}
        addIcon={Search}
        addLabel={tCommon("actions.search")}
        addTooltipContent={
          <SidebarSearchShortcutTooltip
            searchLabel={tCommon("actions.search")}
          />
        }
        search={{
          value: sidebarSearchQueries[activeSidebarSearchKey],
          filterValue:
            activeSidebarSearchKey === "workstation"
              ? ""
              : sidebarSearchQueries[activeSidebarSearchKey],
          onChange: handleSidebarSearchChange,
          placeholder: searchPlaceholder,
          noResultsTitle: noSearchResultsTitle,
          showInput: false,
        }}
        listTopPadding={!workItemsContentVisible}
        bottomContent={
          <SidebarBottomBar
            leftContent={
              <SidebarMenuSearchInput
                value={sidebarSearchQueries[activeSidebarSearchKey]}
                onChange={handleSidebarSearchChange}
                placeholder={searchPlaceholder}
                compact
              />
            }
            rightActions={sidebarBottomRightActions}
            settingsAction={<SidebarSettingsMenuButton />}
          />
        }
        isLoading={isLoading}
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

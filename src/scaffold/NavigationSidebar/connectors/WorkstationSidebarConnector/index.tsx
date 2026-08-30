import { useAtomValue, useSetAtom } from "jotai";
import React, { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";

import { ROUTES } from "@src/config/routes";
import { normalizeSidebarGuideProgress } from "@src/config/settingsSchema/sidebarGuideProgress";
import { createLogger } from "@src/hooks/logger";
import { useAppNavigation } from "@src/hooks/navigation/useAppNavigation";
import { useSessionView } from "@src/hooks/ui/tabs/useSessionView";
import { Search01Icon } from "@src/icons";
import { teamInboxUnreadCountAtom } from "@src/modules/MainApp/TeamInbox/store";
import { useTeamInboxDataSource } from "@src/modules/MainApp/TeamInbox/useTeamInboxDataSource";
import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
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
import { settingsAtom } from "@src/store/settings/settingsAtom";
import {
  SETUP_GUIDE_PERSISTED_MILESTONE,
  completeSetupGuideMilestone,
  dismissSetupGuide,
  hasCompletedSetupGuideMilestone,
} from "@src/store/settings/setupGuideProgress";
import { saveSetupGuideProgressAtom } from "@src/store/settings/setupGuideProgressAtom";
import {
  CHAT_PANEL_CREATE_TARGET,
  CHAT_PANEL_SURFACE_KIND,
  CLOUD_ORG_MANAGEMENT_VIEW,
} from "@src/store/ui/chatPanelAtom";
import { showGuideHighlightAtom } from "@src/store/ui/guideHighlightAtom";
import { runtimeNavigationIntentAtom } from "@src/store/ui/runtimeNavigationAtom";
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
import {
  SIDEBAR_GUIDE_MILESTONE,
  type SidebarGuideCompletion,
} from "../sidebarGuideProgress";
import { DEFAULT_COLLAPSED_SECTION_IDS } from "../workstationSidebarData";
import { SidebarDialogs } from "./SidebarDialogs";
import { WorkItemsSidebarSkeleton } from "./WorkItemsSidebarSkeleton";
import {
  type WorkstationSidebarViewKey,
  WorkstationSidebarViewSwitcher,
} from "./WorkstationSidebarViewSwitcher";
import { useLocalChannelsSection } from "./localChannelsSection";
import { openNewChatFromSidebar } from "./sessionEntryActions";
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
import { resolveSidebarGuideInviteSpotlight } from "./sidebarGuideInviteNavigation";
import { resolveSidebarGuideOrganizationNavigation } from "./sidebarGuideOrganizationNavigation";
import { startSidebarGuideProductTour } from "./sidebarGuideProductTour";
import { resolveSidebarGuideTeamUsageNavigation } from "./sidebarGuideTeamUsageNavigation";
import { SidebarSearchShortcutTooltip } from "./sidebarTabs";
import type { WorkstationSidebarKey } from "./types";
import { useWorkspaceGroupActions } from "./useWorkspaceGroupActions";

const logger = createLogger("WorkstationSidebarGuide");

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
  const setupGuideProgress = normalizeSidebarGuideProgress(
    useAtomValue(settingsAtom)["general.setupWalkthroughProgress"]
  );
  const saveSetupGuideProgress = useSetAtom(saveSetupGuideProgressAtom);
  const showGuideHighlight = useSetAtom(showGuideHighlightAtom);
  const setRuntimeNavigationIntent = useSetAtom(runtimeNavigationIntentAtom);
  const guideNavigationRequestId = useRef(0);
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
  const [activeSessionMoreMenuId, setActiveSessionMoreMenuId] = useState("");
  const [projectsSelectedMenuItemId, setProjectsSelectedMenuItemId] =
    useState("");
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
  const guideCloudOrg = manageableCloudOrg;

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

  // Local-scope Channels (this-machine, single-user): the mirror of the
  // cloud channels section, mounted only while no cloud org is active.
  const {
    localChannelsMenuItems,
    handleLocalChannelsItemClick,
    selectedLocalChannelMenuItemId,
    localChannelsDialogs,
  } = useLocalChannelsSection({ enabled: activeCloudOrgId === null });

  // Local channel rows resolve first (their ids can never collide with
  // session/cloud ids) — the cloudMenuData composition idiom.
  const handleScopedSessionItemClick = useCallback(
    (item: NavigationMenuItem): boolean =>
      handleLocalChannelsItemClick(item) || handleCloudSessionItemClick(item),
    [handleLocalChannelsItemClick, handleCloudSessionItemClick]
  );

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
    sessionFilterOrgIds,
    cloudScopedExtraSessionIds,
    sessionListExcludedIds,
    includeExternal,
    groupVisibleCounts,
    activeCloudOrgId,
    expandedSubagentParentIds,
    revealedSessionIds,
    workspaceGroupActions,
    activeSidebarKey,
    workItemsContentVisible,
    projectsGroupVisibleCounts,
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
    handleCloudSessionItemClick: handleScopedSessionItemClick,
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
    buildCloudRemoteItemMenuItems,
    t,
    tCommon,
    activeSessionMoreMenuId,
    expandedSubagentParentIds,
    pinFolderLabel,
    unpinFolderLabel,
    setActiveSessionMoreMenuId,
    subagentParentIds,
    cloudSessionMenuItems,
    channelSidebarMenuItems:
      channelMenuItems.length > 0 ? channelMenuItems : localChannelsMenuItems,
    channelSidebarVisible,
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
      channelSidebarVisible,
      activeSidebarKey,
      projectsWorkItemsLoading,
      projectsSidebarMenuItems,
      sessionsLoading,
      openRuntimeTab,
      runtimeLabel,
      groupByMode,
      includeExternal,
      setGroupByMode,
      setIncludeExternal,
      // In the local scope `selectedCloudMenuItemId` is null, so the open
      // local-channel row lands in the same slot the cloud section uses.
      selectedCloudMenuItemId:
        selectedLocalChannelMenuItemId ?? selectedCloudMenuItemId,
      selectedMenuItemId,
      activeSessionId,
      collapsedSectionIds,
      pinnedMenuItems,
    });

  const handleGuideConnectOrganization = useCallback(() => {
    guideNavigationRequestId.current = Math.max(
      guideNavigationRequestId.current + 1,
      Date.now()
    );
    const navigation = resolveSidebarGuideOrganizationNavigation(
      guideNavigationRequestId.current
    );
    openCreateTargetInStartPage({
      target: CHAT_PANEL_CREATE_TARGET.COLLAB_ORG,
      title: t("routes.launchpad"),
      collabOrgCreateIntent: navigation.createIntent,
    });
    showGuideHighlight({
      targetId: navigation.spotlight.targetId,
      title: t("sidebar.guide.connectOrganization"),
      message: t(navigation.spotlight.messageKey),
    });
  }, [openCreateTargetInStartPage, showGuideHighlight, t]);

  const handleGuideInviteTeammate = useCallback(() => {
    if (!guideCloudOrg) {
      handleGuideConnectOrganization();
      return;
    }
    guideNavigationRequestId.current = Math.max(
      guideNavigationRequestId.current + 1,
      Date.now()
    );
    openOrganizationTab({
      organization: {
        kind: "cloud",
        cloudOrg: {
          orgId: guideCloudOrg.orgId,
          initialView: CLOUD_ORG_MANAGEMENT_VIEW.MEMBERS,
          initialViewRequestId: guideNavigationRequestId.current,
        },
      },
      title: t("collaboration.manageOrg"),
    });
    const spotlight = resolveSidebarGuideInviteSpotlight(guideCloudOrg.role);
    showGuideHighlight({
      targetId: spotlight.targetId,
      title: t("sidebar.guide.inviteTeammate"),
      message: t(spotlight.messageKey),
    });
  }, [
    handleGuideConnectOrganization,
    guideCloudOrg,
    openOrganizationTab,
    showGuideHighlight,
    t,
  ]);

  const handleGuideExploreProduct = useCallback(() => {
    startSidebarGuideProductTour();
    void saveSetupGuideProgress((progress) =>
      completeSetupGuideMilestone(
        progress,
        SETUP_GUIDE_PERSISTED_MILESTONE.PRODUCT_TOUR_STARTED
      )
    ).catch((error: unknown) => {
      logger.warn("failed to persist product tour guide milestone", error);
    });
  }, [saveSetupGuideProgress]);

  const handleGuideDismiss = useCallback(() => {
    void saveSetupGuideProgress(dismissSetupGuide).catch((error: unknown) => {
      logger.warn("failed to persist setup guide dismissal", error);
    });
  }, [saveSetupGuideProgress]);

  const handleGuideViewTeamUsage = useCallback(() => {
    guideNavigationRequestId.current = Math.max(
      guideNavigationRequestId.current + 1,
      Date.now()
    );
    const navigation = resolveSidebarGuideTeamUsageNavigation(
      guideNavigationRequestId.current,
      guideCloudOrg?.orgId
    );
    if (!navigation) {
      handleGuideConnectOrganization();
      return;
    }
    setRuntimeNavigationIntent(navigation.intent);
    openRuntimeTab(runtimeLabel);
    showGuideHighlight({
      targetId: navigation.spotlight.targetId,
      title: t("sidebar.guide.viewTeamActivity"),
      message: t(navigation.spotlight.messageKey),
    });
    void saveSetupGuideProgress((progress) =>
      completeSetupGuideMilestone(
        progress,
        SETUP_GUIDE_PERSISTED_MILESTONE.TEAM_ACTIVITY_VIEWED
      )
    ).catch((error: unknown) => {
      logger.warn("failed to persist team usage guide milestone", error);
    });
  }, [
    guideCloudOrg,
    handleGuideConnectOrganization,
    openRuntimeTab,
    runtimeLabel,
    saveSetupGuideProgress,
    setRuntimeNavigationIntent,
    showGuideHighlight,
    t,
  ]);

  const guideCompletion = useMemo<SidebarGuideCompletion>(
    () => ({
      [SIDEBAR_GUIDE_MILESTONE.SESSION]: sessions.length > 0,
      [SIDEBAR_GUIDE_MILESTONE.ORGANIZATION]: Boolean(guideCloudOrg),
      [SIDEBAR_GUIDE_MILESTONE.TEAMMATE]: hasCompletedSetupGuideMilestone(
        setupGuideProgress,
        SETUP_GUIDE_PERSISTED_MILESTONE.TEAMMATE_INVITED
      ),
      [SIDEBAR_GUIDE_MILESTONE.TEAM_USAGE]: hasCompletedSetupGuideMilestone(
        setupGuideProgress,
        SETUP_GUIDE_PERSISTED_MILESTONE.TEAM_ACTIVITY_VIEWED
      ),
      [SIDEBAR_GUIDE_MILESTONE.PRODUCT_TOUR]: hasCompletedSetupGuideMilestone(
        setupGuideProgress,
        SETUP_GUIDE_PERSISTED_MILESTONE.PRODUCT_TOUR_STARTED
      ),
    }),
    [guideCloudOrg, sessions.length, setupGuideProgress]
  );

  const guideScopeLabel = useMemo(() => {
    const activeOption = orgSelectorOptions.find(
      (option) => String(option.value) === String(activeOrgId)
    );
    return typeof activeOption?.label === "string"
      ? activeOption.label
      : t("sidebar.guide.localWorkspace");
  }, [activeOrgId, orgSelectorOptions, t]);

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
                  completion={guideCompletion}
                  dismissed={setupGuideProgress.dismissed}
                  scopeLabel={guideScopeLabel}
                  onDismiss={handleGuideDismiss}
                  onStartSession={handleGoToNewSession}
                  onConnectOrganization={handleGuideConnectOrganization}
                  onInviteTeammate={handleGuideInviteTeammate}
                  onViewTeamUsage={handleGuideViewTeamUsage}
                  onExploreProduct={handleGuideExploreProduct}
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

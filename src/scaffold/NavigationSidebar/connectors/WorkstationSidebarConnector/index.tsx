import { openUrl } from "@tauri-apps/plugin-opener";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { ChevronLeft, Search } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";

import { ROUTES } from "@src/config/routes";
import { useCloudSessionShareDialog } from "@src/features/Org2Cloud/CloudSessionShareDialog/useCloudSessionShareDialog";
import { useCloudSyncLevelDialog } from "@src/features/Org2Cloud/CloudSyncLevelDialog/useCloudSyncLevelDialog";
import { buildOrg2CloudLoginUrl } from "@src/features/Org2Cloud/config";
import { org2CloudAuthAtom } from "@src/features/Org2Cloud/org2CloudAuthAtom";
import { useMoveToOrgDialog } from "@src/features/TeamCollaboration/components/MoveToOrgDialog/useMoveToOrgDialog";
import { createLogger } from "@src/hooks/logger";
import { useAppNavigation } from "@src/hooks/navigation/useAppNavigation";
import { useSessionView } from "@src/hooks/ui/tabs/useSessionView";
import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import { benchmarkAgentBatchStatusAtom } from "@src/store/benchmark";
import {
  activateChatPanelTabAtom,
  activeChatPanelTabAtom,
  activeWorkManagementSectionAtom,
  closeAndDestroyChatPanelTabAtom,
  openCreateTargetInChatPanelStartPageAtom,
  openOrFocusChatPanelStartPageTabAtom,
  openOrReplaceSessionInChatPanelTabAtom,
  openOrganizationInChatPanelTabAtom,
  openRuntimeInChatPanelTabAtom,
  openSessionInNewChatTabAtom,
  openWorkManagementChatPanelTabAtom,
} from "@src/store/chatPanel/chatPanelTabsAtom";
import { repoMapAtom } from "@src/store/repo";
import {
  activeSessionCreatorDraftIdAtom,
  deleteSessionCreatorDraftAtom,
  loadMoreCategory,
  loadSidebarSessionById,
  loadSidebarSessions,
  markAllSessionsVisited,
  promoteActiveSessionCreatorDraftAtom,
  sessionCreatorDraftListAtom,
  sessionLoadingAtom,
  sessionPaginationAtom,
  sessionsAtom,
  visitedSessionsAtom,
  workstationActiveSessionIdAtom,
} from "@src/store/session";
import { openSessionInWorkstationAtom } from "@src/store/session/sessionTabPlacementAtom";
import {
  CHAT_PANEL_CREATE_TARGET,
  CHAT_PANEL_SURFACE_KIND,
  activeStationChatVisibleAtom,
  chatPanelContentModeAtom,
  chatPanelCreateTargetAtom,
  chatPanelNavigateAtom,
  chatPanelSelectedProjectAtom,
  chatPanelSelectedWorkItemAtom,
} from "@src/store/ui/chatPanelAtom";
import {
  clearSessionSidebarRevealAtom,
  sessionSidebarRevealRequestAtom,
  sidebarCollapsedAtom,
} from "@src/store/ui/sidebarAtom";
import { type StationMode, stationModeAtom } from "@src/store/ui/simulatorAtom";
import { spotlightOpenAtom } from "@src/store/ui/uiAtom";
import {
  PROJECT_ORG_SURFACE_VIEW,
  STORY_ORG_SCOPE,
  WORK_MANAGEMENT_PROJECTS_VIEW,
  WORK_MANAGEMENT_SECTION,
  type WorkManagementSection,
  workManagementProjectsViewAtom,
} from "@src/store/workstation";
import {
  getChatPanelTabIdFromTuiSessionId,
  isChatPanelTuiSessionId,
  toChatPanelTuiSessionId,
} from "@src/util/ui/terminal/chatPanelTuiSessionId";

import {
  SidebarBottomBar,
  SidebarHeaderNavButton,
  SidebarMenuSearchInput,
} from "../../blocks";
import SidebarSettingsMenuButton from "../../blocks/SidebarSettingsMenuButton";
import NavigationSidebar from "../../variants/NavigationSidebar";
import SidebarOrgSelector from "../SidebarOrgSelector";
import {
  COLLAB_ADD_ORG_MENU_ITEM_ID,
  KANBAN_MENU_ITEM_ID,
  NEW_SESSION_MENU_ITEM_ID,
  RUNTIME_MENU_ITEM_ID,
  WORK_ITEMS_GITHUB_ISSUES_MENU_ITEM_ID,
  WORK_ITEMS_GITHUB_PRS_MENU_ITEM_ID,
  WORK_ITEMS_MENU_ITEM_ID,
  WORK_ITEMS_PROJECTS_MENU_ITEM_ID,
  getDraftIdFromMenuItemId,
  isWorkManagementMenuItemId,
} from "../sidebarConnectorUtils";
import {
  sidebarGroupByAtom,
  sidebarIncludeExternalAtom,
} from "../sidebarGroupByAtom";
import { useProjectsWorkItemMenuItems } from "../useProjectsWorkItemMenuItems";
import { useRenameSessionModal } from "../useRenameSessionModal";
import { useSessionMenuItems } from "../useSessionMenuItems";
import { loadUnifiedReadyCategories } from "../useSessionMenuItems/paginationHelpers";
import { useWorkstationSidebarContextMenu } from "../useWorkstationSidebarContextMenu";
import { useWorkstationSidebarHandlers } from "../useWorkstationSidebarHandlers";
import {
  DEFAULT_COLLAPSED_SECTION_IDS,
  buildRepoPathToName,
  findSidebarSectionIdForMenuItem,
  getAllSectionIds,
  sortSessionsByActivity,
} from "../workstationSidebarData";
import { SidebarDialogs } from "./SidebarDialogs";
import { useSidebarBottomRightActions } from "./bottomActions";
import {
  CLOUD_MY_SESSIONS_LOAD_MORE_ID,
  CLOUD_MY_SESSIONS_SECTION_ID,
  CLOUD_SESSION_SECTION_PAGE_SIZE,
  CLOUD_TEAM_SESSIONS_SECTION_ID,
  buildCloudScopedMenuItems,
  isCloudScopedLocalRow,
} from "./cloudScopedMenuItems";
import { useCloudSessionsSection } from "./cloudSessionsSection";
import {
  useRenderProjectsMenuItemWrapper,
  useRenderSessionMenuItemWrapper,
  useRenderWorkstationMenuItemWrapper,
} from "./menuItemWrappers";
import { resolveSelectedMenuItemIds } from "./menuSelection";
import {
  getProjectsSectionVisibleCountKey,
  getSessionSectionVisibleCountKey,
  resetNewlyCollapsedSectionVisibleCounts,
  resetScopedSectionPagination,
} from "./sectionPagination";
import { useSessionEntryActions } from "./sessionEntryActions";
import { useDecorateSessionRowActions } from "./sessionRowActions";
import { useWorkstationSidebarMemory } from "./sidebarMemory";
import {
  getChatTerminalTabId,
  isChatTerminalSidebarItem,
  useChatPanelTuiSidebarSessions,
  usePinnedMenuItems,
  useSessionSidebarMenuItems,
} from "./sidebarMenuCollections";
import {
  rescanSidebarSessions,
  useSidebarSessionRefreshEffects,
} from "./sidebarSessionRefresh";
import { SidebarSearchShortcutTooltip } from "./sidebarTabs";
import type { WorkstationSidebarKey } from "./types";
import { useProjectsMenuItemClick } from "./useProjectsMenuItemClick";
import {
  buildCloudOrgSelectorValue,
  useSidebarOrgScope,
} from "./useSidebarOrgScope";
import {
  buildWorkItemsSidebarMenuItems,
  resolveWorkItemsSidebarMenuItemId,
} from "./workItemsSidebarMenuItems";

const logger = createLogger("WorkstationSidebar");

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
  const setSpotlightOpen = useSetAtom(spotlightOpenAtom);
  const chatPanelContentMode = useAtomValue(chatPanelContentModeAtom);
  const chatPanelCreateTarget = useAtomValue(chatPanelCreateTargetAtom);
  const chatPanelSelectedWorkItem = useAtomValue(chatPanelSelectedWorkItemAtom);
  const chatPanelSelectedProject = useAtomValue(chatPanelSelectedProjectAtom);
  const setChatPanelCreateTarget = useSetAtom(chatPanelCreateTargetAtom);
  const navigateChatPanel = useSetAtom(chatPanelNavigateAtom);
  const setStationChatVisible = useSetAtom(activeStationChatVisibleAtom);
  const setStationMode = useSetAtom(stationModeAtom);
  const activeWorkManagementSection = useAtomValue(
    activeWorkManagementSectionAtom
  );
  const [workManagementProjectsView, setWorkManagementProjectsView] = useAtom(
    workManagementProjectsViewAtom
  );
  const openWorkManagementTab = useSetAtom(openWorkManagementChatPanelTabAtom);
  const openOrganizationTab = useSetAtom(openOrganizationInChatPanelTabAtom);
  const openSessionInNewChatTab = useSetAtom(openSessionInNewChatTabAtom);
  const openSessionInWorkstation = useSetAtom(openSessionInWorkstationAtom);
  const openOrReplaceSessionInChatPanelTab = useSetAtom(
    openOrReplaceSessionInChatPanelTabAtom
  );
  const activateChatPanelTab = useSetAtom(activateChatPanelTabAtom);
  const openStartPageTab = useSetAtom(openOrFocusChatPanelStartPageTabAtom);
  const openCreateTargetInStartPage = useSetAtom(
    openCreateTargetInChatPanelStartPageAtom
  );
  const openRuntimeTab = useSetAtom(openRuntimeInChatPanelTabAtom);
  const closeAndDestroyChatPanelTab = useSetAtom(
    closeAndDestroyChatPanelTabAtom
  );
  const { openSession } = useSessionView();
  const activeSessionId = useAtomValue(workstationActiveSessionIdAtom) ?? "";
  const { goToNewSession, navigateTo } = useAppNavigation();
  const [activeSidebarKey, setActiveSidebarKey] =
    useState<WorkstationSidebarKey>("workstation");
  const localOrgManagementRequestIdRef = React.useRef(0);
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
        void loadSidebarSessions();
      }
    },
    [activeSidebarSearchKey]
  );

  useSidebarSessionRefreshEffects();

  const chatPanelTuiSessions = useChatPanelTuiSidebarSessions();
  const sortedSessions = useMemo(
    () => sortSessionsByActivity([...chatPanelTuiSessions, ...sessions]),
    [chatPanelTuiSessions, sessions]
  );
  const {
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
  } = useSidebarOrgScope({ sortedSessions });
  const repoMap = useAtomValue(repoMapAtom);
  const repoPathToName = useMemo(() => buildRepoPathToName(repoMap), [repoMap]);

  const [groupByMode, setGroupByMode] = useAtom(sidebarGroupByAtom);
  const [includeExternal, setIncludeExternal] = useAtom(
    sidebarIncludeExternalAtom
  );
  const cloudMyPaginationScopeKey = activeCloudOrgId
    ? [
        activeCloudOrgId,
        sidebarSearchQueries.workstation,
        groupByMode,
        includeExternal ? "external" : "native",
      ].join("\u001f")
    : "";
  const [cloudMyPagination, setCloudMyPagination] = useState({
    scopeKey: "",
    visibleCount: CLOUD_SESSION_SECTION_PAGE_SIZE,
  });
  const resetCloudMyPagination = useCallback(() => {
    setCloudMyPagination((current) =>
      resetScopedSectionPagination(current, CLOUD_SESSION_SECTION_PAGE_SIZE)
    );
  }, []);
  const cloudMySessionsVisibleCount =
    cloudMyPagination.scopeKey === cloudMyPaginationScopeKey
      ? cloudMyPagination.visibleCount
      : CLOUD_SESSION_SECTION_PAGE_SIZE;
  const cloudAuth = useAtomValue(org2CloudAuthAtom);
  const cloudSignedInIdentity = cloudAuth
    ? (cloudAuth.profile?.displayName ??
      cloudAuth.profile?.primaryEmail ??
      cloudAuth.userId)
    : null;
  const handleCloudSignIn = useCallback(() => {
    openUrl(buildOrg2CloudLoginUrl()).catch((error: unknown) => {
      logger.error("failed to open ORG2 Cloud login in system browser", error);
    });
  }, []);
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
  const activatedRevealRequestIdRef = React.useRef<number | null>(null);
  const activeSessionSidebarRevealRequest =
    sessionSidebarRevealRequest?.sessionId === activeSessionId
      ? sessionSidebarRevealRequest
      : null;
  useEffect(() => {
    if (!sessionSidebarRevealRequest) {
      activatedRevealRequestIdRef.current = null;
      return;
    }
    if (sessionSidebarRevealRequest.sessionId === activeSessionId) {
      activatedRevealRequestIdRef.current =
        sessionSidebarRevealRequest.requestId;
      return;
    }
    if (
      activatedRevealRequestIdRef.current ===
      sessionSidebarRevealRequest.requestId
    ) {
      clearSessionSidebarReveal(sessionSidebarRevealRequest.requestId);
      activatedRevealRequestIdRef.current = null;
    }
  }, [activeSessionId, clearSessionSidebarReveal, sessionSidebarRevealRequest]);
  const revealedSessionIds = useMemo(() => {
    const ids = new Set<string>();
    if (activeSessionSidebarRevealRequest?.sessionId) {
      ids.add(activeSessionSidebarRevealRequest.sessionId);
    }
    if (activeSessionSidebarRevealRequest?.parentSessionId) {
      ids.add(activeSessionSidebarRevealRequest.parentSessionId);
    }
    return ids;
  }, [activeSessionSidebarRevealRequest]);

  const untitledSession = t("sidebar.defaults.untitledSession");
  const newSessionLabel = t("labels.newSession");
  const pinFolderLabel = tCommon("sessions:chat.pinSession", "Pin");
  const unpinFolderLabel = tCommon("sessions:chat.unpinSession", "Unpin");
  const createProjectLabel = tProjects("projects.createProject");
  const createWorkItemLabel = tProjects("workItems.createWorkItem");
  const workItemsLabel = t("labels.workItems");
  const runtimeLabel = tSessions("chat.startPage.tabs.runtime");
  const importGithubIssuesLabel = tProjects("githubIssuesImport.menuLabel");
  const addOrgLabel = t("collaboration.addOrg");
  const manageOrgLabel = t("collaboration.manageOrg");
  const searchPlaceholder = tCommon("common.searchPlaceholder", "Search...");
  const noSearchResultsTitle = t("sidebar.empty.noSearchResults");
  const {
    cloudMenuItems,
    cloudFlatListExcludedSessionIds,
    selectedCloudMenuItemId,
    handleCloudSessionItemClick,
    resetCloudTeamPagination,
    handleCloudRemoteItemRemove,
    cloudMemberFilterDropdown,
    cloudRemoteRowMap,
    cloudRemoteViewerMap,
  } = useCloudSessionsSection({
    orgId: activeCloudOrgId,
    sessions,
    filter: cloudSessionFilter,
    activeSessionId,
    revealedMenuItemId:
      activeSessionSidebarRevealRequest?.cloudOrgId === activeCloudOrgId
        ? activeSessionSidebarRevealRequest.sidebarItemId
        : undefined,
    onFilterChange: handleCloudSessionFilterChange,
  });

  // Threaded position wins: mine-rows shown inside a fork thread leave the
  // flat local list, and imported teammate caches never count as "mine"
  // (sessionMap keeps every excluded row available for click routing).
  const sessionListExcludedIds = useMemo(() => {
    if (!personalHiddenCloudTaggedIds) return cloudFlatListExcludedSessionIds;
    if (cloudFlatListExcludedSessionIds.size === 0) {
      return personalHiddenCloudTaggedIds;
    }
    return new Set([
      ...cloudFlatListExcludedSessionIds,
      ...personalHiddenCloudTaggedIds,
    ]);
  }, [cloudFlatListExcludedSessionIds, personalHiddenCloudTaggedIds]);

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
    searchQuery: sidebarSearchQueries.workstation,
    selectedOrgIds: sessionFilterOrgIds,
    extraSessionIds: cloudTaggedSessionIds,
    excludedSessionIds: sessionListExcludedIds,
    includeExternal,
    groupVisibleCounts,
    showAllLoadedGroupSessions: Boolean(activeCloudOrgId),
    expandedSubagentParentIds,
    revealedSessionIds,
  });
  const {
    menuItems: projectsWorkItemMenuItems,
    projectMap: projectsProjectMap,
    workItemMap: projectsWorkItemMap,
    linearWorkItemMap: projectsLinearWorkItemMap,
    localOrgMap: projectsLocalOrgMap,
    linearOrgMap: projectsLinearOrgMap,
    loading: projectsWorkItemsLoading,
    linkedSessionIds: projectsLinkedSessionIds,
    getLoadMoreGroupId: getProjectsLoadMoreGroupId,
    loadLinearOrgWorkItems: loadProjectsLinearOrgWorkItems,
    toChatPanelProject,
    toChatPanelWorkItem,
    openLinearOrg: openProjectsLinearOrg,
    openLinearWorkItem: openProjectsLinearWorkItem,
  } = useProjectsWorkItemMenuItems({
    enabled: activeSidebarKey === "projects" || workItemsContentVisible,
    groupVisibleCounts: projectsGroupVisibleCounts,
    searchQuery: sidebarSearchQueries.projects,
    selectedOrgId: activeProjectOrgId,
  });

  const rename = useRenameSessionModal();
  const activeChatPanelTab = useAtomValue(activeChatPanelTabAtom);
  const benchmarkBatchStatus = useAtomValue(benchmarkAgentBatchStatusAtom);
  const activeChatPanelTuiSessionId =
    activeChatPanelTab?.type === "terminal"
      ? toChatPanelTuiSessionId(activeChatPanelTab.id)
      : "";
  const highlightedSessionId = activeChatPanelTuiSessionId
    ? activeChatPanelTuiSessionId
    : benchmarkBatchStatus?.items.some(
          (item) => item.sessionId === activeSessionId
        )
      ? benchmarkBatchStatus.masterSessionId
      : activeSessionId;

  const workItemsSidebarMenuItems = useMemo(
    () =>
      buildWorkItemsSidebarMenuItems({
        projects: t("labels.projects"),
        githubIssues: tSessions("kanban.sidebar.githubIssues"),
        githubPrs: tSessions("kanban.sidebar.githubPrs"),
      }),
    [t, tSessions]
  );

  const { pinnedMenuItems } = usePinnedMenuItems({
    activeSidebarKey: projectsSidebarVisible ? "projects" : activeSidebarKey,
    createProjectLabel,
    createWorkItemLabel,
    importGithubIssuesLabel,
    kanbanLabel: tSessions("simulator.tabs.kanban"),
    newSessionLabel,
    runtimeLabel,
    workItemDestinations: workItemsSidebarMenuItems,
    t,
  });
  const sessionSidebarMenuItems = useSessionSidebarMenuItems({
    menuItems,
    sessionCreatorDrafts,
    t,
  });
  const loadedCloudMySessionRowCount = useMemo(
    () => sessionSidebarMenuItems.filter(isCloudScopedLocalRow).length,
    [sessionSidebarMenuItems]
  );
  const revealCandidateMenuItems = useMemo(
    () => [...cloudMenuItems, ...sessionSidebarMenuItems],
    [cloudMenuItems, sessionSidebarMenuItems]
  );
  useEffect(() => {
    if (!sessionSidebarRevealRequest) return;

    setSidebarCollapsed(false);
    const parentSessionId =
      sessionSidebarRevealRequest.parentSessionId ??
      sessionSidebarRevealRequest.sessionId;
    const revealFrame = window.requestAnimationFrame(() => {
      setActiveSidebarKey("workstation");
      setWorkItemsOpen(false);
      if (sessionSidebarRevealRequest.cloudOrgId) {
        setSelectedOrgId(
          buildCloudOrgSelectorValue(sessionSidebarRevealRequest.cloudOrgId)
        );
      }
      setSidebarSearchQueries((currentQueries) =>
        currentQueries.workstation
          ? { ...currentQueries, workstation: "" }
          : currentQueries
      );
      if (sessionSidebarRevealRequest.parentSessionId) {
        setExpandedSubagentParentIds((previousIds) => {
          if (previousIds.has(parentSessionId)) return previousIds;
          const nextIds = new Set(previousIds);
          nextIds.add(parentSessionId);
          return nextIds;
        });
      }
    });

    const sessionIds = new Set([
      parentSessionId,
      sessionSidebarRevealRequest.sessionId,
    ]);
    for (const sessionId of sessionIds) {
      void loadSidebarSessionById(sessionId)
        .then((session) => {
          if (!session) {
            logger.warn(
              `Unable to hydrate sidebar row for session ${sessionId}`
            );
          }
        })
        .catch((error: unknown) => {
          logger.warn(
            `Failed to hydrate sidebar row for session ${sessionId}:`,
            error
          );
        });
    }

    return () => window.cancelAnimationFrame(revealFrame);
  }, [sessionSidebarRevealRequest, setSelectedOrgId, setSidebarCollapsed]);

  const revealedSectionId = useMemo(
    () =>
      activeSessionSidebarRevealRequest
        ? findSidebarSectionIdForMenuItem(
            revealCandidateMenuItems,
            activeSessionSidebarRevealRequest.sidebarItemId ??
              activeSessionSidebarRevealRequest.sessionId
          )
        : null,
    [activeSessionSidebarRevealRequest, revealCandidateMenuItems]
  );
  useEffect(() => {
    if (!revealedSectionId) return;
    const revealFrame = window.requestAnimationFrame(() => {
      setCollapsedSectionIds((previousIds) => {
        if (!previousIds.has(revealedSectionId)) return previousIds;
        const nextIds = new Set(previousIds);
        nextIds.delete(revealedSectionId);
        return nextIds;
      });
    });
    return () => window.cancelAnimationFrame(revealFrame);
  }, [revealedSectionId]);
  const resetWorkManagementStateForProjectsContent = useCallback(() => {
    const stationMode: StationMode = "my-station";
    setStationMode(stationMode);
    setStationChatVisible(stationMode, true);
    openStartPageTab({ title: t("routes.launchpad") });
  }, [openStartPageTab, setStationChatVisible, setStationMode, t]);

  const projectsSidebarMenuItems = projectsWorkItemMenuItems;
  const { selectedMenuItemId: baseSelectedMenuItemId } =
    resolveSelectedMenuItemIds({
      activeSessionCreatorDraftId,
      activeSessionId: highlightedSessionId,
      activeSidebarKey,
      activeChatPanelTabType: activeChatPanelTab?.type ?? null,
      chatPanelContentMode,
      chatPanelCreateTarget,
      chatPanelSelectedProject,
      chatPanelSelectedWorkItem,
      projectsSelectedMenuItemId,
      sessionCreatorDrafts,
    });
  const selectedMenuItemId =
    workItemsContentVisible && projectsSelectedMenuItemId
      ? projectsSelectedMenuItemId
      : activeSidebarKey === "workstation" &&
          activeChatPanelTab?.type === "work-management"
        ? resolveWorkItemsSidebarMenuItemId({
            homeTab: activeWorkManagementSection,
            projectsView: workManagementProjectsView,
          })
        : baseSelectedMenuItemId;
  const handleSessionCollapsedSectionIdsChange = useCallback(
    (nextCollapsedSectionIds: Set<string>) => {
      setGroupVisibleCounts((currentVisibleCounts) =>
        resetNewlyCollapsedSectionVisibleCounts({
          currentVisibleCounts,
          previousCollapsedSectionIds: collapsedSectionIds,
          nextCollapsedSectionIds,
          resolveVisibleCountKey: (sectionId) =>
            getSessionSectionVisibleCountKey(sectionId, groupByMode),
        })
      );

      if (
        !collapsedSectionIds.has(CLOUD_TEAM_SESSIONS_SECTION_ID) &&
        nextCollapsedSectionIds.has(CLOUD_TEAM_SESSIONS_SECTION_ID)
      ) {
        resetCloudTeamPagination();
      }
      if (
        !collapsedSectionIds.has(CLOUD_MY_SESSIONS_SECTION_ID) &&
        nextCollapsedSectionIds.has(CLOUD_MY_SESSIONS_SECTION_ID)
      ) {
        resetCloudMyPagination();
      }

      setCollapsedSectionIds(nextCollapsedSectionIds);
    },
    [
      collapsedSectionIds,
      groupByMode,
      resetCloudMyPagination,
      resetCloudTeamPagination,
    ]
  );
  const handleProjectsCollapsedSectionIdsChange = useCallback(
    (nextCollapsedSectionIds: Set<string>) => {
      setProjectsGroupVisibleCounts((currentVisibleCounts) =>
        resetNewlyCollapsedSectionVisibleCounts({
          currentVisibleCounts,
          previousCollapsedSectionIds: projectsCollapsedSectionIds,
          nextCollapsedSectionIds,
          resolveVisibleCountKey: getProjectsSectionVisibleCountKey,
        })
      );
      setProjectsCollapsedSectionIds(nextCollapsedSectionIds);
    },
    [projectsCollapsedSectionIds]
  );
  const resolvedCollapsedSectionIds =
    activeSidebarKey === "projects" || workItemsContentVisible
      ? projectsCollapsedSectionIds
      : collapsedSectionIds;
  const resolvedOnCollapsedSectionIdsChange =
    activeSidebarKey === "projects" || workItemsContentVisible
      ? handleProjectsCollapsedSectionIdsChange
      : handleSessionCollapsedSectionIdsChange;

  const activateMyStationRouteForProjectsContent = useCallback(() => {
    const targetRoute = ROUTES.workStation.code.path;
    resetWorkManagementStateForProjectsContent();
    if (location.pathname !== targetRoute) navigate(targetRoute);
  }, [location.pathname, navigate, resetWorkManagementStateForProjectsContent]);

  const activateMyStationRouteForProjectTabContent = useCallback(() => {
    const stationMode: StationMode = "my-station";
    const targetRoute = ROUTES.workStation.code.path;
    setStationMode(stationMode);
    setStationChatVisible(stationMode, true);
    if (location.pathname !== targetRoute) navigate(targetRoute);
  }, [location.pathname, navigate, setStationChatVisible, setStationMode]);

  const openNewChatTab = useCallback(() => {
    openStartPageTab({ title: t("routes.launchpad") });
  }, [openStartPageTab, t]);

  const { handleGoToNewSession } = useSessionEntryActions({
    goToNewSession,
    navigateChatPanel,
    openNewChatTab,
    setChatPanelCreateTarget,
  });

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
    sessionRouteLabel: t("routes.session"),
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

  const handleToggleSubagentExpansion = useCallback((sessionId: string) => {
    setExpandedSubagentParentIds((previousIds) => {
      const nextIds = new Set(previousIds);
      if (nextIds.has(sessionId)) {
        nextIds.delete(sessionId);
      } else {
        nextIds.add(sessionId);
      }
      return nextIds;
    });
  }, []);

  const moveToOrg = useMoveToOrgDialog();
  const cloudSyncLevel = useCloudSyncLevelDialog();
  const cloudShare = useCloudSessionShareDialog();
  const handleMenuItemContextMenu = useWorkstationSidebarContextMenu({
    sessionMap,
    rename,
    handleDeleteSession,
    handleDeleteDraft: deleteSessionCreatorDraft,
    handleExportMarkdown,
    handleOpenInNewTab,
    handleOpenInMyStation,
    handleTogglePin,
    isMoveEligible: moveToOrg.isMoveEligible,
    handleOpenMoveToOrg: moveToOrg.openMoveToOrg,
    moveToOrgLabel: t("cloud.moveToOrg.menuItem"),
    isCloudSyncLevelEligible: cloudSyncLevel.isSyncLevelEligible,
    handleOpenCloudSyncLevel: cloudSyncLevel.openSyncLevel,
    cloudSyncLevelLabel: t("cloud.syncLevel.menuItem"),
    isCloudShareEligible: cloudShare.isCloudShareEligible,
    handleOpenCloudShare: cloudShare.openCloudShare,
    cloudShareLabel: t("cloud.share.menuItem"),
    handleCloudRemoteItemRemove,
    tCommon,
  });

  const decorateSessionRowActions = useDecorateSessionRowActions({
    activeSessionMoreMenuId,
    deleteSessionCreatorDraft,
    handleMenuItemContextMenu,
    handleTogglePin,
    handleToggleSubagentExpansion,
    expandedSubagentParentIds,
    pinLabel: pinFolderLabel,
    sessionMap,
    setActiveSessionMoreMenuId,
    subagentParentIds,
    tCommon,
    unpinLabel: unpinFolderLabel,
  });
  const decoratedSessionSidebarMenuItems = useMemo(
    () =>
      buildCloudScopedMenuItems({
        cloudMenuItems,
        // Cloud rows already carry Replay/Fork actions, so only local rows
        // use the regular session action decoration.
        sessionMenuItems: decorateSessionRowActions(sessionSidebarMenuItems),
        mySessionsLabel: t("cloud.sidebar.mySessions"),
        mySessionsVisibleCount: cloudMySessionsVisibleCount,
        loadMoreLabel: tCommon("common:actions.loadMore", "Load more"),
      }),
    [
      cloudMenuItems,
      cloudMySessionsVisibleCount,
      decorateSessionRowActions,
      sessionSidebarMenuItems,
      t,
      tCommon,
    ]
  );
  const sidebarMenuItems =
    activeSidebarKey === "projects" || workItemsContentVisible
      ? projectsSidebarMenuItems
      : decoratedSessionSidebarMenuItems;
  const handleProjectsMenuItemClick = useProjectsMenuItemClick({
    activateMyStationRouteForProjectTabContent,
    activateMyStationRouteForProjectsContent,
    getProjectsLoadMoreGroupId,
    loadProjectsLinearOrgWorkItems,
    openProjectsLinearOrg,
    openProjectsLinearWorkItem: openProjectsLinearWorkItem,
    projectsLinearOrgMap,
    projectsLinearWorkItemMap,
    projectsLocalOrgMap,
    projectsProjectMap,
    projectsWorkItemMap,
    linkedSessionIds: projectsLinkedSessionIds,
    openLinkedSession: handleOpenLinkedWorkItemSession,
    resetWorkManagementStateForProjectsContent,
    setProjectsGroupVisibleCounts,
    setProjectsSelectedMenuItemId,
    toChatPanelProject,
    toChatPanelWorkItem,
  });
  const handleOpenSpotlight = useCallback(() => {
    setSpotlightOpen(true);
  }, [setSpotlightOpen]);
  const handleAddOrgFromSelector = useCallback(() => {
    resetWorkManagementStateForProjectsContent();
    setProjectsSelectedMenuItemId(COLLAB_ADD_ORG_MENU_ITEM_ID);
    openCreateTargetInStartPage({
      target: CHAT_PANEL_CREATE_TARGET.COLLAB_ORG,
      title: t("routes.launchpad"),
    });
  }, [
    openCreateTargetInStartPage,
    resetWorkManagementStateForProjectsContent,
    setProjectsSelectedMenuItemId,
    t,
  ]);
  // UX decision (scope vs. panel): picking an org in the selector ONLY
  // switches the sidebar scope — it never navigates the chat panel. The
  // dropdown's explicit management action remains available from any scope.
  const handleOrgSelectorChange = useCallback(
    (orgId: string) => {
      // Picking an org ONLY switches the sidebar scope. A cloud scope shows
      // the org's local sessions (stamped org id or explicit cloud tag) plus
      // the fork-threaded "Team sessions" section (useCloudSessionsSection).
      setSelectedOrgId(orgId);
    },
    [setSelectedOrgId]
  );
  const handleManageOrg = useCallback(() => {
    resetWorkManagementStateForProjectsContent();
    if (activeCloudOrgId && manageableCloudOrg) {
      openOrganizationTab({
        organization: {
          kind: "cloud",
          cloudOrg: { orgId: manageableCloudOrg.orgId },
        },
        title: t("collaboration.manageOrg"),
      });
      return;
    }
    if (manageableLocalOrg) {
      localOrgManagementRequestIdRef.current += 1;
      openOrganizationTab({
        organization: {
          kind: "local",
          projectOrg: {
            orgId: manageableLocalOrg.id,
            orgName: manageableLocalOrg.name,
            orgScope: STORY_ORG_SCOPE.PROJECT_ORG,
            orgSyncProvider: manageableLocalOrg.sync_provider,
            initialView: PROJECT_ORG_SURFACE_VIEW.SETTINGS,
            initialViewRequestId: localOrgManagementRequestIdRef.current,
          },
        },
        title: t("collaboration.manageOrg"),
      });
      return;
    }
    if (manageableCloudOrg) {
      openOrganizationTab({
        organization: {
          kind: "cloud",
          cloudOrg: { orgId: manageableCloudOrg.orgId },
        },
        title: t("collaboration.manageOrg"),
      });
      return;
    }
    handleAddOrgFromSelector();
  }, [
    activeCloudOrgId,
    handleAddOrgFromSelector,
    manageableCloudOrg,
    manageableLocalOrg,
    openOrganizationTab,
    resetWorkManagementStateForProjectsContent,
    t,
  ]);
  const renderSessionMenuItemWrapper =
    useRenderSessionMenuItemWrapper(sessionMap);
  const renderWorkstationMenuItemWrapper = useRenderWorkstationMenuItemWrapper({
    cloudRemoteRowMap,
    cloudRemoteViewerMap,
    renderSessionMenuItemWrapper,
  });
  const renderProjectsMenuItemWrapper = useRenderProjectsMenuItemWrapper({
    projectsLinearWorkItemMap,
    projectsWorkItemMap,
  });

  const handleWorkManagementMenuItemClick = useCallback(
    (_key: string, item: NavigationMenuItem) => {
      let section: WorkManagementSection = WORK_MANAGEMENT_SECTION.KANBAN;
      let title = tSessions("simulator.tabs.kanban");
      if (item.id === WORK_ITEMS_PROJECTS_MENU_ITEM_ID) {
        setWorkManagementProjectsView(WORK_MANAGEMENT_PROJECTS_VIEW.PROJECTS);
        section = WORK_MANAGEMENT_SECTION.PROJECTS;
        title = t("labels.projects");
      } else if (item.id === WORK_ITEMS_GITHUB_ISSUES_MENU_ITEM_ID) {
        section = WORK_MANAGEMENT_SECTION.GITHUB_ISSUES;
        title = tSessions("kanban.sidebar.githubIssues");
      } else if (item.id === WORK_ITEMS_GITHUB_PRS_MENU_ITEM_ID) {
        section = WORK_MANAGEMENT_SECTION.GITHUB_PRS;
        title = tSessions("kanban.sidebar.githubPrs");
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
      runtimeLabel,
      sessionMap,
      workItemsContentVisible,
    ]
  );

  const handleBackToSessionSidebar = useCallback(() => {
    setWorkItemsOpen(false);
    handleSidebarLayerChange("workstation");
  }, [handleSidebarLayerChange]);

  const handleSubmenuOpenChange = useCallback((key: string, open: boolean) => {
    // Opening the legacy submenu is the transition into the dedicated Work
    // Items layer. Once entered, that layer owns its lifecycle: unmounting
    // the parent submenu may report `open=false`, but only the visible Back
    // action should navigate the user out again.
    if (key === WORK_ITEMS_MENU_ITEM_ID && open) setWorkItemsOpen(true);
  }, []);

  const sidebarLayerHeader = !projectsSidebarVisible ? null : (
    <div className="shrink-0 px-3">
      <SidebarHeaderNavButton
        icon={ChevronLeft}
        label={workItemsLabel}
        onClick={handleBackToSessionSidebar}
      />
    </div>
  );

  const sidebarOrgSelector = (
    <SidebarOrgSelector
      value={activeOrgId}
      options={orgSelectorOptions}
      addOrgLabel={addOrgLabel}
      cloudSignedInIdentity={cloudSignedInIdentity}
      manageLabel={manageOrgLabel}
      onChange={handleOrgSelectorChange}
      onAddOrg={handleAddOrgFromSelector}
      onCloudSignIn={handleCloudSignIn}
      onManageOrg={handleManageOrg}
    />
  );

  const resolvedMenuItemClick =
    activeSidebarKey === "projects"
      ? handleProjectsMenuItemClick
      : handleSessionMenuItemClick;

  const resolvedMenuItemContextMenu =
    activeSidebarKey === "workstation" && !workItemsContentVisible
      ? handleMenuItemContextMenu
      : undefined;
  const resolvedRenderMenuItemWrapper =
    activeSidebarKey === "projects" || workItemsContentVisible
      ? renderProjectsMenuItemWrapper
      : renderWorkstationMenuItemWrapper;
  const allSectionIds = useMemo(
    () => getAllSectionIds(sidebarMenuItems),
    [sidebarMenuItems]
  );
  const handleCollapseAll = useCallback(() => {
    resolvedOnCollapsedSectionIdsChange(new Set(allSectionIds));
  }, [allSectionIds, resolvedOnCollapsedSectionIdsChange]);
  const handleMarkAllRead = useCallback(() => {
    markAllSessionsVisited(sessions.map((session) => session.session_id));
  }, [sessions]);
  const handleRefreshSessions = useCallback(() => {
    void rescanSidebarSessions().catch((error) => {
      logger.warn("Failed to rescan sidebar sessions:", error);
    });
  }, []);
  const isLoading =
    workItemsContentVisible || activeSidebarKey === "projects"
      ? projectsWorkItemsLoading && projectsSidebarMenuItems.length === 0
      : sessionsLoading && sessions.length === 0;
  const sidebarBottomRightActions = useSidebarBottomRightActions({
    activeSidebarKey: workItemsContentVisible ? "projects" : activeSidebarKey,
    groupByMode,
    includeExternal,
    handleCollapseAll,
    handleMarkAllRead,
    handleRefreshSessions,
    setGroupByMode,
    setIncludeExternal,
  });

  const resolvedSelectedMenuItemId =
    activeSidebarKey === "workstation" && selectedCloudMenuItemId
      ? selectedCloudMenuItemId
      : selectedMenuItemId;

  useWorkstationSidebarMemory({
    activeSessionId,
    activeSidebarKey,
    allSectionIds,
    collapsedSectionIds,
    groupByMode,
    pinnedMenuItems,
    selectedMenuItemId: resolvedSelectedMenuItemId,
    sidebarMenuItems,
    tabCount: 0,
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
        compactRows
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

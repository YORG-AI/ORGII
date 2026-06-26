import { RenameModal } from "@/src/scaffold/ModalSystem/variants";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { Search } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";

import { type ProjectOrg, projectApi } from "@src/api/http/project";
import type { WorkspaceRecord } from "@src/api/tauri/workspace";
import { ROUTES } from "@src/config/routes";
import { useCollaborationMetadataSync } from "@src/features/TeamCollaboration/useCollaborationMetadataSync";
import { useRepoSelection } from "@src/hooks/git/useRepoSelection";
import { useKeyVault } from "@src/hooks/keyVault";
import { createLogger } from "@src/hooks/logger";
import { useAppNavigation } from "@src/hooks/navigation/useAppNavigation";
import { useProjectDataChanged } from "@src/hooks/project";
import { useSessionView } from "@src/hooks/ui/tabs/useSessionView";
import { useAgentOrgs } from "@src/modules/MainApp/AgentOrgs/hooks/useAgentOrgs";
import { useLaunchpadAgentCatalog } from "@src/modules/shared/launchpad/hooks";
import { openWorkspaceSpotlight } from "@src/scaffold/GlobalSpotlight/openSpotlight";
import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import { benchmarkAgentBatchStatusAtom } from "@src/store/benchmark";
import { collabOrgsAtom } from "@src/store/collaboration/collabOrgsAtom";
import type { Repo } from "@src/store/repo";
import { repoMapAtom, reposAtom } from "@src/store/repo";
import {
  DEFAULT_SESSION_ORG_ID,
  activeSessionCreatorDraftIdAtom,
  deleteSessionCreatorDraftAtom,
  loadSidebarSessions,
  markAllSessionsVisited,
  promoteActiveSessionCreatorDraftAtom,
  sessionCreatorDraftListAtom,
  sessionLoadingAtom,
  sessionsAtom,
  visitedSessionsAtom,
  workstationActiveSessionIdAtom,
} from "@src/store/session";
import {
  CHAT_PANEL_SURFACE_KIND,
  activeStationChatVisibleAtom,
  chatPanelContentModeAtom,
  chatPanelCreateTargetAtom,
  chatPanelExploreOpenAtom,
  chatPanelNavigateAtom,
  chatPanelSelectedProjectAtom,
  chatPanelSelectedWorkItemAtom,
  chatPanelSelectedWorkspaceAtom,
  chatPanelWorkspaceDashboardOpenAtom,
} from "@src/store/ui/chatPanelAtom";
import { type StationMode, stationModeAtom } from "@src/store/ui/simulatorAtom";
import { spotlightOpenAtom } from "@src/store/ui/uiAtom";
import {
  activeWorkspaceIdAtom,
  activeWorkspaceNameAtom,
  savedWorkspacesAtom,
  setWorkspaceFoldersAtom,
} from "@src/store/workspace";
import {
  opsControlFocusedTabAtom,
  opsControlPeekHostAtom,
} from "@src/store/workstation";

import { SidebarBottomBar } from "../../blocks";
import NavigationSidebar from "../../variants/NavigationSidebar";
import SidebarOrgSelector from "../SidebarOrgSelector";
import { COLLAB_ADD_ORG_MENU_ITEM_ID } from "../sidebarConnectorUtils";
import {
  sidebarGroupByAtom,
  sidebarIncludeExternalAtom,
} from "../sidebarGroupByAtom";
import { useProjectsWorkItemMenuItems } from "../useProjectsWorkItemMenuItems";
import { useRenameSessionModal } from "../useRenameSessionModal";
import { useSessionMenuItems } from "../useSessionMenuItems";
import { useWorkstationSidebarContextMenu } from "../useWorkstationSidebarContextMenu";
import { useWorkstationSidebarHandlers } from "../useWorkstationSidebarHandlers";
import {
  DEFAULT_COLLAPSED_SECTION_IDS,
  buildRepoPathToName,
  getAllSectionIds,
  sortSessionsByActivity,
} from "../workstationSidebarData";
import { useSidebarBottomRightActions } from "./bottomActions";
import {
  FOLDERS_MY_AGENTS_COLLAPSE_SECTION_ID,
  FOLDERS_MY_AGENT_ORGS_COLLAPSE_SECTION_ID,
  FOLDERS_REPO_ITEM_PREFIX,
  FOLDERS_WORKSPACE_ITEM_PREFIX,
  buildWorkspaceRepoNameResolver,
} from "./foldersSidebarMenuItems";
import {
  useRenderProjectsMenuItemWrapper,
  useRenderSessionMenuItemWrapper,
} from "./menuItemWrappers";
import { resolveSelectedMenuItemIds } from "./menuSelection";
import { useSessionEntryActions } from "./sessionEntryActions";
import { useDecorateSessionRowActions } from "./sessionRowActions";
import { useWorkstationSidebarMemory } from "./sidebarMemory";
import {
  useFoldersSidebarMenuItems,
  usePinnedMenuItems,
  useSessionSidebarMenuItems,
} from "./sidebarMenuCollections";
import { useSidebarSessionRefreshEffects } from "./sidebarSessionRefresh";
import {
  HomeHeaderAction,
  SidebarSearchShortcutTooltip,
  isWorkstationSidebarKey,
  useWorkstationSidebarTabs,
} from "./sidebarTabs";
import type { WorkstationSidebarKey } from "./types";
import {
  openRepoTarget,
  openWorkspaceTarget,
  useFoldersMenuItemClick,
} from "./useFoldersMenuItemClick";
import { useFoldersSidebarContextMenu } from "./useFoldersSidebarContextMenu";
import { useProjectsMenuItemClick } from "./useProjectsMenuItemClick";

const logger = createLogger("WorkstationSidebar");

export const WorkstationSidebarConnector: React.FC = () => {
  const { t } = useTranslation("navigation");
  const { t: tProjects } = useTranslation("projects");
  const { t: tCommonRaw } = useTranslation();
  const tCommon = useCallback(
    (key: string, defaultValue?: string) => tCommonRaw(key, { defaultValue }),
    [tCommonRaw]
  );
  const location = useLocation();
  const navigate = useNavigate();
  const sessions = useAtomValue(sessionsAtom);
  const sessionsLoading = useAtomValue(sessionLoadingAtom);
  const collabOrgs = useAtomValue(collabOrgsAtom);
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
  const chatPanelSelectedWorkspace = useAtomValue(
    chatPanelSelectedWorkspaceAtom
  );
  const chatPanelWorkspaceDashboardOpen = useAtomValue(
    chatPanelWorkspaceDashboardOpenAtom
  );
  const chatPanelExploreOpen = useAtomValue(chatPanelExploreOpenAtom);
  const setChatPanelCreateTarget = useSetAtom(chatPanelCreateTargetAtom);
  const navigateChatPanel = useSetAtom(chatPanelNavigateAtom);
  const setStationChatVisible = useSetAtom(activeStationChatVisibleAtom);
  const setStationMode = useSetAtom(stationModeAtom);
  const setOpsControlPeekHost = useSetAtom(opsControlPeekHostAtom);
  const setOpsControlFocusedTab = useSetAtom(opsControlFocusedTabAtom);
  const { openSession } = useSessionView();
  const { goToStartPage, goToNewSession, navigateTo } = useAppNavigation();
  const [activeSidebarKey, setActiveSidebarKey] =
    useState<WorkstationSidebarKey>("workstation");
  const [activeSessionMoreMenuId, setActiveSessionMoreMenuId] = useState("");
  const [activeFolderMoreMenuId, setActiveFolderMoreMenuId] = useState("");
  const [projectsSelectedMenuItemId, setProjectsSelectedMenuItemId] =
    useState("");
  const [selectedOrgId, setSelectedOrgId] = useState(DEFAULT_SESSION_ORG_ID);
  const [projectOrgs, setProjectOrgs] = useState<ProjectOrg[]>([]);
  const [sidebarSearchQueries, setSidebarSearchQueries] = useState<
    Record<WorkstationSidebarKey, string>
  >({ folders: "", workstation: "", projects: "" });
  const [, setFoldersDashboardSelected] = useState(false);
  const [, setFoldersExploreSelected] = useState(false);
  const tabs = useWorkstationSidebarTabs(t);

  const handleTabChange = useCallback((key: string) => {
    if (!isWorkstationSidebarKey(key)) return;
    if (key !== "folders") {
      setFoldersDashboardSelected(false);
      setFoldersExploreSelected(false);
    }
    setActiveSidebarKey(key);
  }, []);

  const fetchProjectOrgs = useCallback(async (): Promise<ProjectOrg[]> => {
    try {
      return await projectApi.readOrgs();
    } catch (error) {
      logger.error("Failed to load sidebar org selector options:", error);
      return [];
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchProjectOrgs().then((orgs) => {
      if (!cancelled) {
        setProjectOrgs(orgs);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [fetchProjectOrgs]);

  useProjectDataChanged(
    useCallback(() => {
      void fetchProjectOrgs().then(setProjectOrgs);
    }, [fetchProjectOrgs])
  );

  const handleSidebarSearchChange = useCallback(
    (value: string) => {
      setSidebarSearchQueries((currentQueries) => ({
        ...currentQueries,
        [activeSidebarKey]: value,
      }));
      if (activeSidebarKey === "workstation") {
        void loadSidebarSessions();
      }
    },
    [activeSidebarKey]
  );

  useSidebarSessionRefreshEffects();

  const sortedSessions = useMemo(
    () => sortSessionsByActivity(sessions),
    [sessions]
  );
  const repoMap = useAtomValue(repoMapAtom);
  const repos = useAtomValue(reposAtom);
  const [savedWorkspaces, setSavedWorkspaces] = useAtom(savedWorkspacesAtom);
  const activeWorkspaceId = useAtomValue(activeWorkspaceIdAtom);
  const dispatchSetWorkspaceFolders = useSetAtom(setWorkspaceFoldersAtom);
  const setActiveWorkspaceName = useSetAtom(activeWorkspaceNameAtom);
  const { localAccounts } = useKeyVault({ autoLoad: true });
  const { installedCliAgents, builtInRustAgents, customRustAgents } =
    useLaunchpadAgentCatalog();
  const { orgs: agentOrgs } = useAgentOrgs();
  const { selectRepo, forceRefreshRepos } = useRepoSelection({
    autoLoad: false,
  });
  const repoPathToName = useMemo(() => buildRepoPathToName(repoMap), [repoMap]);
  const resolveWorkspaceRepoName = useMemo(
    () => buildWorkspaceRepoNameResolver(repos),
    [repos]
  );

  const [groupByMode, setGroupByMode] = useAtom(sidebarGroupByAtom);
  const [includeExternal, setIncludeExternal] = useAtom(
    sidebarIncludeExternalAtom
  );
  const [groupVisibleCounts, setGroupVisibleCounts] = useState<
    Map<string, number>
  >(new Map());
  const [projectsGroupVisibleCounts, setProjectsGroupVisibleCounts] = useState<
    Map<string, number>
  >(new Map());
  const [collapsedSectionIds, setCollapsedSectionIds] = useState<Set<string>>(
    () => new Set(DEFAULT_COLLAPSED_SECTION_IDS)
  );
  const [foldersCollapsedSectionIds, setFoldersCollapsedSectionIds] = useState<
    Set<string>
  >(
    () =>
      new Set([
        FOLDERS_MY_AGENTS_COLLAPSE_SECTION_ID,
        FOLDERS_MY_AGENT_ORGS_COLLAPSE_SECTION_ID,
      ])
  );
  const [projectsCollapsedSectionIds, setProjectsCollapsedSectionIds] =
    useState<Set<string>>(() => new Set());

  const untitledSession = t("sidebar.defaults.untitledSession");
  const newSessionLabel = t("labels.newSession");
  const pinFolderLabel = tCommon("sessions:chat.pinSession", "Pin");
  const unpinFolderLabel = tCommon("sessions:chat.unpinSession", "Unpin");
  const createProjectLabel = tProjects("projects.createProject");
  const createWorkItemLabel = tProjects("workItems.createWorkItem");
  const addOrgLabel = t("collaboration.addOrg");
  const homeLabel = t("sidebar.tabs.build");
  const searchPlaceholder =
    activeSidebarKey === "projects"
      ? t("sidebar.search.projects")
      : activeSidebarKey === "folders"
        ? t("sidebar.search.folders")
        : t("sidebar.search.sessions");
  const noSearchResultsTitle = t("sidebar.empty.noSearchResults");
  const orgSelectorOptions = useMemo(() => {
    const options = [
      {
        value: DEFAULT_SESSION_ORG_ID,
        label: tProjects("orgs.personalOrg"),
      },
    ];
    const seenOrgIds = new Set([DEFAULT_SESSION_ORG_ID]);
    for (const org of projectOrgs) {
      if (seenOrgIds.has(org.id)) continue;
      seenOrgIds.add(org.id);
      options.push({ value: org.id, label: org.name });
    }
    for (const org of collabOrgs) {
      if (seenOrgIds.has(org.id)) continue;
      seenOrgIds.add(org.id);
      options.push({ value: org.id, label: org.name });
    }
    return options;
  }, [collabOrgs, projectOrgs, tProjects]);

  const activeOrgId = useMemo(
    () =>
      orgSelectorOptions.some((option) => option.value === selectedOrgId)
        ? selectedOrgId
        : DEFAULT_SESSION_ORG_ID,
    [orgSelectorOptions, selectedOrgId]
  );

  const { menuItems, sessionMap, isLoadMoreId, getLoadMoreGroupId } =
    useSessionMenuItems({
      sortedSessions,
      visitedSessions,
      repoPathToName,
      groupByMode,
      untitledSession,
      searchQuery: sidebarSearchQueries.workstation,
      selectedOrgId: activeOrgId,
      includeExternal,
      groupVisibleCounts,
    });
  const {
    menuItems: projectsWorkItemMenuItems,
    projectMap: projectsProjectMap,
    workItemMap: projectsWorkItemMap,
    linearWorkItemMap: projectsLinearWorkItemMap,
    localOrgMap: projectsLocalOrgMap,
    cloudOrgMap: projectsCloudOrgMap,
    linearOrgMap: projectsLinearOrgMap,
    loading: projectsWorkItemsLoading,
    getLoadMoreGroupId: getProjectsLoadMoreGroupId,
    loadLinearOrgWorkItems: loadProjectsLinearOrgWorkItems,
    toChatPanelProject,
    toChatPanelWorkItem,
    openLinearOrg: openProjectsLinearOrg,
    openLinearWorkItem: openProjectsLinearWorkItem,
  } = useProjectsWorkItemMenuItems({
    enabled: activeSidebarKey === "projects",
    groupVisibleCounts: projectsGroupVisibleCounts,
    searchQuery: sidebarSearchQueries.projects,
    selectedOrgId: activeOrgId,
  });

  useCollaborationMetadataSync();

  const rename = useRenameSessionModal();
  const activeSessionId = useAtomValue(workstationActiveSessionIdAtom) ?? "";
  const benchmarkBatchStatus = useAtomValue(benchmarkAgentBatchStatusAtom);
  const highlightedSessionId = benchmarkBatchStatus?.items.some(
    (item) => item.sessionId === activeSessionId
  )
    ? benchmarkBatchStatus.masterSessionId
    : activeSessionId;

  const { pinnedMenuItems } = usePinnedMenuItems({
    activeSidebarKey,
    createProjectLabel,
    createWorkItemLabel,
    newSessionLabel,
    t,
  });
  const sessionSidebarMenuItems = useSessionSidebarMenuItems({
    menuItems,
    sessionCreatorDrafts,
    t,
  });
  const clearActiveWorkspace = useCallback(() => {
    dispatchSetWorkspaceFolders([], null);
    setActiveWorkspaceName(null);
  }, [dispatchSetWorkspaceFolders, setActiveWorkspaceName]);

  const resetOpsControlStateForProjectsContent = useCallback(() => {
    const stationMode: StationMode = "my-station";
    setStationMode(stationMode);
    setStationChatVisible(stationMode, true);
    setOpsControlPeekHost(null);
    setOpsControlFocusedTab(null);
  }, [
    setOpsControlFocusedTab,
    setOpsControlPeekHost,
    setStationChatVisible,
    setStationMode,
  ]);

  const handleAddWorkspaceFolder = useCallback(() => {
    openWorkspaceSpotlight("add");
  }, []);
  const handleCreateMultiRepoWorkspace = useCallback(() => {
    openWorkspaceSpotlight("create");
  }, []);

  const handleOpenWorkspace = useCallback(
    (workspace: WorkspaceRecord) => {
      openWorkspaceTarget({
        dispatchSetWorkspaceFolders,
        resetOpsControlStateForProjectsContent,
        resolveWorkspaceRepoName,
        setActiveWorkspaceName,
        workspace,
      });
      navigate(ROUTES.workStation.code.path);
    },
    [
      dispatchSetWorkspaceFolders,
      navigate,
      resetOpsControlStateForProjectsContent,
      resolveWorkspaceRepoName,
      setActiveWorkspaceName,
    ]
  );

  const handleOpenRepo = useCallback(
    (repo: Repo) => {
      openRepoTarget({
        dispatchSetWorkspaceFolders,
        resetOpsControlStateForProjectsContent,
        selectRepo,
        setActiveWorkspaceName,
        repoId: repo.id,
      });
      navigate(ROUTES.workStation.code.path);
    },
    [
      dispatchSetWorkspaceFolders,
      navigate,
      resetOpsControlStateForProjectsContent,
      selectRepo,
      setActiveWorkspaceName,
    ]
  );

  const { openWorkspaceMenu, openRepoMenu } = useFoldersSidebarContextMenu({
    activeWorkspaceId,
    clearActiveWorkspace,
    forceRefreshRepos,
    onOpenWorkspace: handleOpenWorkspace,
    onOpenRepo: handleOpenRepo,
    setSavedWorkspaces,
    tCommon,
  });

  const handleMoreActionsForWorkspace = useCallback(
    (
      _event: React.MouseEvent<HTMLButtonElement>,
      workspace: WorkspaceRecord
    ) => {
      const itemId = `${FOLDERS_WORKSPACE_ITEM_PREFIX}${workspace.workspaceId}`;
      setActiveFolderMoreMenuId(itemId);
      void openWorkspaceMenu(workspace).finally(() => {
        setActiveFolderMoreMenuId((current) =>
          current === itemId ? "" : current
        );
      });
    },
    [openWorkspaceMenu]
  );
  const handleMoreActionsForRepo = useCallback(
    (_event: React.MouseEvent<HTMLButtonElement>, repo: Repo) => {
      const itemId = `${FOLDERS_REPO_ITEM_PREFIX}${repo.id}`;
      setActiveFolderMoreMenuId(itemId);
      void openRepoMenu(repo).finally(() => {
        setActiveFolderMoreMenuId((current) =>
          current === itemId ? "" : current
        );
      });
    },
    [openRepoMenu]
  );

  const foldersSidebarMenuItems = useFoldersSidebarMenuItems({
    savedWorkspaces,
    repos,
    localAccounts,
    installedCliAgents,
    builtInRustAgents,
    customRustAgents,
    agentOrgs,
    t,
    tCommon,
    onAddWorkspaceFolder: handleAddWorkspaceFolder,
    onCreateMultiRepoWorkspace: handleCreateMultiRepoWorkspace,
    onOpenWorkspace: handleOpenWorkspace,
    onOpenRepo: handleOpenRepo,
    onMoreActionsForWorkspace: handleMoreActionsForWorkspace,
    onMoreActionsForRepo: handleMoreActionsForRepo,
    activeMoreMenuId: activeFolderMoreMenuId,
  });
  const projectsSidebarMenuItems = projectsWorkItemMenuItems;

  const { selectedMenuItemId, sessionSelectedMenuItemId } =
    resolveSelectedMenuItemIds({
      activeSessionCreatorDraftId,
      activeSessionId: highlightedSessionId,
      activeSidebarKey,
      chatPanelContentMode,
      chatPanelCreateTarget,
      chatPanelSelectedProject,
      chatPanelSelectedWorkItem,
      chatPanelSelectedWorkspace,
      chatPanelWorkspaceDashboardOpen,
      chatPanelExploreOpen,
      opsControlRoutePath: ROUTES.workStation.opsControl.path,
      pathname: location.pathname,
      projectsSelectedMenuItemId,
      sessionCreatorDrafts,
    });
  const resolvedCollapsedSectionIds =
    activeSidebarKey === "projects"
      ? projectsCollapsedSectionIds
      : activeSidebarKey === "folders"
        ? foldersCollapsedSectionIds
        : collapsedSectionIds;
  const resolvedSetCollapsedSectionIds =
    activeSidebarKey === "projects"
      ? setProjectsCollapsedSectionIds
      : activeSidebarKey === "folders"
        ? setFoldersCollapsedSectionIds
        : setCollapsedSectionIds;

  const activateMyStationRouteForProjectsContent = useCallback(() => {
    const targetRoute = ROUTES.workStation.code.path;
    resetOpsControlStateForProjectsContent();
    if (location.pathname !== targetRoute) navigate(targetRoute);
  }, [location.pathname, navigate, resetOpsControlStateForProjectsContent]);

  const activateMyStationRouteForProjectTabContent = useCallback(() => {
    const stationMode: StationMode = "my-station";
    const targetRoute = ROUTES.workStation.code.path;
    setStationMode(stationMode);
    setStationChatVisible(stationMode, true);
    setOpsControlPeekHost(null);
    setOpsControlFocusedTab(null);
    if (location.pathname !== targetRoute) navigate(targetRoute);
  }, [
    location.pathname,
    navigate,
    setOpsControlFocusedTab,
    setOpsControlPeekHost,
    setStationChatVisible,
    setStationMode,
  ]);

  const { handleGoToNewSession } = useSessionEntryActions({
    goToNewSession,
    navigateChatPanel,
    setChatPanelCreateTarget,
  });

  const {
    handleDeleteSession,
    handleExportMarkdown,
    handleMenuItemClick,
    handleTogglePin,
  } = useWorkstationSidebarHandlers({
    activeSessionId,
    selectedMenuItemId: sessionSelectedMenuItemId,
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
  });
  const handleMenuItemContextMenu = useWorkstationSidebarContextMenu({
    sessionMap,
    rename,
    handleDeleteSession,
    handleDeleteDraft: deleteSessionCreatorDraft,
    handleExportMarkdown,
    handleTogglePin,
    tCommon,
  });

  const decorateSessionRowActions = useDecorateSessionRowActions({
    activeSessionMoreMenuId,
    deleteSessionCreatorDraft,
    handleMenuItemContextMenu,
    handleTogglePin,
    pinLabel: pinFolderLabel,
    sessionMap,
    setActiveSessionMoreMenuId,
    tCommon,
    unpinLabel: unpinFolderLabel,
  });
  const decoratedSessionSidebarMenuItems = useMemo(
    () => decorateSessionRowActions(sessionSidebarMenuItems),
    [decorateSessionRowActions, sessionSidebarMenuItems]
  );
  const sidebarMenuItems =
    activeSidebarKey === "projects"
      ? projectsSidebarMenuItems
      : activeSidebarKey === "folders"
        ? foldersSidebarMenuItems
        : decoratedSessionSidebarMenuItems;

  const handleFoldersMenuItemClick = useFoldersMenuItemClick({
    navigate,
    repos,
    resetOpsControlStateForProjectsContent,
    savedWorkspaces,
    navigateChatPanel,
    setFoldersDashboardSelected,
    setFoldersExploreSelected,
    setProjectsSelectedMenuItemId,
  });
  const handleProjectsMenuItemClick = useProjectsMenuItemClick({
    activateMyStationRouteForProjectTabContent,
    activateMyStationRouteForProjectsContent,
    getProjectsLoadMoreGroupId,
    loadProjectsLinearOrgWorkItems,
    navigateChatPanel,
    openProjectsLinearOrg,
    openProjectsLinearWorkItem: openProjectsLinearWorkItem,
    projectsCloudOrgMap,
    projectsLinearOrgMap,
    projectsLinearWorkItemMap,
    projectsLocalOrgMap,
    projectsProjectMap,
    projectsWorkItemMap,
    resetOpsControlStateForProjectsContent,
    setProjectsGroupVisibleCounts,
    setProjectsSelectedMenuItemId,
    toChatPanelProject,
    toChatPanelWorkItem,
  });
  const handleOpenSpotlight = useCallback(() => {
    setSpotlightOpen(true);
  }, [setSpotlightOpen]);
  const handleAddOrgFromSelector = useCallback(() => {
    resetOpsControlStateForProjectsContent();
    setProjectsSelectedMenuItemId(COLLAB_ADD_ORG_MENU_ITEM_ID);
    navigateChatPanel({ kind: CHAT_PANEL_SURFACE_KIND.NEW_COLLAB_ORG });
  }, [navigateChatPanel, resetOpsControlStateForProjectsContent]);
  const renderSessionMenuItemWrapper =
    useRenderSessionMenuItemWrapper(sessionMap);
  const renderProjectsMenuItemWrapper = useRenderProjectsMenuItemWrapper({
    projectsLinearWorkItemMap,
    projectsWorkItemMap,
  });

  const resolvedMenuItemClick =
    activeSidebarKey === "projects"
      ? handleProjectsMenuItemClick
      : activeSidebarKey === "folders"
        ? handleFoldersMenuItemClick
        : handleMenuItemClick;

  const handleFoldersMenuItemContextMenu = useCallback(
    (event: React.MouseEvent, _key: string, item: NavigationMenuItem) => {
      if (item.id.startsWith(FOLDERS_WORKSPACE_ITEM_PREFIX)) {
        const workspaceId = item.id.slice(FOLDERS_WORKSPACE_ITEM_PREFIX.length);
        const workspace = savedWorkspaces.find(
          (candidate) => candidate.workspaceId === workspaceId
        );
        if (!workspace) return;
        event.preventDefault();
        event.stopPropagation();
        void openWorkspaceMenu(workspace);
        return;
      }
      if (item.id.startsWith(FOLDERS_REPO_ITEM_PREFIX)) {
        const repoId = item.id.slice(FOLDERS_REPO_ITEM_PREFIX.length);
        const repo = repos.find((candidate) => candidate.id === repoId);
        if (!repo) return;
        event.preventDefault();
        event.stopPropagation();
        void openRepoMenu(repo);
      }
    },
    [openRepoMenu, openWorkspaceMenu, repos, savedWorkspaces]
  );

  const resolvedMenuItemContextMenu =
    activeSidebarKey === "workstation"
      ? handleMenuItemContextMenu
      : activeSidebarKey === "folders"
        ? handleFoldersMenuItemContextMenu
        : undefined;
  const resolvedRenderMenuItemWrapper =
    activeSidebarKey === "projects"
      ? renderProjectsMenuItemWrapper
      : activeSidebarKey === "folders"
        ? undefined
        : renderSessionMenuItemWrapper;
  const allSectionIds = useMemo(
    () => getAllSectionIds(sidebarMenuItems),
    [sidebarMenuItems]
  );
  const handleCollapseAll = useCallback(() => {
    setCollapsedSectionIds(new Set(allSectionIds));
  }, [allSectionIds]);
  const handleMarkAllRead = useCallback(() => {
    markAllSessionsVisited(sessions.map((session) => session.session_id));
  }, [sessions]);
  const handleRefreshSessions = useCallback(() => {
    void loadSidebarSessions({ forceRefresh: true });
  }, []);
  const handleCollapseAllActiveSections = useCallback(() => {
    resolvedSetCollapsedSectionIds(new Set(allSectionIds));
  }, [allSectionIds, resolvedSetCollapsedSectionIds]);
  const isLoading =
    activeSidebarKey === "workstation"
      ? sessionsLoading && sessions.length === 0
      : activeSidebarKey === "projects"
        ? projectsWorkItemsLoading && projectsSidebarMenuItems.length === 0
        : false;
  const sidebarBottomRightActions = useSidebarBottomRightActions({
    activeSidebarKey,
    groupByMode,
    includeExternal,
    handleCollapseAll,
    handleCollapseAllActiveSections,
    handleMarkAllRead,
    handleRefreshSessions,
    setGroupByMode,
    setIncludeExternal,
    t,
  });

  useWorkstationSidebarMemory({
    activeSessionId,
    activeSidebarKey,
    allSectionIds,
    collapsedSectionIds,
    groupByMode,
    pinnedMenuItems,
    selectedMenuItemId,
    sidebarMenuItems,
    tabCount: tabs.length,
  });

  return (
    <>
      <NavigationSidebar
        items={tabs}
        activeKey={activeSidebarKey}
        onChange={handleTabChange}
        menuItems={sidebarMenuItems}
        pinnedMenuItems={pinnedMenuItems}
        selectedKey={selectedMenuItemId}
        onMenuItemClick={resolvedMenuItemClick}
        onMenuItemContextMenu={resolvedMenuItemContextMenu}
        renderMenuItemWrapper={resolvedRenderMenuItemWrapper}
        compactRows
        solidSurface
        onAddNew={handleOpenSpotlight}
        addIcon={Search}
        addLabel={tCommon("actions.search")}
        addTooltipContent={
          <SidebarSearchShortcutTooltip
            searchLabel={tCommon("actions.search")}
          />
        }
        beforeAddNewActions={
          <HomeHeaderAction
            label={homeLabel}
            tooltipLabel={t("sidebar.actions.openHome")}
            onClick={goToStartPage}
          />
        }
        search={{
          value: sidebarSearchQueries[activeSidebarKey],
          filterValue:
            activeSidebarKey === "workstation"
              ? ""
              : sidebarSearchQueries[activeSidebarKey],
          onChange: handleSidebarSearchChange,
          placeholder: searchPlaceholder,
          noResultsTitle: noSearchResultsTitle,
        }}
        preListContent={
          <SidebarOrgSelector
            value={activeOrgId}
            options={orgSelectorOptions}
            addOrgLabel={addOrgLabel}
            onChange={setSelectedOrgId}
            onAddOrg={handleAddOrgFromSelector}
          />
        }
        listTopPadding
        bottomContent={
          <SidebarBottomBar rightActions={sidebarBottomRightActions} />
        }
        isLoading={isLoading}
        collapsibleSections
        collapsedSectionIds={resolvedCollapsedSectionIds}
        onCollapsedSectionsChange={resolvedSetCollapsedSectionIds}
      />
      <RenameModal
        visible={rename.visible}
        currentName={rename.currentName}
        title={tCommon("actions.rename") + " " + t("routes.session")}
        placeholder={t("sidebar.defaults.enterSessionName")}
        loading={rename.loading}
        onCancel={rename.onCancel}
        onConfirm={(newName) => rename.onConfirm(newName, sessionMap)}
      />
    </>
  );
};

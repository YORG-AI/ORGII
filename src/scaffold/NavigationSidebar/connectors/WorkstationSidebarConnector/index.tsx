import { RenameModal } from "@/src/scaffold/ModalSystem/variants";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { ChevronLeft, Cloud, Laptop, Search } from "lucide-react";
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import { Search } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";

import { type ProjectOrg, projectApi } from "@src/api/http/project";
import type { SelectOption } from "@src/components/Select";
import CloudSessionHoverCard from "@src/components/SessionHoverCard/CloudSessionHoverCard";
import { ROUTES } from "@src/config/routes";
import CloudSessionShareDialog from "@src/features/Org2Cloud/CloudSessionShareDialog";
import { useCloudSessionShareDialog } from "@src/features/Org2Cloud/CloudSessionShareDialog/useCloudSessionShareDialog";
import CloudShareImportDialog from "@src/features/Org2Cloud/CloudShareImportDialog";
import CloudSyncLevelDialog from "@src/features/Org2Cloud/CloudSyncLevelDialog";
import { useCloudSyncLevelDialog } from "@src/features/Org2Cloud/CloudSyncLevelDialog/useCloudSyncLevelDialog";
import JoinCloudOrgDialog from "@src/features/Org2Cloud/JoinCloudOrgDialog";
import { CLOUD_REMOTE_ITEM_PREFIX } from "@src/features/Org2Cloud/cloudRemoteItemId";
import {
  ALL_CLOUD_SESSIONS_FILTER,
  type CloudSessionFilter,
} from "@src/features/Org2Cloud/cloudSessionFilter";
import {
  buildCloudOrgSelectorValue,
  org2CloudOrgsAtom,
  parseCloudOrgSelectorValue,
  sidebarActiveCloudOrgIdAtom,
} from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import { org2CloudRepoScopesAtom } from "@src/features/Org2Cloud/org2CloudSyncAtoms";
import ForkCheckoutPickerDialog from "@src/features/TeamCollaboration/components/ForkCheckoutPickerDialog";
import ForkSessionSetupDialog from "@src/features/TeamCollaboration/components/ForkSessionSetupDialog";
import MoveToOrgDialog from "@src/features/TeamCollaboration/components/MoveToOrgDialog";
import { useMoveToOrgDialog } from "@src/features/TeamCollaboration/components/MoveToOrgDialog/useMoveToOrgDialog";
import { collectScopeMatchedImportedSessionIds } from "@src/features/TeamCollaboration/importedSessionScopeMatch";
import { useShareableScopeKeyVersion } from "@src/features/TeamCollaboration/repoScopeResolver";
import {
  cloudOrgIdsForSession,
  isSessionExcludedFromPersonal,
  sessionOrgTagsAtom,
} from "@src/features/TeamCollaboration/sessionOrgTagsAtom";
import type { WorkspaceRecord } from "@src/api/tauri/workspace";
import { ROUTES } from "@src/config/routes";
import LinkSessionToWorkItemModal from "@src/engines/ChatPanel/panels/LinkSessionToWorkItemModal";
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
import {
  activateChatPanelTabAtom,
  activeChatPanelTabAtom,
  activeWorkManagementSectionAtom,
  closeAndDestroyChatPanelTabAtom,
  openCloudOrgManagementInChatPanelTabAtom,
  openKanbanChatPanelTabAtom,
  openOrFocusChatPanelStartPageTabAtom,
  openOrReplaceSessionInChatPanelTabAtom,
  openSessionInNewChatTabAtom,
} from "@src/store/chatPanel/chatPanelTabsAtom";
import { repoMapAtom } from "@src/store/repo";
  closeAndDestroyChatPanelTabAtom,
  openSessionInNewChatTabAtom,
} from "@src/store/chatPanel/chatPanelTabsAtom";
import { collabOrgsAtom } from "@src/store/collaboration/collabOrgsAtom";
import type { Repo } from "@src/store/repo";
import { repoMapAtom, reposAtom } from "@src/store/repo";
import {
  DEFAULT_SESSION_ORG_ID,
  activeSessionCreatorDraftIdAtom,
  deleteSessionCreatorDraftAtom,
  loadSidebarSessionById,
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
  WORK_MANAGEMENT_PROJECTS_VIEW,
  WORK_MANAGEMENT_SECTION,
  type WorkManagementSection,
  workManagementProjectsViewAtom,
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
import {
  getChatPanelTabIdFromTuiSessionId,
  isChatPanelTuiSessionId,
  toChatPanelTuiSessionId,
} from "@src/util/ui/terminal/chatPanelTuiSessionId";

import { SidebarBottomBar, SidebarHeaderNavButton } from "../../blocks";
import SidebarSettingsMenuButton from "../../blocks/SidebarSettingsMenuButton";
import NavigationSidebar from "../../variants/NavigationSidebar";
import SidebarOrgSelector from "../SidebarOrgSelector";
import {
  COLLAB_ADD_ORG_MENU_ITEM_ID,
  KANBAN_MENU_ITEM_ID,
  NEW_SESSION_MENU_ITEM_ID,
  WORK_ITEMS_GITHUB_ISSUES_MENU_ITEM_ID,
  WORK_ITEMS_GITHUB_PRS_MENU_ITEM_ID,
  WORK_ITEMS_MENU_ITEM_ID,
  WORK_ITEMS_PROJECTS_MENU_ITEM_ID,
  getDraftIdFromMenuItemId,
  isWorkManagementMenuItemId,
} from "../sidebarConnectorUtils";
import { SidebarBottomBar } from "../../blocks";
import NavigationSidebar from "../../variants/NavigationSidebar";
import SidebarOrgSelector from "../SidebarOrgSelector";
import { COLLAB_ADD_ORG_MENU_ITEM_ID } from "../sidebarConnectorUtils";
import {
  sidebarGroupByAtom,
  sidebarIncludeExternalAtom,
} from "../sidebarGroupByAtom";
import { sidebarSelectedOrgIdAtom } from "../sidebarOrgScopeAtom";
import { useProjectsWorkItemMenuItems } from "../useProjectsWorkItemMenuItems";
import { useRenameSessionModal } from "../useRenameSessionModal";
import { useSessionMenuItems } from "../useSessionMenuItems";
import { buildSessionOrgFilterIds } from "../useSessionMenuItems/orgFilter";
import { useProjectsWorkItemMenuItems } from "../useProjectsWorkItemMenuItems";
import { useRenameSessionModal } from "../useRenameSessionModal";
import { useSessionMenuItems } from "../useSessionMenuItems";
import { useWorkstationSidebarContextMenu } from "../useWorkstationSidebarContextMenu";
import { useWorkstationSidebarHandlers } from "../useWorkstationSidebarHandlers";
import {
  DEFAULT_COLLAPSED_SECTION_IDS,
  buildRepoPathToName,
  findSidebarSectionIdForMenuItem,
  getAllSectionIds,
  sortSessionsByActivity,
} from "../workstationSidebarData";
import { useSidebarBottomRightActions } from "./bottomActions";
import { useCloudSessionsSection } from "./cloudSessionsSection";
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
import {
  buildOrgSelectorEntries,
  resolveProjectOrgScopeId,
} from "./orgSelectorEntries";
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
  buildWorkItemsSidebarMenuItems,
  resolveWorkItemsSidebarMenuItemId,
} from "./workItemsSidebarMenuItems";
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
  const sessionSidebarRevealRequest = useAtomValue(
    sessionSidebarRevealRequestAtom
  );
  const clearSessionSidebarReveal = useSetAtom(clearSessionSidebarRevealAtom);
  const setSidebarCollapsed = useSetAtom(sidebarCollapsedAtom);
  // Managed ORG2 Cloud orgs (the only team backend).
  const cloudOrgs = useAtomValue(org2CloudOrgsAtom);
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
  const activeWorkManagementSection = useAtomValue(
    activeWorkManagementSectionAtom
  );
  const [workManagementProjectsView, setWorkManagementProjectsView] = useAtom(
    workManagementProjectsViewAtom
  );
  const openKanbanTab = useSetAtom(openKanbanChatPanelTabAtom);
  const openCloudOrgManagementTab = useSetAtom(
    openCloudOrgManagementInChatPanelTabAtom
  );
  const openSessionInNewChatTab = useSetAtom(openSessionInNewChatTabAtom);
  const openOrReplaceSessionInChatPanelTab = useSetAtom(
    openOrReplaceSessionInChatPanelTabAtom
  );
  const activateChatPanelTab = useSetAtom(activateChatPanelTabAtom);
  const openStartPageTab = useSetAtom(openOrFocusChatPanelStartPageTabAtom);
  const setOpsControlPeekHost = useSetAtom(opsControlPeekHostAtom);
  const setOpsControlFocusedTab = useSetAtom(opsControlFocusedTabAtom);
  const openSessionInNewChatTab = useSetAtom(openSessionInNewChatTabAtom);
  const activateChatPanelTab = useSetAtom(activateChatPanelTabAtom);
  const closeAndDestroyChatPanelTab = useSetAtom(
    closeAndDestroyChatPanelTabAtom
  );
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
  // Fixed + floating workstation sidebars are mounted concurrently. Keep
  // their privacy/session scope shared so either surface always reflects the
  // user's last selection and cannot overwrite the other's active cloud org.
  const [selectedOrgId, setSelectedOrgId] = useAtom(sidebarSelectedOrgIdAtom);
  const [projectOrgs, setProjectOrgs] = useState<ProjectOrg[]>([]);
  const [sidebarSearchQueries, setSidebarSearchQueries] = useState<
    Record<WorkstationSidebarKey, string>
  >({ workstation: "", projects: "" });
  const handleSidebarLayerChange = useCallback((key: WorkstationSidebarKey) => {
  const { goToStartPage, goToNewSession, navigateTo } = useAppNavigation();
  const [activeSidebarKey, setActiveSidebarKey] =
    useState<WorkstationSidebarKey>("workstation");
  const [activeSessionMoreMenuId, setActiveSessionMoreMenuId] = useState("");
  const [activeFolderMoreMenuId, setActiveFolderMoreMenuId] = useState("");
  const [linkWorkItemSessionId, setLinkWorkItemSessionId] = useState<
    string | null
  >(null);
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
        [activeSidebarSearchKey]: value,
      }));
      if (activeSidebarSearchKey === "workstation") {
        void loadSidebarSessions();
      }
    },
    [activeSidebarSearchKey]
        [activeSidebarKey]: value,
      }));
      if (activeSidebarKey === "workstation") {
        void loadSidebarSessions();
      }
    },
    [activeSidebarKey]
  );

  useSidebarSessionRefreshEffects();

  const chatPanelTuiSessions = useChatPanelTuiSidebarSessions();
  const sortedSessions = useMemo(
    () => sortSessionsByActivity([...chatPanelTuiSessions, ...sessions]),
    [chatPanelTuiSessions, sessions]
  );
  const repoMap = useAtomValue(repoMapAtom);
  const repoPathToName = useMemo(() => buildRepoPathToName(repoMap), [repoMap]);
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
  const workItemsLabel = t("labels.workItems");
  const importGithubIssuesLabel = tProjects("githubIssuesImport.menuLabel");
  const addOrgLabel = t("collaboration.addOrg");
  const manageOrgLabel = t("collaboration.manageOrg");
  const searchPlaceholder =
    activeSidebarKey === "projects" || workItemsContentVisible
      ? t("sidebar.search.projects")
      : t("sidebar.search.sessions");
  const noSearchResultsTitle = t("sidebar.empty.noSearchResults");
  // Entry-building rules (alias hiding, dead-org GC, name disambiguation)
  // live in the pure builder — see orgSelectorEntries.ts.
  const orgSelectorOptions = useMemo(
    () =>
      buildOrgSelectorEntries({
        personalOrgId: DEFAULT_SESSION_ORG_ID,
        personalLabel: tProjects("orgs.personalOrg"),
        localOrgs: projectOrgs,
        cloudOrgs,
        localSuffix: "local",
      }).map(
        (entry): SelectOption => ({
          value: entry.value,
          label: entry.label,
          icon:
            entry.kind === "cloud" ? (
              <Cloud size={13} strokeWidth={2} />
            ) : (
              <Laptop size={13} strokeWidth={2} />
            ),
          ...(entry.kind === "personal"
            ? { dataTestId: "sidebar-personal-org-option" }
            : entry.cloudOrgId
              ? { dataTestId: `sidebar-cloud-org-option-${entry.cloudOrgId}` }
              : {}),
        })
      ),
    [cloudOrgs, projectOrgs, tProjects]
  );
  const importGithubIssuesLabel = tProjects("githubIssuesImport.menuLabel");
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
  const activeProjectOrgId = useMemo(
    () => resolveProjectOrgScopeId(activeOrgId, projectOrgs),
    [activeOrgId, projectOrgs]
  );

  // A selected scope whose org disappeared (dead cloud-era entry, roster
  // change) falls back to personal via the `activeOrgId` derivation above;
  // leave a trace so "sharing broke" reports are diagnosable.
  useEffect(() => {
    if (
      selectedOrgId === DEFAULT_SESSION_ORG_ID ||
      selectedOrgId === activeOrgId
    ) {
      return;
    }
    logger.warn(
      `Sidebar scope "${selectedOrgId}" no longer exists; falling back to personal scope`
    );
  }, [activeOrgId, selectedOrgId]);

  // Cloud imports/forks are stamped with the BARE cloud org id while the
  // selector value is namespaced (`cloud:<id>`) — accept both. See
  // orgFilter.ts.
  const sessionFilterOrgIds = useMemo(
    () => buildSessionOrgFilterIds(activeOrgId),
    [activeOrgId]
  );

  const activeCloudOrg = useMemo(() => {
    const cloudOrgId = parseCloudOrgSelectorValue(activeOrgId);
    if (!cloudOrgId) return null;
    return cloudOrgs.find((org) => org.orgId === cloudOrgId) ?? null;
  }, [activeOrgId, cloudOrgs]);
  // Management is a global org action, not a property of the current
  // sidebar scope. When Personal or a local org is selected, open the first
  // managed cloud org; the management page's switcher handles the rest.
  const manageableCloudOrg = activeCloudOrg ?? cloudOrgs[0] ?? null;
  const activeCloudOrgId = activeCloudOrg?.orgId ?? null;

  const setSidebarActiveCloudOrgId = useSetAtom(sidebarActiveCloudOrgIdAtom);
  // Native context-menu handlers read this atom synchronously. Publish the
  // selected privacy scope before paint so a just-switched sidebar can never
  // expose the previous cloud org's roster for one effect tick.
  useLayoutEffect(() => {
    setSidebarActiveCloudOrgId(activeCloudOrgId);
    return () => setSidebarActiveCloudOrgId(null);
  }, [activeCloudOrgId, setSidebarActiveCloudOrgId]);

  // Sessions explicitly tagged into the active cloud org (MoveToOrgDialog)
  // match the cloud scope even without a stamped orgId.
  const sessionOrgTags = useAtomValue(sessionOrgTagsAtom);
  const repoScopesByOrg = useAtomValue(org2CloudRepoScopesAtom);
  const scopeKeyVersion = useShareableScopeKeyVersion();
  const cloudTaggedSessionIds = useMemo(() => {
    if (!activeCloudOrgId) return undefined;
    const ids = collectScopeMatchedImportedSessionIds(
      sortedSessions,
      repoScopesByOrg[activeCloudOrgId]
    );
    void scopeKeyVersion;
    for (const sessionId of Object.keys(sessionOrgTags)) {
      if (
        cloudOrgIdsForSession(sessionOrgTags, sessionId).includes(
          activeCloudOrgId
        )
      ) {
        ids.add(sessionId);
      }
    }
    return ids;
  }, [
    activeCloudOrgId,
    sessionOrgTags,
    sortedSessions,
    repoScopesByOrg,
    scopeKeyVersion,
  ]);

  const personalHiddenCloudTaggedIds = useMemo(() => {
    if (activeOrgId !== DEFAULT_SESSION_ORG_ID) return undefined;
    const ids = new Set<string>();
    for (const sessionId of Object.keys(sessionOrgTags)) {
      if (isSessionExcludedFromPersonal(sessionOrgTags, sessionId)) {
        ids.add(sessionId);
      }
    }
    return ids.size > 0 ? ids : undefined;
  }, [activeOrgId, sessionOrgTags]);

  // Per-org filter for the cloud "Team sessions" section.
  const [cloudSessionFilters, setCloudSessionFilters] = useState<
    Map<string, CloudSessionFilter>
  >(new Map());
  const cloudSessionFilter = activeCloudOrgId
    ? (cloudSessionFilters.get(activeCloudOrgId) ?? ALL_CLOUD_SESSIONS_FILTER)
    : ALL_CLOUD_SESSIONS_FILTER;
  const handleCloudSessionFilterChange = useCallback(
    (filter: CloudSessionFilter) => {
      if (!activeCloudOrgId) return;
      setCloudSessionFilters((previous) =>
        new Map(previous).set(activeCloudOrgId, filter)
      );
    },
    [activeCloudOrgId]
  );

  const {
    cloudMenuItems,
    cloudThreadedLocalSessionIds,
    selectedCloudMenuItemId,
    handleCloudRemoteItemClick,
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
  // flat local list (sessionMap keeps them for click routing).
  const sessionListExcludedIds = useMemo(() => {
    if (!personalHiddenCloudTaggedIds) return cloudThreadedLocalSessionIds;
    if (cloudThreadedLocalSessionIds.size === 0) {
      return personalHiddenCloudTaggedIds;
    }
    return new Set([
      ...cloudThreadedLocalSessionIds,
      ...personalHiddenCloudTaggedIds,
    ]);
  }, [cloudThreadedLocalSessionIds, personalHiddenCloudTaggedIds]);

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
    expandedSubagentParentIds,
    revealedSessionIds,
  });

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
    enabled: activeSidebarKey === "projects" || workItemsContentVisible,
    groupVisibleCounts: projectsGroupVisibleCounts,
    searchQuery: sidebarSearchQueries.projects,
    selectedOrgId: activeProjectOrgId,
  });

  const rename = useRenameSessionModal();
    enabled: activeSidebarKey === "projects",
    groupVisibleCounts: projectsGroupVisibleCounts,
    searchQuery: sidebarSearchQueries.projects,
    selectedOrgId: activeOrgId,
  });

  useCollaborationMetadataSync();

  const rename = useRenameSessionModal();
  const activeSessionId = useAtomValue(workstationActiveSessionIdAtom) ?? "";
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
    workItemDestinations: workItemsSidebarMenuItems,
  const { pinnedMenuItems } = usePinnedMenuItems({
    activeSidebarKey,
    createProjectLabel,
    createWorkItemLabel,
    importGithubIssuesLabel,
    newSessionLabel,
    t,
  });
  const sessionSidebarMenuItems = useSessionSidebarMenuItems({
    menuItems,
    sessionCreatorDrafts,
    t,
  });
  const revealCandidateMenuItems = useMemo(
    () => [...cloudMenuItems, ...sessionSidebarMenuItems],
    [cloudMenuItems, sessionSidebarMenuItems]
  );
  const org2TreeItems = useMemo(() => buildOrg2TreeItems(sessions), [sessions]);
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
  const org2TreeItems = useMemo(() => buildOrg2TreeItems(sessions), [sessions]);
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
  const resolvedCollapsedSectionIds =
    activeSidebarKey === "projects" || workItemsContentVisible
      ? projectsCollapsedSectionIds
      : collapsedSectionIds;
  const resolvedSetCollapsedSectionIds =
    activeSidebarKey === "projects" || workItemsContentVisible
      ? setProjectsCollapsedSectionIds
      : setCollapsedSectionIds;

  const activateMyStationRouteForProjectsContent = useCallback(() => {
    const targetRoute = ROUTES.workStation.code.path;
    resetWorkManagementStateForProjectsContent();
    if (location.pathname !== targetRoute) navigate(targetRoute);
  }, [location.pathname, navigate, resetWorkManagementStateForProjectsContent]);
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
    if (location.pathname !== targetRoute) navigate(targetRoute);
  }, [location.pathname, navigate, setStationChatVisible, setStationMode]);

  const openNewChatTab = useCallback(() => {
    openStartPageTab({ title: t("routes.launchpad") });
  }, [openStartPageTab, t]);
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
    openNewChatTab,
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
    onOpenChatPanelTab: activateChatPanelTab,
    onOpenSessionChatPanelTab: openOrReplaceSessionInChatPanelTab,
    onCloseChatPanelTab: closeAndDestroyChatPanelTab,
    onCloudRemoteItemClick: handleCloudRemoteItemClick,
  });
  const handleOpenInNewTab = useCallback(
    (sessionId: string) => {
      activateMyStationRouteForProjectTabContent();
      navigateChatPanel({ kind: CHAT_PANEL_SURFACE_KIND.SESSION });
    onCloseChatPanelTab: closeAndDestroyChatPanelTab,
  });
  const handleOpenInNewTab = useCallback(
    (sessionId: string) => {
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
      openSessionInNewChatTab(sessionId);
    },
    [activateChatPanelTab, openSessionInNewChatTab]
  );

  const handleMenuItemContextMenu = useWorkstationSidebarContextMenu({
    sessionMap,
    rename,
    handleDeleteSession,
    handleDeleteDraft: deleteSessionCreatorDraft,
    handleExportMarkdown,
    handleOpenInNewTab,
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
    onLinkToWorkItem: setLinkWorkItemSessionId,
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
    pinLabel: pinFolderLabel,
    sessionMap,
    setActiveSessionMoreMenuId,
    tCommon,
    unpinLabel: unpinFolderLabel,
  });
  const decoratedSessionSidebarMenuItems = useMemo(
    () =>
      // Cloud scope: keep the fork-threaded "Team sessions" section above
      // the org-filtered local list. Cloud rows already carry their own
      // Replay/Fork actions, so only local rows need action decoration.
      cloudMenuItems.length > 0
        ? [
            ...cloudMenuItems,
            ...decorateSessionRowActions(sessionSidebarMenuItems),
          ]
        : decorateSessionRowActions(sessionSidebarMenuItems),
    [cloudMenuItems, decorateSessionRowActions, sessionSidebarMenuItems]
  );
  const sidebarMenuItems =
    activeSidebarKey === "projects" || workItemsContentVisible
      ? projectsSidebarMenuItems
      : decoratedSessionSidebarMenuItems;
    () => decorateSessionRowActions(sessionSidebarMenuItems),
    [decorateSessionRowActions, sessionSidebarMenuItems]
  );
  const decoratedOrg2TreeItems = useMemo(
    () => decorateSessionRowActions(org2TreeItems),
    [decorateSessionRowActions, org2TreeItems]
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
    resetWorkManagementStateForProjectsContent,
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
    resetWorkManagementStateForProjectsContent();
    setProjectsSelectedMenuItemId(COLLAB_ADD_ORG_MENU_ITEM_ID);
    navigateChatPanel({ kind: CHAT_PANEL_SURFACE_KIND.NEW_COLLAB_ORG });
  }, [navigateChatPanel, resetWorkManagementStateForProjectsContent]);
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
    if (!manageableCloudOrg) return;
    resetWorkManagementStateForProjectsContent();
    openCloudOrgManagementTab({
      cloudOrg: { orgId: manageableCloudOrg.orgId },
      title: t("collaboration.manageOrg"),
    });
  }, [
    manageableCloudOrg,
    openCloudOrgManagementTab,
    resetWorkManagementStateForProjectsContent,
    t,
  ]);
  const renderSessionMenuItemWrapper =
    useRenderSessionMenuItemWrapper(sessionMap);
  // Cloud teammate rows without published segments render disabled — the
  // native title tooltip explains why (the row primitive has no tooltip
  // slot of its own).
  const renderWorkstationMenuItemWrapper = useCallback(
    (item: NavigationMenuItem, node: React.ReactElement) => {
      if (item.id.startsWith(CLOUD_REMOTE_ITEM_PREFIX)) {
        if (item.disabled) {
          // Two distinct dead-ends: the owner never published segments vs
          // the owner shares metadata only (access ladder) — name the one
          // that actually applies.
          const metadataOnly =
            cloudRemoteRowMap.get(item.id)?.accessMode === "metadata_only";
          return (
            <div
              key={item.key}
              title={t(
                metadataOnly
                  ? "cloud.sidebar.metadataOnly"
                  : "cloud.sidebar.notPublished"
              )}
            >
              {node}
            </div>
          );
        }
        return (
          <CloudSessionHoverCard
            key={item.key}
            row={cloudRemoteRowMap.get(item.id)}
            viewers={cloudRemoteViewerMap.get(item.id)}
            position="right-start"
            mouseEnterDelay={1000}
            mouseLeaveDelay={100}
          >
            {node}
          </CloudSessionHoverCard>
        );
      }
      return renderSessionMenuItemWrapper(item, node);
    },
    [cloudRemoteRowMap, cloudRemoteViewerMap, renderSessionMenuItemWrapper, t]
  );
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
      openKanbanTab({ section, title });
    },
    [openKanbanTab, setWorkManagementProjectsView, t, tSessions]
  );

  const handleSessionMenuItemClick = useCallback(
    (key: string, item: NavigationMenuItem, event: React.MouseEvent) => {
      if (isWorkManagementMenuItemId(item.id)) {
        handleWorkManagementMenuItemClick(key, item);
        return;
      }
  const handleSessionMenuItemClick = useCallback(
    (key: string, item: NavigationMenuItem) => {
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
      handleMenuItemClick(key, item);
    },
    [activateChatPanelTab, handleMenuItemClick]
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
      : activeSidebarKey === "folders"
        ? handleFoldersMenuItemClick
        : handleSessionMenuItemClick;

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
  });

  const resolvedSelectedMenuItemId =
    activeSidebarKey === "workstation" && selectedCloudMenuItemId
      ? selectedCloudMenuItemId
      : selectedMenuItemId;

    t,
  });

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
    selectedMenuItemId,
    sidebarMenuItems,
    tabCount: tabs.length,
  });

  return (
    <>
      <NavigationSidebar
        items={[]}
        activeKey={activeSidebarKey}
        onChange={() => undefined}
        menuItems={
          activeSidebarKey === "workstation"
            ? [...org2TreeItems, ...sidebarMenuItems]
            : sidebarMenuItems
        }
        pinnedMenuItems={pinnedMenuItems}
        selectedKey={resolvedSelectedMenuItemId}
        onMenuItemClick={resolvedMenuItemClick}
        onSubmenuOpenChange={handleSubmenuOpenChange}
        onMenuItemContextMenu={resolvedMenuItemContextMenu}
        renderMenuItemWrapper={resolvedRenderMenuItemWrapper}
        preListContent={sidebarLayerHeader}
        items={tabs}
        activeKey={activeSidebarKey}
        onChange={handleTabChange}
        menuItems={
          activeSidebarKey === "workstation"
            ? [...decoratedOrg2TreeItems, ...sidebarMenuItems]
            : sidebarMenuItems
        }
        pinnedMenuItems={pinnedMenuItems}
        selectedKey={selectedMenuItemId}
        onMenuItemClick={resolvedMenuItemClick}
        onMenuItemContextMenu={resolvedMenuItemContextMenu}
        renderMenuItemWrapper={resolvedRenderMenuItemWrapper}
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
        listTopPadding={!workItemsContentVisible}
        bottomContent={
          <SidebarBottomBar
            leftContent={
              <SidebarOrgSelector
                value={activeOrgId}
                options={orgSelectorOptions}
                addOrgLabel={addOrgLabel}
                manageLabel={manageOrgLabel}
                onChange={handleOrgSelectorChange}
                onAddOrg={handleAddOrgFromSelector}
                onManageOrg={manageableCloudOrg ? handleManageOrg : undefined}
              />
            }
            rightActions={sidebarBottomRightActions}
            settingsAction={<SidebarSettingsMenuButton />}
          />
        }
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
      <LinkSessionToWorkItemModal
        open={Boolean(linkWorkItemSessionId)}
        sessionId={linkWorkItemSessionId}
        onClose={() => setLinkWorkItemSessionId(null)}
        onLinked={() => void loadSidebarSessions({ forceRefresh: true })}
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
      <MoveToOrgDialog
        session={moveToOrg.moveDialogSession}
        onClose={moveToOrg.closeMoveToOrg}
      />
      {/* Per-session cloud access ladder (§13.4): Off / Metadata only /
          Full replay + visibility, per cloud org. */}
      <CloudSyncLevelDialog
        session={cloudSyncLevel.syncLevelSession}
        onClose={cloudSyncLevel.closeSyncLevel}
      />
      {/* Cloud per-session shares (0012): directed grants + guest links. */}
      <CloudSessionShareDialog
        session={cloudShare.cloudShareSession}
        orgs={cloudShare.cloudShareOrgs}
        onClose={cloudShare.closeCloudShare}
      />
      {/* Consumes orgii://cloud/session share deep links (0012): resolve →
          confirm → read-only guest import. */}
      <CloudShareImportDialog />
      {/* Consumes orgii://cloud/join invite deep links (ORG2 Cloud):
          confirm → accept_invite → refresh org2CloudOrgsAtom. */}
      <JoinCloudOrgDialog />
      <ForkCheckoutPickerDialog />
      <ForkSessionSetupDialog />
      {/* Member-filter dropdown for the cloud "Team sessions" section,
          anchored to its section-header action button. */}
      {cloudMemberFilterDropdown}
    </>
  );
};

export type Org2TreeLevel =
  | "workspace"
  | "project"
  | "task"
  | "session"
  | "unlinked";

const ORG2_TREE_LEVEL_BADGES: Record<
  Org2TreeLevel,
  { label: string; className: string }
> = {
  workspace: {
    label: "W",
    className: "border-violet-400/60 bg-violet-500/20 text-violet-200",
  },
  project: {
    label: "P",
    className: "border-sky-400/60 bg-sky-500/20 text-sky-200",
  },
  task: {
    label: "T",
    className: "border-amber-400/60 bg-amber-500/20 text-amber-100",
  },
  session: {
    label: "S",
    className: "border-emerald-400/60 bg-emerald-500/20 text-emerald-100",
  },
  unlinked: {
    label: "–",
    className: "border-zinc-500/70 bg-zinc-500/20 text-zinc-300",
  },
};

function createOrg2TreeBadge(level: Org2TreeLevel): React.ReactNode {
  const badge = ORG2_TREE_LEVEL_BADGES[level];
  return (
    <span
      className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] border text-[9px] font-semibold leading-none ${badge.className}`}
      title={`层级：${badge.label}`}
    >
      {badge.label}
    </span>
  );
}

export function buildOrg2TreeItems(
  sessions: readonly import("@src/store/session").Session[]
): NavigationMenuItem[] {
  const projects = new Map<string, Map<string, NavigationMenuItem[]>>();
  for (const session of sessions) {
    const projectKey = session.projectSlug || session.projectId || "未关联";
    const workItemKey = session.workItemId || "未关联任务";
    const projectBucket =
      projects.get(projectKey) ?? new Map<string, NavigationMenuItem[]>();
    const workItemBucket = projectBucket.get(workItemKey) ?? [];
    workItemBucket.push({
      id: `org2-tree-session-${session.session_id}`,
      // 复用普通 session 列表的 id，点击、hover 行动作、右键菜单都走同一套逻辑。
      id: session.session_id,
      key: `org2-tree-session-${session.session_id}`,
      label: session.name || session.user_input || session.session_id,
      shortcut: "session",
      iconElement: createOrg2TreeBadge("session"),
    });
    projectBucket.set(workItemKey, workItemBucket);
    projects.set(projectKey, projectBucket);
  }
  return [
    {
      id: "org2-tree-workspace",
      key: "org2-tree-workspace",
      label: "Workspace 层级树",
      shortcut: "workspace",
      iconElement: createOrg2TreeBadge("workspace"),
      // # ORG2 四层树：workspace → project → task/work-item → session，未关联数据保留灰色层级入口。
      children: Array.from(projects.entries()).map(
        ([projectName, workItems]) => {
          const isUnlinkedProject = projectName === "未关联";
          return {
            id: `org2-tree-project-${projectName}`,
            key: `org2-tree-project-${projectName}`,
            label: projectName,
            shortcut: isUnlinkedProject ? "未关联" : "project",
            iconElement: createOrg2TreeBadge(
              isUnlinkedProject ? "unlinked" : "project"
            ),
            children: Array.from(workItems.entries()).map(
              ([workItemName, sessionItems]) => {
                const isUnlinkedTask = workItemName === "未关联任务";
                return {
                  id: `org2-tree-wi-${projectName}-${workItemName}`,
                  key: `org2-tree-wi-${projectName}-${workItemName}`,
                  label: workItemName,
                  shortcut: "task",
                  iconElement: createOrg2TreeBadge(
                    isUnlinkedTask ? "unlinked" : "task"
                  ),
                  children: sessionItems,
                };
              }
            ),
          };
        }
      ),
    },
  ];
}

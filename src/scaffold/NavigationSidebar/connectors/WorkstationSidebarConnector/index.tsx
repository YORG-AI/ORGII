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
import { createLogger } from "@src/hooks/logger";
import { useAppNavigation } from "@src/hooks/navigation/useAppNavigation";
import { useProjectDataChanged } from "@src/hooks/project";
import { useSessionView } from "@src/hooks/ui/tabs/useSessionView";
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
import {
  sidebarGroupByAtom,
  sidebarIncludeExternalAtom,
} from "../sidebarGroupByAtom";
import { sidebarSelectedOrgIdAtom } from "../sidebarOrgScopeAtom";
import { useProjectsWorkItemMenuItems } from "../useProjectsWorkItemMenuItems";
import { useRenameSessionModal } from "../useRenameSessionModal";
import { useSessionMenuItems } from "../useSessionMenuItems";
import { buildSessionOrgFilterIds } from "../useSessionMenuItems/orgFilter";
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
  );

  useSidebarSessionRefreshEffects();

  const chatPanelTuiSessions = useChatPanelTuiSidebarSessions();
  const sortedSessions = useMemo(
    () => sortSessionsByActivity([...chatPanelTuiSessions, ...sessions]),
    [chatPanelTuiSessions, sessions]
  );
  const repoMap = useAtomValue(repoMapAtom);
  const repoPathToName = useMemo(() => buildRepoPathToName(repoMap), [repoMap]);

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
  const {
    menuItems: projectsWorkItemMenuItems,
    projectMap: projectsProjectMap,
    workItemMap: projectsWorkItemMap,
    linearWorkItemMap: projectsLinearWorkItemMap,
    localOrgMap: projectsLocalOrgMap,
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
    onCloudRemoteItemClick: handleCloudRemoteItemClick,
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
  const handleProjectsMenuItemClick = useProjectsMenuItemClick({
    activateMyStationRouteForProjectTabContent,
    activateMyStationRouteForProjectsContent,
    getProjectsLoadMoreGroupId,
    loadProjectsLinearOrgWorkItems,
    navigateChatPanel,
    openProjectsLinearOrg,
    openProjectsLinearWorkItem: openProjectsLinearWorkItem,
    projectsLinearOrgMap,
    projectsLinearWorkItemMap,
    projectsLocalOrgMap,
    projectsProjectMap,
    projectsWorkItemMap,
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

function buildOrg2TreeItems(
  sessions: readonly import("@src/store/session").Session[]
): NavigationMenuItem[] {
  const projects = new Map<string, NavigationMenuItem[]>();
  const loose: NavigationMenuItem[] = [];
  for (const session of sessions) {
    const sessionItem: NavigationMenuItem = {
      id: `org2-tree-session-${session.session_id}`,
      key: `org2-tree-session-${session.session_id}`,
      label: session.name || session.user_input || session.session_id,
      shortcut: "session",
    };
    const projectKey = session.projectSlug || session.projectId || "未关联";
    const workItemKey = session.workItemId || "未关联任务";
    const bucket = projects.get(projectKey) ?? [];
    bucket.push({
      id: `org2-tree-wi-${projectKey}-${workItemKey}`,
      key: `org2-tree-wi-${projectKey}-${workItemKey}`,
      label: workItemKey,
      shortcut: "task",
      children: [sessionItem],
    });
    projects.set(projectKey, bucket);
    if (projectKey === "未关联") loose.push(sessionItem);
  }
  return [
    {
      id: "org2-tree-workspace",
      key: "org2-tree-workspace",
      label: "Workspace 层级树",
      shortcut: "workspace",
      // # ORG2 四层树：workspace → project → task/work-item → session，数据直接来自现有 session 关联字段。
      children: Array.from(projects.entries()).map(
        ([projectName, workItems]) => ({
          id: `org2-tree-project-${projectName}`,
          key: `org2-tree-project-${projectName}`,
          label: projectName,
          shortcut: projectName === "未关联" ? "未关联" : "project",
          children: projectName === "未关联" ? loose : workItems,
        })
      ),
    },
  ];
}

/**
 * Thin wrapper around the two big external menu-item builder hooks used by
 * `WorkstationSidebarConnector` (`index.tsx`): `useSessionMenuItems` (the
 * flat session list, cloud-scope aware) and `useProjectsWorkItemMenuItems`
 * (the Projects-tab tree). Split out purely to shrink the connector's body
 * — no behavior lives here beyond forwarding params/results.
 */
import { useProjectsWorkItemMenuItems } from "../useProjectsWorkItemMenuItems";
import { useSessionMenuItems } from "../useSessionMenuItems";
import type { WorkstationSidebarKey } from "./types";

type SessionMenuItemsParams = Parameters<typeof useSessionMenuItems>[0];
type ProjectsWorkItemMenuItemsParams = Parameters<
  typeof useProjectsWorkItemMenuItems
>[0];

interface UseWorkstationSidebarSessionAndProjectMenuItemsParams {
  sortedSessions: SessionMenuItemsParams["sortedSessions"];
  visitedSessions: SessionMenuItemsParams["visitedSessions"];
  repoPathToName: SessionMenuItemsParams["repoPathToName"];
  groupByMode: SessionMenuItemsParams["groupByMode"];
  untitledSession: SessionMenuItemsParams["untitledSession"];
  workstationSearchQuery: string;
  sessionFilterOrgIds: SessionMenuItemsParams["selectedOrgIds"];
  sidebarOrgIds: SessionMenuItemsParams["sidebarOrgIds"];
  cloudScopedExtraSessionIds: SessionMenuItemsParams["extraSessionIds"];
  sessionListExcludedIds: SessionMenuItemsParams["excludedSessionIds"];
  includeExternal: SessionMenuItemsParams["includeExternal"];
  pinnedPage: SessionMenuItemsParams["pinnedPage"];
  workspaceFacetPage: SessionMenuItemsParams["workspaceFacetPage"];
  groupVisibleCounts: SessionMenuItemsParams["groupVisibleCounts"];
  activeCloudOrgId: string | null;
  expandedSubagentParentIds: SessionMenuItemsParams["expandedSubagentParentIds"];
  revealedSessionIds: SessionMenuItemsParams["revealedSessionIds"];
  activeSidebarKey: WorkstationSidebarKey;
  workItemsContentVisible: boolean;
  projectsGroupVisibleCounts: ProjectsWorkItemMenuItemsParams["groupVisibleCounts"];
  projectsSearchQuery: string;
  activeProjectOrgId: ProjectsWorkItemMenuItemsParams["selectedOrgId"];
}

export function useWorkstationSidebarSessionAndProjectMenuItems({
  sortedSessions,
  visitedSessions,
  repoPathToName,
  groupByMode,
  untitledSession,
  workstationSearchQuery,
  sessionFilterOrgIds,
  sidebarOrgIds,
  cloudScopedExtraSessionIds,
  sessionListExcludedIds,
  includeExternal,
  pinnedPage,
  workspaceFacetPage,
  groupVisibleCounts,
  activeCloudOrgId,
  expandedSubagentParentIds,
  revealedSessionIds,
  activeSidebarKey,
  workItemsContentVisible,
  projectsGroupVisibleCounts,
  projectsSearchQuery,
  activeProjectOrgId,
}: UseWorkstationSidebarSessionAndProjectMenuItemsParams) {
  const {
    menuItems,
    sessionMap,
    subagentParentIds,
    isLoadMoreId,
    getLoadMoreGroupId,
    getLoadMoreScopeKey,
    isPinnedLoadMoreId,
    isWorkspaceFacetLoadMoreId,
  } = useSessionMenuItems({
    sortedSessions,
    visitedSessions,
    repoPathToName,
    groupByMode,
    untitledSession,
    searchQuery: workstationSearchQuery,
    selectedOrgIds: sessionFilterOrgIds,
    sidebarOrgIds,
    extraSessionIds: cloudScopedExtraSessionIds,
    excludedSessionIds: sessionListExcludedIds,
    includeExternal,
    pinnedPage,
    workspaceFacetPage,
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
    searchQuery: projectsSearchQuery,
    selectedOrgId: activeProjectOrgId,
  });

  return {
    menuItems,
    sessionMap,
    subagentParentIds,
    isLoadMoreId,
    getLoadMoreGroupId,
    getLoadMoreScopeKey,
    isPinnedLoadMoreId,
    isWorkspaceFacetLoadMoreId,
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
  };
}

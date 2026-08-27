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
  cloudScopedExtraSessionIds: SessionMenuItemsParams["extraSessionIds"];
  sessionListExcludedIds: SessionMenuItemsParams["excludedSessionIds"];
  includeExternal: SessionMenuItemsParams["includeExternal"];
  groupVisibleCounts: SessionMenuItemsParams["groupVisibleCounts"];
  activeCloudOrgId: string | null;
  expandedSubagentParentIds: SessionMenuItemsParams["expandedSubagentParentIds"];
  revealedSessionIds: SessionMenuItemsParams["revealedSessionIds"];
  workspaceGroupActions: SessionMenuItemsParams["workspaceGroupActions"];
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
  projectsSearchQuery,
  activeProjectOrgId,
}: UseWorkstationSidebarSessionAndProjectMenuItemsParams) {
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
    searchQuery: workstationSearchQuery,
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

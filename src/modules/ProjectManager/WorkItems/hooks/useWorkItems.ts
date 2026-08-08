/**
 * useWorkItems
 *
 * Main orchestrator hook for WorkItem page.
 * Combines state, data transformations, and handlers.
 */
import { createLogger } from "@src/hooks/logger";
import { useWorkItemInboxNotifications } from "@src/modules/MainApp/Inbox/hooks/useWorkItemInboxNotifications";

import type { WorkItemsViewTab } from "../types";
import { useProjectData } from "./useProjectData";
import { useWorkItemActions } from "./useWorkItemActions";
import { useWorkItemsData } from "./useWorkItemsData";
import { useWorkItemsHandlers } from "./useWorkItemsHandlers";
import { useWorkItemsState } from "./useWorkItemsState";

const log = createLogger("WorkItems");

export interface UseWorkItemsOptions {
  /** Project ID from the active tab */
  projectId?: string;
  /** Cached project slug from the tab data — allows work items to start loading
   *  before useProjectData resolves, eliminating the sequential wait. */
  cachedProjectSlug?: string;
  initialActiveTab?: WorkItemsViewTab;
  /** Whether this tab is currently visible (gates background refresh on hidden tabs) */
  isActive?: boolean;
}

export function useWorkItems(options: UseWorkItemsOptions = {}) {
  const {
    projectId,
    cachedProjectSlug,
    initialActiveTab = "List",
    isActive = true,
  } = options;

  // Initialize state
  const state = useWorkItemsState(initialActiveTab);

  // Assignment change → inbox notification bridge
  const { onAssignmentChanges } = useWorkItemInboxNotifications();

  // Initialize project data from the global SQLite project store
  const projectData = useProjectData({
    projectId,
    autoLoad: true,
    isActive,
  });

  // Use resolved slug when available, fall back to cached slug from tab data
  const projectSlug = projectData.project?.slug ?? cachedProjectSlug ?? null;

  // Compute derived data (with assignment change detection).
  // Pass shared labels/members from projectData to avoid duplicate reads
  // when slug was resolved sequentially (no cachedProjectSlug).
  const data = useWorkItemsData({
    searchQuery: state.searchQuery,
    statusFilter: state.statusFilter,
    selectedWorkItemId: state.selectedWorkItemId,
    localUpdates: state.localUpdates,
    projectSlug,
    onAssignmentChanges,
    sharedLabels: projectData.rawLabels,
    sharedMembers: projectData.rawMembers,
    isActive,
    activeView: state.activeTab,
  });

  const {
    createWorkItem: createWorkItemApi,
    deleteWorkItem: deleteWorkItemApi,
    restoreWorkItem: restoreWorkItemApi,
  } = useWorkItemActions({
    teamId: data.teamId,
    projectSlug,
    onError: (errorMessage) => {
      log.error("Failed to update work item:", errorMessage);
    },
    onSuccess: () => {
      data.refresh();
    },
  });

  // Initialize handlers
  const handlers = useWorkItemsHandlers({
    projectSlug,
    selectedWorkItemId: state.selectedWorkItemId,
    showProperties: state.showProperties,
    propertiesWasOpenRef: state.propertiesWasOpenRef,
    navigation: data.navigation,
    filteredWorkItems: data.filteredWorkItems,
    setSelectedWorkItemId: state.setSelectedWorkItemId,
    setShowProperties: state.setShowProperties,
    setLocalUpdates: state.setLocalUpdates,
    setActiveTab: state.setActiveTab,
    updateWorkItemSource: data.updateWorkItemSource,
    createWorkItemApi,
    deleteWorkItemApi,
    restoreWorkItemApi,
    updateProjectApi: projectData.updateProject,
    getShortId: data.getShortId,
    refreshWorkItems: data.refresh,
  });

  return {
    state: {
      activeTab: state.activeTab,
      searchQuery: state.searchQuery,
      statusFilter: state.statusFilter,
      selectedWorkItemId: state.selectedWorkItemId,
      showProperties: state.showProperties,
      setSearchQuery: state.setSearchQuery,
      setStatusFilter: state.setStatusFilter,
    },

    data: {
      workItems: data.workItems,
      filteredWorkItems: data.filteredWorkItems,
      selectedWorkItem: data.selectedWorkItem,
      groupedWorkItems: data.groupedWorkItems,
      kanbanTasks: data.kanbanTasks,
      ganttTasks: data.ganttTasks,
      calendarEvents: data.calendarEvents,
      navigation: data.navigation,
      statusCounts: data.statusCounts,
      overviewStats: data.overviewStats,
      updateWorkItemSource: data.updateWorkItemSource,
      getShortId: data.getShortId,
      refresh: data.refresh,
      loading: data.loading,
    },

    projectData: {
      project: projectData.project,
      loading: projectData.loading,
      error: projectData.error,
      availableMembers: projectData.availableMembers,
      availableTeams: projectData.availableTeams,
      availableLabels: projectData.availableLabels,
      availableProjects: projectData.availableProjects,
      availableMilestones: projectData.availableMilestones,
      rawMembers: projectData.rawMembers,
      rawLabels: projectData.rawLabels,
      projects: projectData.projects,
      selectProject: projectData.selectProject,
      refresh: projectData.refresh,
      updateMembers: projectData.updateMembers,
      updateLabels: projectData.updateLabels,
    },

    handlers,
  };
}

import { useAtomValue, useSetAtom } from "jotai";
import React, {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { STORY_SYNC_ADAPTER } from "@src/api/http/integrations/syncConnections";
import { projectSyncApi } from "@src/api/http/project/sync";
import { Placeholder } from "@src/components/Placeholder";
import TabPill from "@src/components/TabPill";
import type { TabPillItem } from "@src/components/TabPill";
import { HEADER_ICON_SIZE } from "@src/config/workstation/tokens";
import { useProjectOrgCloudPermissions } from "@src/features/Org2Cloud/useProjectOrgCloudPermissions";
import { useCurrentUserMemberIds } from "@src/hooks/project/useCurrentUserMemberId";
import type { WorkstationTabHeaderHost } from "@src/hooks/tabHost/useWorkstationTabHeader";
import { DeliveryBox01Icon, HugeiconsIcon } from "@src/icons";
import type { LinkedRepoOption } from "@src/modules/ProjectManager/shared";
import type { ProjectManagerBreadcrumbSegment } from "@src/modules/ProjectManager/shared/components/ProjectManagerBreadcrumb";
import { WorkManagementSearchInput } from "@src/modules/shared/components/WorkManagementSearchInput";
import { reposAtom } from "@src/store/repo";
import { syncDeepLinkAtom } from "@src/store/sync";
import { activeWorkspaceRootPathAtom } from "@src/store/workspace";
import {
  PROJECT_DETAIL_SURFACE_VIEW,
  type ProjectDetailSurfaceView,
} from "@src/store/workstation/tabs";
import type { WorkItemStatus } from "@src/types/core/workItem";
import type { WorkItem } from "@src/types/core/workItem";
import { confirmDestructiveAction } from "@src/util/dialogs/confirmDestructiveAction";

import { ProjectDetailSurfacePillSwitch } from "../ProjectManagerLayout/components/ProjectDetailSurfacePillSwitch";
import {
  EmbeddedWorkItemDetail,
  MultiSelectBar,
  OverviewPropertiesPanel,
  WorkItemsHeaderActions,
  WorkItemsPageHeader,
  WorkItemsTabContent,
} from "./components";
import { getEffectiveWorkItemPrefix } from "./config";
import { useBufferedProjectProperties } from "./hooks/useBufferedProjectProperties";
import { useMultiSelect } from "./hooks/useMultiSelect";
import { useWorkItems } from "./hooks/useWorkItems";
import { useWorkItemsHeaderState } from "./hooks/useWorkItemsHeaderState";
import { useWorkItemsSync } from "./hooks/useWorkItemsSync";
import {
  type EmbeddedWorkItemDetailState,
  useWorkItemsTabBarState,
} from "./hooks/useWorkItemsTabBarState";
import {
  type StatusFilterType,
  WORK_ITEMS_DEFAULT_STATUS,
  type WorkItemsViewTab,
} from "./types";
import {
  WORK_ITEMS_KANBAN_GROUP,
  type WorkItemsKanbanGroup,
  getStatusFilterKeysForWorkItems,
} from "./workItemsViewModel";

const WorkItemsSettings = React.lazy(
  () => import("./components/WorkItemsSettings")
);

const WORK_ITEMS_VIEW_TABS: readonly WorkItemsViewTab[] = [
  "List",
  "Kanban",
  "Gantt",
  "Calendar",
];

// ============================================
// Types
// ============================================

export type { EmbeddedWorkItemDetailState } from "./hooks/useWorkItemsTabBarState";

interface WorkItemsPageProps {
  breadcrumbSegments?: readonly ProjectManagerBreadcrumbSegment[];
  /** Project ID from the active tab */
  projectId: string;
  /** Project name from the active tab (for display) */
  projectName: string;
  /** Display title override for aggregate Work Items surfaces. */
  pageTitle?: string;
  /** Cached project slug from tab data — enables parallel work item loading */
  cachedProjectSlug?: string;
  /** Workspace path used by editor context menus. */
  repoPath?: string | null;
  /** Surface to show for the project detail tab. */
  projectView?: ProjectDetailSurfaceView;
  /** Persist project detail surface changes to the owning tab. */
  onProjectViewChange?: (view: ProjectDetailSurfaceView) => void;
  /** Called when the resolved project slug is known, so the layout can persist it to the tab */
  onProjectSlugResolved?: (slug: string) => void;
  /** Navigate back to the Projects index from the breadcrumb. */
  onOpenProjects?: () => void;
  /** Callback to open the "New Project" modal */
  onCreateProject?: () => void;
  /** Callback to open a "New Work Item" tab */
  onCreateWorkItem?: (
    projectId: string,
    projectName: string,
    projectSlug: string
  ) => void;
  /** Callback after project is deleted (e.g. close the tab) */
  onProjectDeleted?: () => void;
  /** Notify parent tab system about unsaved changes (for dot indicator) */
  onSetUnsaved?: (unsaved: boolean) => void;
  /** Notify parent tab system when the project title changes */
  onProjectNameUpdated?: (projectName: string) => void;
  /** Navigate to repo-level settings (Projects > Settings tab) */
  onOpenRepoSettings?: () => void;
  /** Open a work item in its own dedicated tab (carries unsaved changes) */
  onExpandWorkItemToTab?: (
    workItemId: string,
    workItemName: string,
    pendingUpdates?: Record<string, unknown>,
    workItemStatus?: string,
    workItem?: WorkItem
  ) => void;
  /** Open an agent session in a chat tab */
  onOpenChatSession?: (sessionId: string, title?: string) => void;
  /** Report whether this project tab is showing its list or an embedded work item detail. */
  onEmbeddedWorkItemDetailStateChange?: (
    tabId: string,
    state: EmbeddedWorkItemDetailState
  ) => void;
  /** Whether this tab is the currently visible tab (gates background refreshes) */
  isActive?: boolean;
  /**
   * When set (Workstation Project Manager), Info / Add work item are shown on
   * the Workstation tab bar instead of the page header.
   */
  workStationTabId?: string;
  /** Target workstation host slot for the published 40px header. */
  workstationHeaderHost?: WorkstationTabHeaderHost;
}

// ============================================
// Main Component
// ============================================

const WorkItemsPage: React.FC<WorkItemsPageProps> = ({
  breadcrumbSegments,
  projectId,
  projectName: tabProjectName,
  pageTitle,
  cachedProjectSlug,
  repoPath,
  projectView = PROJECT_DETAIL_SURFACE_VIEW.WORK_ITEMS,
  onProjectViewChange,
  onProjectSlugResolved,
  onOpenProjects,
  onCreateProject,
  onCreateWorkItem,
  onProjectDeleted,
  onSetUnsaved,
  onProjectNameUpdated,
  onOpenRepoSettings,
  onExpandWorkItemToTab,
  onOpenChatSession,
  onEmbeddedWorkItemDetailStateChange,
  isActive = true,
  workStationTabId,
  workstationHeaderHost = "project",
}) => {
  const { t } = useTranslation("projects");
  const interactiveBreadcrumbSegments = useMemo(
    () =>
      breadcrumbSegments?.map((segment, index) =>
        index === 0 && onOpenProjects && !segment.onClick
          ? { ...segment, onClick: onOpenProjects }
          : segment
      ),
    [breadcrumbSegments, onOpenProjects]
  );
  const { canAdminister: canAdministerProjectOrg } =
    useProjectOrgCloudPermissions(isActive);
  const activeWorkspaceRootPath = useAtomValue(activeWorkspaceRootPathAtom);
  const allRepos = useAtomValue(reposAtom);
  const availableRepos = useMemo<LinkedRepoOption[]>(
    () =>
      allRepos
        .map((repo) => ({
          id: repo.path ?? repo.fs_uri ?? repo.id,
          name: repo.name || repo.path || repo.id,
        }))
        .filter((repo) => repo.id),
    [allRepos]
  );
  const deepLinkRequest = useAtomValue(syncDeepLinkAtom);
  const setDeepLinkRequest = useSetAtom(syncDeepLinkAtom);
  const { state, data, projectData, handlers } = useWorkItems({
    projectId,
    cachedProjectSlug,
    initialActiveTab:
      projectView === PROJECT_DETAIL_SURFACE_VIEW.OVERVIEW
        ? "Overview"
        : "List",
    isActive,
  });
  const { handleTabChange } = handlers;
  const { memberIds: currentUserMemberIds } = useCurrentUserMemberIds(
    projectData.rawMembers
  );
  const pinnedKanbanColumnIds = useMemo(
    () => [...currentUserMemberIds].map((memberId) => `person:${memberId}`),
    [currentUserMemberIds]
  );
  const statusFilterKeys = useMemo(
    () => getStatusFilterKeysForWorkItems(data.workItems),
    [data.workItems]
  );
  const { statusFilter, setStatusFilter } = state;
  useEffect(() => {
    if (!statusFilterKeys.includes(statusFilter)) {
      setStatusFilter("all");
    }
  }, [setStatusFilter, statusFilter, statusFilterKeys]);

  // Persist resolved slug to tab data for faster loading on next app launch
  const resolvedSlug = projectData.project?.slug;
  const reportedSlugRef = useRef<string | null>(null);
  useEffect(() => {
    if (resolvedSlug && resolvedSlug !== reportedSlugRef.current) {
      reportedSlugRef.current = resolvedSlug;
      onProjectSlugResolved?.(resolvedSlug);
    }
  }, [resolvedSlug, onProjectSlugResolved]);
  const [collapseAllSignal, setCollapseAllSignal] = useState(0);
  const [kanbanGroupBy, setKanbanGroupBy] = useState<WorkItemsKanbanGroup>(
    WORK_ITEMS_KANBAN_GROUP.STATUS
  );

  // Deep-link consumer (Phase 4.8 Track D) — keep the request available until
  // the Settings view has rendered it once. Clearing it in the same effect as
  // the tab switch would remove the request before WorkItemsSettings mounts.
  const settingsSectionRequest =
    deepLinkRequest && resolvedSlug && deepLinkRequest.slug === resolvedSlug
      ? deepLinkRequest
      : undefined;
  useEffect(() => {
    if (!settingsSectionRequest) return;
    if (state.activeTab !== "Settings") {
      handleTabChange("Settings");
      return;
    }
    setDeepLinkRequest(null);
  }, [
    handleTabChange,
    setDeepLinkRequest,
    settingsSectionRequest,
    state.activeTab,
  ]);

  const confirmWorkItemDelete = useCallback(
    async (name?: string) =>
      confirmDestructiveAction({
        title: name
          ? t("common:actions.confirmDeleteTitle", { name })
          : t("common:actions.confirmDelete"),
        message: t("common:actions.confirmDeleteMessage"),
        okLabel: t("common:actions.delete"),
        cancelLabel: t("common:actions.cancel"),
      }),
    [t]
  );
  const handleDeleteWorkItem = useCallback(
    async (workItemId: string) => {
      const item = data.workItems.find(
        (candidate) => candidate.session_id === workItemId
      );
      if (!(await confirmWorkItemDelete(item?.name))) return;
      await handlers.handleDelete(workItemId);
    },
    [confirmWorkItemDelete, data.workItems, handlers]
  );
  const handleOpenWorkItem = useCallback(
    (workItemId: string) => {
      handlers.handleSelect(workItemId);
    },
    [handlers]
  );

  const {
    selectedIds,
    bulkDeleting,
    handleCheckedChange,
    handleSelectAll,
    handleUnselectAll,
    handleBulkDelete,
  } = useMultiSelect({
    filteredWorkItems: data.filteredWorkItems,
    onDelete: handlers.handleDelete,
    projectSlug: projectData.project?.slug,
    getShortId: data.getShortId,
    onBatchDeleteComplete: data.refresh,
    onBeforeDelete: () => confirmWorkItemDelete(),
  });

  const handleCollapseAll = useCallback(() => {
    setCollapseAllSignal((currentSignal) => currentSignal + 1);
  }, []);

  const { projectName, headerTitle, sourceProject } = useWorkItemsHeaderState({
    pageTitle,
    tabProjectName,
    project: projectData.project,
    projectLoading: projectData.loading,
  });

  const { handleDeleteProject } = useWorkItemsSync({
    project: projectData.project,
    projectName,
    rawMembers: projectData.rawMembers,
    workItemCount: data.workItems.length,
    onProjectDeleted,
  });

  // Track work item detail pending changes
  const [hasWorkItemPendingChanges, setHasWorkItemPendingChanges] =
    useState(false);
  const [workItemPropertiesOpen, setWorkItemPropertiesOpen] = useState(true);
  const [projectSyncAdapter, setProjectSyncAdapter] = useState<{
    projectSlug: string;
    adapterId: string | null;
  } | null>(null);

  const handleCloseDetail = useCallback(() => {
    handlers.handleCloseWorkItemDetail();
    setHasWorkItemPendingChanges(false);
  }, [handlers]);

  const linkedRepoPath = sourceProject?.linkedRepos?.[0]?.id;
  const resolvedRepoPath = linkedRepoPath ?? activeWorkspaceRootPath ?? null;
  const resolvedProjectSlug = projectData.project?.slug ?? null;
  const projectSyncAdapterId =
    projectSyncAdapter && projectSyncAdapter.projectSlug === resolvedProjectSlug
      ? projectSyncAdapter.adapterId
      : undefined;
  const projectIdentityIcon = useMemo(
    () => (
      <HugeiconsIcon
        icon={DeliveryBox01Icon}
        data-icon="box"
        size={HEADER_ICON_SIZE.sm}
        strokeWidth={1.75}
      />
    ),
    []
  );
  const selectedShortId = data.selectedWorkItem
    ? (data.getShortId(data.selectedWorkItem.session_id) ?? null)
    : null;

  useEffect(() => {
    if (!resolvedProjectSlug) return;

    let cancelled = false;
    void projectSyncApi
      .status(resolvedProjectSlug)
      .then((status) => {
        if (!cancelled) {
          setProjectSyncAdapter({
            projectSlug: resolvedProjectSlug,
            adapterId: status.adapter_id,
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setProjectSyncAdapter({
            projectSlug: resolvedProjectSlug,
            adapterId: null,
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [resolvedProjectSlug]);

  const {
    actionsInStationTabBar: tabBarActionsInStationTabBar,
    propertiesActionAvailable,
  } = useWorkItemsTabBarState({
    activeTab: state.activeTab,
    showProperties: state.showProperties,
    isActive,
    workStationTabId,
    projectId,
    projectName,
    resolvedProjectSlug,
    selectedWorkItem: data.selectedWorkItem,
    onToggleProperties: handlers.handleToggleProperties,
    onCreateWorkItem,
    onAddListItem: handlers.handleAddListItem,
    onEmbeddedWorkItemDetailStateChange,
  });

  const handleOpenSelectedWorkItemInNewTab = useCallback(() => {
    const workItem = data.selectedWorkItem;
    if (!workItem || !onExpandWorkItemToTab) return;
    onExpandWorkItemToTab(
      workItem.session_id,
      workItem.name || t("common:placeholders.untitled"),
      undefined,
      workItem.workItemStatus ?? workItem.status,
      workItem
    );
  }, [data.selectedWorkItem, onExpandWorkItemToTab, t]);

  const detailContent = (
    <EmbeddedWorkItemDetail
      workItem={data.selectedWorkItem ?? null}
      onClose={handleCloseDetail}
      onOpenInNewTab={
        onExpandWorkItemToTab ? handleOpenSelectedWorkItemInNewTab : undefined
      }
      onNavigate={handlers.handleNavigate}
      hasPrev={data.navigation.hasPrev}
      hasNext={data.navigation.hasNext}
      onUpdateWorkItem={handlers.handleUpdate}
      onDeleteWorkItem={handleDeleteWorkItem}
      availableMembers={projectData.availableMembers}
      availableProjects={projectData.availableProjects}
      availableMilestones={projectData.availableMilestones}
      availableLabels={projectData.availableLabels}
      onPendingChangesChange={setHasWorkItemPendingChanges}
      repoPath={resolvedRepoPath}
      projectSlug={resolvedProjectSlug}
      shortId={selectedShortId}
      onRefreshWorkItem={data.refresh}
      onOpenSession={onOpenChatSession}
      breadcrumbSegments={interactiveBreadcrumbSegments}
      breadcrumbProjectName={headerTitle}
      breadcrumbIcon={projectIdentityIcon}
      titleEditable={
        projectSyncAdapterId !== undefined &&
        projectSyncAdapterId !== STORY_SYNC_ADAPTER.GITHUB
      }
      propertiesOpen={workItemPropertiesOpen}
      onToggleProperties={() => setWorkItemPropertiesOpen((prev) => !prev)}
      publishHeaderToWorkstation={false}
      workstationHeaderHost={workstationHeaderHost}
    />
  );

  const {
    displayProject,
    handleLocalProjectUpdate,
    handleUpdateProjectMembers,
    handleProjectNameChange,
    handleProjectDescriptionChange,
    handleWorkItemPrefixUpdate,
  } = useBufferedProjectProperties({
    projectId,
    sourceProject,
    onProjectUpdate: handlers.handleProjectUpdate,
    hasWorkItemPendingChanges,
    onSetUnsaved,
    onProjectNameUpdated,
  });

  const overviewPropertiesPanel = (
    <OverviewPropertiesPanel
      project={displayProject}
      onUpdate={handleLocalProjectUpdate}
      availableMembers={projectData.availableMembers}
      availableTeams={projectData.availableTeams}
      availableLabels={projectData.availableLabels}
      availableRepos={availableRepos}
    />
  );

  const propertiesPanel = state.showProperties && overviewPropertiesPanel;

  const activeProjectView =
    state.activeTab === "Overview"
      ? PROJECT_DETAIL_SURFACE_VIEW.OVERVIEW
      : PROJECT_DETAIL_SURFACE_VIEW.WORK_ITEMS;
  const isWorkItemsSurface =
    activeProjectView === PROJECT_DETAIL_SURFACE_VIEW.WORK_ITEMS;
  const detailOpen =
    isWorkItemsSurface &&
    state.activeTab !== "Settings" &&
    Boolean(data.selectedWorkItem);

  const handleProjectViewChange = useCallback(
    (nextProjectView: ProjectDetailSurfaceView) => {
      onProjectViewChange?.(nextProjectView);
      handleTabChange(
        nextProjectView === PROJECT_DETAIL_SURFACE_VIEW.OVERVIEW
          ? "Overview"
          : "List"
      );
    },
    [handleTabChange, onProjectViewChange]
  );

  const handleHeaderTabChange = useCallback(
    (nextTab: WorkItemsViewTab) => {
      onProjectViewChange?.(
        nextTab === "Overview"
          ? PROJECT_DETAIL_SURFACE_VIEW.OVERVIEW
          : PROJECT_DETAIL_SURFACE_VIEW.WORK_ITEMS
      );
      handleTabChange(nextTab);
    },
    [handleTabChange, onProjectViewChange]
  );

  const workItemsViewTabs = useMemo<TabPillItem[]>(
    () =>
      WORK_ITEMS_VIEW_TABS.map((tab) => ({
        key: tab,
        label: t(`workItems.tabs.${tab.toLowerCase()}`),
      })),
    [t]
  );
  const kanbanGroupTabs = useMemo<TabPillItem[]>(
    () => [
      {
        key: WORK_ITEMS_KANBAN_GROUP.STATUS,
        label: t("projects.groupBy.status"),
      },
      {
        key: WORK_ITEMS_KANBAN_GROUP.ASSIGNED_TO,
        label: t("projects.groupBy.assignedTo"),
      },
      {
        key: WORK_ITEMS_KANBAN_GROUP.CREATED_BY,
        label: t("projects.groupBy.createdBy"),
      },
    ],
    [t]
  );

  const projectSurfaceControls = useMemo(
    () => (
      <div className="flex min-w-0 items-center gap-1.5">
        <ProjectDetailSurfacePillSwitch
          projectView={activeProjectView}
          onProjectViewChange={handleProjectViewChange}
        />
        {isWorkItemsSurface && (
          <>
            <span className="text-xs text-text-4">/</span>
            <TabPill
              tabs={workItemsViewTabs}
              activeTab={state.activeTab}
              onChange={(key) => handleHeaderTabChange(key as WorkItemsViewTab)}
              variant="pill"
              color="fill"
              fillWidth={false}
              size="small"
            />
            {state.activeTab === "Kanban" && (
              <>
                <span className="text-xs text-text-4">/</span>
                <TabPill
                  tabs={kanbanGroupTabs}
                  activeTab={kanbanGroupBy}
                  onChange={(key) =>
                    setKanbanGroupBy(key as WorkItemsKanbanGroup)
                  }
                  variant="pill"
                  color="fill"
                  fillWidth={false}
                  size="small"
                />
              </>
            )}
          </>
        )}
      </div>
    ),
    [
      activeProjectView,
      handleHeaderTabChange,
      handleProjectViewChange,
      isWorkItemsSurface,
      kanbanGroupBy,
      kanbanGroupTabs,
      state.activeTab,
      workItemsViewTabs,
    ]
  );
  const workItemsSearchControl = useMemo(
    () =>
      isWorkItemsSurface && state.activeTab !== "Settings" ? (
        <WorkManagementSearchInput
          value={state.searchQuery}
          onChange={state.setSearchQuery}
          dataTestId="project-work-items-search"
        />
      ) : null,
    [
      isWorkItemsSurface,
      state.activeTab,
      state.searchQuery,
      state.setSearchQuery,
    ]
  );
  const workItemsListSearchControl = useMemo(
    () => (
      <WorkManagementSearchInput
        value={state.searchQuery}
        onChange={state.setSearchQuery}
        placement="list"
        dataTestId="project-work-items-search"
      />
    ),
    [state.searchQuery, state.setSearchQuery]
  );
  const addListItem = handlers.handleAddListItem;
  const handleStatusFilterChange = useCallback(
    (value: string) => setStatusFilter(value as StatusFilterType),
    [setStatusFilter]
  );
  const handleCreateWorkItem = useCallback(() => {
    if (onCreateWorkItem) {
      onCreateWorkItem(
        projectId,
        projectName,
        resolvedProjectSlug ?? projectId
      );
      return;
    }
    void addListItem(WORK_ITEMS_DEFAULT_STATUS);
  }, [
    addListItem,
    onCreateWorkItem,
    projectId,
    projectName,
    resolvedProjectSlug,
  ]);
  const addWorkItemAction =
    state.activeTab !== "Settings" ? handleCreateWorkItem : undefined;
  const workItemsListHeader = useMemo(
    () => (
      <WorkItemsHeaderActions
        activeTab={state.activeTab}
        placement="list"
        trailingControls={workItemsListSearchControl}
        statusFilter={isWorkItemsSurface ? state.statusFilter : undefined}
        onStatusFilterChange={
          isWorkItemsSurface ? handleStatusFilterChange : undefined
        }
        statusCounts={data.statusCounts}
        statusFilterKeys={statusFilterKeys}
        onCollapseAll={isWorkItemsSurface ? handleCollapseAll : undefined}
        onRefresh={isWorkItemsSurface ? data.refresh : undefined}
        onAddProject={
          isWorkItemsSurface && state.activeTab !== "Settings"
            ? onCreateProject
            : undefined
        }
        onAddWorkItem={addWorkItemAction}
        refreshLoading={data.loading}
        t={t}
      />
    ),
    [
      addWorkItemAction,
      data.loading,
      data.refresh,
      data.statusCounts,
      handleCollapseAll,
      handleStatusFilterChange,
      isWorkItemsSurface,
      onCreateProject,
      state.activeTab,
      state.statusFilter,
      statusFilterKeys,
      t,
      workItemsListSearchControl,
    ]
  );

  const settingsContent = (
    <Suspense fallback={<Placeholder variant="loading" />}>
      <WorkItemsSettings
        members={projectData.rawMembers}
        onUpdateMembers={projectData.updateMembers}
        labels={projectData.rawLabels}
        onUpdateLabels={projectData.updateLabels}
        slug={resolvedProjectSlug ?? projectId}
        projectName={projectName}
        workItemPrefix={displayProject.workItemPrefix ?? "PRJ"}
        workItemPrefixCustom={displayProject.workItemPrefixCustom ?? false}
        onUpdateWorkItemPrefix={handleWorkItemPrefixUpdate}
        onDeleteProject={
          canAdministerProjectOrg(displayProject.orgId)
            ? handleDeleteProject
            : undefined
        }
        projectMembers={displayProject.members ?? []}
        onUpdateProjectMembers={handleUpdateProjectMembers}
        onOpenRepoSettings={onOpenRepoSettings}
        sectionRequest={settingsSectionRequest}
      />
    </Suspense>
  );

  const resolvedProjectDescription =
    displayProject.description ?? projectData.project?.description;

  // The project header stays mounted while the selected work item opens in the
  // reusable right-hand detail pane.
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <WorkItemsPageHeader
        projectName={headerTitle}
        breadcrumbSegments={interactiveBreadcrumbSegments}
        identityIcon={projectIdentityIcon}
        onOpenProjects={onOpenProjects}
        activeTab={state.activeTab}
        leadingControls={projectSurfaceControls}
        trailingControls={workItemsSearchControl}
        hideTrailingControls={detailOpen}
        statusFilter={isWorkItemsSurface ? state.statusFilter : undefined}
        onStatusFilterChange={
          isWorkItemsSurface ? handleStatusFilterChange : undefined
        }
        statusCounts={data.statusCounts}
        statusFilterKeys={statusFilterKeys}
        onCollapseAll={isWorkItemsSurface ? handleCollapseAll : undefined}
        showProperties={
          propertiesActionAvailable ? state.showProperties : undefined
        }
        onToggleProperties={
          propertiesActionAvailable
            ? handlers.handleToggleProperties
            : undefined
        }
        onAddProject={
          isWorkItemsSurface && state.activeTab !== "Settings"
            ? onCreateProject
            : undefined
        }
        onAddWorkItem={addWorkItemAction}
        onRefresh={isWorkItemsSurface ? data.refresh : undefined}
        refreshLoading={data.loading}
        publishToWorkstationHeader={tabBarActionsInStationTabBar && isActive}
        workstationHeaderHost={workstationHeaderHost}
      />

      {/* Content Area */}
      <div className="min-h-0 flex-1 overflow-hidden">
        <WorkItemsTabContent
          activeTab={state.activeTab}
          groupedWorkItems={data.groupedWorkItems}
          filteredWorkItems={data.filteredWorkItems}
          selectedWorkItem={data.selectedWorkItem ?? null}
          selectedWorkItemId={state.selectedWorkItemId}
          workItems={data.workItems}
          projectName={displayProject.name}
          projectDescription={resolvedProjectDescription}
          projectProperties={displayProject}
          hideProjectPropertiesRow={
            projectSyncAdapterId === STORY_SYNC_ADAPTER.GITHUB
          }
          repoPath={repoPath}
          availableMembers={projectData.availableMembers}
          availableTeams={projectData.availableTeams}
          projectLabels={projectData.availableLabels}
          availableRepos={availableRepos}
          availableProjects={projectData.availableProjects}
          availableMilestones={projectData.availableMilestones}
          availableLabels={projectData.availableLabels}
          overviewStats={data.overviewStats}
          checkedWorkItemIds={selectedIds}
          onCheckedChange={handleCheckedChange}
          onSelectWorkItem={handleOpenWorkItem}
          onUpdateWorkItem={handlers.handleUpdate}
          onDeleteWorkItem={handleDeleteWorkItem}
          onRestoreWorkItem={handlers.handleRestore}
          onAddListItem={(status: WorkItemStatus) =>
            handlers.handleAddListItem(status)
          }
          onProjectNameChange={handleProjectNameChange}
          onProjectDescriptionChange={handleProjectDescriptionChange}
          onProjectPropertiesChange={handleLocalProjectUpdate}
          onKanbanTaskMove={handlers.handleKanbanTaskMove}
          onKanbanTaskClick={(task) => handleOpenWorkItem(task.id)}
          onAddKanbanTask={handlers.handleAddTask}
          onGanttTaskClick={(task) => handleOpenWorkItem(task.id)}
          onGanttTaskUpdate={handlers.handleGanttTaskUpdate}
          onCalendarEventClick={(event) => handleOpenWorkItem(event.id)}
          kanbanGroupBy={kanbanGroupBy}
          pinnedKanbanColumnIds={pinnedKanbanColumnIds}
          kanbanTasks={data.kanbanTasks}
          ganttTasks={data.ganttTasks}
          calendarEvents={data.calendarEvents}
          listHeader={workItemsListHeader}
          detailContent={detailContent}
          propertiesPanel={propertiesPanel}
          settingsContent={settingsContent}
          collapseAllSignal={collapseAllSignal}
          workItemPrefix={getEffectiveWorkItemPrefix(
            displayProject.name,
            displayProject.workItemPrefix,
            displayProject.workItemPrefixCustom
          )}
        />
      </div>

      <MultiSelectBar
        selectedCount={selectedIds.size}
        visibleItemCount={data.filteredWorkItems.length}
        deleting={bulkDeleting}
        onSelectAll={handleSelectAll}
        onUnselectAll={handleUnselectAll}
        onDelete={handleBulkDelete}
      />
    </div>
  );
};

export default WorkItemsPage;

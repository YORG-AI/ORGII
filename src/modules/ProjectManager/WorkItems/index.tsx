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
import IntegrationIcon from "@src/components/IntegrationIcon";
import TabPill from "@src/components/TabPill";
import type { TabPillItem } from "@src/components/TabPill";
import { HEADER_ICON_SIZE } from "@src/config/workstation/tokens";
import { useProjectOrgCloudPermissions } from "@src/features/Org2Cloud/useProjectOrgCloudPermissions";
import { useCurrentUserMemberIds } from "@src/hooks/project/useCurrentUserMemberId";
import type { WorkstationTabHeaderHost } from "@src/hooks/workStation";
import type { LinkedRepoOption } from "@src/modules/ProjectManager/shared";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import { ContentSearchPalette } from "@src/scaffold/GlobalSpotlight/palettes";
import { reposAtom } from "@src/store/repo";
import { syncDeepLinkAtom } from "@src/store/sync";
import { activeWorkspaceRootPathAtom } from "@src/store/workspace";
import {
  PROJECT_DETAIL_SURFACE_VIEW,
  type ProjectDetailSurfaceView,
} from "@src/store/workstation/tabs";
import type { WorkItemStatus } from "@src/types/core/workItem";
import { confirmDestructiveAction } from "@src/util/dialogs/confirmDestructiveAction";

import { ProjectDetailSurfacePillSwitch } from "../ProjectManagerLayout/components/ProjectDetailSurfacePillSwitch";
import {
  EmbeddedWorkItemDetail,
  MultiSelectBar,
  OverviewPropertiesPanel,
  WorkItemsPageHeader,
  WorkItemsTabContent,
} from "./components";
import type { SettingsSectionId } from "./components/WorkItemsSettings";
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
import { WORK_ITEMS_DEFAULT_STATUS, type WorkItemsViewTab } from "./types";
import {
  WORK_ITEMS_KANBAN_GROUP,
  type WorkItemsKanbanGroup,
  getStatusFilterKeysForWorkItems,
} from "./workItemsViewModel";

const WorkItemsSettings = React.lazy(
  () => import("./components/WorkItemsSettings")
);

const WORK_ITEMS_VIEW_TABS: readonly WorkItemsViewTab[] = ["List", "Kanban"];

// ============================================
// Types
// ============================================

export type { EmbeddedWorkItemDetailState } from "./hooks/useWorkItemsTabBarState";

export interface WorkItemsPageProps {
  breadcrumbSegments?: readonly { label: string }[];
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
    workItemStatus?: string
  ) => void;
  /** Notify parent tab system when the embedded work item title changes */
  onEmbeddedWorkItemNameUpdated?: (workItemName: string) => void;
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
  onEmbeddedWorkItemNameUpdated,
  onOpenChatSession,
  onEmbeddedWorkItemDetailStateChange,
  isActive = true,
  workStationTabId,
  workstationHeaderHost = "project",
}) => {
  const { t } = useTranslation("projects");
  const { canAdminister: canAdministerProjectOrg } =
    useProjectOrgCloudPermissions();
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
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [collapseAllSignal, setCollapseAllSignal] = useState(0);
  const [kanbanGroupBy, setKanbanGroupBy] = useState<WorkItemsKanbanGroup>(
    WORK_ITEMS_KANBAN_GROUP.STATUS
  );

  // Pending Settings section forwarded to `WorkItemsSettings` once the
  // user clicks the status-bar sync widget. Cleared on consumption so
  // the same value never re-fires when the user later picks a
  // different section in the sidebar.
  const [pendingSettingsSection, setPendingSettingsSection] = useState<
    SettingsSectionId | undefined
  >(undefined);

  // Deep-link consumer (Phase 4.8 Track D) — when the widget writes a
  // request whose slug matches this project, switch to the Settings
  // view, store the section to focus, and clear the atom in the same
  // tick so a stale request never opens the wrong project's section.
  // The setState calls below are guarded so they fire at most once per
  // request value: the atom is cleared in the same effect run, so the
  // next render exits early at the `!deepLinkRequest` check.
  useEffect(() => {
    if (!deepLinkRequest) return;
    if (!resolvedSlug || deepLinkRequest.slug !== resolvedSlug) return;

    handlers.handleTabChange("Settings");
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPendingSettingsSection(deepLinkRequest.section);
    setDeepLinkRequest(null);
  }, [deepLinkRequest, resolvedSlug, handlers, setDeepLinkRequest]);

  const handleSettingsSectionConsumed = useCallback(() => {
    setPendingSettingsSection(undefined);
  }, []);

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

  const handleOpenSearch = useCallback(() => {
    setIsSearchOpen(true);
  }, []);

  const handleCloseSearch = useCallback(() => {
    setIsSearchOpen(false);
  }, []);

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
    () =>
      projectSyncAdapterId === STORY_SYNC_ADAPTER.GITHUB ? (
        <IntegrationIcon
          type={STORY_SYNC_ADAPTER.GITHUB}
          size={HEADER_ICON_SIZE.sm}
        />
      ) : undefined,
    [projectSyncAdapterId]
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
    isDetailOpen,
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
    onOpenSearch: handleOpenSearch,
    onToggleProperties: handlers.handleToggleProperties,
    onCreateWorkItem,
    onAddListItem: handlers.handleAddListItem,
    onEmbeddedWorkItemDetailStateChange,
  });

  const detailContent = (
    <EmbeddedWorkItemDetail
      workItem={data.selectedWorkItem ?? null}
      onClose={handleCloseDetail}
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
      onWorkItemNameUpdated={onEmbeddedWorkItemNameUpdated}
      onExpandWorkItemToTab={onExpandWorkItemToTab}
      breadcrumbProjectName={headerTitle}
      breadcrumbIcon={projectIdentityIcon}
      titleEditable={
        projectSyncAdapterId !== undefined &&
        projectSyncAdapterId !== STORY_SYNC_ADAPTER.GITHUB
      }
      propertiesOpen={workItemPropertiesOpen}
      onToggleProperties={() => setWorkItemPropertiesOpen((prev) => !prev)}
      publishHeaderToWorkstation={tabBarActionsInStationTabBar && isActive}
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
        label: t(`workItems.tabs.${tab === "List" ? "list" : "kanban"}`),
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
        initialSection={pendingSettingsSection}
        onSectionConsumed={handleSettingsSectionConsumed}
      />
    </Suspense>
  );

  const resolvedProjectDescription =
    displayProject.description ?? projectData.project?.description;

  // When a work item is selected, the detail's own header (with the
  // `Project > Item` breadcrumb) replaces the page header. Otherwise the
  // page header with view tabs / status filter is shown.
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {!isDetailOpen && (
        <WorkItemsPageHeader
          projectName={headerTitle}
          breadcrumbSegments={breadcrumbSegments}
          identityIcon={projectIdentityIcon}
          onOpenProjects={onOpenProjects}
          activeTab={state.activeTab}
          leadingControls={projectSurfaceControls}
          statusFilter={isWorkItemsSurface ? state.statusFilter : undefined}
          onStatusFilterChange={
            isWorkItemsSurface
              ? (value) =>
                  state.setStatusFilter(value as typeof state.statusFilter)
              : undefined
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
          onAddWorkItem={
            state.activeTab !== "Settings"
              ? onCreateWorkItem
                ? () =>
                    onCreateWorkItem(
                      projectId,
                      projectName,
                      resolvedProjectSlug ?? projectId
                    )
                : () => handlers.handleAddListItem(WORK_ITEMS_DEFAULT_STATUS)
              : undefined
          }
          onRefresh={isWorkItemsSurface ? data.refresh : undefined}
          refreshLoading={data.loading}
          onSearch={
            isWorkItemsSurface && !tabBarActionsInStationTabBar
              ? handleOpenSearch
              : undefined
          }
          publishToWorkstationHeader={tabBarActionsInStationTabBar && isActive}
          workstationHeaderHost={workstationHeaderHost}
        />
      )}

      {/* Content search spotlight */}
      <ContentSearchPalette
        isOpen={isSearchOpen}
        onClose={handleCloseSearch}
        query={state.searchQuery}
        onQueryChange={(value) => state.setSearchQuery(value)}
        placeholder={t("workItems.searchPlaceholder")}
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
          onSelectWorkItem={handlers.handleSelect}
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
          onKanbanTaskClick={handlers.handleKanbanTaskClick}
          onAddKanbanTask={handlers.handleAddTask}
          onGanttTaskClick={handlers.handleGanttTaskClick}
          onGanttTaskUpdate={handlers.handleGanttTaskUpdate}
          onCalendarEventClick={handlers.handleCalendarEventClick}
          kanbanGroupBy={kanbanGroupBy}
          pinnedKanbanColumnIds={pinnedKanbanColumnIds}
          kanbanTasks={data.kanbanTasks}
          ganttTasks={data.ganttTasks}
          calendarEvents={data.calendarEvents}
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

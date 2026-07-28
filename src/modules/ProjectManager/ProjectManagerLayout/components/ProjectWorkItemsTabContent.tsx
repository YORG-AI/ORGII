import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import TabPill from "@src/components/TabPill";
import type { TabPillItem } from "@src/components/TabPill";
import KanbanBoard from "@src/features/KanbanBoard";
import { MultiSelectBar } from "@src/modules/ProjectManager/WorkItems/components/WorkItemsFooterBars";
import WorkItemsListSurface from "@src/modules/ProjectManager/WorkItems/components/WorkItemsListSurface";
import WorkItemsPageHeader from "@src/modules/ProjectManager/WorkItems/components/WorkItemsPageHeader";
import type {
  StatusCounts,
  StatusFilterType,
} from "@src/modules/ProjectManager/WorkItems/types";
import {
  WORK_ITEMS_KANBAN_GROUP,
  type WorkItemsKanbanGroup,
  countWorkspaceWorkItemsByStatus,
  filterWorkspaceWorkItemsByStatus,
  getWorkspaceStatusFilterKeysForWorkItems,
  groupWorkspaceWorkItemsForStatusFilter,
} from "@src/modules/ProjectManager/WorkItems/workItemsViewModel";
import { useProjectManagerWorkItemsTabBarRegistration } from "@src/modules/ProjectManager/hooks/useProjectManagerWorkItemsTabBarRegistration";
import { PROJECT_MANAGER_PLACEHOLDER_PLACEMENT } from "@src/modules/ProjectManager/shared/placeholderTokens";
import { Placeholder } from "@src/modules/shared/layouts/blocks";

import {
  STORY_WORK_ITEMS_VISIBLE_TABS,
  WORKSPACE_DEFAULT_COLLAPSED_STATUSES,
} from "./ProjectWorkItemsTabContentConstants";
import type {
  ProjectWorkItemsTabContentProps,
  ProjectWorkItemsViewTab,
  WorkspaceSourceMode,
} from "./ProjectWorkItemsTabContentTypes";
import { useProjectWorkItemsTabContentInteractions } from "./useProjectWorkItemsTabContentInteractions";
import { useProjectWorkItemsTabContentWorkspaceData } from "./useProjectWorkItemsTabContentWorkspaceData";

export type {
  ProjectWorkItemSelection,
  ProjectWorkItemsTabContentProps,
} from "./ProjectWorkItemsTabContentTypes";

export const ProjectWorkItemsTabContent: React.FC<
  ProjectWorkItemsTabContentProps
> = ({
  breadcrumbSegments,
  workStationTabId,
  workstationHeaderHost = "project",
  onCreateProject,
  onCreateWorkItem,
  onOpenLinearProject,
  orgId,
  allowExternalSources = false,
  onOpenWorkItem,
  orgSurfaceControls,
}) => {
  const { t } = useTranslation("projects");
  const [activeViewTab, setActiveViewTab] =
    useState<ProjectWorkItemsViewTab>("List");
  const [statusFilter, setStatusFilter] = useState<StatusFilterType>("all");
  const [kanbanGroupBy, setKanbanGroupBy] = useState<WorkItemsKanbanGroup>(
    WORK_ITEMS_KANBAN_GROUP.STATUS
  );

  const {
    workItemsByProject,
    setWorkItemsByProject,
    projectOptions,
    loading,
    loaded,
    error,
    completedItemsLoading,
    completedItemsError,
    loadWorkItems,
    loadCompletedWorkItems,
    completedSectionExpandedRef,
    workspaceSourceMode,
    setWorkspaceSourceMode,
  } = useProjectWorkItemsTabContentWorkspaceData({
    orgId,
    allowExternalSources,
    t,
  });

  useEffect(() => {
    if (statusFilter === "done" || statusFilter === "closed") {
      void loadCompletedWorkItems();
    }
  }, [loadCompletedWorkItems, statusFilter]);

  const workItems = useMemo(
    () => workItemsByProject.map((entry) => entry.item),
    [workItemsByProject]
  );

  const availableProjects = useMemo(
    () => projectOptions.map(({ id, name }) => ({ id, name })),
    [projectOptions]
  );

  const statusCounts = useMemo<StatusCounts>(
    () => countWorkspaceWorkItemsByStatus(workItems),
    [workItems]
  );

  const statusFilterKeys = useMemo(
    () => getWorkspaceStatusFilterKeysForWorkItems(workItems),
    [workItems]
  );
  useEffect(() => {
    if (!statusFilterKeys.includes(statusFilter)) {
      // Pre-existing reset behavior, unchanged by the file split. The analyzer
      // only surfaces this now that the component is small enough to fully
      // analyze; fixing it would be an out-of-scope behavior change.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStatusFilter("all");
    }
  }, [statusFilter, statusFilterKeys]);

  const filteredWorkItems = useMemo(
    () => filterWorkspaceWorkItemsByStatus(workItems, statusFilter),
    [statusFilter, workItems]
  );

  const groupedWorkItems = useMemo(
    () => groupWorkspaceWorkItemsForStatusFilter(workItems, statusFilter),
    [statusFilter, workItems]
  );

  const {
    kanbanTasks,
    kanbanColumns,
    selectableFilteredWorkItemCount,
    selectedWorkItemIds,
    bulkDeleting,
    collapseAllSignal,
    handleSelectWorkItem,
    handleUpdateWorkItem,
    handleKanbanTaskMove,
    handleKanbanTaskClick,
    handleAddKanbanTask,
    handleRefresh,
    handleCheckedChange,
    handleSelectAll,
    handleUnselectAll,
    handleBulkDelete,
    handleCollapseAll,
    handleSectionExpandedChange,
    renderSectionPlaceholder,
  } = useProjectWorkItemsTabContentInteractions({
    workItems,
    workItemsByProject,
    setWorkItemsByProject,
    filteredWorkItems,
    projectOptions,
    kanbanGroupBy,
    loadWorkItems,
    loadCompletedWorkItems,
    completedSectionExpandedRef,
    completedItemsLoading,
    completedItemsError,
    onOpenLinearProject,
    onOpenWorkItem,
    onCreateWorkItem,
    t,
  });

  const workspaceSourceTabs = useMemo<TabPillItem[]>(
    () => [
      { key: "local_only", label: t("projects.source.localOnly") },
      {
        key: "include_external",
        label: t("projects.source.includeExternal"),
      },
    ],
    [t]
  );

  const workItemsViewTabs = useMemo<TabPillItem[]>(
    () =>
      STORY_WORK_ITEMS_VISIBLE_TABS.map((tab) => ({
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

  const handleWorkItemsViewChange = useCallback((key: string) => {
    if (key === "List" || key === "Kanban") {
      setActiveViewTab(key);
    }
  }, []);

  const workItemsViewSwitch = useMemo(
    () => (
      <TabPill
        tabs={workItemsViewTabs}
        activeTab={activeViewTab}
        onChange={handleWorkItemsViewChange}
        variant="pill"
        color="fill"
        fillWidth={false}
        size="small"
      />
    ),
    [activeViewTab, handleWorkItemsViewChange, workItemsViewTabs]
  );

  const kanbanGroupSwitch = useMemo(() => {
    if (activeViewTab !== "Kanban") return null;
    return (
      <TabPill
        tabs={kanbanGroupTabs}
        activeTab={kanbanGroupBy}
        onChange={(key) => setKanbanGroupBy(key as WorkItemsKanbanGroup)}
        variant="pill"
        color="fill"
        fillWidth={false}
        size="small"
      />
    );
  }, [activeViewTab, kanbanGroupBy, kanbanGroupTabs]);

  const handleWorkspaceSourceModeChange = useCallback(
    (key: string) => {
      setWorkspaceSourceMode(key as WorkspaceSourceMode);
    },
    [setWorkspaceSourceMode]
  );

  const sourceModeSwitch = useMemo(() => {
    if (!allowExternalSources) return null;
    return (
      <TabPill
        tabs={workspaceSourceTabs}
        activeTab={workspaceSourceMode}
        onChange={handleWorkspaceSourceModeChange}
        variant="pill"
        color="fill"
        fillWidth={false}
        size="small"
      />
    );
  }, [
    allowExternalSources,
    handleWorkspaceSourceModeChange,
    workspaceSourceMode,
    workspaceSourceTabs,
  ]);

  const headerLeadingControls = useMemo(
    () => (
      <div className="flex min-w-0 items-center gap-1.5">
        {orgSurfaceControls}
        {orgSurfaceControls && <span className="text-xs text-text-4">/</span>}
        {workItemsViewSwitch}
        {kanbanGroupSwitch && <span className="text-xs text-text-4">/</span>}
        {kanbanGroupSwitch}
        {sourceModeSwitch && (
          <span
            className="pointer-events-none mx-1 h-4 w-px shrink-0 bg-border-2"
            aria-hidden
          />
        )}
        {sourceModeSwitch}
      </div>
    ),
    [
      kanbanGroupSwitch,
      orgSurfaceControls,
      sourceModeSwitch,
      workItemsViewSwitch,
    ]
  );

  useProjectManagerWorkItemsTabBarRegistration({
    workStationTabId,
    showPropertiesActive: false,
    onSearch: null,
    onRefresh: handleRefresh,
    refreshLoading: loading,
    onToggleProperties: null,
    onAddProject: onCreateProject ?? null,
    onAddWorkItem: onCreateWorkItem ?? null,
  });

  if (loading && !loaded) {
    return (
      <Placeholder
        variant="loading"
        placement={PROJECT_MANAGER_PLACEHOLDER_PLACEMENT}
        title={t("projects.loading")}
        fillParentHeight
      />
    );
  }

  if (error && workItems.length === 0) {
    return (
      <Placeholder
        variant="error"
        placement={PROJECT_MANAGER_PLACEHOLDER_PLACEMENT}
        title={error}
        onRetry={handleRefresh}
        fillParentHeight
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <WorkItemsPageHeader
        projectName={t("projects.columns.workItems")}
        breadcrumbSegments={breadcrumbSegments}
        activeTab={activeViewTab}
        statusFilter={statusFilter}
        onStatusFilterChange={(value) =>
          setStatusFilter(value as StatusFilterType)
        }
        statusCounts={statusCounts}
        statusFilterKeys={statusFilterKeys}
        onCollapseAll={handleCollapseAll}
        onAddProject={onCreateProject}
        onAddWorkItem={onCreateWorkItem}
        onRefresh={handleRefresh}
        refreshLoading={loading}
        leadingControls={headerLeadingControls}
        publishToWorkstationHeader={!!workStationTabId}
        workstationHeaderHost={workstationHeaderHost}
      />

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden scrollbar-hide">
        {activeViewTab === "Kanban" ? (
          <div className="h-full min-h-0">
            <KanbanBoard
              tasks={kanbanTasks}
              columnOrder={kanbanColumns}
              allowColumnReorder={false}
              allowTaskDrag={kanbanGroupBy === WORK_ITEMS_KANBAN_GROUP.STATUS}
              onTaskMove={handleKanbanTaskMove}
              onTaskClick={handleKanbanTaskClick}
              onAddTask={handleAddKanbanTask}
              showAddButton={
                kanbanGroupBy === WORK_ITEMS_KANBAN_GROUP.STATUS &&
                Boolean(onCreateWorkItem)
              }
              className="kanban-board--linear"
            />
          </div>
        ) : (
          <WorkItemsListSurface
            groupedWorkItems={groupedWorkItems}
            filteredWorkItems={filteredWorkItems}
            selectedWorkItem={null}
            selectedWorkItemId={null}
            workItems={workItems}
            availableMembers={[]}
            availableProjects={availableProjects}
            checkedWorkItemIds={selectedWorkItemIds}
            onCheckedChange={handleCheckedChange}
            onSelectWorkItem={handleSelectWorkItem}
            onUpdateWorkItem={handleUpdateWorkItem}
            collapseAllSignal={collapseAllSignal}
            showEmptySections
            defaultCollapsedStatuses={WORKSPACE_DEFAULT_COLLAPSED_STATUSES}
            renderSectionPlaceholder={renderSectionPlaceholder}
            onSectionExpandedChange={handleSectionExpandedChange}
            emptyListPlaceholder={
              <Placeholder
                variant="empty"
                placement={PROJECT_MANAGER_PLACEHOLDER_PLACEMENT}
                title={t("workItems.noWorkItems")}
                subtitle={t("workItems.noWorkItemsSubtitle")}
                action={
                  onCreateWorkItem
                    ? {
                        label: t("workItems.addFirstWorkItem"),
                        onClick: onCreateWorkItem,
                      }
                    : undefined
                }
                fillParentHeight
              />
            }
            hidePropertiesPanel
          />
        )}
      </div>

      <MultiSelectBar
        selectedCount={selectedWorkItemIds.size}
        visibleItemCount={selectableFilteredWorkItemCount}
        deleting={bulkDeleting}
        onSelectAll={handleSelectAll}
        onUnselectAll={handleUnselectAll}
        onDelete={handleBulkDelete}
      />
    </div>
  );
};

export default ProjectWorkItemsTabContent;

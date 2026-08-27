import { ListTodo } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Checkbox from "@src/components/Checkbox";
import { HeaderSectionSeparator } from "@src/components/HeaderSectionSeparator";
import IntegrationIcon from "@src/components/IntegrationIcon";
import { Placeholder } from "@src/components/Placeholder";
import type { SettingsTableSelectFilter } from "@src/components/SettingsTable";
import TabPill from "@src/components/TabPill";
import type { TabPillItem } from "@src/components/TabPill";
import { HEADER_ICON_SIZE } from "@src/config/workstation/tokens";
import { MultiSelectBar } from "@src/modules/ProjectManager/WorkItems/components/WorkItemsFooterBars";
import WorkItemsPageHeader from "@src/modules/ProjectManager/WorkItems/components/WorkItemsPageHeader";
import WorkItemsStatusFilterSelect from "@src/modules/ProjectManager/WorkItems/components/WorkItemsStatusFilterSelect";
import type {
  StatusCounts,
  StatusFilterType,
} from "@src/modules/ProjectManager/WorkItems/types";
import {
  formatWorkItemShortId,
  getWorkItemSourceIntegration,
  isGitHubIssueStatus,
} from "@src/modules/ProjectManager/WorkItems/workItemIdentity";
import {
  WORK_ITEMS_KANBAN_GROUP,
  type WorkItemsKanbanGroup,
  countWorkspaceWorkItemsByStatus,
  filterWorkItemsBySearchQuery,
  filterWorkspaceWorkItemsByStatus,
  getWorkItemStatus,
  getWorkspaceStatusFilterKeysForWorkItems,
  normalizeWorkspaceStatusFilter,
} from "@src/modules/ProjectManager/WorkItems/workItemsViewModel";
import {
  GITHUB_ISSUE_STATUS_OPTIONS,
  WORK_ITEM_STATUS_OPTIONS,
} from "@src/modules/ProjectManager/config/manage";
import { useProjectManagerWorkItemsTabBarRegistration } from "@src/modules/ProjectManager/hooks/useProjectManagerWorkItemsTabBarRegistration";
import { PROJECT_MANAGER_PLACEHOLDER_PLACEMENT } from "@src/modules/ProjectManager/shared/placeholderTokens";
import { WORKSPACE_SOURCE } from "@src/modules/ProjectManager/workspaceAggregate";
import { WorkManagementAssigneeCell } from "@src/modules/shared/components/WorkManagementAssigneeCell";
import {
  WorkManagementTable,
  type WorkManagementTableRow,
} from "@src/modules/shared/components/WorkManagementTable";
import type { WorkItemStatus } from "@src/types/core/workItem";
import { formatRelativeTime } from "@src/util/time/formatRelativeTime";

import { STORY_WORK_ITEMS_VISIBLE_TABS } from "./ProjectWorkItemsTabContentConstants";
import type {
  ProjectWorkItemsTabContentProps,
  ProjectWorkItemsViewTab,
  WorkspaceSourceMode,
} from "./ProjectWorkItemsTabContentTypes";
import { useProjectWorkItemsTabContentInteractions } from "./useProjectWorkItemsTabContentInteractions";
import { useProjectWorkItemsTabContentWorkspaceData } from "./useProjectWorkItemsTabContentWorkspaceData";

const KanbanBoard = React.lazy(() => import("@src/features/KanbanBoard"));

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
  onOpenProjects,
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
  const [searchQuery, setSearchQuery] = useState("");
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

  const statusCounts = useMemo<StatusCounts>(
    () => countWorkspaceWorkItemsByStatus(workItems),
    [workItems]
  );

  const statusFilterKeys = useMemo(
    () => getWorkspaceStatusFilterKeysForWorkItems(workItems),
    [workItems]
  );
  const effectiveStatusFilter = normalizeWorkspaceStatusFilter(
    statusFilter,
    statusFilterKeys
  );
  if (effectiveStatusFilter !== statusFilter) {
    // Normalize the selection in the same render that observes a changed
    // result set. This prevents one committed frame with an impossible filter
    // and avoids a post-commit effect cascade.
    setStatusFilter(effectiveStatusFilter);
  }

  const filteredWorkItems = useMemo(
    () => filterWorkspaceWorkItemsByStatus(workItems, effectiveStatusFilter),
    [effectiveStatusFilter, workItems]
  );

  const visibleWorkItems = useMemo(
    () => filterWorkItemsBySearchQuery(filteredWorkItems, searchQuery),
    [filteredWorkItems, searchQuery]
  );
  const completedStatusSelected =
    effectiveStatusFilter === "done" || effectiveStatusFilter === "closed";

  const {
    kanbanTasks,
    kanbanColumns,
    workItemPeople,
    selectableFilteredWorkItemCount,
    selectedWorkItemIds,
    bulkDeleting,
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
  } = useProjectWorkItemsTabContentInteractions({
    workItems,
    workItemsByProject,
    setWorkItemsByProject,
    filteredWorkItems: visibleWorkItems,
    projectOptions,
    kanbanGroupBy,
    loadWorkItems,
    onOpenLinearProject,
    onOpenWorkItem,
    onCreateWorkItem,
    t,
  });

  const settingsRows = useMemo<WorkManagementTableRow[]>(
    () =>
      visibleWorkItems.map((workItem) => {
        const status = getWorkItemStatus(workItem);
        const isSelected = selectedWorkItemIds.has(workItem.session_id);
        const statusOptions = isGitHubIssueStatus(status)
          ? GITHUB_ISSUE_STATUS_OPTIONS
          : WORK_ITEM_STATUS_OPTIONS;
        const statusOption = statusOptions.find(
          (option) => option.value === status
        );
        const storedId = workItem.shortId || workItem.session_id;
        const displayId =
          formatWorkItemShortId(storedId, status, workItem.project?.name) ??
          storedId;
        const sourceIntegration = getWorkItemSourceIntegration(
          status,
          workItem.workspaceSource?.source
        );
        const tags = Array.from(
          new Set((workItem.labels ?? []).map((label) => label.name))
        );

        return {
          key: workItem.session_id,
          selection: (
            <Checkbox
              checked={isSelected}
              size="small"
              className={`shrink-0 ${
                isSelected ? "" : "[&_[data-checkbox-icon]]:!bg-bg-2"
              }`}
              ariaLabel={t("common:workManagementTable.selectRow", {
                id: displayId,
              })}
              onCheckedChange={(checked) =>
                handleCheckedChange(workItem.session_id, checked)
              }
            />
          ),
          idSortValue: displayId,
          id: (
            <div className="flex min-w-0 items-center gap-1.5">
              {sourceIntegration ? (
                <IntegrationIcon
                  type={sourceIntegration}
                  size={14}
                  className="shrink-0 text-text-2"
                />
              ) : null}
              <span className="min-w-0 truncate">{displayId}</span>
            </div>
          ),
          title: workItem.name || t("workItems.untitledWorkItem"),
          titleLinkOnRowHover: true,
          metadata: workItem.project?.name
            ? [workItem.project.name]
            : undefined,
          tags,
          assignee: (
            <WorkManagementAssigneeCell
              currentAssigneeIds={
                workItem.assignee ? [workItem.assignee.id] : []
              }
              options={workItemPeople.map((person) => ({
                id: person.id,
                label: person.name,
                avatar: person.avatar,
              }))}
              noneLabel={t("workItems.properties.noAssignee")}
              loadingLabel={t("common:status.loading")}
              searchPlaceholder={t("properties.searchAssignee")}
              readonlyReason={t("common:errors.messages.forbidden")}
              disabled={
                workItem.workspaceSource?.source === WORKSPACE_SOURCE.LINEAR ||
                !workItem.project
              }
              dataTestId={`work-item-assignee-${workItem.session_id}`}
              onChangeAssigneeIds={(assigneeIds) => {
                const assignee = workItemPeople.find(
                  (person) => person.id === assigneeIds[0]
                );
                return handleUpdateWorkItem(workItem.session_id, {
                  assignee,
                  assigneeType: assignee ? "human" : undefined,
                });
              }}
            />
          ),
          statusSelect: statusOption
            ? {
                value: status,
                label: t(`workItems.statusLabels.${statusOption.value}`, {
                  defaultValue: statusOption.label,
                }),
                icon: statusOption.icon,
                iconColor: statusOption.color,
                options: statusOptions.map((option) => ({
                  value: option.value,
                  label: t(`workItems.statusLabels.${option.value}`, {
                    defaultValue: option.label,
                  }),
                  icon: option.icon,
                  iconColor: option.color,
                })),
                onChange: (nextStatus) =>
                  handleUpdateWorkItem(workItem.session_id, {
                    workItemStatus: nextStatus as WorkItemStatus,
                  }),
                readonly:
                  workItem.workspaceSource?.source === WORKSPACE_SOURCE.LINEAR,
                dataTestId: `work-item-status-${displayId}`,
              }
            : undefined,
          status: statusOption ? undefined : (
            <span className="capitalize text-text-2">{status}</span>
          ),
          updated: (
            <span title={workItem.updated_time}>
              {formatRelativeTime(workItem.updated_time, "nano") || "—"}
            </span>
          ),
          onClick: () => handleSelectWorkItem(workItem.session_id),
        };
      }),
    [
      handleCheckedChange,
      handleSelectWorkItem,
      handleUpdateWorkItem,
      selectedWorkItemIds,
      t,
      visibleWorkItems,
      workItemPeople,
    ]
  );

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

  const tableSelectFilters = useMemo<SettingsTableSelectFilter[]>(() => {
    const filters: SettingsTableSelectFilter[] = [
      {
        key: "status",
        value: effectiveStatusFilter,
        defaultValue: "all",
        options: statusFilterKeys.map((key) => {
          const label = t(`workItems.statusFilters.${key}`);
          return {
            value: key,
            label: (
              <span className="flex items-center gap-2 whitespace-nowrap">
                <span>{label}</span>
                <span className="tabular-nums text-text-3">
                  {statusCounts[key] ?? 0}
                </span>
              </span>
            ),
            triggerLabel: label,
          };
        }),
        onChange: (value) => setStatusFilter(value as StatusFilterType),
        minWidth: 172,
        appearance: "default",
      },
    ];
    if (allowExternalSources) {
      filters.push({
        key: "source",
        value: workspaceSourceMode,
        defaultValue: "local_only",
        options: workspaceSourceTabs.map((tab) => ({
          value: tab.key,
          label: tab.label,
        })),
        onChange: (value) =>
          setWorkspaceSourceMode(value as WorkspaceSourceMode),
        minWidth: 150,
        appearance: "default",
      });
    }
    return filters;
  }, [
    allowExternalSources,
    setWorkspaceSourceMode,
    statusCounts,
    effectiveStatusFilter,
    statusFilterKeys,
    t,
    workspaceSourceMode,
    workspaceSourceTabs,
  ]);

  const headerLeadingControls = useMemo(
    () => (
      <div className="contents">
        {activeViewTab === "Kanban" ? (
          <>
            <WorkItemsStatusFilterSelect
              value={effectiveStatusFilter}
              onChange={setStatusFilter}
              statusCounts={statusCounts}
              filterKeys={statusFilterKeys}
              dropdownAlign="left"
            />
            <HeaderSectionSeparator />
            {orgSurfaceControls}
            {orgSurfaceControls && <HeaderSectionSeparator />}
          </>
        ) : null}
        {workItemsViewSwitch}
        {kanbanGroupSwitch && <HeaderSectionSeparator />}
        {kanbanGroupSwitch}
        {activeViewTab === "Kanban" && sourceModeSwitch ? (
          <HeaderSectionSeparator />
        ) : null}
        {activeViewTab === "Kanban" ? sourceModeSwitch : null}
      </div>
    ),
    [
      activeViewTab,
      kanbanGroupSwitch,
      orgSurfaceControls,
      sourceModeSwitch,
      statusCounts,
      effectiveStatusFilter,
      statusFilterKeys,
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
        identityIcon={
          <ListTodo size={HEADER_ICON_SIZE.sm} strokeWidth={1.75} />
        }
        onOpenProjects={onOpenProjects}
        activeTab={activeViewTab}
        statusCounts={statusCounts}
        onAddProject={onCreateProject}
        onAddWorkItem={onCreateWorkItem}
        onRefresh={handleRefresh}
        refreshLoading={loading}
        leadingControls={headerLeadingControls}
        publishToWorkstationHeader={!!workStationTabId}
        workstationHeaderHost={workstationHeaderHost}
      />

      <div className="min-h-0 flex-1 overflow-hidden">
        {activeViewTab === "Kanban" ? (
          <div className="h-full min-h-0">
            <React.Suspense
              fallback={<Placeholder variant="loading" fillParentHeight />}
            >
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
            </React.Suspense>
          </div>
        ) : (
          <WorkManagementTable
            rows={settingsRows}
            searchBar={{
              searchValue: searchQuery,
              searchPlaceholder: t("workItems.searchPlaceholder"),
              onSearchChange: setSearchQuery,
              onSearchClear: () => setSearchQuery(""),
            }}
            selectFilters={tableSelectFilters}
            selectFiltersExtra={orgSurfaceControls}
            pageSize={25}
            pageSizeOptions={[10, 25, 50, 100]}
            maxWidth="wide"
            loading={completedStatusSelected && completedItemsLoading}
            testId="workspace-work-items-table"
            noDataElement={
              completedStatusSelected && completedItemsLoading ? (
                <Placeholder
                  variant="loading"
                  placement={PROJECT_MANAGER_PLACEHOLDER_PLACEMENT}
                  title={t("projects.loading")}
                  fillParentHeight
                />
              ) : completedStatusSelected && completedItemsError ? (
                <Placeholder
                  variant="error"
                  placement={PROJECT_MANAGER_PLACEHOLDER_PLACEMENT}
                  title={completedItemsError}
                  onRetry={() => void loadCompletedWorkItems()}
                  fillParentHeight
                />
              ) : workItems.length === 0 ? (
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
              ) : (
                <Placeholder
                  variant="no-results"
                  placement={PROJECT_MANAGER_PLACEHOLDER_PLACEMENT}
                  title={t("workItems.noResults")}
                  fillParentHeight
                />
              )
            }
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

import React, { Suspense, useMemo } from "react";
import { useTranslation } from "react-i18next";

import type {
  PropertyDefinition,
  ScopePropertyValue,
} from "@src/api/http/project";
import { Placeholder } from "@src/components/Placeholder";
import type { CalendarEvent } from "@src/features/CalendarView";
import type { GanttTask } from "@src/features/GanttChart";
import type { KanbanTask, TaskStatus } from "@src/features/KanbanBoard";
import type {
  LinkedRepoOption,
  ProjectData,
} from "@src/modules/ProjectManager/shared";
import InboxListDetailLayout from "@src/modules/shared/layouts/InboxListDetailLayout";
import type { Label, Person, Team } from "@src/types/core/shared";
import type {
  WorkItem as WorkItemExtended,
  WorkItemLabel,
  WorkItemMilestone,
  WorkItemProject,
  WorkItemStatus,
} from "@src/types/core/workItem";

import { indexScopePropertyValues } from "../../propertyViewModel";
import {
  WORK_ITEMS_KANBAN_GROUP,
  type WorkItemGroup,
  type WorkItemsKanbanGroup,
  getPropertyKanbanColumns,
  getWorkItemsKanbanColumns,
  workItemsToKanbanTasks,
  workItemsToPropertyKanbanTasks,
} from "../../workItemsViewModel";
import WorkItemsCompactList from "../WorkItemsCompactList";
import WorkItemsListSurface from "../WorkItemsListSurface";
import type { WorkItemsViewTab } from "../WorkItemsPageHeader";
import type { WorkItemsTableSort } from "../WorkItemsTableView";

const WorkItemsOverview = React.lazy(
  () =>
    import(/* webpackChunkName: "workitems-overview" */ "../WorkItemsOverview")
);

const CalendarView = React.lazy(
  () =>
    import(
      /* webpackChunkName: "workitems-calendar" */ "@src/features/CalendarView"
    )
);
const GanttChart = React.lazy(
  () =>
    import(/* webpackChunkName: "workitems-gantt" */ "@src/features/GanttChart")
);
const KanbanBoard = React.lazy(
  () =>
    import(
      /* webpackChunkName: "workitems-kanban" */ "@src/features/KanbanBoard"
    )
);
const WorkItemsTableView = React.lazy(
  () =>
    import(/* webpackChunkName: "workitems-table" */ "../WorkItemsTableView")
);

/** Pre-computed overview stats from Rust */
interface OverviewStats {
  total: number;
  inProgress: number;
  completed: number;
  completionRate: number;
}

interface WorkItemsTabContentProps {
  statusOrgId: string;
  activeTab: WorkItemsViewTab;
  tableColumns: string[] | null;
  onTableColumnsChange: (columns: string[]) => void;
  tableSort: WorkItemsTableSort | null;
  onTableSortChange: (sort: WorkItemsTableSort | null) => void;
  tablePropertyDefinitions: PropertyDefinition[];
  tablePropertyValues: ScopePropertyValue[];
  tablePropertyGroupBy: string | null;
  onTablePropertyGroupByChange: (propertyId: string | null) => void;
  groupedWorkItems: WorkItemGroup[];
  filteredWorkItems: WorkItemExtended[];
  selectedWorkItem: WorkItemExtended | null;
  selectedWorkItemId: string | null;
  workItems: WorkItemExtended[];
  projectName: string;
  projectDescription?: string;
  projectProperties?: ProjectData;
  hideProjectPropertiesRow?: boolean;
  repoPath?: string | null;
  availableMembers: Person[];
  availableTeams?: Team[];
  projectLabels?: Label[];
  availableRepos?: LinkedRepoOption[];
  availableProjects?: WorkItemProject[];
  availableMilestones?: WorkItemMilestone[];
  availableLabels?: WorkItemLabel[];
  /** Pre-computed overview stats from Rust (preferred over computing from workItems) */
  overviewStats?: OverviewStats;
  checkedWorkItemIds: Set<string>;
  onCheckedChange: (workItemId: string, checked: boolean) => void;
  onSelectWorkItem: (workItemId: string) => void;
  onUpdateWorkItem: (
    workItemId: string,
    updates: Partial<WorkItemExtended>
  ) => void;
  onDeleteWorkItem: (workItemId: string) => Promise<void>;
  onRestoreWorkItem: (workItemId: string) => Promise<void>;
  onAddListItem: (status: WorkItemStatus) => Promise<void>;
  onProjectNameChange: (name: string) => void;
  onProjectDescriptionChange: (html: string, text: string) => void;
  onProjectPropertiesChange?: (updates: Partial<ProjectData>) => void;
  onKanbanTaskMove: (taskId: string, newStatus: TaskStatus) => void;
  onKanbanTaskClick: (task: KanbanTask) => void;
  onAddKanbanTask: (status: TaskStatus) => Promise<void>;
  onGanttTaskClick: (task: GanttTask) => void;
  onGanttTaskUpdate: (
    taskId: string,
    updates: { startDate?: Date; endDate?: Date }
  ) => void;
  onCalendarEventClick: (event: CalendarEvent) => void;
  kanbanGroupBy?: WorkItemsKanbanGroup;
  pinnedKanbanColumnIds?: readonly string[];
  kanbanTasks: KanbanTask[];
  ganttTasks: GanttTask[];
  calendarEvents: CalendarEvent[];
  listFullscreen?: boolean;
  listHeader?: React.ReactNode;
  detailContent: React.ReactNode;
  propertiesPanel: React.ReactNode;
  settingsContent: React.ReactNode;
  emptyListPlaceholder?: React.ReactNode;
  noResultsPlaceholder?: React.ReactNode;
  hidePropertiesPanel?: boolean;
  collapseAllSignal?: number;
  /** Current project work item prefix (e.g. "MAR") for display ID derivation */
  workItemPrefix?: string;
}

const WorkItemsTabContent: React.FC<WorkItemsTabContentProps> = ({
  statusOrgId,
  activeTab,
  tableColumns,
  onTableColumnsChange,
  tableSort,
  onTableSortChange,
  tablePropertyDefinitions,
  tablePropertyValues,
  tablePropertyGroupBy,
  onTablePropertyGroupByChange,
  groupedWorkItems,
  filteredWorkItems,
  selectedWorkItem,
  selectedWorkItemId,
  workItems,
  projectName,
  projectDescription,
  projectProperties,
  hideProjectPropertiesRow = false,
  repoPath,
  availableMembers,
  availableTeams = [],
  projectLabels = [],
  availableRepos = [],
  availableProjects = [],
  availableMilestones = [],
  availableLabels = [],
  overviewStats,
  checkedWorkItemIds,
  onCheckedChange,
  onSelectWorkItem,
  onUpdateWorkItem,
  onDeleteWorkItem,
  onRestoreWorkItem,
  onAddListItem,
  onProjectNameChange,
  onProjectDescriptionChange,
  onProjectPropertiesChange,
  onKanbanTaskMove,
  onKanbanTaskClick,
  onAddKanbanTask,
  onGanttTaskClick,
  onGanttTaskUpdate,
  onCalendarEventClick,
  kanbanGroupBy = WORK_ITEMS_KANBAN_GROUP.STATUS,
  pinnedKanbanColumnIds = [],
  kanbanTasks,
  ganttTasks,
  calendarEvents,
  listFullscreen = false,
  listHeader,
  detailContent,
  propertiesPanel,
  settingsContent,
  emptyListPlaceholder,
  noResultsPlaceholder,
  hidePropertiesPanel = false,
  collapseAllSignal = 0,
  workItemPrefix,
}) => {
  const { t } = useTranslation("projects");

  /** Keep develop's unified list/detail owner while extending its board data. */
  const kanbanPropertyDefinition = useMemo(
    () =>
      tablePropertyDefinitions.find(
        (definition) => definition.id === tablePropertyGroupBy
      ) ?? null,
    [tablePropertyDefinitions, tablePropertyGroupBy]
  );
  const kanbanPropertyValuesByItem = useMemo(
    () => indexScopePropertyValues(tablePropertyValues),
    [tablePropertyValues]
  );
  const effectiveKanbanTasks = useMemo(() => {
    if (kanbanGroupBy === WORK_ITEMS_KANBAN_GROUP.STATUS) return kanbanTasks;
    if (kanbanGroupBy === WORK_ITEMS_KANBAN_GROUP.PROPERTY) {
      return kanbanPropertyDefinition
        ? workItemsToPropertyKanbanTasks(
            filteredWorkItems,
            kanbanPropertyDefinition,
            kanbanPropertyValuesByItem,
            availableMembers
          )
        : [];
    }
    return workItemsToKanbanTasks(filteredWorkItems, kanbanGroupBy);
  }, [
    availableMembers,
    filteredWorkItems,
    kanbanGroupBy,
    kanbanPropertyDefinition,
    kanbanPropertyValuesByItem,
    kanbanTasks,
  ]);
  const kanbanColumns = useMemo(() => {
    if (kanbanGroupBy === WORK_ITEMS_KANBAN_GROUP.PROPERTY) {
      return kanbanPropertyDefinition
        ? getPropertyKanbanColumns(
            filteredWorkItems,
            kanbanPropertyDefinition,
            kanbanPropertyValuesByItem,
            availableMembers,
            t("workItems.properties.noValue")
          )
        : [];
    }
    return getWorkItemsKanbanColumns(
      filteredWorkItems,
      kanbanGroupBy,
      t("workItems.properties.noAssignee"),
      pinnedKanbanColumnIds,
      t("workItems.properties.noProject")
    );
  }, [
    availableMembers,
    filteredWorkItems,
    kanbanGroupBy,
    kanbanPropertyDefinition,
    kanbanPropertyValuesByItem,
    pinnedKanbanColumnIds,
    t,
  ]);

  const renderWithOptionalDetail = (content: React.ReactNode) => {
    const isDetail = !!selectedWorkItem;
    const fullContent = (
      <div className="flex h-full min-h-0 overflow-hidden">
        <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
          <div className="h-full min-h-0">{content}</div>
        </div>
        {!hidePropertiesPanel && propertiesPanel}
      </div>
    );
    return (
      <InboxListDetailLayout
        testId="project-work-items-view-detail-layout"
        detailOpen={isDetail}
        fullContent={fullContent}
        listContent={
          <WorkItemsCompactList
            items={filteredWorkItems}
            selectedWorkItemId={selectedWorkItemId}
            onSelectWorkItem={onSelectWorkItem}
            workItemPrefix={workItemPrefix}
            testId="project-work-items-view-compact-list"
          />
        }
        detailContent={detailContent}
      />
    );
  };

  switch (activeTab) {
    case "Overview":
      return (
        <div className="flex h-full min-h-0 overflow-hidden">
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <div className="min-h-0 flex-1 overflow-auto">
              <Suspense fallback={<Placeholder variant="loading" />}>
                <WorkItemsOverview
                  workItems={workItems}
                  projectName={projectName}
                  projectDescription={projectDescription}
                  repoPath={repoPath}
                  availableMembers={availableMembers}
                  availableTeams={availableTeams}
                  availableLabels={projectLabels}
                  availableRepos={availableRepos}
                  projectProperties={projectProperties}
                  hideProjectPropertiesRow={hideProjectPropertiesRow}
                  onProjectPropertiesChange={onProjectPropertiesChange}
                  precomputedStats={overviewStats}
                  onProjectNameChange={onProjectNameChange}
                  onProjectDescriptionChange={onProjectDescriptionChange}
                />
              </Suspense>
            </div>
          </div>
          {propertiesPanel}
        </div>
      );

    case "Table":
      return renderWithOptionalDetail(
        <Suspense fallback={<Placeholder variant="loading" />}>
          <WorkItemsTableView
            statusOrgId={statusOrgId}
            items={filteredWorkItems}
            members={availableMembers}
            visibleColumns={tableColumns}
            onVisibleColumnsChange={onTableColumnsChange}
            tableSort={tableSort}
            onTableSortChange={onTableSortChange}
            propertyDefinitions={tablePropertyDefinitions}
            propertyValues={tablePropertyValues}
            propertyGroupBy={tablePropertyGroupBy}
            onPropertyGroupByChange={onTablePropertyGroupByChange}
            onRowClick={(workItem) => onSelectWorkItem(workItem.session_id)}
          />
        </Suspense>
      );

    case "Kanban":
      return renderWithOptionalDetail(
        <div className="h-full min-h-0">
          <Suspense fallback={<Placeholder variant="loading" />}>
            <KanbanBoard
              tasks={effectiveKanbanTasks}
              columnOrder={kanbanColumns}
              allowColumnReorder={false}
              allowTaskDrag={kanbanGroupBy === WORK_ITEMS_KANBAN_GROUP.STATUS}
              onTaskMove={onKanbanTaskMove}
              onTaskClick={onKanbanTaskClick}
              onAddTask={onAddKanbanTask}
              showAddButton={kanbanGroupBy === WORK_ITEMS_KANBAN_GROUP.STATUS}
              className="kanban-board--linear"
            />
          </Suspense>
        </div>
      );

    case "Gantt":
      return renderWithOptionalDetail(
        <Suspense fallback={<Placeholder variant="loading" />}>
          <GanttChart
            tasks={ganttTasks}
            onTaskClick={onGanttTaskClick}
            selectedTaskId={selectedWorkItemId}
            editable={true}
            onTaskUpdate={onGanttTaskUpdate}
            showTooltips={true}
            snapToGrid={true}
          />
        </Suspense>
      );

    case "Calendar":
      return renderWithOptionalDetail(
        <Suspense fallback={<Placeholder variant="loading" />}>
          <CalendarView
            events={calendarEvents}
            onEventClick={onCalendarEventClick}
            selectedEventId={selectedWorkItemId}
          />
        </Suspense>
      );

    case "Settings":
      return <>{settingsContent}</>;

    case "List":
    default:
      return (
        <WorkItemsListSurface
          statusOrgId={statusOrgId}
          groupedWorkItems={groupedWorkItems}
          filteredWorkItems={filteredWorkItems}
          selectedWorkItem={selectedWorkItem}
          selectedWorkItemId={selectedWorkItemId}
          workItems={workItems}
          availableMembers={availableMembers}
          availableProjects={availableProjects}
          availableMilestones={availableMilestones}
          availableLabels={availableLabels}
          checkedWorkItemIds={checkedWorkItemIds}
          onCheckedChange={onCheckedChange}
          onSelectWorkItem={onSelectWorkItem}
          onUpdateWorkItem={onUpdateWorkItem}
          onDeleteWorkItem={onDeleteWorkItem}
          onRestoreWorkItem={onRestoreWorkItem}
          onAddListItem={onAddListItem}
          detailContent={detailContent}
          propertiesPanel={propertiesPanel}
          emptyListPlaceholder={emptyListPlaceholder}
          noResultsPlaceholder={noResultsPlaceholder}
          hidePropertiesPanel={hidePropertiesPanel}
          collapseAllSignal={collapseAllSignal}
          workItemPrefix={workItemPrefix}
          hideProjectCell={hideProjectPropertiesRow}
          listFullscreen={listFullscreen}
          listHeader={listHeader}
        />
      );
  }
};

export default WorkItemsTabContent;

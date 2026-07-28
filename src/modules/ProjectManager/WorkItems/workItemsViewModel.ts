import { UserRound } from "lucide-react";

import {
  DEFAULT_KANBAN_COLUMNS,
  GITHUB_ISSUE_KANBAN_COLUMNS,
  type KanbanColumnConfig,
  type KanbanTask,
} from "@src/features/KanbanBoard";
import type {
  StatusCounts,
  StatusFilterType,
} from "@src/modules/ProjectManager/WorkItems/types";
import {
  GITHUB_ISSUE_STATUS_OPTIONS,
  WORK_ITEM_STATUS_OPTIONS,
} from "@src/modules/ProjectManager/config/manage";
import type { DropdownOption, Person } from "@src/types/core/shared";
import {
  GITHUB_ISSUE_STATUS,
  WORK_ITEM_STATUS,
  type WorkItem,
  type WorkItemStatus,
} from "@src/types/core/workItem";

import {
  FILTER_TO_STATUS,
  GITHUB_ISSUE_STATUS_FILTER_KEYS,
  STATUS_FILTER_KEYS,
  WORK_ITEMS_DEFAULT_STATUS,
} from "./types";

export type WorkItemGroupStatus = WorkItemStatus | "deleted";

export interface WorkItemGroup<TWorkItem extends WorkItem = WorkItem> {
  status: WorkItemGroupStatus;
  config: DropdownOption;
  items: TWorkItem[];
}

export interface WorkItemNavigation {
  hasPrev: boolean;
  hasNext: boolean;
  currentIndex: number;
}

export function isDeletedWorkItem(workItem: WorkItem): boolean {
  return Boolean(workItem.deletedAt);
}

export function getWorkItemStatus(workItem: WorkItem): WorkItemStatus {
  return (workItem.workItemStatus ??
    workItem.status ??
    WORK_ITEMS_DEFAULT_STATUS) as WorkItemStatus;
}

export function filterWorkItemsByStatus<TWorkItem extends WorkItem>(
  workItems: TWorkItem[],
  statusFilter: StatusFilterType
): TWorkItem[] {
  const mappedStatus = FILTER_TO_STATUS[statusFilter];
  if (!mappedStatus) return workItems;
  return workItems.filter(
    (workItem) =>
      !isDeletedWorkItem(workItem) &&
      getWorkItemStatus(workItem) === mappedStatus
  );
}

export function groupWorkItemsByStatus<TWorkItem extends WorkItem>(
  workItems: TWorkItem[],
  options?: readonly DropdownOption[]
): WorkItemGroup<TWorkItem>[] {
  const activeItems = workItems.filter(
    (workItem) => !isDeletedWorkItem(workItem)
  );
  const hasGitHubIssueStatuses = activeItems.some((workItem) =>
    GITHUB_ISSUE_STATUS_OPTIONS.some(
      (option) => option.value === getWorkItemStatus(workItem)
    )
  );
  const hasWorkflowStatuses = activeItems.some((workItem) =>
    WORK_ITEM_STATUS_OPTIONS.some(
      (option) => option.value === getWorkItemStatus(workItem)
    )
  );
  const statusOptions =
    options ??
    (hasGitHubIssueStatuses
      ? hasWorkflowStatuses
        ? [...GITHUB_ISSUE_STATUS_OPTIONS, ...WORK_ITEM_STATUS_OPTIONS]
        : GITHUB_ISSUE_STATUS_OPTIONS
      : WORK_ITEM_STATUS_OPTIONS);
  return statusOptions.map((option) => ({
    status: option.value as WorkItemStatus,
    config: option,
    items: activeItems.filter(
      (workItem) => getWorkItemStatus(workItem) === option.value
    ),
  }));
}

export function getStatusFilterKeysForWorkItems(
  workItems: WorkItem[]
): readonly StatusFilterType[] {
  const activeItems = workItems.filter(
    (workItem) => !isDeletedWorkItem(workItem)
  );
  const hasGitHubIssueStatuses = activeItems.some((workItem) => {
    const status = getWorkItemStatus(workItem);
    return (
      status === GITHUB_ISSUE_STATUS.OPEN ||
      status === GITHUB_ISSUE_STATUS.CLOSED
    );
  });
  const hasWorkflowStatuses = activeItems.some((workItem) => {
    const status = getWorkItemStatus(workItem);
    return (
      status !== GITHUB_ISSUE_STATUS.OPEN &&
      status !== GITHUB_ISSUE_STATUS.CLOSED
    );
  });

  if (hasGitHubIssueStatuses && !hasWorkflowStatuses) {
    return GITHUB_ISSUE_STATUS_FILTER_KEYS;
  }
  if (hasGitHubIssueStatuses) {
    return [...GITHUB_ISSUE_STATUS_FILTER_KEYS, ...STATUS_FILTER_KEYS.slice(1)];
  }
  return STATUS_FILTER_KEYS;
}

export function isWorkspaceCompletedWorkItem(workItem: WorkItem): boolean {
  const status = getWorkItemStatus(workItem);
  return (
    status === WORK_ITEM_STATUS.COMPLETED ||
    status === GITHUB_ISSUE_STATUS.CLOSED
  );
}

export function filterWorkspaceWorkItemsByStatus<TWorkItem extends WorkItem>(
  workItems: TWorkItem[],
  statusFilter: StatusFilterType
): TWorkItem[] {
  if (statusFilter === "done" || statusFilter === "closed") {
    return workItems.filter(
      (workItem) =>
        !isDeletedWorkItem(workItem) && isWorkspaceCompletedWorkItem(workItem)
    );
  }
  return filterWorkItemsByStatus(workItems, statusFilter);
}

export function getWorkspaceStatusFilterKeysForWorkItems(
  workItems: WorkItem[]
): readonly StatusFilterType[] {
  const availableKeys = new Set(getStatusFilterKeysForWorkItems(workItems));
  availableKeys.delete("closed");
  availableKeys.add("done");

  return [
    "all",
    ...(availableKeys.has("open") ? (["open"] as const) : []),
    ...STATUS_FILTER_KEYS.slice(1).filter((key) => availableKeys.has(key)),
  ];
}

function mergeWorkspaceCompletedGroups<TWorkItem extends WorkItem>(
  groups: WorkItemGroup<TWorkItem>[]
): WorkItemGroup<TWorkItem>[] {
  const completedItems = groups
    .filter(
      (group) =>
        group.status === WORK_ITEM_STATUS.COMPLETED ||
        group.status === GITHUB_ISSUE_STATUS.CLOSED
    )
    .flatMap((group) => group.items);
  const completedConfig = WORK_ITEM_STATUS_OPTIONS.find(
    (option) => option.value === WORK_ITEM_STATUS.COMPLETED
  );
  if (!completedConfig) return groups;

  const completedGroup: WorkItemGroup<TWorkItem> = {
    status: WORK_ITEM_STATUS.COMPLETED,
    config: completedConfig,
    items: completedItems,
  };
  const mergedGroups: WorkItemGroup<TWorkItem>[] = [];
  let insertedCompletedGroup = false;

  for (const group of groups) {
    if (group.status === GITHUB_ISSUE_STATUS.CLOSED) continue;
    if (group.status === WORK_ITEM_STATUS.COMPLETED) {
      mergedGroups.push(completedGroup);
      insertedCompletedGroup = true;
      continue;
    }
    if (group.status === "deleted" && !insertedCompletedGroup) {
      mergedGroups.push(completedGroup);
      insertedCompletedGroup = true;
    }
    mergedGroups.push(group);
  }

  if (!insertedCompletedGroup) mergedGroups.push(completedGroup);
  return mergedGroups;
}

export function groupWorkspaceWorkItemsForStatusFilter<
  TWorkItem extends WorkItem,
>(
  workItems: TWorkItem[],
  statusFilter: StatusFilterType
): WorkItemGroup<TWorkItem>[] {
  const filteredItems = filterWorkspaceWorkItemsByStatus(
    workItems,
    statusFilter
  );
  const completedFilter = statusFilter === "done" || statusFilter === "closed";
  const groups = groupWorkItemsForStatusFilter(
    filteredItems,
    completedFilter ? "all" : statusFilter
  );
  if (!completedFilter && statusFilter !== "all") return groups;
  const mergedGroups = mergeWorkspaceCompletedGroups(groups);
  return completedFilter
    ? mergedGroups.filter(
        (group) => group.status === WORK_ITEM_STATUS.COMPLETED
      )
    : mergedGroups;
}

export function groupWorkItemsForStatusFilter<TWorkItem extends WorkItem>(
  workItems: TWorkItem[],
  statusFilter: StatusFilterType
): WorkItemGroup<TWorkItem>[] {
  const groups = groupWorkItemsByStatus(workItems);
  if (statusFilter === "all") {
    const deletedItems = workItems.filter(isDeletedWorkItem);
    if (deletedItems.length === 0) return groups;
    return [
      ...groups,
      {
        status: "deleted",
        config: {
          value: "deleted",
          label: "Delete Bin",
          color: "var(--color-text-3)",
        },
        items: deletedItems,
      },
    ];
  }

  const mappedStatus = FILTER_TO_STATUS[statusFilter];
  return groups.filter((group) => group.status === mappedStatus);
}

export const WORK_ITEMS_KANBAN_GROUP = {
  STATUS: "status",
  ASSIGNED_TO: "assigned_to",
  CREATED_BY: "created_by",
} as const;

export type WorkItemsKanbanGroup =
  (typeof WORK_ITEMS_KANBAN_GROUP)[keyof typeof WORK_ITEMS_KANBAN_GROUP];

const UNASSIGNED_PERSON_COLUMN_ID = "person:unassigned" as const;

function getPersonForGroup(
  workItem: WorkItem,
  groupBy: WorkItemsKanbanGroup
): Person | undefined {
  if (groupBy === WORK_ITEMS_KANBAN_GROUP.CREATED_BY) {
    return workItem.createdBy;
  }
  return workItem.assignee;
}

function getPersonColumnId(
  workItem: WorkItem,
  groupBy: WorkItemsKanbanGroup
): KanbanTask["status"] {
  return `person:${getPersonForGroup(workItem, groupBy)?.id || "unassigned"}`;
}

function pinColumnsFirst(
  columns: KanbanColumnConfig[],
  pinnedColumnIds: readonly string[] = []
): KanbanColumnConfig[] {
  if (pinnedColumnIds.length === 0) return columns;
  const firstPinnedColumnId = pinnedColumnIds.find((columnId) =>
    columns.some((column) => column.id === columnId)
  );
  if (!firstPinnedColumnId) return columns;
  return [
    ...columns.filter((column) => column.id === firstPinnedColumnId),
    ...columns.filter((column) => column.id !== firstPinnedColumnId),
  ];
}

function hasGitHubIssueStatus(workItems: WorkItem[]): boolean {
  return workItems.some((workItem) => {
    const status = getWorkItemStatus(workItem);
    return (
      status === GITHUB_ISSUE_STATUS.OPEN ||
      status === GITHUB_ISSUE_STATUS.CLOSED
    );
  });
}

function hasWorkflowStatus(workItems: WorkItem[]): boolean {
  return workItems.some((workItem) => {
    const status = getWorkItemStatus(workItem);
    return DEFAULT_KANBAN_COLUMNS.some((column) => column.id === status);
  });
}

export function getStatusKanbanColumns(
  workItems: WorkItem[]
): KanbanColumnConfig[] {
  const activeItems = workItems.filter(
    (workItem) => !isDeletedWorkItem(workItem)
  );
  const hasIssueStatuses = hasGitHubIssueStatus(activeItems);
  const hasDefaultWorkflowStatuses = hasWorkflowStatus(activeItems);

  if (hasIssueStatuses && !hasDefaultWorkflowStatuses) {
    return GITHUB_ISSUE_KANBAN_COLUMNS;
  }

  if (hasIssueStatuses) {
    return [...GITHUB_ISSUE_KANBAN_COLUMNS, ...DEFAULT_KANBAN_COLUMNS];
  }

  return DEFAULT_KANBAN_COLUMNS;
}

export function getPersonKanbanColumns(
  workItems: WorkItem[],
  groupBy: WorkItemsKanbanGroup,
  unassignedTitle: string,
  pinnedColumnIds: readonly string[] = []
): KanbanColumnConfig[] {
  const people = new Map<string, { name: string; color?: string }>();
  let hasUnassigned = false;

  for (const workItem of workItems) {
    if (isDeletedWorkItem(workItem)) continue;
    const person = getPersonForGroup(workItem, groupBy);
    if (!person) {
      hasUnassigned = true;
      continue;
    }
    people.set(person.id, { name: person.name, color: person.color });
  }

  const personColumns = [...people]
    .sort(([, first], [, second]) => first.name.localeCompare(second.name))
    .map(([id, person]) => {
      const color = person.color || "var(--color-primary-6)";
      return {
        id: `person:${id}` as KanbanTask["status"],
        title: person.name,
        icon: UserRound,
        color,
        bgColor: `color-mix(in srgb, ${color} 10%, transparent)`,
        dotColor: color,
        headerBgColor: `color-mix(in srgb, ${color} 8%, transparent)`,
        showAddButton: false,
      } satisfies KanbanColumnConfig;
    });

  const columns = hasUnassigned
    ? [
        ...personColumns,
        {
          id: UNASSIGNED_PERSON_COLUMN_ID,
          title: unassignedTitle,
          icon: UserRound,
          color: "var(--color-text-3)",
          bgColor: "color-mix(in srgb, var(--color-text-3) 10%, transparent)",
          dotColor: "var(--color-text-3)",
          headerBgColor:
            "color-mix(in srgb, var(--color-text-3) 8%, transparent)",
          showAddButton: false,
        },
      ]
    : personColumns;

  return pinColumnsFirst(columns, pinnedColumnIds);
}

export function getWorkItemsKanbanColumns(
  workItems: WorkItem[],
  groupBy: WorkItemsKanbanGroup,
  unassignedTitle: string,
  pinnedColumnIds: readonly string[] = []
): KanbanColumnConfig[] {
  return groupBy === WORK_ITEMS_KANBAN_GROUP.STATUS
    ? getStatusKanbanColumns(workItems)
    : getPersonKanbanColumns(
        workItems,
        groupBy,
        unassignedTitle,
        pinnedColumnIds
      );
}

export function workItemToKanbanTask(
  workItem: WorkItem,
  groupBy: WorkItemsKanbanGroup = WORK_ITEMS_KANBAN_GROUP.STATUS
): KanbanTask {
  return {
    id: workItem.session_id,
    title: workItem.name,
    description: workItem.spec,
    status:
      groupBy === WORK_ITEMS_KANBAN_GROUP.STATUS
        ? getWorkItemStatus(workItem)
        : getPersonColumnId(workItem, groupBy),
    priority: workItem.priority as KanbanTask["priority"],
    assignee: workItem.assignee?.name,
    labels: workItem.labels,
  };
}

export function workItemsToKanbanTasks(
  workItems: WorkItem[],
  groupBy: WorkItemsKanbanGroup = WORK_ITEMS_KANBAN_GROUP.STATUS
): KanbanTask[] {
  return workItems
    .filter((workItem) => !isDeletedWorkItem(workItem))
    .map((workItem) => workItemToKanbanTask(workItem, groupBy));
}

export function countWorkItemsByStatus(workItems: WorkItem[]): StatusCounts {
  const activeItems = workItems.filter(
    (workItem) => !isDeletedWorkItem(workItem)
  );
  const counts: StatusCounts = {
    all: activeItems.length,
    backlog: 0,
    todo: 0,
    inProgress: 0,
    inReview: 0,
    done: 0,
    cancelled: 0,
    duplicate: 0,
    open: 0,
    closed: 0,
  };

  for (const key of [
    ...STATUS_FILTER_KEYS,
    ...GITHUB_ISSUE_STATUS_FILTER_KEYS,
  ]) {
    if (key === "all") continue;
    const mappedStatus = FILTER_TO_STATUS[key];
    counts[key] = mappedStatus
      ? activeItems.filter(
          (workItem) => getWorkItemStatus(workItem) === mappedStatus
        ).length
      : 0;
  }

  return counts;
}

export function countWorkspaceWorkItemsByStatus(
  workItems: WorkItem[]
): StatusCounts {
  const counts = countWorkItemsByStatus(workItems);
  return {
    ...counts,
    done: counts.done + counts.closed,
    closed: 0,
  };
}

export function getWorkItemNavigation(
  filteredWorkItems: WorkItem[],
  selectedWorkItemId: string | null
): WorkItemNavigation {
  const currentIndex = filteredWorkItems.findIndex(
    (workItem) => workItem.session_id === selectedWorkItemId
  );
  return {
    hasPrev: currentIndex > 0,
    hasNext: currentIndex >= 0 && currentIndex < filteredWorkItems.length - 1,
    currentIndex,
  };
}

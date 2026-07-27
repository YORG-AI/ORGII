/**
 * useWorkItemsData
 *
 * Handles data transformations and computations for work items.
 *
 * OPTIMIZED: Uses Rust-computed view data internally:
 * - Kanban/Gantt/Calendar views computed in Rust
 * - Status grouping computed in Rust
 * - Single IPC call for all view data
 * - Search and status filtering done in Rust
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import { enrichedWorkItemToUI, projectApi } from "@src/api/http/project";
import type {
  LabelEntry,
  MemberEntry,
  RustCalendarEvent,
  RustGanttTask,
  RustKanbanTask,
  WorkItemPartialUpdate,
  WorkItemsViewData,
} from "@src/api/http/project";
import type { CalendarEvent } from "@src/features/CalendarView";
import type { GanttTask } from "@src/features/GanttChart";
import type { KanbanTask } from "@src/features/KanbanBoard";
import { createLogger } from "@src/hooks/logger";
import { useDebouncedCallback } from "@src/hooks/perf";
import { useProjectDataChanged } from "@src/hooks/project";
import type { WorkItem as WorkItemExtended } from "@src/types/core/workItem";
import { LatestScopedTask } from "@src/util/core/latestScopedTask";

import { type OnAssignmentChanges, type StatusFilterType } from "../types";
import {
  countWorkItemsByStatus,
  getWorkItemNavigation,
  groupWorkItemsForStatusFilter,
} from "../workItemsViewModel";

const logger = createLogger("useWorkItemsData");

// ============================================
// Type Converters
// ============================================

/**
 * Convert UI WorkItemExtended partial updates to Rust WorkItemPartialUpdate format.
 * Only includes fields that are present in the input.
 */
function uiToPartialUpdate(
  data: Partial<WorkItemExtended>
): WorkItemPartialUpdate {
  const updates: WorkItemPartialUpdate = {};

  if (data.name !== undefined) {
    updates.title = data.name;
  }
  if (data.spec !== undefined) {
    updates.body = data.spec;
  }
  if (data.workItemStatus !== undefined) {
    updates.status = data.workItemStatus;
  }
  if (data.priority !== undefined) {
    updates.priority = data.priority;
  }
  if ("project" in data) {
    updates.project = data.project?.id ?? null;
  }
  // WorkItem uses `star`, not `starred`
  if (data.star !== undefined) {
    updates.starred = data.star;
  }
  if ("assignee" in data) {
    updates.assignee = data.assignee?.id ?? null;
  }
  if ("assigneeType" in data) {
    updates.assigneeType = data.assigneeType ?? null;
  }
  if ("labels" in data) {
    updates.labels = data.labels?.map((label) => label.id) ?? [];
  }
  if ("milestone" in data) {
    updates.milestone = data.milestone?.id ?? null;
  }
  if ("startDate" in data) {
    updates.startDate = data.startDate ?? null;
  }
  if ("endDate" in data) {
    updates.targetDate = data.endDate ?? null;
  }
  if ("target_date" in data) {
    updates.targetDate = data.target_date ?? null;
  }
  if (data.todos !== undefined) {
    updates.todos = data.todos?.map((todo) => ({
      id: todo.id,
      content: todo.content,
      status: todo.status,
    }));
  }
  if (data.comments !== undefined) {
    updates.comments = data.comments?.map((comment) => ({
      id: comment.id,
      author: comment.author,
      content: comment.content,
      created_at: comment.created_at,
    }));
  }
  if (data.linkedSessions !== undefined) {
    updates.linkedSessions = data.linkedSessions;
  }
  if (data.orchestratorConfig !== undefined) {
    updates.orchestratorConfig = data.orchestratorConfig;
  }
  if (data.orchestratorState !== undefined) {
    updates.orchestratorState = data.orchestratorState;
  }
  if (data.schedule !== undefined) {
    updates.schedule = data.schedule ?? null;
  }
  if (data.executionLock !== undefined) {
    updates.executionLock = data.executionLock ?? null;
  }
  if (data.closeOut !== undefined) {
    updates.closeOut = data.closeOut ?? null;
  }
  if (data.workProducts !== undefined) {
    updates.workProducts = data.workProducts;
  }

  return updates;
}

function rustKanbanToFrontend(task: RustKanbanTask): KanbanTask {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    status: task.status as KanbanTask["status"],
    priority: task.priority as KanbanTask["priority"],
    assignee: task.assignee,
    labels: task.labels,
  };
}

function rustGanttToFrontend(task: RustGanttTask): GanttTask {
  return {
    id: task.id,
    title: task.title,
    startDate: task.startDate,
    endDate: task.endDate,
    status: task.status,
    assignee: task.assignee,
    labels: task.labels,
  };
}

function rustCalendarToFrontend(event: RustCalendarEvent): CalendarEvent {
  return {
    id: event.id,
    title: event.title,
    startDate: event.startDate,
    endDate: event.endDate,
    status: event.status as CalendarEvent["status"],
    assignee: event.assignee,
    labels: event.labels,
    allDay: event.allDay,
  };
}

// ============================================
// Hook
// ============================================

interface UseWorkItemsDataParams {
  searchQuery: string;
  statusFilter: StatusFilterType;
  selectedWorkItemId: string | null;
  localUpdates: Record<string, Partial<WorkItemExtended>>;
  projectSlug: string | null;
  /** Optional callback for assignment change notifications */
  onAssignmentChanges?: OnAssignmentChanges;
  /** Pre-loaded labels from useProjectData — avoids duplicate IPC on sequential path */
  sharedLabels?: LabelEntry[];
  /** Pre-loaded members from useProjectData — avoids duplicate IPC on sequential path */
  sharedMembers?: MemberEntry[];
  /** Whether this tab is currently visible */
  isActive?: boolean;
}

export function useWorkItemsData({
  searchQuery,
  statusFilter,
  selectedWorkItemId,
  localUpdates,
  projectSlug,
  onAssignmentChanges: _onAssignmentChanges,
  sharedLabels: _sharedLabels,
  sharedMembers,
  isActive = true,
}: UseWorkItemsDataParams) {
  // ============================================
  // Rust View Data (optimized path)
  // ============================================

  const [viewData, setViewData] = useState<WorkItemsViewData | null>(null);
  const [viewLoading, setViewLoading] = useState(false);
  const [viewError, setViewError] = useState<string | null>(null);
  const viewLoadCoordinator = useMemo(() => new LatestScopedTask(), []);

  // Debounced search query for IPC calls (avoid IPC on every keystroke)
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState(searchQuery);

  const debouncedSetSearchQuery = useDebouncedCallback(
    (q: string) => setDebouncedSearchQuery(q),
    300
  );

  useEffect(() => {
    debouncedSetSearchQuery(searchQuery);
  }, [searchQuery, debouncedSetSearchQuery]);

  const fetchViewData = useCallback(async () => {
    if (!projectSlug) {
      viewLoadCoordinator.supersede();
      setViewData(null);
      setViewLoading(false);
      return;
    }

    const normalizedSearch = debouncedSearchQuery.trim();
    const scopeKey = JSON.stringify([
      projectSlug,
      statusFilter,
      normalizedSearch,
    ]);
    await viewLoadCoordinator.run(scopeKey, async (context) => {
      setViewLoading(true);
      setViewError(null);

      try {
        await projectApi.purgeExpiredDeletedWorkItems(projectSlug);
        const data = await projectApi.readWorkItemsViewData(projectSlug, {
          statusFilter: statusFilter !== "all" ? statusFilter : undefined,
          searchQuery: normalizedSearch || undefined,
        });
        if (context.isCurrent()) {
          setViewData(data);
        }
      } catch (err) {
        if (!context.isCurrent()) return;
        const message =
          err instanceof Error ? err.message : "Failed to load work items";
        logger.error("View data fetch error:", err);
        setViewError(message);
      } finally {
        if (context.isCurrent()) {
          setViewLoading(false);
        }
      }
    });
  }, [debouncedSearchQuery, projectSlug, statusFilter, viewLoadCoordinator]);

  useEffect(() => {
    void fetchViewData();
    return () => viewLoadCoordinator.supersede();
  }, [fetchViewData, viewLoadCoordinator]);

  // Listen for orgii-data-changed events
  useProjectDataChanged(
    useCallback(() => {
      if (isActive) {
        fetchViewData();
      }
    }, [isActive, fetchViewData])
  );

  // ============================================
  // Write Operations Support
  // ============================================

  // Build shortId map from view data (for getShortId lookup)
  const shortIdMap = useMemo(() => {
    const map = new Map<string, string>();
    if (viewData) {
      for (const item of viewData.items) {
        map.set(item.id, item.shortId);
      }
    }
    return map;
  }, [viewData]);

  const getShortId = useCallback(
    (workItemId: string): string | null => {
      return shortIdMap.get(workItemId) ?? null;
    },
    [shortIdMap]
  );

  // Members: use shared data from useProjectData, only fetch if not provided
  const [localMembers, setLocalMembers] = useState<MemberEntry[]>([]);
  const members = sharedMembers?.length ? sharedMembers : localMembers;

  useEffect(() => {
    if (sharedMembers?.length || !projectSlug) return;
    let cancelled = false;

    projectApi.readMembers(projectSlug).then((file) => {
      if (!cancelled) {
        setLocalMembers(file.members);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [projectSlug, sharedMembers]);

  // Single IPC call: atomic read-modify-write with label/member resolution
  const updateWorkItemSource = useCallback(
    async (
      workItemId: string,
      data: Partial<WorkItemExtended>
    ): Promise<boolean> => {
      try {
        if (!projectSlug) return false;

        const shortId = shortIdMap.get(workItemId);
        if (!shortId) {
          logger.error("Short ID not found for work item:", workItemId);
          return false;
        }

        const updates = uiToPartialUpdate(data);
        if (Object.keys(updates).length === 0) {
          return true;
        }

        const updatedItem = await projectApi.updateWorkItemPartial(
          projectSlug,
          shortId,
          updates
        );

        setViewData((current) => {
          if (!current) return current;
          return {
            ...current,
            items: current.items.map((item) =>
              item.id === updatedItem.id ? updatedItem : item
            ),
          };
        });

        return true;
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : "Failed to update work item";
        logger.error(`Update error for ${workItemId}: ${msg}`);
        return false;
      }
    },
    [projectSlug, shortIdMap]
  );

  const teamId = "file";

  // ============================================
  // Derived Data (from Rust view data)
  // ============================================

  const sourceWorkItems = useMemo(() => {
    if (!viewData) return [];
    return viewData.items.map(enrichedWorkItemToUI);
  }, [viewData]);

  const workItems = useMemo(() => {
    return sourceWorkItems.map((item) => {
      const overrides = localUpdates[item.session_id];
      if (overrides) {
        return { ...item, ...overrides };
      }
      return item;
    });
  }, [sourceWorkItems, localUpdates]);

  // Filtered work items - Rust does the filtering now!
  // We only need JS filtering for instant feedback during search debounce
  const filteredWorkItems = useMemo(() => {
    if (searchQuery === debouncedSearchQuery) {
      return workItems;
    }

    const search = searchQuery.toLowerCase().trim();
    if (!search) {
      return workItems;
    }

    return workItems.filter((workItem) => {
      const name = workItem.name?.toLowerCase() || "";
      const labels =
        workItem.labels?.map((label) => label.name.toLowerCase()).join(" ") ||
        "";
      const assignee = workItem.assignee?.name?.toLowerCase() || "";
      return (
        name.includes(search) ||
        labels.includes(search) ||
        assignee.includes(search)
      );
    });
  }, [workItems, searchQuery, debouncedSearchQuery]);

  const selectedWorkItem = useMemo(
    () =>
      workItems.find((item) => item.session_id === selectedWorkItemId) as
        | WorkItemExtended
        | undefined,
    [workItems, selectedWorkItemId]
  );

  const groupedWorkItems = useMemo(
    () => groupWorkItemsForStatusFilter(filteredWorkItems, statusFilter),
    [filteredWorkItems, statusFilter]
  );

  // ============================================
  // View Data (from Rust - no JS computation!)
  // ============================================

  const kanbanTasks = useMemo((): KanbanTask[] => {
    if (!viewData) return [];
    return viewData.kanbanTasks.map(rustKanbanToFrontend);
  }, [viewData]);

  const ganttTasks = useMemo((): GanttTask[] => {
    if (!viewData) return [];
    return viewData.ganttTasks.map(rustGanttToFrontend);
  }, [viewData]);

  const calendarEvents = useMemo((): CalendarEvent[] => {
    if (!viewData) return [];
    return viewData.calendarEvents.map(rustCalendarToFrontend);
  }, [viewData]);

  const navigation = useMemo(
    () => getWorkItemNavigation(filteredWorkItems, selectedWorkItemId),
    [filteredWorkItems, selectedWorkItemId]
  );

  const statusCounts = useMemo(() => {
    if (!viewData) {
      return {
        all: workItems.length,
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
    }
    const counts = viewData.counts;
    const issueCounts = countWorkItemsByStatus(workItems);
    return {
      all: counts.all,
      backlog: counts.backlog,
      todo: counts.planned, // Rust: "planned" → Frontend: "todo"
      inProgress: counts.inProgress,
      inReview: counts.inReview,
      done: counts.completed,
      cancelled: counts.cancelled,
      duplicate: counts.duplicate,
      open: issueCounts.open,
      closed: issueCounts.closed,
    };
  }, [viewData, workItems]);

  const overviewStats = useMemo(() => {
    const total = statusCounts.all;
    const inProgress = statusCounts.inProgress;
    const completed = statusCounts.done;
    const completionRate =
      total > 0 ? Math.round((completed / total) * 100) : 0;
    return { total, inProgress, completed, completionRate };
  }, [statusCounts]);

  return {
    workItems,
    filteredWorkItems,
    selectedWorkItem,
    groupedWorkItems,
    kanbanTasks,
    ganttTasks,
    calendarEvents,
    navigation,
    statusCounts,
    overviewStats,
    loading: viewLoading,
    error: viewError,
    refresh: fetchViewData,
    updateWorkItemSource,
    teamId,
    getShortId,
    members,
  };
}

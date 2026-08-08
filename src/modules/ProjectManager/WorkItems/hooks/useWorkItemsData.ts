/**
 * useWorkItemsData
 *
 * Handles data transformations and computations for work items.
 *
 * OPTIMIZED: Uses Rust-computed view data internally:
 * - Only the active view projection is computed in Rust
 * - Single IPC call for the active view data
 * - Search and status filtering done in Rust
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { enrichedWorkItemToUI, projectApi } from "@src/api/http/project";
import type {
  LabelEntry,
  MemberEntry,
  RustCalendarEvent,
  RustGanttTask,
  RustKanbanTask,
  WorkItemsViewData,
} from "@src/api/http/project";
import type { CalendarEvent } from "@src/features/CalendarView";
import type { GanttTask } from "@src/features/GanttChart";
import type { KanbanTask } from "@src/features/KanbanBoard";
import { createLogger } from "@src/hooks/logger";
import { useDebouncedCallback } from "@src/hooks/perf";
import { useProjectDataChanged } from "@src/hooks/project";
import { useCurrentUserMemberIds } from "@src/hooks/project/useCurrentUserMemberId";
import type { WorkItem as WorkItemExtended } from "@src/types/core/workItem";

import {
  type OnAssignmentChanges,
  type StatusFilterType,
  type WorkItemsViewTab,
} from "../types";
import { toWorkItemPartialUpdate } from "../workItemPartialUpdate";
import {
  countWorkItemsByStatus,
  filterWorkItemsBySearchQuery,
  getWorkItemNavigation,
  groupWorkItemsForStatusFilter,
} from "../workItemsViewModel";

const logger = createLogger("useWorkItemsData");

// ============================================
// Type Converters
// ============================================

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
  activeView: WorkItemsViewTab;
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
  activeView,
}: UseWorkItemsDataParams) {
  // ============================================
  // Rust View Data (optimized path)
  // ============================================

  const [viewData, setViewData] = useState<WorkItemsViewData | null>(null);
  const [viewLoading, setViewLoading] = useState(false);
  const [viewError, setViewError] = useState<string | null>(null);
  const loadGenerationRef = useRef(0);
  const purgedProjectSlugRef = useRef<string | null>(null);

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
    if (!isActive) return;
    if (!projectSlug) {
      setViewData(null);
      return;
    }

    const loadGeneration = loadGenerationRef.current + 1;
    loadGenerationRef.current = loadGeneration;
    setViewLoading(true);
    setViewError(null);

    try {
      if (purgedProjectSlugRef.current !== projectSlug) {
        await projectApi.purgeExpiredDeletedWorkItems(projectSlug);
        if (loadGenerationRef.current !== loadGeneration) return;
        purgedProjectSlugRef.current = projectSlug;
      }
      const data = await projectApi.readWorkItemsViewData(projectSlug, {
        statusFilter: statusFilter !== "all" ? statusFilter : undefined,
        searchQuery: debouncedSearchQuery.trim() || undefined,
        view:
          activeView === "Kanban"
            ? "kanban"
            : activeView === "Gantt"
              ? "gantt"
              : activeView === "Calendar"
                ? "calendar"
                : "list",
      });
      if (loadGenerationRef.current !== loadGeneration) return;
      setViewData(data);
    } catch (err) {
      if (loadGenerationRef.current !== loadGeneration) return;
      const message =
        err instanceof Error ? err.message : "Failed to load work items";
      logger.error("View data fetch error:", err);
      setViewError(message);
    } finally {
      if (loadGenerationRef.current === loadGeneration) {
        setViewLoading(false);
      }
    }
  }, [activeView, debouncedSearchQuery, isActive, projectSlug, statusFilter]);

  useEffect(() => {
    if (!isActive) {
      loadGenerationRef.current += 1;
      return;
    }
    void fetchViewData();
    return () => {
      loadGenerationRef.current += 1;
    };
  }, [fetchViewData, isActive]);

  // Listen for orgii-data-changed events
  useProjectDataChanged(
    useCallback(
      (change) => {
        if (
          isActive &&
          (!change?.projectSlug || change.projectSlug === projectSlug)
        ) {
          fetchViewData();
        }
      },
      [isActive, fetchViewData, projectSlug]
    )
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
  const { currentUser } = useCurrentUserMemberIds(members);

  useEffect(() => {
    if (!isActive || sharedMembers?.length || !projectSlug) return;
    let cancelled = false;

    projectApi.readMembers(projectSlug).then((file) => {
      if (!cancelled) {
        setLocalMembers(file.members);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [isActive, projectSlug, sharedMembers]);

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

        const updates = toWorkItemPartialUpdate(data, currentUser);
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
    [currentUser, projectSlug, shortIdMap]
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

    return filterWorkItemsBySearchQuery(workItems, searchQuery);
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
    return (viewData.kanbanTasks ?? []).map(rustKanbanToFrontend);
  }, [viewData]);

  const ganttTasks = useMemo((): GanttTask[] => {
    if (!viewData) return [];
    return (viewData.ganttTasks ?? []).map(rustGanttToFrontend);
  }, [viewData]);

  const calendarEvents = useMemo((): CalendarEvent[] => {
    if (!viewData) return [];
    return (viewData.calendarEvents ?? []).map(rustCalendarToFrontend);
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

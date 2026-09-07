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
import { applyWorkItemUpdate } from "../workItemSource";
import {
  countWorkItemsByStatus,
  filterWorkItemsBySearchQuery,
  getWorkItemNavigation,
  groupWorkItemsForStatusFilter,
} from "../workItemsViewModel";
import {
  useCustomStatusOptions,
  useStatusCategoryResolver,
} from "./useStatusDefinitions";
import { useWorkItemRevisionConflict } from "./useWorkItemRevisionConflict";

const logger = createLogger("useWorkItemsData");

interface WorkItemsRevisionAttempt {
  workItemId: string;
  shortId: string;
  updates: Partial<WorkItemExtended>;
  name?: string;
  spec?: string;
}

/** Keep an older async refresh from overwriting a newer local/collab row. */
export function mergeWorkItemsViewDataByRevision(
  current: WorkItemsViewData | null,
  incoming: WorkItemsViewData
): WorkItemsViewData {
  if (!current) return incoming;
  const currentById = new Map(current.items.map((item) => [item.id, item]));
  const staleIds = new Set<string>();
  const items = incoming.items.map((item) => {
    const existing = currentById.get(item.id);
    if (existing && existing.revision > item.revision) {
      staleIds.add(item.id);
      return existing;
    }
    return item;
  });
  const mergeProjection = <T extends { id: string }>(
    next: T[] | undefined,
    previous: T[] | undefined
  ): T[] | undefined => {
    if (!next || !previous || staleIds.size === 0) return next;
    const previousById = new Map(previous.map((entry) => [entry.id, entry]));
    return next.map((entry) =>
      staleIds.has(entry.id) ? (previousById.get(entry.id) ?? entry) : entry
    );
  };
  return {
    ...incoming,
    items,
    kanbanTasks: mergeProjection(incoming.kanbanTasks, current.kanbanTasks),
    ganttTasks: mergeProjection(incoming.ganttTasks, current.ganttTasks),
    calendarEvents: mergeProjection(
      incoming.calendarEvents,
      current.calendarEvents
    ),
  };
}

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
  /** Stable project-store identity; slug alone may be reused after navigation. */
  projectId: string | null;
  projectSlug: string | null;
  statusOrgId: string | null;
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
  projectId,
  projectSlug,
  statusOrgId,
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
      setViewData((current) => mergeWorkItemsViewDataByRevision(current, data));
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
  const revisionMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of viewData?.items ?? []) {
      map.set(item.id, item.revision);
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

  const acceptRevisionRecord = useCallback(
    (record: Awaited<ReturnType<typeof projectApi.readWorkItemEnriched>>) => {
      setViewData((current) => {
        if (!current) return current;
        return {
          ...current,
          items: current.items.map((item) =>
            item.id === record.id ? record : item
          ),
        };
      });
    },
    []
  );
  const readLatestRevisionRecord = useCallback(
    (attempt: WorkItemsRevisionAttempt) =>
      projectSlug
        ? projectApi.readWorkItemEnriched(projectSlug, attempt.shortId)
        : Promise.resolve(null),
    [projectSlug]
  );
  const retryRevisionUpdate = useCallback(
    (attempt: WorkItemsRevisionAttempt, expectedRevision: number) => {
      if (!projectSlug) {
        return Promise.reject(new Error("Project is unavailable"));
      }
      return projectApi.updateWorkItemPartial(
        projectSlug,
        attempt.shortId,
        toWorkItemPartialUpdate(attempt.updates, currentUser),
        expectedRevision
      );
    },
    [currentUser, projectSlug]
  );
  const handleNonTextRevisionConflict = useCallback(() => {
    setViewError(
      "This Work Item changed elsewhere. The latest version was reloaded; your edit was not applied."
    );
  }, []);
  const {
    revisionConflict,
    handleRevisionConflict,
    useLatestRevisionConflict,
    keepMineRevisionConflict,
  } = useWorkItemRevisionConflict({
    identityKey: JSON.stringify([projectId, projectSlug, selectedWorkItemId]),
    readLatest: readLatestRevisionRecord,
    retry: retryRevisionUpdate,
    acceptRecord: acceptRevisionRecord,
    recordTitle: (record) => record.title,
    recordDescription: (record) => record.body,
    recordRevision: (record) => record.revision,
    onReloadFailure: fetchViewData,
    onNonTextConflict: handleNonTextRevisionConflict,
  });

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

        const updatedItem = await applyWorkItemUpdate(
          projectSlug,
          shortId,
          data,
          currentUser,
          revisionMap.get(workItemId)
        );
        if (!updatedItem) return true;

        setViewData((current) => {
          if (!current) return current;
          return {
            ...current,
            items: current.items.map((item) =>
              item.id === updatedItem.id &&
              item.revision <= updatedItem.revision
                ? updatedItem
                : item
            ),
          };
        });

        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const shortId = shortIdMap.get(workItemId);
        if (shortId) {
          await handleRevisionConflict(err, {
            workItemId,
            shortId,
            updates: data,
            name: data.name,
            spec: data.spec,
          });
        }
        logger.error(`Update error for ${workItemId}: ${msg}`);
        return false;
      }
    },
    [currentUser, handleRevisionConflict, projectSlug, revisionMap, shortIdMap]
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

  const customStatusOptions = useCustomStatusOptions(statusOrgId);
  const resolveStatusCategory = useStatusCategoryResolver(statusOrgId);
  const groupedWorkItems = useMemo(
    () =>
      groupWorkItemsForStatusFilter(
        filteredWorkItems,
        statusFilter,
        customStatusOptions,
        resolveStatusCategory
      ),
    [
      filteredWorkItems,
      statusFilter,
      customStatusOptions,
      resolveStatusCategory,
    ]
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
        blocked: 0,
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
      blocked: counts.blocked,
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
    revisionConflict,
    useLatestRevisionConflict,
    keepMineRevisionConflict,
    teamId,
    getShortId,
    members,
  };
}

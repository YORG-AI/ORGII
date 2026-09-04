import { useMemo } from "react";

import type { KanbanTask } from "@src/features/KanbanBoard";

import type { KanbanAgentTypeFilter, KanbanSidebarFilter } from "../config";
import {
  KANBAN_AGENT_TYPE_FILTER,
  KANBAN_COLUMNS,
  KANBAN_SIDEBAR_FILTER,
} from "../config";

export function taskMatchesKanbanAgentTypeFilter(
  task: KanbanTask,
  filter: KanbanAgentTypeFilter
): boolean {
  if (filter === KANBAN_AGENT_TYPE_FILTER.ALL) return true;
  return task.agentTypeFilter === filter;
}

export interface UseTaskKanbanFiltersOptions {
  tasks: KanbanTask[];
  diaryTasks?: KanbanTask[];
  sidebarFilter: KanbanSidebarFilter;
  agentTypeFilter: KanbanAgentTypeFilter;
  selectedTaskId: string | null;
  searchQuery: string;
}

export function normalizeKanbanSearchQuery(value: string): string {
  return value.trim().toLowerCase();
}

export function buildTaskSessionNameSearchText(task: KanbanTask): string {
  return task.title.toLowerCase();
}

export function useTaskKanbanFilters({
  tasks,
  diaryTasks,
  sidebarFilter,
  agentTypeFilter,
  selectedTaskId,
  searchQuery,
}: UseTaskKanbanFiltersOptions) {
  const normalizedSearchQuery = normalizeKanbanSearchQuery(searchQuery);
  const searchActive = normalizedSearchQuery.length > 0;

  const applyVisibleFilters = useMemo(() => {
    return (sourceTasks: KanbanTask[], includeSearch: boolean) =>
      sourceTasks.filter((task) => {
        if (sidebarFilter !== KANBAN_SIDEBAR_FILTER.ALL) {
          const status = task.status as KanbanSidebarFilter;
          if (status !== sidebarFilter) return false;
        }

        if (agentTypeFilter !== KANBAN_AGENT_TYPE_FILTER.ALL) {
          if (!taskMatchesKanbanAgentTypeFilter(task, agentTypeFilter)) {
            return false;
          }
        }

        if (
          includeSearch &&
          searchActive &&
          !buildTaskSessionNameSearchText(task).includes(normalizedSearchQuery)
        ) {
          return false;
        }

        return true;
      });
  }, [agentTypeFilter, normalizedSearchQuery, searchActive, sidebarFilter]);

  const visibleTasks = useMemo(
    () => applyVisibleFilters(tasks, true),
    [applyVisibleFilters, tasks]
  );

  const visibleDiaryTasks = useMemo(
    () => applyVisibleFilters(diaryTasks ?? tasks, false),
    [applyVisibleFilters, diaryTasks, tasks]
  );

  const visibleColumns = useMemo(() => {
    if (sidebarFilter === KANBAN_SIDEBAR_FILTER.ALL) return KANBAN_COLUMNS;
    return KANBAN_COLUMNS.filter((column) => column.id === sidebarFilter);
  }, [sidebarFilter]);

  const selectedTask: KanbanTask | null = useMemo(() => {
    if (!selectedTaskId) return null;

    return (
      visibleTasks.find((task) => task.id === selectedTaskId) ??
      tasks.find((task) => task.id === selectedTaskId) ??
      (diaryTasks ?? []).find((task) => task.id === selectedTaskId) ??
      null
    );
  }, [diaryTasks, selectedTaskId, tasks, visibleTasks]);

  return {
    visibleTasks,
    visibleDiaryTasks,
    visibleColumns,
    selectedTask,
  };
}

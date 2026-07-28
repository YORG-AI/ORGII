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
  fileSearchQuery: string;
}

export function normalizeFileSearchQuery(value: string): string {
  return value.trim().replace(/\\/g, "/").toLowerCase();
}

export function buildTaskFileSearchText(task: KanbanTask): string {
  return (task.impact?.touchedFiles ?? [])
    .map((path) => path.replace(/\\/g, "/").toLowerCase())
    .join("\u0000");
}

export function useTaskKanbanFilters({
  tasks,
  diaryTasks,
  sidebarFilter,
  agentTypeFilter,
  selectedTaskId,
  fileSearchQuery,
}: UseTaskKanbanFiltersOptions) {
  const normalizedFileQuery = normalizeFileSearchQuery(fileSearchQuery);
  const fileSearchActive = normalizedFileQuery.length > 0;
  const fileSearchTextByTaskId = useMemo(() => {
    if (!fileSearchActive) return new Map<string, string>();
    const index = new Map<string, string>();
    for (const task of tasks) {
      index.set(task.id, buildTaskFileSearchText(task));
    }
    return index;
  }, [fileSearchActive, tasks]);

  const applyVisibleFilters = useMemo(() => {
    return (sourceTasks: KanbanTask[], includeFileSearch: boolean) =>
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
          includeFileSearch &&
          fileSearchActive &&
          !fileSearchTextByTaskId.get(task.id)?.includes(normalizedFileQuery)
        ) {
          return false;
        }

        return true;
      });
  }, [
    agentTypeFilter,
    fileSearchActive,
    fileSearchTextByTaskId,
    normalizedFileQuery,
    sidebarFilter,
  ]);

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

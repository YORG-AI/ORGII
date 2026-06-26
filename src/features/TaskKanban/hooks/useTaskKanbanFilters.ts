import { useAtomValue } from "jotai";
import { useMemo } from "react";

import type { ImportedHistorySourceId } from "@src/api/tauri/importedHistory";
import { DISPATCH_CATEGORY } from "@src/api/tauri/session";
import type { KanbanTask } from "@src/features/KanbanBoard";
import { type Session, sessionMapAtom } from "@src/store/session";
import {
  getDispatchCategory,
  getExternalHistorySourceId,
} from "@src/util/session/sessionDispatch";

import type { KanbanAgentTypeFilter, KanbanSidebarFilter } from "../config";
import {
  KANBAN_AGENT_TYPE_FILTER,
  KANBAN_COLUMNS,
  KANBAN_SIDEBAR_FILTER,
} from "../config";

const EXTERNAL_HISTORY_FILTER_BY_SOURCE: Record<
  ImportedHistorySourceId,
  KanbanAgentTypeFilter
> = {
  codex_app: KANBAN_AGENT_TYPE_FILTER.CODEX,
  claude_code: KANBAN_AGENT_TYPE_FILTER.CLAUDE_CODE,
  opencode: KANBAN_AGENT_TYPE_FILTER.OPENCODE,
  windsurf: KANBAN_AGENT_TYPE_FILTER.WINDSURF,
  workbuddy: KANBAN_AGENT_TYPE_FILTER.WORKBUDDY,
};

function matchesAgentTypeFilter(
  session: Session | undefined,
  sessionId: string | undefined,
  filter: KanbanAgentTypeFilter
): boolean {
  if (filter === KANBAN_AGENT_TYPE_FILTER.ALL) return true;
  if (!sessionId) return false;

  const category = getDispatchCategory(sessionId);
  if (filter === KANBAN_AGENT_TYPE_FILTER.CURSOR_IDE) {
    return category === DISPATCH_CATEGORY.CURSOR_IDE;
  }

  if (category === DISPATCH_CATEGORY.RUST_AGENT) {
    return session?.agentDefinitionId === filter;
  }

  if (category === DISPATCH_CATEGORY.EXTERNAL_HISTORY) {
    const sourceId = getExternalHistorySourceId(sessionId);
    return sourceId
      ? EXTERNAL_HISTORY_FILTER_BY_SOURCE[sourceId] === filter
      : false;
  }

  return session?.cliAgentType === filter;
}

export interface UseTaskKanbanFiltersOptions {
  tasks: KanbanTask[];
  diaryTasks?: KanbanTask[];
  sidebarFilter: KanbanSidebarFilter;
  agentTypeFilter: KanbanAgentTypeFilter;
  selectedTaskId: string | null;
}

export function useTaskKanbanFilters({
  tasks,
  diaryTasks,
  sidebarFilter,
  agentTypeFilter,
  selectedTaskId,
}: UseTaskKanbanFiltersOptions) {
  const sessionMap = useAtomValue(sessionMapAtom);

  const applyVisibleFilters = useMemo(() => {
    return (sourceTasks: KanbanTask[]) =>
      sourceTasks.filter((task) => {
        if (sidebarFilter !== KANBAN_SIDEBAR_FILTER.ALL) {
          const status = task.status as KanbanSidebarFilter;
          if (status !== sidebarFilter) return false;
        }

        if (agentTypeFilter !== KANBAN_AGENT_TYPE_FILTER.ALL) {
          const session = task.session_id
            ? sessionMap.get(task.session_id)
            : undefined;
          if (
            !matchesAgentTypeFilter(session, task.session_id, agentTypeFilter)
          ) {
            return false;
          }
        }

        return true;
      });
  }, [agentTypeFilter, sessionMap, sidebarFilter]);

  const visibleTasks = useMemo(
    () => applyVisibleFilters(tasks),
    [applyVisibleFilters, tasks]
  );

  const visibleDiaryTasks = useMemo(
    () => applyVisibleFilters(diaryTasks ?? tasks),
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
    sessionMap,
    visibleTasks,
    visibleDiaryTasks,
    visibleColumns,
    selectedTask,
  };
}

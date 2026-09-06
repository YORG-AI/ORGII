/**
 * Re-export shared Kanban types from the canonical source.
 * TaskKanban uses the same KanbanTask shape as the generic KanbanBoard feature.
 */
export type {
  KanbanTask,
  KanbanResultStatus,
  TaskStatus,
} from "@src/features/KanbanBoard/types";

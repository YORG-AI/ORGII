import type { KanbanTask } from "@src/features/KanbanBoard/types";

export function getTaskTimestamp(task: KanbanTask): number {
  const timestamp = task.updated_at || task.created_at;
  if (!timestamp) return 0;
  return new Date(timestamp).getTime();
}

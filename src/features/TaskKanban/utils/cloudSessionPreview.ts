/**
 * Which task the board's preview window should render while (and after) a
 * remote Team Session imports.
 *
 * A cloud card carries no `session_id` of its own, and the imported local copy
 * only joins the board once its transcript lands. Until then the cloud card is
 * previewed with that pending session id grafted on; after it lands, the
 * imported task takes over (the cloud row is dropped from the projection as a
 * duplicate of the local copy).
 */
import type { KanbanTask } from "@src/features/KanbanBoard";
import type { KanbanCloudPreviewTarget } from "@src/store/ui/kanbanViewStateAtom";

export function resolveKanbanPreviewTask(
  selectedTask: KanbanTask | null,
  cloudPreviewTarget: KanbanCloudPreviewTarget | null,
  allTasks: readonly KanbanTask[]
): KanbanTask | null {
  if (!cloudPreviewTarget) return selectedTask;
  // The user moved on to another card; the preview target is stale context.
  if (selectedTask && selectedTask.id !== cloudPreviewTarget.taskId) {
    return selectedTask;
  }
  const importedTask = allTasks.find(
    (task) => task.session_id === cloudPreviewTarget.sessionId
  );
  if (importedTask) return importedTask;
  return selectedTask
    ? { ...selectedTask, session_id: cloudPreviewTarget.sessionId }
    : null;
}

/**
 * Which task the board's preview window should render while (and after) a
 * Team Session replays.
 *
 * A cloud card carries no `session_id` of its own, and the local copy the
 * replay imports only joins the board once its transcript lands. Until then
 * the cloud card is previewed with that pending session id grafted on; after
 * it lands, the imported task takes over (the cloud row is dropped from the
 * projection as a duplicate of the local copy).
 */
import type { KanbanTask } from "@src/features/KanbanBoard";
import type { KanbanCloudReplayTarget } from "@src/store/ui/kanbanViewStateAtom";

export function resolveKanbanPreviewTask(
  selectedTask: KanbanTask | null,
  cloudReplayTarget: KanbanCloudReplayTarget | null,
  allTasks: readonly KanbanTask[]
): KanbanTask | null {
  if (!cloudReplayTarget) return selectedTask;
  // The user moved on to another card; the replay target is stale context.
  if (selectedTask && selectedTask.id !== cloudReplayTarget.taskId) {
    return selectedTask;
  }
  const importedTask = allTasks.find(
    (task) => task.session_id === cloudReplayTarget.sessionId
  );
  if (importedTask) return importedTask;
  return selectedTask
    ? { ...selectedTask, session_id: cloudReplayTarget.sessionId }
    : null;
}

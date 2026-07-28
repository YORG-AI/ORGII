export const INITIAL_TASK_RENDER_COUNT = 25;
export const TASK_RENDER_BATCH_SIZE = 25;

/** Return the next bounded reveal size for a single Kanban column. */
export function getNextTaskRenderCount(
  currentCount: number,
  totalCount: number
): number {
  return Math.min(currentCount + TASK_RENDER_BATCH_SIZE, totalCount);
}

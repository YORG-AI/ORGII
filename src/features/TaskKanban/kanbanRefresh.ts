export interface KanbanRefreshSources {
  refreshLocal: () => void | Promise<void>;
  refreshCloud: () => void | Promise<void>;
}

/**
 * Refresh every authoritative Kanban source while callers keep the current
 * projection visible. Source owners retain their existing single-flight and
 * identity-generation guards.
 */
export async function refreshKanbanSources({
  refreshLocal,
  refreshCloud,
}: KanbanRefreshSources): Promise<void> {
  await Promise.all([
    Promise.resolve(refreshLocal()),
    Promise.resolve(refreshCloud()),
  ]);
}

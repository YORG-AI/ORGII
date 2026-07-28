import { workstationWorkspaceId } from "./storage";
import type { WorkstationWorkspaceKey } from "./types";

/**
 * Pending File Opens — workspace-scoped module queue.
 *
 * Producers capture the WorkStation workspace before navigation and queue the
 * files against that immutable key. The Code Editor consumes only the queue
 * for the workspace it is currently presenting, so a delayed mount cannot
 * open session A's files in session B after the user switches sessions.
 */
export interface PendingFileOpen {
  path: string;
  line?: number;
}

const queues = new Map<string, PendingFileOpen[]>();

/** Replace the pending file list for exactly one workspace. */
export function queueFileOpens(
  workspace: WorkstationWorkspaceKey,
  files: PendingFileOpen[]
): void {
  const id = workstationWorkspaceId(workspace);
  if (files.length === 0) {
    queues.delete(id);
    return;
  }
  queues.set(id, files);
}

/** Consume only the files queued for the specified workspace. */
export function consumePendingFileOpens(
  workspace: WorkstationWorkspaceKey
): PendingFileOpen[] {
  const id = workstationWorkspaceId(workspace);
  const files = queues.get(id) ?? [];
  queues.delete(id);
  return files;
}

/** Drop delayed file opens when their owning session workspace is disposed. */
export function clearPendingFileOpensForSession(sessionId: string): void {
  queues.delete(workstationWorkspaceId({ kind: "session", sessionId }));
}

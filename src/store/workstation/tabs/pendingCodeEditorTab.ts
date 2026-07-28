import { workstationWorkspaceId } from "./storage";
import type { WorkstationWorkspaceKey } from "./types";

const pendingTabIds = new Map<string, string>();

export function queuePendingCodeEditorTab(
  workspace: WorkstationWorkspaceKey,
  tabId: string
): void {
  pendingTabIds.set(workstationWorkspaceId(workspace), tabId);
}

export function consumePendingCodeEditorTab(
  workspace: WorkstationWorkspaceKey
): string | null {
  const workspaceId = workstationWorkspaceId(workspace);
  const tabId = pendingTabIds.get(workspaceId) ?? null;
  pendingTabIds.delete(workspaceId);
  return tabId;
}

export function clearPendingCodeEditorTabForSession(sessionId: string): void {
  pendingTabIds.delete(workstationWorkspaceId({ kind: "session", sessionId }));
}

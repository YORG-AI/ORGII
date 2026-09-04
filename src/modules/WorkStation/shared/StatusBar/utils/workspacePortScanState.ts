/**
 * Reducer for workspace port scan notifications.
 *
 * Lives apart from the scanner component so every scan subscriber folds an
 * update the same way, and so the identity-stable bail-out is unit testable.
 */
import type { WorkspacePortScanResult } from "@src/api/tauri/workspacePorts";
import type { WorkspacePortsState } from "@src/store/workstation/codeEditor/workspacePortsAtom";

export interface WorkspacePortScanUpdate {
  refreshing: boolean;
  result?: WorkspacePortScanResult;
  lastScanStartedAt?: number;
}

/**
 * Fold one scan notification into the port state.
 *
 * Returns `previous` unchanged when nothing moved. More than one subscriber
 * can be mounted at a time (the background scanner and the open ports menu),
 * and each of them applies the same update; the identity bail-out keeps the
 * duplicates from re-rendering every port row twice.
 */
export function applyWorkspacePortScanUpdate(
  previous: WorkspacePortsState,
  update: WorkspacePortScanUpdate
): WorkspacePortsState {
  const next: WorkspacePortsState = {
    result: update.result ?? previous.result,
    refreshing: update.refreshing,
    lastScanStartedAt: update.lastScanStartedAt ?? previous.lastScanStartedAt,
  };

  if (
    next.result === previous.result &&
    next.refreshing === previous.refreshing &&
    next.lastScanStartedAt === previous.lastScanStartedAt
  ) {
    return previous;
  }

  return next;
}

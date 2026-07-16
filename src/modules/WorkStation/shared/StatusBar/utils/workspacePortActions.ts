/**
 * Scan / kill orchestration for workspace ports (coalesced, min-interval).
 */
import {
  type WorkspacePortProbe,
  type WorkspacePortScanResult,
  ingestWorkspacePortAdvertisedUrl,
  killWorkspacePort,
  scanWorkspacePorts,
} from "@src/api/tauri/workspacePorts";
import { createLogger } from "@src/hooks/logger";
import {
  WORKSPACE_PORT_MIN_INTERVAL_MS,
  WORKSPACE_PORT_STOP_SETTLE_MS,
} from "@src/store/workstation/codeEditor/workspacePortsAtom";

const logger = createLogger("WorkspacePorts");

type ScanListener = (update: {
  refreshing: boolean;
  result?: WorkspacePortScanResult;
  lastScanStartedAt?: number;
}) => void;

let inFlightScan: Promise<WorkspacePortScanResult> | null = null;
let lastScanStartedAt = 0;
const listeners = new Set<ScanListener>();

export function subscribeWorkspacePortScan(listener: ScanListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notifyListeners(update: {
  refreshing: boolean;
  result?: WorkspacePortScanResult;
  lastScanStartedAt?: number;
}): void {
  for (const listener of listeners) {
    listener(update);
  }
}

export async function refreshWorkspacePortScan(params: {
  folders: WorkspacePortProbe[];
  force?: boolean;
}): Promise<WorkspacePortScanResult | null> {
  const now = Date.now();
  if (
    !params.force &&
    now - lastScanStartedAt < WORKSPACE_PORT_MIN_INTERVAL_MS
  ) {
    return null;
  }

  if (inFlightScan) {
    return inFlightScan;
  }

  lastScanStartedAt = now;
  notifyListeners({ refreshing: true, lastScanStartedAt });

  const promise = scanWorkspacePorts(params.folders)
    .then((result) => {
      notifyListeners({
        refreshing: false,
        result,
        lastScanStartedAt,
      });
      return result;
    })
    .catch((error: unknown) => {
      logger.warn("workspace port scan failed:", error);
      notifyListeners({ refreshing: false, lastScanStartedAt });
      throw error;
    })
    .finally(() => {
      if (inFlightScan === promise) {
        inFlightScan = null;
      }
    });

  inFlightScan = promise;
  return promise;
}

export async function stopWorkspacePort(params: {
  folders: WorkspacePortProbe[];
  pid: number;
  port: number;
}): Promise<{ ok: boolean; reason?: string }> {
  const result = await killWorkspacePort(params);
  if (!result.ok) {
    return result;
  }

  await refreshWorkspacePortScan({ folders: params.folders, force: true });
  window.setTimeout(() => {
    void refreshWorkspacePortScan({ folders: params.folders, force: true });
  }, WORKSPACE_PORT_STOP_SETTLE_MS);

  return result;
}

export async function ingestAdvertisedUrlAndMaybeRefresh(params: {
  folderId: string;
  origin: string;
  folders: WorkspacePortProbe[];
}): Promise<boolean> {
  const result = await ingestWorkspacePortAdvertisedUrl({
    folderId: params.folderId,
    origin: params.origin,
  });
  if (!result.accepted) {
    return false;
  }
  await refreshWorkspacePortScan({ folders: params.folders });
  return true;
}

/**
 * Workspace listening-port scan state for the editor status bar.
 */
import { atom } from "jotai";

import type {
  WorkspacePort,
  WorkspacePortProbe,
  WorkspacePortScanResult,
} from "@src/api/tauri/workspacePorts";
import { workspaceFoldersAtom } from "@src/store/ui/workspaceFoldersAtom";

export const WORKSPACE_PORT_SCAN_INTERVAL_MS = 60_000;
export const WORKSPACE_PORT_MIN_INTERVAL_MS = 10_000;
export const WORKSPACE_PORT_ADVERTISED_URL_DEBOUNCE_MS = 1_000;
export const WORKSPACE_PORT_STOP_SETTLE_MS = 500;

export interface WorkspacePortsState {
  result: WorkspacePortScanResult | null;
  refreshing: boolean;
  lastScanStartedAt: number;
}

export const workspacePortsStateAtom = atom<WorkspacePortsState>({
  result: null,
  refreshing: false,
  lastScanStartedAt: 0,
});
workspacePortsStateAtom.debugLabel = "workspacePortsStateAtom";

export const workspacePortsRefreshingAtom = atom((get) => {
  return get(workspacePortsStateAtom).refreshing;
});
workspacePortsRefreshingAtom.debugLabel = "workspacePortsRefreshingAtom";

export const workspacePortsAtom = atom((get) => {
  return get(workspacePortsStateAtom).result?.ports ?? [];
});
workspacePortsAtom.debugLabel = "workspacePortsAtom";

export const workspacePortCountAtom = atom((get) => {
  return get(workspacePortsAtom).filter((port) => port.kind === "workspace")
    .length;
});
workspacePortCountAtom.debugLabel = "workspacePortCountAtom";

export const externalPortCountAtom = atom((get) => {
  return get(workspacePortsAtom).filter((port) => port.kind !== "workspace")
    .length;
});
externalPortCountAtom.debugLabel = "externalPortCountAtom";

export const workspacePortProbesAtom = atom((get): WorkspacePortProbe[] => {
  return get(workspaceFoldersAtom).map((folder) => ({
    id: folder.id,
    repoId: folder.repoId ?? folder.id,
    displayName: folder.name,
    path: folder.path,
  }));
});
workspacePortProbesAtom.debugLabel = "workspacePortProbesAtom";

export function groupWorkspacePorts(ports: WorkspacePort[]): {
  workspaceGroups: Array<{
    folderId: string;
    displayName: string;
    ports: WorkspacePort[];
  }>;
  externalPorts: WorkspacePort[];
} {
  const groups = new Map<
    string,
    { folderId: string; displayName: string; ports: WorkspacePort[] }
  >();
  const externalPorts: WorkspacePort[] = [];

  for (const port of ports) {
    if (port.kind === "workspace" && port.owner) {
      const existing = groups.get(port.owner.folderId);
      if (existing) {
        existing.ports.push(port);
      } else {
        groups.set(port.owner.folderId, {
          folderId: port.owner.folderId,
          displayName: port.owner.displayName,
          ports: [port],
        });
      }
      continue;
    }
    externalPorts.push(port);
  }

  return {
    workspaceGroups: Array.from(groups.values()),
    externalPorts,
  };
}

export function addressForPort(port: WorkspacePort): string {
  if (port.advertisedUrl) {
    try {
      const parsed = new URL(port.advertisedUrl);
      return parsed.host;
    } catch {
      // Fall through to connect host.
    }
  }
  return `${formatHostForUrl(port.connectHost)}:${port.port}`;
}

export function browserUrlForPort(port: WorkspacePort): string {
  if (port.advertisedUrl) {
    return port.advertisedUrl.endsWith("/")
      ? port.advertisedUrl
      : `${port.advertisedUrl}/`;
  }
  const protocol = port.protocol === "https" ? "https" : "http";
  return `${protocol}://${formatHostForUrl(port.connectHost)}:${port.port}/`;
}

export function canStopWorkspacePort(port: WorkspacePort): boolean {
  return (
    port.kind === "workspace" &&
    typeof port.pid === "number" &&
    port.pid > 0 &&
    port.processName?.toLowerCase() !== "electron"
  );
}

function formatHostForUrl(host: string): string {
  if (host.includes(":") && !host.startsWith("[") && !host.endsWith("]")) {
    return `[${host}]`;
  }
  return host;
}

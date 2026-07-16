/**
 * Workspace listening-port scan / kill / advertised-URL ingest.
 */
import { invoke } from "@tauri-apps/api/core";

export type WorkspacePortAttributionConfidence = "cwd" | "command" | "none";

export type WorkspacePortKind = "workspace" | "container" | "external";

export type WorkspacePortProtocol = "http" | "https" | "unknown";

export interface WorkspacePortProbe {
  id: string;
  repoId: string;
  displayName: string;
  path: string;
}

export interface WorkspacePortOwner {
  folderId: string;
  repoId: string;
  displayName: string;
  path: string;
  confidence: WorkspacePortAttributionConfidence;
}

export interface WorkspacePort {
  id: string;
  bindHost: string;
  connectHost: string;
  port: number;
  pid?: number;
  processName?: string;
  protocol: WorkspacePortProtocol;
  kind: WorkspacePortKind;
  owner?: WorkspacePortOwner;
  advertisedUrl?: string;
}

export interface WorkspacePortScanResult {
  platform: string;
  scannedAt: number;
  ports: WorkspacePort[];
  unavailableReason?: string;
}

export interface WorkspacePortKillResult {
  ok: boolean;
  reason?: string;
}

export interface WorkspacePortIngestAdvertisedUrlResult {
  accepted: boolean;
  port?: number;
}

export async function scanWorkspacePorts(
  folders: WorkspacePortProbe[]
): Promise<WorkspacePortScanResult> {
  return invoke<WorkspacePortScanResult>("workspace_ports_scan", {
    request: { folders },
  });
}

export async function killWorkspacePort(params: {
  folders: WorkspacePortProbe[];
  pid: number;
  port: number;
}): Promise<WorkspacePortKillResult> {
  return invoke<WorkspacePortKillResult>("workspace_ports_kill", {
    request: params,
  });
}

export async function ingestWorkspacePortAdvertisedUrl(params: {
  folderId: string;
  origin: string;
}): Promise<WorkspacePortIngestAdvertisedUrlResult> {
  return invoke<WorkspacePortIngestAdvertisedUrlResult>(
    "workspace_ports_ingest_advertised_url",
    { request: params }
  );
}

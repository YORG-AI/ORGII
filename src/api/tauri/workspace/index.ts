/**
 * Workspace API Endpoints
 *
 * Uses Tauri commands for workspace preset CRUD.
 * Workspaces are multi-repo presets persisted in SQLite.
 */
import { invoke as invokeTauri } from "@tauri-apps/api/core";

// ============================================
// Types
// ============================================

export interface WorkspaceFolderRecord {
  folderPath: string;
  folderName: string;
  sortOrder: number;
  isPrimary: boolean;
  repoId?: string | null;
  kind: string;
}

export interface WorkspaceRecord {
  workspaceId: string;
  name: string;
  primaryRepoId?: string | null;
  createdAt: string;
  updatedAt: string;
  folders: WorkspaceFolderRecord[];
}

// ============================================
// CRUD
// ============================================

export async function listWorkspaces(): Promise<WorkspaceRecord[]> {
  const raw = await invokeTauri<WorkspaceRecord[]>("server_list_workspaces");
  return raw;
}

export async function createWorkspace(
  name: string,
  folders: WorkspaceFolderRecord[]
): Promise<WorkspaceRecord> {
  const raw = await invokeTauri<WorkspaceRecord>("server_create_workspace", {
    name,
    folders,
  });
  return raw;
}

export async function updateWorkspace(
  workspaceId: string,
  name: string,
  folders: WorkspaceFolderRecord[]
): Promise<WorkspaceRecord> {
  const raw = await invokeTauri<WorkspaceRecord>("server_update_workspace", {
    workspaceId,
    name,
    folders,
  });
  return raw;
}

export async function deleteWorkspace(workspaceId: string): Promise<boolean> {
  return invokeTauri<boolean>("server_delete_workspace", { workspaceId });
}

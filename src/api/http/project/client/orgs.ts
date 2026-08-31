/**
 * Init / discovery + project org (`project_*_org*`) commands.
 */
import { invoke } from "@tauri-apps/api/core";

import { cachedRead, invalidateCache } from "../cache";
import type {
  ConfigureProjectOrgGitFolderSyncRequest,
  CreateProjectOrgRequest,
  ProjectOrg,
  ResolveProjectOrgGitFolderConflictRequest,
  SyncProjectOrgGitFolderRequest,
  SyncProjectOrgGitFolderResult,
} from "../types";

/** Return the OS Agent personal workspace path (`~/.orgii/personal/workspace/`). */
export async function personalWorkspace(): Promise<string> {
  return invoke("project_personal_workspace");
}

export async function readOrgs(): Promise<ProjectOrg[]> {
  return cachedRead("__project_orgs__:list", () => invoke("project_read_orgs"));
}

export async function createOrg(
  request: CreateProjectOrgRequest
): Promise<ProjectOrg> {
  const result = await invoke<ProjectOrg>("project_create_org", { request });
  invalidateCache("__project_orgs__");
  return result;
}

export async function deleteOrg(orgId: string): Promise<void> {
  await invoke("project_delete_org", { orgId });
  invalidateCache("__project_orgs__");
  invalidateCache("__projects__");
}

export async function configureOrgGitFolderSync(
  request: ConfigureProjectOrgGitFolderSyncRequest
): Promise<ProjectOrg> {
  const result = await invoke<ProjectOrg>(
    "project_configure_org_git_folder_sync",
    {
      request,
    }
  );
  invalidateCache("__project_orgs__");
  return result;
}

export async function syncOrgGitFolder(
  request: SyncProjectOrgGitFolderRequest
): Promise<SyncProjectOrgGitFolderResult> {
  const result = await invoke<SyncProjectOrgGitFolderResult>(
    "project_sync_org_git_folder",
    {
      request,
    }
  );
  invalidateCache("__project_orgs__");
  invalidateCache("__projects__");
  return result;
}

export async function resolveOrgGitFolderConflict(
  request: ResolveProjectOrgGitFolderConflictRequest
): Promise<void> {
  return invoke("project_resolve_org_git_folder_conflict", { request });
}

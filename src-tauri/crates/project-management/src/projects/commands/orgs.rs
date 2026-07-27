//! Project org commands for native ORGII teams.

use super::super::io;
use super::super::types::{
    ConfigureProjectOrgGitFolderSyncRequest, CreateProjectOrgRequest, ProjectOrg,
    ResolveProjectOrgGitFolderConflictRequest, SyncProjectOrgGitFolderRequest,
    SyncProjectOrgGitFolderResult,
};

#[tauri::command]
pub async fn project_read_orgs() -> Result<Vec<ProjectOrg>, String> {
    tokio::task::spawn_blocking(io::read_project_orgs)
        .await
        .map_err(|err| format!("Task join error: {}", err))?
}

#[tauri::command]
pub async fn project_create_org(request: CreateProjectOrgRequest) -> Result<ProjectOrg, String> {
    tokio::task::spawn_blocking(move || io::create_project_org(&request))
        .await
        .map_err(|err| format!("Task join error: {}", err))?
}

#[tauri::command]
pub async fn project_delete_org(org_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || io::delete_project_org(&org_id))
        .await
        .map_err(|err| format!("Task join error: {}", err))??;
    super::super::events::notify_data_changed();
    Ok(())
}

#[tauri::command]
pub async fn project_configure_org_git_folder_sync(
    request: ConfigureProjectOrgGitFolderSyncRequest,
) -> Result<ProjectOrg, String> {
    tokio::task::spawn_blocking(move || io::configure_project_org_git_folder_sync(&request))
        .await
        .map_err(|err| format!("Task join error: {}", err))?
}

#[tauri::command]
pub async fn project_sync_org_git_folder(
    request: SyncProjectOrgGitFolderRequest,
) -> Result<SyncProjectOrgGitFolderResult, String> {
    tokio::task::spawn_blocking(move || io::sync_project_org_git_folder(&request))
        .await
        .map_err(|err| format!("Task join error: {}", err))?
}

#[tauri::command]
pub async fn project_resolve_org_git_folder_conflict(
    request: ResolveProjectOrgGitFolderConflictRequest,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || io::resolve_project_org_git_folder_conflict(&request))
        .await
        .map_err(|err| format!("Task join error: {}", err))?
}

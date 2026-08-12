//! Project-level CRUD: list, read, write, delete, full context bundle.
//!
//! Projects are global rows in `~/.orgii/projects/projects.db`, not
//! per-repo files. Slug remains the public identifier so frontend URLs
//! and stored current-project state can stay unchanged.

use super::super::io;
use super::super::types::{ProjectData, ProjectMeta};

/// List all projects, sorted by `updated_at` descending so the most
/// recently touched ones surface first in the sidebar.
#[tauri::command]
pub async fn project_read_projects(org_id: Option<String>) -> Result<Vec<ProjectData>, String> {
    tokio::task::spawn_blocking(move || io::read_all_projects_scoped(org_id.as_deref()))
        .await
        .map_err(|err| format!("Task join error: {}", err))?
}

/// Read a single project by slug. Returns `Err` when the slug doesn't
/// resolve — callers must distinguish missing from empty.
#[tauri::command]
pub async fn project_read_project(slug: String) -> Result<ProjectData, String> {
    tokio::task::spawn_blocking(move || io::read_project(&slug))
        .await
        .map_err(|err| format!("Task join error: {}", err))?
}

/// Create or update a project row.
///
/// `expect_new` (defaults to `false`) lets the caller assert "this
/// must be a fresh insert". When `true`, attempting to write a slug
/// that already exists fails fast — used by the new-project wizard so
/// a slug collision surfaces before the user fills in fields.
#[tauri::command]
pub async fn project_write_project(
    slug: String,
    meta: ProjectMeta,
    description: String,
    expect_new: Option<bool>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        io::write_project(&slug, &meta, &description, expect_new.unwrap_or(false))
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))?
}

/// Move a project and all of its project-scoped work items to another org.
#[tauri::command]
pub async fn project_move_project(
    slug: String,
    destination_org_id: String,
) -> Result<ProjectData, String> {
    tokio::task::spawn_blocking(move || io::move_project_to_org(&slug, &destination_org_id))
        .await
        .map_err(|err| format!("Task join error: {}", err))?
}

/// Delete a project and every dependent row (work items, labels,
/// milestones, members) via FK cascade. Asset files on disk are NOT
/// touched here — the asset commands handle blob cleanup since
/// deleting a project may legitimately preserve attachments for
/// export.
#[tauri::command]
pub async fn project_delete_project(slug: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || io::delete_project(&slug))
        .await
        .map_err(|err| format!("Task join error: {}", err))?
}

//! Repository Management
//!
//! Tauri commands for repo CRUD (list, import, delete, clone, create).
//! Repos are persisted in the shared `sessions.db` SQLite database.
//! The in-memory git watcher is registered on demand for active workspaces only.
//! Work folders (kind=folder) are tracked without git watcher registration.

pub mod repo_db;
pub mod repo_service;
pub mod workspace_db;

use repo_db::{RepoKind, RepoRecord};

/// Convert a `RepoRecord` to the JSON shape consumed by the frontend.
/// `fs_uri` is a legacy field kept for UI components that read it.
fn repo_record_to_json(repo: &RepoRecord) -> serde_json::Value {
    serde_json::json!({
        "id": repo.repo_id,
        "repo_id": repo.repo_id,
        "name": repo.name,
        "path": repo.path,
        "fs_uri": repo.path,
        "visibility": repo.visibility,
        "kind": repo.kind.as_str(),
    })
}

// ============================================
// Watcher Helpers
// ============================================

/// Unregister a workspace from the git watcher (best-effort).
pub fn unregister_workspace_from_watcher(repo_id: &str) {
    let manager = crate::watch::REPO_WATCH_MANAGER.read();
    if let Some(mgr) = manager.as_ref() {
        let _ = mgr.watcher.unwatch_repo(repo_id);
    }
}

// ============================================
// Tauri Commands
// ============================================

/// List tracked repositories from the database.
#[tauri::command]
pub async fn server_list_repos() -> Result<Vec<serde_json::Value>, String> {
    let repos = repo_service::list().await?;
    Ok(repos.iter().map(repo_record_to_json).collect())
}

/// Update repository visibility (public/private) by path.
#[tauri::command]
pub async fn server_update_repo_visibility(path: String, visibility: String) -> Result<(), String> {
    repo_service::update_visibility(path, visibility).await
}

/// Check GitHub repo visibility via unauthenticated API (no CORS issues).
/// Returns `"public"`, `"private"`, or `null` when uncertain.
#[tauri::command]
pub async fn server_check_github_visibility(owner_repo: String) -> Result<Option<String>, String> {
    let url = format!("https://api.github.com/repos/{}", owner_repo);
    let client = reqwest::Client::new();
    let response = client
        .head(&url)
        .header("User-Agent", "orgii-app")
        .send()
        .await;

    match response {
        Ok(resp) => {
            let status = resp.status().as_u16();
            if status == 200 {
                Ok(Some("public".to_string()))
            } else if status == 404 {
                Ok(Some("private".to_string()))
            } else {
                Ok(None)
            }
        }
        Err(_) => Ok(None),
    }
}

/// Import a local folder as a repository.
/// Persists to DB, registers with git watcher, auto-inits git if needed.
#[tauri::command]
pub async fn server_import_repo(
    path: String,
    name: Option<String>,
) -> Result<serde_json::Value, String> {
    let repo = repo_service::import_repo(path, name).await?;
    Ok(repo_record_to_json(&repo))
}

/// Delete / unwatch a repository.
/// Removes from DB and unwatches — does NOT delete files from disk.
#[tauri::command]
pub async fn server_delete_repo(repo_id: String) -> Result<bool, String> {
    Ok(repo_service::remove(repo_id).await?.is_some())
}

/// Get a repository by ID (path).
/// Checks DB first, falls back to filesystem if not tracked.
#[tauri::command]
pub async fn server_get_repo(repo_id: String) -> Result<serde_json::Value, String> {
    if let Some(repo) = repo_service::get(repo_id.clone()).await? {
        return Ok(repo_record_to_json(&repo));
    }

    let repo_path = std::path::Path::new(&repo_id);
    if !repo_path.exists() {
        return Err(format!("Repository path not found: {}", repo_id));
    }

    let name = repo_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "project".to_string());

    let inferred_kind = if repo_path.join(".git").exists() {
        RepoKind::Git
    } else {
        RepoKind::Folder
    };

    Ok(serde_json::json!({
        "id": repo_id,
        "repo_id": repo_id,
        "name": name,
        "path": repo_id,
        "fs_uri": repo_id,
        "kind": inferred_kind.as_str(),
    }))
}

/// Clone a GitHub repository locally.
/// Clones via git, persists to DB, registers with git watcher.
#[tauri::command]
pub async fn server_clone_github(
    url: String,
    target_dir: String,
    name: Option<String>,
) -> Result<serde_json::Value, String> {
    let repo = repo_service::clone_github(url, target_dir, name).await?;
    Ok(repo_record_to_json(&repo))
}

/// Create an empty repository.
#[tauri::command]
pub async fn server_create_empty_repo(
    path: String,
    name: Option<String>,
) -> Result<serde_json::Value, String> {
    let repo = repo_service::create_empty_repo(path, name).await?;
    Ok(repo_record_to_json(&repo))
}

// ============================================
// Work Folder Commands
// ============================================

/// Import an existing local folder as a work folder (no git).
/// Persists to DB only — no git init, no git watcher.
#[tauri::command]
pub async fn server_import_folder(
    path: String,
    name: Option<String>,
) -> Result<serde_json::Value, String> {
    let folder = repo_service::import_folder(path, name).await?;
    Ok(repo_record_to_json(&folder))
}

/// Create a new empty work folder (no git).
/// Creates directory, persists to DB — no git init, no git watcher.
#[tauri::command]
pub async fn server_create_folder(
    path: String,
    name: Option<String>,
) -> Result<serde_json::Value, String> {
    let folder = repo_service::create_folder(path, name).await?;
    Ok(repo_record_to_json(&folder))
}

/// Validate an existing workspace directory and return its canonical path.
///
/// This runs in the Rust backend because the native folder dialog grants the
/// frontend FS plugin a runtime scope that an equivalent pasted path lacks.
#[tauri::command]
pub async fn server_validate_workspace_path(path: String) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Workspace path cannot be empty".to_string());
    }

    let candidate = std::path::Path::new(trimmed);
    if !candidate.is_absolute() {
        return Err("Workspace path must be absolute".to_string());
    }

    let metadata = std::fs::metadata(candidate)
        .map_err(|err| format!("Unable to access workspace path: {err}"))?;
    if !metadata.is_dir() {
        return Err("Workspace path is not a directory".to_string());
    }

    candidate
        .canonicalize()
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|err| format!("Unable to resolve workspace path: {err}"))
}

/// Check if a directory is a git repository (has .git subdirectory).
#[tauri::command]
pub async fn server_check_is_git_repo(path: String) -> Result<bool, String> {
    let git_dir = std::path::Path::new(&path).join(".git");
    Ok(git_dir.exists())
}

// ============================================
// Workspace Preset Commands
// ============================================

/// List all saved workspace presets from the database.
#[tauri::command]
pub async fn server_list_workspaces() -> Result<Vec<serde_json::Value>, String> {
    let workspaces = workspace_db::list_workspaces()?;
    Ok(workspaces
        .iter()
        .map(|ws| serde_json::to_value(ws).unwrap_or_default())
        .collect())
}

/// Create a new workspace preset.
#[tauri::command]
pub async fn server_create_workspace(
    name: String,
    folders: Vec<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let folder_records: Vec<workspace_db::WorkspaceFolderRecord> = folders
        .into_iter()
        .enumerate()
        .map(|(i, f)| workspace_db::WorkspaceFolderRecord {
            folder_path: f["folderPath"].as_str().unwrap_or("").to_string(),
            folder_name: f["folderName"].as_str().unwrap_or("").to_string(),
            sort_order: i as i32,
            is_primary: f["isPrimary"].as_bool().unwrap_or(false),
            repo_id: f["repoId"].as_str().map(|s| s.to_string()),
            kind: f["kind"].as_str().unwrap_or("git").to_string(),
        })
        .collect();

    let ws = workspace_db::create_workspace(&name, folder_records)?;
    serde_json::to_value(&ws).map_err(|e| format!("Serialize error: {}", e))
}

/// Update an existing workspace preset (name + folders).
#[tauri::command]
pub async fn server_update_workspace(
    workspace_id: String,
    name: String,
    folders: Vec<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let existing = workspace_db::get_workspace(&workspace_id)?
        .ok_or_else(|| format!("Workspace not found: {}", workspace_id))?;

    let folder_records: Vec<workspace_db::WorkspaceFolderRecord> = folders
        .into_iter()
        .enumerate()
        .map(|(i, f)| workspace_db::WorkspaceFolderRecord {
            folder_path: f["folderPath"].as_str().unwrap_or("").to_string(),
            folder_name: f["folderName"].as_str().unwrap_or("").to_string(),
            sort_order: i as i32,
            is_primary: f["isPrimary"].as_bool().unwrap_or(false),
            repo_id: f["repoId"].as_str().map(|s| s.to_string()),
            kind: f["kind"].as_str().unwrap_or("git").to_string(),
        })
        .collect();

    let primary_repo_id = folder_records
        .iter()
        .find(|f| f.is_primary)
        .and_then(|f| f.repo_id.clone());

    let ws = workspace_db::WorkspaceRecord {
        workspace_id,
        name,
        primary_repo_id,
        created_at: existing.created_at,
        updated_at: chrono::Utc::now().to_rfc3339(),
        folders: folder_records,
    };

    workspace_db::upsert_workspace(&ws)?;
    serde_json::to_value(&ws).map_err(|e| format!("Serialize error: {}", e))
}

/// Delete a workspace preset by ID.
#[tauri::command]
pub async fn server_delete_workspace(workspace_id: String) -> Result<bool, String> {
    workspace_db::delete_workspace(&workspace_id)
}

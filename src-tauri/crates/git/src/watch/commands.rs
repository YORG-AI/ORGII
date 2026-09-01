//! Tauri commands for repository watching
//!
//! Exposes `start_watch`, `stop_watch`, `get_repo_status`, and related
//! commands to the frontend via Tauri's invoke system.
use std::path::PathBuf;

use super::types::*;
use super::REPO_WATCH_MANAGER;

// ============================================
// Watch Management
// ============================================

/// Watch multiple repositories
#[tauri::command]
pub async fn watch_repos(repos: Vec<RepoInfoDto>) -> Result<WatchStatus, String> {
    // Clone manager reference before async operations
    let watcher = {
        let manager_lock = REPO_WATCH_MANAGER.read();
        let manager = manager_lock
            .as_ref()
            .ok_or_else(|| "Repo watch manager not initialized".to_string())?;
        manager.watcher.clone()
    };

    let mut _results = Vec::new();

    for repo_dto in repos {
        let repo_name = repo_dto.repo_name.clone();

        // Validate path doesn't have file:// prefix (should be normalized by frontend)
        if repo_dto.repo_path.starts_with("file://") {
            log::warn!(
                "[watch_repos] Path has file:// prefix, skipping: {}",
                repo_dto.repo_path
            );
            continue;
        }

        let repo_info = RepoInfo {
            repo_id: repo_dto.repo_id,
            repo_path: PathBuf::from(&repo_dto.repo_path),
            repo_name: repo_dto.repo_name,
        };

        match watcher.watch_repo(repo_info) {
            Ok(_) => {
                log::info!("Successfully started watching repo: {}", repo_name);
                _results.push(true);
            }
            Err(e) => {
                log::error!("Failed to watch repo {}: {}", repo_name, e);
                _results.push(false);
            }
        }
    }

    // Return watch status
    get_watch_status().await
}

/// Unwatch a repository
#[tauri::command]
pub async fn unwatch_repo(repo_id: String) -> Result<(), String> {
    let manager_lock = REPO_WATCH_MANAGER.read();
    let manager = manager_lock
        .as_ref()
        .ok_or_else(|| "Repo watch manager not initialized".to_string())?;

    manager.watcher.unwatch_repo(&repo_id)
}

// ============================================
// Status Queries
// ============================================

// ============================================
// Health Monitoring
// ============================================

/// Get watch status summary
pub async fn get_watch_status() -> Result<WatchStatus, String> {
    let manager_lock = REPO_WATCH_MANAGER.read();
    let manager = manager_lock
        .as_ref()
        .ok_or_else(|| "Repo watch manager not initialized".to_string())?;

    let health_monitor = super::health_monitor::HealthMonitor::new(
        manager.state_store.clone(),
        manager.watcher.clone(),
        manager.event_emitter.clone(),
    );

    Ok(health_monitor.get_watch_status())
}

/// Set window focus state for adaptive polling
/// Polls faster when window is focused, slower when in background
#[tauri::command]
pub async fn set_window_focus(focused: bool) -> Result<(), String> {
    let manager_lock = REPO_WATCH_MANAGER.read();
    let manager = manager_lock
        .as_ref()
        .ok_or_else(|| "Repo watch manager not initialized".to_string())?;

    manager.watcher.set_window_focused(focused);
    Ok(())
}

/// Report whether a Source Control surface is visible in the frontend.
/// While visible, focused git-status polling uses the fast (5s) interval;
/// otherwise it relaxes to 10s to keep idle git subprocess load low.
#[tauri::command]
pub async fn set_source_control_attention(visible: bool) -> Result<(), String> {
    let manager_lock = REPO_WATCH_MANAGER.read();
    let manager = manager_lock
        .as_ref()
        .ok_or_else(|| "Repo watch manager not initialized".to_string())?;

    manager.watcher.set_source_control_attention(visible);
    Ok(())
}

#[tauri::command]
pub async fn set_active_git_polling_repo(repo_id: Option<String>) -> Result<(), String> {
    let manager_lock = REPO_WATCH_MANAGER.read();
    let manager = manager_lock
        .as_ref()
        .ok_or_else(|| "Repo watch manager not initialized".to_string())?;

    manager.watcher.set_active_polling_repo(repo_id);
    Ok(())
}

// ============================================
// Utility Types
// ============================================

/// DTO for repo info from frontend
#[derive(Debug, serde::Deserialize)]
pub struct RepoInfoDto {
    pub repo_id: String,
    pub repo_path: String,
    pub repo_name: String,
}

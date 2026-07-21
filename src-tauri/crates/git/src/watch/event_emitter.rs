//! Tauri event emitter for repository change notifications
//!
//! Emits `repo:status_updated`, `repo:watcher_health`, and related events
//! to the frontend WebView via `tauri::AppHandle::emit`.
use serde_json::json;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Emitter;

use super::types::*;

pub struct EventEmitter {
    app_handle: tauri::AppHandle,
}

impl EventEmitter {
    pub fn new(app_handle: tauri::AppHandle) -> Self {
        Self { app_handle }
    }

    // ============================================
    // Repository Events
    // ============================================

    /// Emit repo changed event (for git status changes)
    pub fn emit_repo_changed(
        &self,
        repo_id: String,
        change_type: RepoChangeType,
        affected_count: usize,
    ) {
        let change_type_str = match change_type {
            RepoChangeType::Files => "files",
            RepoChangeType::GitMeta => "git_meta",
            RepoChangeType::Branch => "branch",
            RepoChangeType::Remote => "remote",
        };

        // Broadcast into automation trigger system
        crate::hooks::send_git_event(crate::hooks::GitWatchEvent {
            operation: String::new(),
            repo_id: repo_id.clone(),
            change_type: change_type_str.to_string(),
        });

        let payload = json!({
            "repo_id": repo_id,
            "change_type": change_type_str,
            "affected_count": affected_count,
            "timestamp": Self::current_timestamp_ms(),
        });

        let _ = self.app_handle.emit("repo:changed", payload);
    }

    /// Emit file changed event (for Filesync channel - individual file changes)
    /// This is separate from repo:changed which is for git status tracking
    pub fn emit_file_changed(
        &self,
        repo_id: String,
        file_path: String,
        event_kind: &str, // "modified", "created", "deleted", "renamed"
    ) {
        // Emit coding activity heartbeat for individual file changes
        crate::hooks::record_file_change(Some(repo_id.clone()), file_path.clone(), 0, 0);

        let payload = json!({
            "repo_id": repo_id,
            "path": file_path,
            "kind": event_kind,
            "timestamp": Self::current_timestamp_ms(),
        });

        let _ = self.app_handle.emit("file:changed", payload);
    }

    /// Emit batch of file changed events (more efficient for multiple files)
    pub fn emit_files_changed(
        &self,
        repo_id: String,
        files: Vec<(String, String)>, // (path, event_kind)
    ) {
        if files.is_empty() {
            return;
        }

        let files_json: Vec<serde_json::Value> = files
            .iter()
            .map(|(path, kind)| {
                json!({
                    "path": path,
                    "kind": kind,
                })
            })
            .collect();

        let message = json!({
            "type": "file:changed",
            "repo_id": repo_id,
            "files": files_json,
            "timestamp": Self::current_timestamp_ms(),
        });

        // Broadcast via WebSocket to all connected clients
        crate::hooks::websocket_broadcast(message.to_string());
    }

    /// Emit repo status updated event (suggested action computed on frontend)
    /// Now includes full file list for real-time source control updates
    /// Also includes git operation states (merge, rebase, etc.) for context engineering
    pub fn emit_status_updated(&self, repo_id: String, status: GitStatus) {
        // Convert files to JSON array
        let files_json: Vec<serde_json::Value> = status
            .files
            .iter()
            .map(|f| {
                json!({
                    "path": f.path,
                    "status": f.status,
                    "staged": f.staged,
                    "original_path": f.original_path,
                })
            })
            .collect();

        let message = json!({
            "type": "repo:status_updated",
            "repo_id": repo_id,
            "status": {
                "branch": status.branch,
                "current_upstream_branch": status.current_upstream_branch,
                "ahead": status.ahead,
                "behind": status.behind,
                "staged": status.staged,
                "unstaged": status.unstaged,
                "untracked": status.untracked,
                "conflicted": status.conflicted,
                "last_commit_hash": status.last_commit_hash,
                "last_commit_message": status.last_commit_message,
                "files": files_json,
                // Git operation states for context engineering
                "merge_in_progress": status.merge_in_progress,
                "rebase_in_progress": status.rebase_in_progress,
                "cherry_pick_in_progress": status.cherry_pick_in_progress,
                "revert_in_progress": status.revert_in_progress,
                "bisect_in_progress": status.bisect_in_progress,
                // Legacy field names for backward compatibility with frontend
                "merge_head_found": status.merge_in_progress,
                "do_conflicted_files_exist": status.conflicted > 0,
            },
            "timestamp": Self::current_timestamp_ms(),
        });

        // Broadcast via WebSocket to all connected clients
        crate::hooks::websocket_broadcast(message.to_string());
    }

    /// Emit git operation event (for context signals and Output panel)
    /// This is separate from status_updated - it describes WHAT happened, not just current state
    pub fn emit_git_operation(
        &self,
        repo_id: String,
        operation: &str, // "commit", "push", "pull", "fetch", "merge", "rebase", "checkout", "reset"
        success: bool,
        summary: String, // Human-readable summary: "Created commit abc1234"
        details: String, // More details: commit message, branch name, etc.
    ) {
        // Broadcast into automation trigger system
        crate::hooks::send_git_event(crate::hooks::GitWatchEvent {
            operation: operation.to_string(),
            repo_id: repo_id.clone(),
            change_type: String::new(),
        });

        let message = json!({
            "type": "repo:git_operation",
            "repo_id": repo_id,
            "operation": operation,
            "success": success,
            "summary": summary,
            "details": details,
            "timestamp": Self::current_timestamp_ms(),
        });

        // Broadcast via WebSocket to all connected clients
        crate::hooks::websocket_broadcast(message.to_string());
    }

    // ============================================
    // Job Events
    // ============================================

    /// Emit background job event
    pub fn emit_job_event(
        &self,
        job_id: String,
        repo_id: String,
        job_type: JobType,
        state: JobState,
        progress: Option<u32>,
        error: Option<String>,
    ) {
        let job_type_str = match job_type {
            JobType::Index => "index",
            JobType::Embed => "embed",
            JobType::Analyze => "analyze",
        };

        let state_str = match state {
            JobState::Started => "started",
            JobState::Progress => "progress",
            JobState::Completed => "completed",
            JobState::Failed => "failed",
        };

        let mut payload = json!({
            "job_id": job_id,
            "repo_id": repo_id,
            "job_type": job_type_str,
            "state": state_str,
        });

        if let Some(p) = progress {
            payload["progress"] = json!(p);
        }

        if let Some(e) = error {
            payload["error"] = json!(e);
        }

        let _ = self.app_handle.emit("repo:background_job", payload);
    }

    // ============================================
    // Health Events
    // ============================================

    /// Emit watcher health event
    pub fn emit_watcher_health(
        &self,
        repo_id: String,
        status: HealthStatus,
        reason: Option<String>,
    ) {
        let status_str = match status {
            HealthStatus::Healthy => "healthy",
            HealthStatus::Degraded => "degraded",
            HealthStatus::Failed => "failed",
        };

        let mut message = json!({
            "type": "repo:watcher_health",
            "repo_id": repo_id,
            "status": status_str,
            "timestamp": Self::current_timestamp_ms(),
        });

        if let Some(r) = reason {
            message["reason"] = json!(r);
        }

        // Broadcast via WebSocket to all connected clients
        crate::hooks::websocket_broadcast(message.to_string());
    }

    /// Emit watcher health update with full status
    pub fn emit_health_update(&self, health: WatcherHealth) {
        let payload = json!({
            "repo_id": health.repo_id,
            "repo_name": health.repo_name,
            "status": match health.status {
                HealthStatus::Healthy => "healthy",
                HealthStatus::Degraded => "degraded",
                HealthStatus::Failed => "failed",
            },
            "mode": match health.mode {
                WatchMode::EventDriven => "event_driven",
                WatchMode::SmartPolling => "smart_polling",
                WatchMode::SlowPolling => "slow_polling",
                WatchMode::Disabled => "disabled",
            },
            "reason": health.reason,
            "last_event": health.last_event,
            "cache_valid": health.cache_valid,
        });

        let _ = self.app_handle.emit("repo:health_update", payload);
    }

    // ============================================
    // Bulk Updates
    // ============================================

    /// Emit bulk status update for multiple repos
    pub fn emit_bulk_status_update(&self, statuses: std::collections::HashMap<String, GitStatus>) {
        let payload: serde_json::Value = statuses
            .into_iter()
            .map(|(repo_id, status)| {
                (
                    repo_id,
                    json!({
                        "branch": status.branch,
                        "ahead": status.ahead,
                        "behind": status.behind,
                        "staged": status.staged,
                        "unstaged": status.unstaged,
                        "untracked": status.untracked,
                        "last_commit_hash": status.last_commit_hash,
                        "last_commit_message": status.last_commit_message,
                    }),
                )
            })
            .collect();

        let _ = self.app_handle.emit("repo:bulk_status_update", payload);
    }

    // ============================================
    // Utilities
    // ============================================

    /// Get current timestamp in milliseconds
    fn current_timestamp_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
    }
}

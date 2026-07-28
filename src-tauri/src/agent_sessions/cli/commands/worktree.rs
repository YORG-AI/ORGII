//! Worktree branch operations on an existing session —
//! `cli_agent_merge`, `cli_agent_worktree_diff`, `cli_agent_worktree_discard`.

use super::super::persistence;
use core_types::worktree::{MergeStrategy, WorktreeMergeResult};
use git::worktree;

/// Merge a session's worktree branch back into the base branch.
#[tauri::command]
pub async fn cli_agent_merge(
    session_id: String,
    strategy: Option<String>,
) -> Result<WorktreeMergeResult, String> {
    let session = tokio::task::spawn_blocking({
        let sid = session_id.clone();
        move || persistence::get_session(&sid).map_err(|e| format!("DB error: {}", e))
    })
    .await
    .map_err(|e| format!("Task error: {}", e))??
    .ok_or_else(|| format!("Session {} not found", session_id))?;

    let repo_path = session
        .repo_path
        .as_deref()
        .ok_or("Session has no repo_path")?;

    if session.worktree_path.is_none() || session.base_branch.is_none() {
        return Err("Session does not own an isolated worktree".to_string());
    }

    let base_branch = session
        .base_branch
        .as_deref()
        .ok_or("Session has no base_branch recorded")?
        .to_string();

    let merge_strategy = MergeStrategy::parse(strategy.as_deref().unwrap_or("auto"));

    let repo = std::path::Path::new(repo_path).to_path_buf();
    let sid = session_id.clone();

    let result = tokio::task::spawn_blocking(move || {
        worktree::merge_session_worktree(&repo, &sid, &base_branch, merge_strategy)
    })
    .await
    .map_err(|e| format!("Task error: {}", e))??;

    // Update merge status in DB
    let merge_status = if result.merged {
        "merged"
    } else if !result.conflicts.is_empty() {
        "conflict"
    } else {
        "failed"
    };
    let sid = session_id.clone();
    let ms = merge_status.to_string();
    tokio::task::spawn_blocking(move || {
        persistence::update_merge_status(&sid, &ms).map_err(|e| format!("DB error: {}", e))
    })
    .await
    .map_err(|e| format!("Task error: {}", e))??;

    // Clean up worktree after successful merge
    if result.merged {
        if let Some(ref rp) = session.repo_path {
            let repo = std::path::Path::new(rp).to_path_buf();
            let sid = session_id.clone();
            let _ = tokio::task::spawn_blocking(move || {
                if let Err(err) = worktree::remove_session_worktree(&repo, &sid, true) {
                    tracing::warn!(
                        "[CodeSession] Failed to clean up worktree after merge: {}",
                        err
                    );
                }
            })
            .await;
        }
    }

    // Broadcast merge result
    let ws_msg = serde_json::json!({
        "type": "code_session.merge_result",
        "session_id": session_id,
        "status": merge_status,
        "merged": result.merged,
        "conflicts": result.conflicts,
    });
    crate::api::websocket_handler::broadcast(ws_msg.to_string());

    Ok(result)
}

/// Get diff between a session's worktree branch and its base branch.
#[tauri::command]
pub async fn cli_agent_worktree_diff(session_id: String) -> Result<String, String> {
    let session = tokio::task::spawn_blocking({
        let sid = session_id.clone();
        move || persistence::get_session(&sid).map_err(|e| format!("DB error: {}", e))
    })
    .await
    .map_err(|e| format!("Task error: {}", e))??
    .ok_or_else(|| format!("Session {} not found", session_id))?;

    let repo_path = session
        .repo_path
        .as_deref()
        .ok_or("Session has no repo_path")?;
    let base_branch = session
        .base_branch
        .as_deref()
        .ok_or("Session has no base_branch")?;

    if session.worktree_path.is_none() {
        return Err("Session does not use worktree isolation".to_string());
    }

    let repo = std::path::Path::new(repo_path).to_path_buf();
    let sid = session_id.clone();
    let base = base_branch.to_string();

    tokio::task::spawn_blocking(move || worktree::get_session_diff(&repo, &sid, &base))
        .await
        .map_err(|e| format!("Task error: {}", e))?
}

/// Discard a session's worktree (remove worktree and delete branch).
#[tauri::command]
pub async fn cli_agent_worktree_discard(session_id: String) -> Result<bool, String> {
    let session = tokio::task::spawn_blocking({
        let sid = session_id.clone();
        move || persistence::get_session(&sid).map_err(|e| format!("DB error: {}", e))
    })
    .await
    .map_err(|e| format!("Task error: {}", e))??
    .ok_or_else(|| format!("Session {} not found", session_id))?;

    let repo_path = session
        .repo_path
        .as_deref()
        .ok_or("Session has no repo_path")?;

    if session.worktree_path.is_none() || session.base_branch.is_none() {
        return Err("Session does not own an isolated worktree".to_string());
    }

    let repo = std::path::Path::new(repo_path).to_path_buf();
    let sid_for_wt = session_id.clone();
    tokio::task::spawn_blocking(move || {
        worktree::remove_session_worktree(&repo, &sid_for_wt, true)
    })
    .await
    .map_err(|e| format!("Task error: {}", e))?
    .map_err(|e| format!("Failed to remove worktree: {}", e))?;

    let sid = session_id.clone();
    tokio::task::spawn_blocking(move || {
        persistence::update_merge_status(&sid, "skipped").map_err(|e| format!("DB error: {}", e))
    })
    .await
    .map_err(|e| format!("Task error: {}", e))??;

    Ok(true)
}

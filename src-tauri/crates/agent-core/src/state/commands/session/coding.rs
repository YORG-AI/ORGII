//! Coding session commands: snapshots, reverts, files, todos, reviews.

use std::path::PathBuf;

use crate::foundation::session_bridge;
use crate::persistence::db_helpers as shared;
use crate::persistence::session_snapshots;
use crate::tools::file_history;

use super::common::review_session_ids;

fn invalidate_cli_resume_state_best_effort(session_id: String, mutation_reason: &'static str) {
    std::thread::spawn(move || {
        if let Err(err) = session_bridge::clear_cli_resume_state(&session_id, mutation_reason) {
            tracing::warn!(
                "[agent_review] failed to clear CLI resume state for {} after {}: {}",
                session_id,
                mutation_reason,
                err
            );
        }
    });
}

/// Get files modified by a session.
#[tauri::command]
pub async fn agent_get_session_files(session_id: String) -> Result<Vec<serde_json::Value>, String> {
    shared::spawn_blocking_cmd(move || {
        let mut files_by_path = std::collections::BTreeMap::new();
        let mut stats_by_path = std::collections::BTreeMap::new();
        for review_session_id in review_session_ids(&session_id) {
            for (path, stats) in file_history::session_numstat(&review_session_id)
                .map_err(|err| rusqlite::Error::ToSqlConversionFailure(Box::new(err)))?
            {
                let aggregate = stats_by_path.entry(path).or_insert((0_u64, 0_u64));
                aggregate.0 += stats.0;
                aggregate.1 += stats.1;
            }
            for file in session_snapshots::get_session_modified_files(&review_session_id)? {
                files_by_path
                    .entry(file.path.clone())
                    .and_modify(|existing: &mut session_snapshots::SessionFileChange| {
                        existing.count += file.count;
                    })
                    .or_insert(file);
            }
        }
        files_by_path
            .into_values()
            .map(|file| {
                let (additions, deletions) =
                    stats_by_path.get(&file.path).copied().unwrap_or((0, 0));
                let mut value = shared::to_json_value(file)?;
                value["additions"] = serde_json::json!(additions);
                value["deletions"] = serde_json::json!(deletions);
                value["lineCount"] = serde_json::json!(additions + deletions);
                Ok(value)
            })
            .collect()
    })
    .await
}

/// Get snapshots for a session.
#[tauri::command]
pub async fn agent_get_snapshots(session_id: String) -> Result<Vec<serde_json::Value>, String> {
    shared::spawn_blocking_cmd(move || {
        let mut snapshots = Vec::new();
        for review_session_id in review_session_ids(&session_id) {
            for (tool_call_id, hash, created_at) in
                session_snapshots::get_snapshots(&review_session_id)?
            {
                if tool_call_id == file_history::REDO_SNAPSHOT_TOOL_CALL_ID {
                    continue;
                }
                snapshots.push((review_session_id.clone(), tool_call_id, hash, created_at));
            }
        }
        snapshots.sort_by(|left, right| left.3.cmp(&right.3).then_with(|| left.0.cmp(&right.0)));
        Ok(snapshots
            .into_iter()
            .map(|(review_session_id, tool_call_id, hash, created_at)| {
                serde_json::json!({
                    "sessionId": review_session_id,
                    "toolCallId": tool_call_id,
                    "hash": hash,
                    "createdAt": created_at,
                })
            })
            .collect())
    })
    .await
}

/// Revert ALL file-history snapshots taken at or after `created_at` for the
/// given session. Walks every snapshot from `created_at` forward (newest
/// first) so that all agent edits in the current review round are undone —
/// not just the first one.
#[tauri::command]
pub async fn agent_revert(
    created_at: String,
    session_id: String,
) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || {
        let mut restored = 0usize;
        let mut deleted = 0usize;
        let mut skipped = 0usize;
        let mut failed = 0usize;
        let mut redo_anchors = Vec::new();
        let mut errors = Vec::new();

        for review_session_id in review_session_ids(&session_id) {
            match file_history::rewind_to_message(&review_session_id, &created_at) {
                Ok(stats) => {
                    restored += stats.restored;
                    deleted += stats.deleted;
                    skipped += stats.skipped_unchanged;
                    failed += stats.failed;
                    invalidate_cli_resume_state_best_effort(
                        review_session_id.clone(),
                        session_bridge::CLI_HISTORY_MUTATION_FILE_REWIND,
                    );

                    if let Some(redo_id) = stats.redo_snapshot_id {
                        match session_snapshots::get_snapshot_created_at_by_hash(
                            &review_session_id,
                            &redo_id,
                        ) {
                            Ok(Some(created_at)) => {
                                redo_anchors.push(serde_json::json!({
                                    "sessionId": review_session_id,
                                    "snapshotId": redo_id,
                                    "createdAt": created_at,
                                }));
                            }
                            Ok(None) => {
                                failed += 1;
                                errors.push(format!(
                                    "{review_session_id}: missing redo snapshot timestamp for {redo_id}"
                                ));
                            }
                            Err(err) => {
                                failed += 1;
                                errors.push(format!(
                                    "{review_session_id}: failed to load redo snapshot timestamp: {err}"
                                ));
                            }
                        }
                    }
                }
                Err(err) => {
                    failed += 1;
                    errors.push(format!("{review_session_id}: {err}"));
                }
            }
        }

        let mut result = serde_json::json!({
            "reverted": restored + deleted,
            "restored": restored,
            "deleted": deleted,
            "skipped": skipped,
            "failed": failed,
            "createdAt": created_at,
            "redoAnchors": redo_anchors,
        });
        if !errors.is_empty() {
            result["errors"] = serde_json::json!(errors);
        }
        Ok(result)
    })
    .await
    .map_err(|err| format!("spawn_blocking join error: {}", err))?
}

/// Restore one exact snapshot for one exact owning session. This is used for
/// redo anchors and intentionally does not use `created_at` rewind semantics.
#[tauri::command]
pub async fn agent_restore_snapshot(
    session_id: String,
    snapshot_id: String,
) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || {
        let stats = file_history::restore_snapshot(&session_id, &snapshot_id)
            .map_err(|err| format!("Failed to restore snapshot: {err}"))?;
        invalidate_cli_resume_state_best_effort(
            session_id.clone(),
            session_bridge::CLI_HISTORY_MUTATION_SNAPSHOT_RESTORE,
        );
        Ok(serde_json::json!({
            "reverted": stats.restored + stats.deleted,
            "restored": stats.restored,
            "deleted": stats.deleted,
            "skipped": stats.skipped_unchanged,
            "failed": stats.failed,
        }))
    })
    .await
    .map_err(|err| format!("spawn_blocking join error: {}", err))?
}

#[tauri::command]
pub async fn agent_revert_file_review(
    workspace_path: String,
    file_path: String,
    session_id: String,
    created_at: String,
) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || {
        let project = PathBuf::from(&workspace_path);
        let target = if std::path::Path::new(&file_path).is_absolute() {
            PathBuf::from(&file_path)
        } else {
            project.join(&file_path)
        };
        let mut changed = false;
        let mut errors = Vec::new();
        for review_session_id in review_session_ids(&session_id) {
            match file_history::rewind_file_to_message(&review_session_id, &created_at, &target) {
                Ok(stats) => {
                    changed = changed || stats.restored > 0 || stats.deleted > 0;
                    if stats.failed > 0 {
                        errors.push(format!(
                            "{review_session_id}: {} file snapshot restores failed",
                            stats.failed
                        ));
                    }
                }
                Err(err) => errors.push(format!("{review_session_id}: {err}")),
            }
        }
        if !errors.is_empty() {
            return Err(format!(
                "Failed to revert file review: {}",
                errors.join("; ")
            ));
        }
        Ok(changed)
    })
    .await
    .map_err(|err| format!("spawn_blocking join error: {}", err))?
}

/// Revert a single file within a specific snapshot back to its captured
/// bytes. `workspace_path` is used only to resolve relative `file_path`
/// inputs; pass an empty string when `file_path` is absolute.
#[tauri::command]
pub async fn agent_revert_file(
    workspace_path: String,
    snapshot_hash: String,
    file_path: String,
    session_id: String,
) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || {
        let project = PathBuf::from(&workspace_path);
        let target = if std::path::Path::new(&file_path).is_absolute() {
            PathBuf::from(&file_path)
        } else {
            project.join(&file_path)
        };
        file_history::rewind_file(&session_id, &snapshot_hash, &target)
            .map_err(|err| format!("Failed to revert file: {}", err))
    })
    .await
    .map_err(|err| format!("spawn_blocking join error: {}", err))?
}

/// Get todos for a session.
#[tauri::command]
pub async fn agent_get_todos(session_id: String) -> Result<serde_json::Value, String> {
    let todos = tokio::task::spawn_blocking(move || shared::todos::get_todos(&session_id))
        .await
        .map_err(|err| format!("Join error: {}", err))?
        .map_err(|err| format!("DB error: {}", err))?;

    let items: Vec<serde_json::Value> = todos
        .into_iter()
        .enumerate()
        .map(|(idx, todo)| {
            let mut obj = serde_json::json!({
                "id": format!("persisted-{idx}"),
                "index": idx,
                "content": todo.content,
                "activeForm": todo.active_form,
                "status": todo.status,
                "priority": todo.priority,
            });
            if !todo.blocked_by.is_empty() {
                obj["blockedBy"] = serde_json::json!(todo.blocked_by);
            }
            obj
        })
        .collect();

    Ok(serde_json::json!(items))
}

// `agent_list_modes` was removed (Orgtrack migration, mode-list
// convergence): it returned a fourth divergent mode catalog (4 entries)
// that no UI ever called — the picker is driven by the TS
// `AGENT_EXEC_MODES` constant in sessionCreatorConfig.ts, which is the
// single user-facing list.

/// Resolve review: clear file resolutions and snapshots for a session.
#[tauri::command]
pub async fn agent_resolve_review(session_id: String) -> Result<i64, String> {
    shared::spawn_blocking_cmd(move || {
        let mut deleted = 0i64;
        for review_session_id in review_session_ids(&session_id) {
            session_snapshots::clear_file_resolutions(&review_session_id)?;
            deleted += session_snapshots::clear_review_snapshots(&review_session_id)?;
        }
        Ok(deleted)
    })
    .await
}

/// Save a file resolution for a session.
#[tauri::command]
pub async fn agent_save_file_resolution(
    session_id: String,
    file_path: String,
    resolution: String,
) -> Result<(), String> {
    shared::spawn_blocking_cmd(move || {
        session_snapshots::save_file_resolution(&session_id, &file_path, &resolution)
    })
    .await
}

/// Get file resolutions for a session.
#[tauri::command]
pub async fn agent_get_file_resolutions(
    session_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    shared::spawn_blocking_cmd(move || {
        let resolutions = session_snapshots::get_file_resolutions(&session_id)?;
        Ok(resolutions
            .into_iter()
            .map(|(path, resolution)| {
                serde_json::json!({
                    "path": path,
                    "resolution": resolution,
                })
            })
            .collect())
    })
    .await
}

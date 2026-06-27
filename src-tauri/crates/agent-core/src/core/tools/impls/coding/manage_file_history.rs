//! `manage_file_history` tool — lets the LLM inspect and rewind file-history
//! snapshots for the current session. Exposes three actions:
//!
//! - `list`   — list all snapshots with their file counts
//! - `rewind` — restore files to their state before a given message
//! - `redo`   — re-apply the most recent rewind (if a redo snapshot exists)

use async_trait::async_trait;
use serde_json::Value;

use crate::tools::names as tool_names;
use crate::tools::traits::{required_string, Tool, ToolError};

/// Sentinel prefix for redo snapshots written by `rewind_to_message`.
const REDO_TOOL_CALL_PREFIX: &str = "redo:";

pub struct ManageFileHistoryTool {
    session_id: tokio::sync::Mutex<Option<String>>,
}

impl Default for ManageFileHistoryTool {
    fn default() -> Self {
        Self::new()
    }
}

impl ManageFileHistoryTool {
    pub fn new() -> Self {
        Self {
            session_id: tokio::sync::Mutex::new(None),
        }
    }

    async fn get_session_id(&self) -> Result<String, ToolError> {
        self.session_id
            .lock()
            .await
            .clone()
            .ok_or_else(|| ToolError::ExecutionFailed("No session context set".into()))
    }
}

fn review_session_ids(session_id: &str) -> Vec<String> {
    let mut session_ids = vec![session_id.to_string()];
    match crate::session::persistence::get_child_sessions(session_id) {
        Ok(children) => session_ids.extend(children.into_iter().map(|child| child.session_id)),
        Err(err) => tracing::warn!(
            "[manage_file_history] failed to load child sessions for {}: {}",
            session_id,
            err
        ),
    }
    session_ids
}

fn invalidate_cli_resume_state_best_effort(session_id: &str, mutation_reason: &'static str) {
    if let Err(err) =
        crate::foundation::session_bridge::clear_cli_resume_state(session_id, mutation_reason)
    {
        tracing::warn!(
            "[manage_file_history] failed to clear CLI resume state for {} after {}: {}",
            session_id,
            mutation_reason,
            err
        );
    }
}

#[async_trait]
impl Tool for ManageFileHistoryTool {
    fn name(&self) -> &str {
        tool_names::MANAGE_FILE_HISTORY
    }

    fn description(&self) -> &str {
        "Inspect and rewind file-history snapshots for this session.\n\n\
        ## Actions\n\
        - **list** — show all snapshots captured in this session with their file counts and timestamps.\n\
        - **rewind** — restore all tracked files to their state before a given message. \
          Pass the `created_at` timestamp of the earliest snapshot you want to undo. \
          All snapshots at or after that timestamp are undone in reverse order. \
          A redo snapshot is automatically captured before the rewind so you can re-apply.\n\
        - **redo** — re-apply the most recent rewind by restoring the redo snapshot. \
          Only works if a redo snapshot exists (i.e. a rewind was performed earlier in the session).\n\n\
        ## When to Use\n\
        - After making file edits that turned out to be wrong: rewind to before those edits.\n\
        - After a rewind that was too aggressive: redo to restore the reverted state."
    }

    fn parameters(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["list", "rewind", "redo"],
                    "description": "\"list\" to inspect snapshots, \"rewind\" to undo edits since a timestamp, \"redo\" to re-apply the most recent rewind."
                },
                "created_at": {
                    "type": "string",
                    "description": "Required for rewind. ISO-8601 timestamp of the earliest snapshot to undo. All snapshots at or after this time will be reverted."
                }
            },
            "required": ["action"]
        })
    }

    async fn execute_text(
        &self,
        params: Value,
        _ctx: &crate::tools::traits::CallContext,
    ) -> Result<String, ToolError> {
        let action = required_string(&params, "action")?;
        match action.as_str() {
            "list" => self.exec_list().await,
            "rewind" => self.exec_rewind(&params).await,
            "redo" => self.exec_redo().await,
            other => Err(ToolError::InvalidParams(format!(
                "Unknown action: \"{}\". Use \"list\", \"rewind\", or \"redo\".",
                other
            ))),
        }
    }

    async fn set_session_key(&self, session_key: &str) {
        *self.session_id.lock().await = Some(session_key.to_string());
    }
}

impl ManageFileHistoryTool {
    async fn exec_list(&self) -> Result<String, ToolError> {
        let session_id = self.get_session_id().await?;
        let snapshots = tokio::task::spawn_blocking(move || {
            let mut snapshots = Vec::new();
            for review_session_id in review_session_ids(&session_id) {
                for (tool_call_id, snapshot_id, created_at) in
                    crate::persistence::session_snapshots::get_snapshots(&review_session_id)?
                {
                    snapshots.push((
                        review_session_id.clone(),
                        tool_call_id,
                        snapshot_id,
                        created_at,
                    ));
                }
            }
            snapshots
                .sort_by(|left, right| left.3.cmp(&right.3).then_with(|| left.0.cmp(&right.0)));
            Ok::<_, rusqlite::Error>(snapshots)
        })
        .await
        .map_err(|err| ToolError::ExecutionFailed(format!("Join error: {}", err)))?
        .map_err(|err| ToolError::ExecutionFailed(format!("DB error: {}", err)))?;

        if snapshots.is_empty() {
            return Ok("No snapshots captured in this session yet.".into());
        }

        let mut lines = vec!["Snapshots (oldest first):".to_string()];
        for (session_id, tool_call_id, _snapshot_id, created_at) in &snapshots {
            let kind = if tool_call_id.starts_with(REDO_TOOL_CALL_PREFIX) {
                " [redo]"
            } else {
                ""
            };
            lines.push(format!(
                "  • session_id={} tool_call_id={} created_at={}{}",
                session_id, tool_call_id, created_at, kind
            ));
        }
        lines.push(String::new());
        lines.push(format!(
            "Total: {} snapshot(s). To rewind to before a specific snapshot, \
             use action=rewind with the created_at of the earliest snapshot to undo.",
            snapshots.len()
        ));
        Ok(lines.join("\n"))
    }

    async fn exec_rewind(&self, params: &Value) -> Result<String, ToolError> {
        let session_id = self.get_session_id().await?;
        let created_at = required_string(params, "created_at")?;
        let ca = created_at.clone();

        let (restored, deleted, skipped, failed, redo_count) =
            tokio::task::spawn_blocking(move || {
                let mut restored = 0usize;
                let mut deleted = 0usize;
                let mut skipped = 0usize;
                let mut failed = 0usize;
                let mut redo_count = 0usize;
                let mut errors = Vec::new();

                for review_session_id in review_session_ids(&session_id) {
                    match crate::tools::file_history::rewind_to_message(&review_session_id, &ca) {
                        Ok(stats) => {
                            restored += stats.restored;
                            deleted += stats.deleted;
                            skipped += stats.skipped_unchanged;
                            failed += stats.failed;
                            if stats.redo_snapshot_id.is_some() {
                                redo_count += 1;
                            }
                            invalidate_cli_resume_state_best_effort(
                                &review_session_id,
                                crate::foundation::session_bridge::CLI_HISTORY_MUTATION_FILE_REWIND,
                            );
                        }
                        Err(err) => {
                            failed += 1;
                            errors.push(format!("{review_session_id}: {err}"));
                        }
                    }
                }

                if errors.is_empty() {
                    Ok((restored, deleted, skipped, failed, redo_count))
                } else {
                    Err(errors.join("; "))
                }
            })
            .await
            .map_err(|err| ToolError::ExecutionFailed(format!("Join error: {}", err)))?
            .map_err(|err| ToolError::ExecutionFailed(format!("Rewind failed: {}", err)))?;

        let redo_note = if redo_count > 0 {
            " A redo snapshot was captured — call `redo` to re-apply."
        } else {
            ""
        };

        Ok(format!(
            "Rewind complete. Restored {} file(s), deleted {} file(s), \
             skipped {} unchanged, {} failed.{}",
            restored, deleted, skipped, failed, redo_note
        ))
    }

    async fn exec_redo(&self) -> Result<String, ToolError> {
        let session_id = self.get_session_id().await?;

        let (restored, deleted, skipped, failed) = tokio::task::spawn_blocking(move || {
            let mut restored = 0usize;
            let mut deleted = 0usize;
            let mut skipped = 0usize;
            let mut failed = 0usize;
            let mut restored_any = false;
            let mut errors = Vec::new();

            for review_session_id in review_session_ids(&session_id) {
                let redo_snapshot_id =
                    crate::persistence::session_snapshots::get_latest_snapshot_by_tool_call_prefix(
                        &review_session_id,
                        REDO_TOOL_CALL_PREFIX,
                    )
                    .map_err(|err| format!("{review_session_id}: DB error: {err}"))?;

                let Some(snapshot_id) = redo_snapshot_id else {
                    continue;
                };

                match crate::tools::file_history::restore_snapshot(&review_session_id, &snapshot_id) {
                    Ok(stats) => {
                        restored_any = true;
                        restored += stats.restored;
                        deleted += stats.deleted;
                        skipped += stats.skipped_unchanged;
                        failed += stats.failed;
                        invalidate_cli_resume_state_best_effort(
                            &review_session_id,
                            crate::foundation::session_bridge::CLI_HISTORY_MUTATION_SNAPSHOT_RESTORE,
                        );
                    }
                    Err(err) => {
                        failed += 1;
                        errors.push(format!("{review_session_id}: {err}"));
                    }
                }
            }

            if !restored_any {
                return Err("No redo snapshot found. Perform a rewind first.".to_string());
            }
            if errors.is_empty() {
                Ok((restored, deleted, skipped, failed))
            } else {
                Err(errors.join("; "))
            }
        })
        .await
        .map_err(|err| ToolError::ExecutionFailed(format!("Join error: {}", err)))?
        .map_err(|err| ToolError::ExecutionFailed(format!("Redo failed: {}", err)))?;

        Ok(format!(
            "Redo complete. Restored {} file(s), deleted {} file(s), \
             skipped {} unchanged, {} failed.",
            restored, deleted, skipped, failed
        ))
    }
}

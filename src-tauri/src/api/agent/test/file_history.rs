//! Debug-only file-history / restore-checkpoint endpoints.
//!
//! Exposes the SAME backend truncate path used by the production restore
//! checkpoint flow (`useRestoreCheckpoint`) and edit-resend flow
//! (`useEditUserMessage`), MINUS the frontend re-dispatch. This lets the
//! WDIO rewind matrix drive a deterministic "restore to checkpoint" and
//! assert the durable outcome (file revert + message-history truncation)
//! without depending on a live provider re-send.
//!
//! Only compiled in dev builds; `create_routes` in `api/agent/mod.rs`
//! calls this via `test::file_history::*`.

#![cfg(debug_assertions)]

use axum::Json;
use serde::Deserialize;
use serde_json::json;

/// Restore the session to the checkpoint at `created_at`: revert files
/// (optional) and hard-delete all messages/chunks at or after that point.
/// Mirrors the production restore path; no message is re-sent.
#[derive(Debug, Deserialize)]
pub struct RestoreCheckpointRequest {
    session_id: String,
    created_at: String,
    /// When true (default), file-history is rewound to the checkpoint.
    revert_files: Option<bool>,
    /// `true` for CLI-runtime sessions (claude-code, codex, cursor-cli,
    /// Codex), `false`/omitted for Rust-runtime agent sessions.
    is_cli: Option<bool>,
    /// Agent-session message anchor id (optional; mirrors the production
    /// `messageId` argument passed to `agent_truncate_after_message`).
    message_id: Option<String>,
}

pub async fn test_restore_checkpoint(
    Json(req): Json<RestoreCheckpointRequest>,
) -> Json<serde_json::Value> {
    use tauri::Manager;

    let revert_files = req.revert_files.unwrap_or(true);

    if req.is_cli.unwrap_or(false) {
        // CLI runtime: plain-args command, no AgentAppState needed.
        return match crate::agent_sessions::cli::commands::cli_agent_truncate_after_chunk(
            req.session_id.clone(),
            req.created_at.clone(),
            Some(revert_files),
        )
        .await
        {
            Ok(deleted) => Json(json!({
                "ok": true,
                "session_id": req.session_id,
                "created_at": req.created_at,
                "revert_files": revert_files,
                "runtime": "cli",
                "deleted_chunks": deleted,
            })),
            Err(err) => Json(json!({ "ok": false, "error": err })),
        };
    }

    // Rust-runtime agent session: needs AgentAppState from the app handle.
    let handle = match crate::api::get_app_handle() {
        Some(h) => h,
        None => {
            return Json(json!({ "ok": false, "error": "AppHandle not initialized" }));
        }
    };
    let state = handle.state::<agent_core::state::AgentAppState>();

    match agent_core::state::commands::session::agent_truncate_after_message(
        state,
        req.session_id.clone(),
        req.created_at.clone(),
        Some(revert_files),
        req.message_id.clone(),
    )
    .await
    {
        Ok(deleted) => Json(json!({
            "ok": true,
            "session_id": req.session_id,
            "created_at": req.created_at,
            "revert_files": revert_files,
            "runtime": "agent",
            "deleted_messages": deleted,
        })),
        Err(err) => Json(json!({ "ok": false, "error": err })),
    }
}

//! Cross-cutting helpers shared by the `session_crud` write paths:
//! the canonical timestamp and the best-effort orgtrack row mirror.

use chrono::Utc;

pub(in crate::agent_sessions::cli::persistence) fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

/// Best-effort mirror of the session row into orgtrack's canonical store.
/// Runs after writes that change fields orgtrack surfaces (title, status,
/// model, exec mode); never fails the primary write.
pub(super) fn sync_orgtrack_mirror(session_id: &str) {
    if let Err(err) =
        crate::agent_sessions::session_directory::orgtrack_adapter::upsert_cli_session(session_id)
    {
        tracing::warn!(session_id, error = %err, "[cli-persistence] orgtrack session mirror failed");
    }
}

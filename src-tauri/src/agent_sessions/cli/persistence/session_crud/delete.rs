//! Session deletion: shell-replay guard, non-CASCADE usage-table cleanup,
//! orgtrack mirror removal, and hosted-Codex profile teardown.

use rusqlite::Result as SqliteResult;

use database::db::get_connection;

/// Delete a session and all its chunks (CASCADE) + per-round token usage records.
pub fn delete_session(session_id: &str) -> SqliteResult<bool> {
    if let Err(error) =
        agent_core::tools::impls::coding::exec::shell_replay::ensure_session_replays_deletable(
            session_id,
        )
    {
        return Err(rusqlite::Error::ToSqlConversionFailure(Box::new(
            std::io::Error::other(error),
        )));
    }
    agent_core::tools::impls::coding::exec::shell_replay::queue_session_replay_cleanup(session_id)
        .map_err(|error| {
            rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::other(error)))
        })?;
    let conn = get_connection()?;
    conn.execute(
        "DELETE FROM code_session_chunks WHERE session_id = ?1",
        [session_id],
    )?;
    // Clean up per-round token usage records
    conn.execute(
        "DELETE FROM session_token_usage WHERE session_id = ?1",
        [session_id],
    )?;
    // Per-LLM-call telemetry lives in the shared usage tables (not under the
    // code_session_chunks CASCADE), so it needs its own cleanup here.
    conn.execute(
        "DELETE FROM session_llm_usage_spans WHERE session_id = ?1",
        [session_id],
    )?;
    conn.execute(
        "DELETE FROM session_tool_usage WHERE session_id = ?1",
        [session_id],
    )?;
    let affected = conn.execute(
        "DELETE FROM code_sessions WHERE session_id = ?1",
        [session_id],
    )?;
    if affected > 0 {
        if let Err(err) =
            agent_core::tools::impls::coding::exec::shell_replay::remove_session_replays(session_id)
        {
            tracing::warn!(session_id, error = %err, "[cli-persistence] shell replay delete failed");
        }
        if let Err(err) =
            crate::agent_sessions::session_directory::orgtrack_adapter::remove_mirrored_session(
                session_id,
            )
        {
            tracing::warn!(session_id, error = %err, "[cli-persistence] orgtrack delete mirror failed");
        }
        let hosted_codex_profile = app_paths::codex_hosted_cli_profile_dir(session_id);
        if hosted_codex_profile.exists() {
            if let Err(err) = std::fs::remove_dir_all(&hosted_codex_profile) {
                tracing::warn!(
                    session_id,
                    path = %hosted_codex_profile.display(),
                    error = %err,
                    "[cli-persistence] hosted Codex profile delete failed"
                );
            }
        }
    }
    Ok(affected > 0)
}

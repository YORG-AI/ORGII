//! Transcript location and message-edit truncation.

use super::super::persistence;
use super::super::session_runner;

/// Where a managed session's transcript of record lives, for display
/// surfaces (session hover card storage row).
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliTranscriptLocation {
    /// True when the transcript lives in the CLI's native store
    /// (`code_sessions.transcript_source = 'native'`), not `sessions.db`.
    pub native: bool,
    /// Resolved native store path (e.g. a Codex rollout jsonl), when the
    /// imported-history cache already knows it. `None` for chunks-mode
    /// sessions, or for native sessions not yet scanned into the cache.
    pub path: Option<String>,
}

/// Resolve the storage location of a session's transcript of record.
/// Chunks-mode (legacy) sessions report `native: false` — the caller keeps
/// showing `sessions.db`. Native sessions report the CLI store file path when
/// the imported-history cache has it, else `native: true` with no path.
#[tauri::command]
pub async fn cli_agent_transcript_path(
    session_id: String,
) -> Result<CliTranscriptLocation, String> {
    tokio::task::spawn_blocking(move || {
        use super::super::native_transcript;
        let is_native = persistence::get_session(&session_id)
            .map_err(|e| format!("DB error: {}", e))?
            .is_some_and(|session| {
                session.transcript_source == native_transcript::TRANSCRIPT_SOURCE_NATIVE
            });
        if !is_native {
            return Ok(CliTranscriptLocation {
                native: false,
                path: None,
            });
        }
        // Native session with no bound CLI id yet (first turn still running,
        // or crash before bind): native, but no path to show.
        let Some((binding, cli_session_id)) =
            native_transcript::native_store_key_for_managed_session(&session_id)
        else {
            return Ok(CliTranscriptLocation {
                native: true,
                path: None,
            });
        };
        let conn = database::db::get_connection()
            .map_err(|err| format!("Failed to open orgtrack source cache DB: {err}"))?;
        // Exact match first; Codex caches key on the rollout file stem, which
        // only the `-`-bounded suffix variant matches.
        let mut path =
            orgtrack_core::sources::imported_history::cache::get_cached_source_path_from_conn(
                &conn,
                binding.source,
                &cli_session_id,
            )?;
        if path.is_none() {
            path = orgtrack_core::sources::imported_history::cache::
                get_cached_source_path_by_suffix_from_conn(&conn, binding.source, &cli_session_id)?;
        }
        Ok(CliTranscriptLocation { native: true, path })
    })
    .await
    .map_err(|e| format!("Task error: {}", e))?
}

/// Truncate chunks at and after a specific timestamp.
/// Used for message editing — removes chunks at or after the given timestamp,
/// kills the running agent, clears CLI resume state, and optionally restores file snapshots.
#[tauri::command]
pub async fn cli_agent_truncate_after_chunk(
    session_id: String,
    created_at: String,
    revert_files: Option<bool>,
) -> Result<i64, String> {
    // Kill any running agent first to prevent it from writing new chunks
    session_runner::kill_running_agent(&session_id).await;

    // Wipe the Cursor config dir so the agent starts fresh — legacy chunk mode
    // ONLY. Under `transcript_source = 'native'` that directory IS the
    // transcript of record (hosted-key Cursor stores its chats under the
    // per-session config dir), so deleting it would erase the whole
    // conversation instead of truncating it. The fork is driven by
    // `clear_cli_resume_state_with_tx` inside the truncate below: with no
    // resume id the CLI opens a fresh conversation, and the superseded store
    // stays on disk hidden behind the native-transcript ledger — the same
    // semantics Claude/Codex native forks already have.
    if persistence::session_persists_chunks(&session_id) {
        session_runner::cleanup_cursor_config_dir(&session_id);
    }

    let should_revert_files = revert_files.unwrap_or(true);
    if should_revert_files {
        let rewind_sid = session_id.clone();
        let rewind_ts = created_at.clone();
        let stats = tokio::task::spawn_blocking(move || {
            agent_core::tools::file_history::rewind_to_message(&rewind_sid, &rewind_ts)
        })
        .await
        .map_err(|err| format!("Task error: {}", err))?
        .map_err(|err| format!("File history rewind failed: {}", err))?;

        tracing::info!(
            "[code_session] file-history rewind at {}: restored={} deleted={} skipped={} failed={}",
            created_at,
            stats.restored,
            stats.deleted,
            stats.skipped_unchanged,
            stats.failed,
        );
    }

    let sid = session_id.clone();
    let mutation_reason = if should_revert_files {
        agent_core::foundation::session_bridge::CLI_HISTORY_MUTATION_FILE_REWIND
    } else {
        agent_core::foundation::session_bridge::CLI_HISTORY_MUTATION_MESSAGE_TRUNCATE
    };
    tokio::task::spawn_blocking(move || {
        persistence::truncate_chunks_after_with_reason(&sid, &created_at, mutation_reason)
            .map_err(|e| format!("DB error: {}", e))
    })
    .await
    .map_err(|e| format!("Task error: {}", e))?
}

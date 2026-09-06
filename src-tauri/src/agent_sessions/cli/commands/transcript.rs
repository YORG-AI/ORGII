//! Transcript loading and mutation — native/legacy chunk resolution
//! (`cli_agent_chunks`, `cli_agent_transcript_path`) and message-edit
//! truncation (`cli_agent_truncate_after_chunk`).

use super::super::persistence::{self, CodeSession};
use super::super::session_runner;
use core_types::activity::ActivityChunk;

use super::super::native_store::native_transcript_revision;

/// Resolve and parse a native-mode session's transcript from the CLI's own
/// store through the imported-history loaders. `None` falls back to legacy
/// chunks — covering pre-migration sessions, crash-before-native-write, and
/// a store the reader can't currently open.
fn load_native_transcript_chunks(session: &CodeSession) -> Option<Vec<ActivityChunk>> {
    use super::super::native_transcript;
    if session.transcript_source != native_transcript::TRANSCRIPT_SOURCE_NATIVE {
        return None;
    }
    let agent = session
        .cli_agent_type
        .as_deref()
        .and_then(key_vault::key_store::ModelType::from_str)?;
    let binding = native_transcript::native_transcript_binding(&agent)?;
    // UI replay and provider resume must use the same account-scoped native
    // UUID. The historical ledger is source-wide and may contain another
    // account's newest UUID after A→B→A; consulting it here would render B's
    // transcript while the next send resumes A. Until the ledger itself is
    // profile-scoped, fail closed to the exact current account mapping.
    let account_id = session
        .account_id
        .as_deref()
        .filter(|value| !value.trim().is_empty());
    let candidate_ids =
        persistence::get_cli_session_id_for_account(&session.session_id, account_id)
            .ok()
            .flatten()
            .into_iter();
    let conn = database::db::get_connection().ok()?;
    for cli_session_id in candidate_ids {
        let imported_id = binding.imported_session_id(&cli_session_id);
        // A managed native session already has an exact provider UUID and
        // execution workspace. Read that authoritative file first: it is
        // available synchronously after materialization and does not require
        // the eventually-consistent imported-history cache (or a global
        // provider-store scan) to have observed it yet.
        let exact_error = match super::super::native_materializer::load_materialized_cli_transcript(
            session,
            &cli_session_id,
        ) {
            Ok(Some(mut chunks)) if !chunks.is_empty() => {
                for chunk in &mut chunks {
                    chunk.session_id = session.session_id.clone();
                }
                return Some(chunks);
            }
            Ok(_) => None,
            Err(err) => Some(err),
        };

        // Fall back to discovery for legacy/provider files that moved away
        // from the bound workspace. Only report errors after both exact and
        // discovery readers failed, so a healthy exact transcript does not
        // emit a misleading file-not-found warning while the cache catches up.
        let mut discovery_failed = false;
        match orgtrack_core::sources::imported_history::load_activity_chunks_for_session(
            &conn,
            &imported_id,
        ) {
            Ok(Some(mut chunks)) if !chunks.is_empty() => {
                // Loaders stamp the imported id; the frontend event store,
                // WS merge, and snapshot keys all key on the managed id.
                for chunk in &mut chunks {
                    chunk.session_id = session.session_id.clone();
                }
                return Some(chunks);
            }
            Ok(_) => {}
            Err(err) => {
                discovery_failed = true;
                if let Some(exact_error) = exact_error.as_deref() {
                    tracing::warn!(
                        "[cli_agent_chunks] Native transcript load failed for {imported_id}: exact={exact_error}; discovery={err}"
                    );
                } else {
                    tracing::warn!(
                        "[cli_agent_chunks] Native transcript load failed for {imported_id}: {err}"
                    );
                }
            }
        }
        if !discovery_failed {
            if let Some(err) = exact_error {
                tracing::warn!(
                    "[cli_agent_chunks] Exact native transcript load failed for {imported_id}: {err}"
                );
            }
        }
    }
    None
}

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

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliTranscriptRevision {
    /// False for legacy DB-chunk sessions, which have no provider file.
    native: bool,
    /// Opaque provider-file-set token. `None` for an unbound or unavailable
    /// native transcript; callers must not treat that snapshot as stable.
    revision: Option<String>,
}

fn cached_native_transcript_path(
    conn: &rusqlite::Connection,
    source: &str,
    native_id: &str,
) -> Result<Option<String>, String> {
    orgtrack_core::sources::imported_history::cache::get_cached_source_path_from_conn(
        conn, source, native_id,
    )
    .and_then(|path| {
        if path.is_some() {
            Ok(path)
        } else {
            orgtrack_core::sources::imported_history::cache::
                get_cached_source_path_by_suffix_from_conn(conn, source, native_id)
        }
    })
}

fn load_cli_transcript_revision(session_id: &str) -> Result<CliTranscriptRevision, String> {
    use super::super::native_transcript;

    let legacy = || CliTranscriptRevision {
        native: false,
        revision: None,
    };
    let unavailable = || CliTranscriptRevision {
        native: true,
        revision: None,
    };

    let Some(session) =
        persistence::get_session(session_id).map_err(|error| format!("DB error: {error}"))?
    else {
        return Ok(legacy());
    };
    if session.transcript_source != native_transcript::TRANSCRIPT_SOURCE_NATIVE {
        return Ok(legacy());
    }
    let Some(binding) = session
        .cli_agent_type
        .as_deref()
        .and_then(key_vault::key_store::ModelType::from_str)
        .and_then(|agent| native_transcript::native_transcript_binding(&agent))
    else {
        return Ok(unavailable());
    };
    let account_id = session
        .account_id
        .as_deref()
        .filter(|value| !value.trim().is_empty());
    let Some(native_id) = persistence::get_cli_session_id_for_account(session_id, account_id)
        .map_err(|error| format!("read native binding for {session_id}: {error}"))?
    else {
        return Ok(unavailable());
    };

    let exact_revision = super::super::native_materializer::materialized_cli_transcript_revision(
        &session, &native_id,
    )
    .ok()
    .flatten();

    let discovery_revision = database::db::get_connection()
        .ok()
        .and_then(|conn| {
            cached_native_transcript_path(&conn, binding.source, &native_id)
                .ok()
                .flatten()
        })
        .map(std::path::PathBuf::from)
        .filter(|path| path.is_file())
        .and_then(|path| native_transcript_revision(&path).ok());
    // The transcript reader tries the exact materialized path and then its
    // imported-history discovery path. Track both candidates: if the exact
    // file is unreadable and replay falls back to discovery, an external App
    // append to either possible source still invalidates the snapshot.
    let revision = if exact_revision.is_none() && discovery_revision.is_none() {
        None
    } else {
        Some(
            serde_json::to_string(&("native-file-set-v1", exact_revision, discovery_revision))
                .map_err(|error| format!("serialize native transcript revision: {error}"))?,
        )
    };
    Ok(CliTranscriptRevision {
        native: true,
        revision,
    })
}

/// Return the provider-file-set revision through the same native binding and
/// path resolution used by transcript replay. The token is opaque to
/// TypeScript; callers may only compare it for equality around a canonical
/// read.
#[tauri::command]
pub async fn cli_agent_transcript_revision(
    session_id: String,
) -> Result<CliTranscriptRevision, String> {
    tokio::task::spawn_blocking(move || load_cli_transcript_revision(&session_id))
        .await
        .map_err(|error| format!("Task error: {error}"))?
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
        let path = cached_native_transcript_path(&conn, binding.source, &cli_session_id)?;
        Ok(CliTranscriptLocation { native: true, path })
    })
    .await
    .map_err(|e| format!("Task error: {}", e))?
}

/// A failed first turn in native mode may leave no readable transcript at
/// all; a synthesized user bubble beats a blank chat.
fn synthesized_user_message_chunk(session: &CodeSession) -> Option<ActivityChunk> {
    let user_input = session.user_input.as_deref()?.trim();
    if user_input.is_empty() {
        return None;
    }
    let mut chunk = ActivityChunk::new(&session.session_id, "raw", "user_message");
    chunk.chunk_id = format!("user-input-{}-synthesized", session.session_id);
    chunk.created_at = session.created_at.clone();
    chunk.result = serde_json::json!({
        "type": "user",
        "message": { "content": user_input, "role": "user" }
    });
    Some(chunk)
}

/// Load persisted chunks for a session (for resume/session switch).
/// Native-transcript sessions route through the imported-history loaders;
/// everything else (and every fallback) reads legacy `code_session_chunks`.
#[tauri::command]
pub async fn cli_agent_chunks(session_id: String) -> Result<Vec<ActivityChunk>, String> {
    tracing::info!(
        "[cli_agent_chunks] Loading chunks for session: {}",
        session_id
    );
    let result = tokio::task::spawn_blocking(move || {
        let session =
            persistence::get_session(&session_id).map_err(|e| format!("DB error: {}", e))?;
        if let Some(session) = session.as_ref() {
            if let Some(chunks) = load_native_transcript_chunks(session) {
                return Ok(chunks);
            }
        }
        let chunks =
            persistence::load_chunks(&session_id).map_err(|e| format!("DB error: {}", e))?;
        if chunks.is_empty() {
            if let Some(chunk) = session
                .as_ref()
                .filter(|session| {
                    session.transcript_source
                        == super::super::native_transcript::TRANSCRIPT_SOURCE_NATIVE
                })
                .and_then(synthesized_user_message_chunk)
            {
                return Ok(vec![chunk]);
            }
        }
        Ok(chunks)
    })
    .await
    .map_err(|e| format!("Task error: {}", e))?;

    match &result {
        Ok(chunks) => {
            tracing::info!("[cli_agent_chunks] Loaded {} chunks", chunks.len())
        }
        Err(ref err) => tracing::error!("[cli_agent_chunks] Failed: {}", err),
    }
    result
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
    let control_lock = session_runner::session_control_lock(&session_id).await;
    let _control_guard = control_lock.lock_owned().await;
    // Kill any running agent first to prevent it from writing new chunks
    session_runner::kill_running_agent(&session_id).await;
    let _identity_guard = session_runner::session_identity_lock(&session_id)
        .await
        .lock_owned()
        .await;
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

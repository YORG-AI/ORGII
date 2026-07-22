use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Result as SqliteResult};

use agent_core::session::AgentExecMode;
use database::db::get_connection;

use super::super::types::{
    session_defaults, KeySource, SessionRunner, SessionStatus, DEFAULT_CODE_SESSION_FLOW,
    PERSONAL_ORG_ID,
};
use super::types::{
    CliHistoryMutation, CliSessionStatusSnapshot, CodeSession, CreateCodeSessionParams,
};

pub(super) fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

/// Best-effort mirror of the session row into orgtrack's canonical store.
/// Runs after writes that change fields orgtrack surfaces (title, status,
/// model, exec mode); never fails the primary write.
fn sync_orgtrack_mirror(session_id: &str) {
    if let Err(err) =
        crate::agent_sessions::session_directory::orgtrack_adapter::upsert_cli_session(session_id)
    {
        tracing::warn!(session_id, error = %err, "[cli-persistence] orgtrack session mirror failed");
    }
}

/// Create a new code session. Returns the session ID.
pub fn create_session(
    session_id: &str,
    params: &CreateCodeSessionParams,
) -> SqliteResult<CodeSession> {
    let conn = get_connection()?;
    let ts = now_iso();
    let name = params
        .name
        .clone()
        .unwrap_or_else(|| session_defaults::CODE_SESSION_NAME.to_string());
    let flow = params
        .flow
        .clone()
        .unwrap_or_else(|| DEFAULT_CODE_SESSION_FLOW.to_string());
    // Wire-typo guard: `runner` is read back via `SessionRunner::parse`
    // (typed enum) at every read site. If the caller passes a typo'd
    // string here, the row would be persisted as garbage and every
    // subsequent `row_to_session` would reject it as a
    // `FromSqlConversionFailure` — i.e. the session would be created
    // but unloadable. Reject at the entry point instead.
    let runner = match params.runner.as_deref().filter(|s| !s.is_empty()) {
        Some(raw) => SessionRunner::parse(raw)
            .ok_or_else(|| {
                rusqlite::Error::ToSqlConversionFailure(
                    format!("unknown SessionRunner value: {raw:?}").into(),
                )
            })?
            .to_string(),
        None => SessionRunner::Local.to_string(),
    };

    let background = params.background.unwrap_or(false);

    // Wire-typo guard for `key_source` — same reasoning as `runner`.
    // `row_to_session` will fail-closed on an unknown column value, so
    // accepting an unvalidated string here would create an unloadable
    // session row (the frontend would see a created session that can
    // never be opened). Validate at the write boundary.
    let key_source_str = match params.key_source.as_deref().filter(|s| !s.is_empty()) {
        Some(raw) => KeySource::parse(raw)
            .ok_or_else(|| {
                rusqlite::Error::ToSqlConversionFailure(
                    format!("unknown KeySource value: {raw:?}").into(),
                )
            })?
            .to_string(),
        None => KeySource::default().to_string(),
    };

    let org_id = params
        .org_id
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| PERSONAL_ORG_ID.to_string());

    let additional_dirs_json: Option<String> = params
        .additional_directories
        .as_ref()
        .filter(|v| !v.is_empty())
        .map(|v| serde_json::to_string(v).unwrap_or_else(|_| "[]".to_string()));

    // Native-transcript capability is decided once at creation and frozen:
    // a later capability flip must never re-route an existing session's
    // replay away from where its turns were actually persisted.
    let transcript_source = key_vault::key_store::ModelType::from_str(&params.cli_agent_type)
        .filter(super::super::native_transcript::native_transcript_enabled)
        .map(|_| super::super::native_transcript::TRANSCRIPT_SOURCE_NATIVE)
        .unwrap_or(super::super::native_transcript::TRANSCRIPT_SOURCE_CHUNKS);

    conn.execute(
        "INSERT INTO code_sessions
            (session_id, name, status, flow, runner, cli_agent_type, model, tier,
             account_id, repo_path, branch, proxy_token, proxy_url, hosted_token,
             proxy_session_id, background, key_source, additional_directories,
             parent_session_id, org_member_id, org_id, project_id, project_name,
             project_slug, work_item_id, agent_role, created_at, updated_at,
             transcript_source)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29)",
        params![
            session_id, name, SessionStatus::Pending.as_ref(), flow, runner, params.cli_agent_type,
            params.model, params.tier, params.account_id,
            params.repo_path, params.branch, params.proxy_token, params.proxy_url,
            params.hosted_token, params.proxy_session_id, background, key_source_str,
            additional_dirs_json, params.parent_session_id, params.org_member_id,
            org_id, params.project_id, params.project_name, params.project_slug,
            params.work_item_id, params.agent_role, ts, ts, transcript_source,
        ],
    )?;

    let session = get_session(session_id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)?;
    sync_orgtrack_mirror(session_id);
    Ok(session)
}

/// Column list shared by get_session and list_sessions.
/// COALESCE(cli_agent_type, platform) provides backward compat for rows written before the migration.
const SESSION_COLUMNS: &str =
    "cs.session_id, cs.name, cs.status, cs.flow, cs.runner,
     COALESCE(cs.cli_agent_type, cs.platform), cs.model, cs.tier, cs.account_id, cs.repo_path, cs.branch, cs.user_input,
     cs.proxy_token, cs.proxy_url, cs.hosted_token, cs.error_message,
     COALESCE((SELECT total_tokens FROM orgtrack_core_session_usage WHERE session_id = cs.session_id), 0),
     cs.pid, cs.cli_session_id, cs.proxy_session_id,
     cs.worktree_path, cs.worktree_branch, cs.base_branch, cs.merge_status,
     COALESCE(cs.background, 0),
     COALESCE(cs.key_source, 'own_key'),
     cs.agent_exec_mode, cs.draft_text, cs.reply_target_event_id,
     COALESCE(cs.pinned, 0), cs.additional_directories,
     cs.parent_session_id, cs.org_member_id,
     COALESCE(cs.org_id, 'personal-org'), cs.project_id, cs.project_name,
     cs.project_slug, cs.work_item_id, cs.agent_role,
     cs.created_at, cs.updated_at,
     COALESCE(cs.transcript_source, 'chunks')";

/// Get a session by ID.
pub fn get_session(session_id: &str) -> SqliteResult<Option<CodeSession>> {
    let conn = get_connection()?;
    let query = format!(
        "SELECT {} FROM code_sessions cs WHERE cs.session_id = ?1",
        SESSION_COLUMNS
    );
    let result = conn.query_row(&query, [session_id], row_to_session);
    match result {
        Ok(s) => Ok(Some(s)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e),
    }
}

/// List all code sessions, newest first.
pub fn list_sessions() -> SqliteResult<Vec<CodeSession>> {
    let conn = get_connection()?;
    let query = format!(
        "SELECT {} FROM code_sessions cs ORDER BY cs.created_at DESC",
        SESSION_COLUMNS
    );
    let mut stmt = conn.prepare(&query)?;
    let rows = stmt.query_map([], row_to_session)?;
    rows.collect()
}

/// Load only lifecycle fields for a bounded set of sessions. This is used by
/// reconnect/focus reconciliation and deliberately avoids hydrating complete
/// session rows or scanning unrelated sessions.
pub fn status_snapshots(session_ids: &[String]) -> SqliteResult<Vec<CliSessionStatusSnapshot>> {
    if session_ids.is_empty() {
        return Ok(Vec::new());
    }
    let conn = get_connection()?;
    let placeholders = std::iter::repeat_n("?", session_ids.len())
        .collect::<Vec<_>>()
        .join(",");
    let query = format!(
        "SELECT session_id, status, updated_at FROM code_sessions WHERE session_id IN ({placeholders})"
    );
    let mut stmt = conn.prepare(&query)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(session_ids), |row| {
        let raw_status: String = row.get(1)?;
        let status = SessionStatus::parse(&raw_status).ok_or_else(|| {
            rusqlite::Error::FromSqlConversionFailure(
                1,
                rusqlite::types::Type::Text,
                format!("invalid code session status: {raw_status}").into(),
            )
        })?;
        Ok(CliSessionStatusSnapshot {
            session_id: row.get(0)?,
            status,
            updated_at: row.get(2)?,
        })
    })?;
    rows.collect()
}

/// One page of sessions ordered by recent activity. Serves the sidebar's
/// paginated category view without loading the whole table.
pub fn list_sessions_page(limit: usize, offset: usize) -> SqliteResult<Vec<CodeSession>> {
    let conn = get_connection()?;
    let query = format!(
        "SELECT {} FROM code_sessions cs ORDER BY cs.updated_at DESC LIMIT ?1 OFFSET ?2",
        SESSION_COLUMNS
    );
    let limit = limit.min(i64::MAX as usize) as i64;
    let offset = offset.min(i64::MAX as usize) as i64;
    let mut stmt = conn.prepare(&query)?;
    let rows = stmt.query_map(params![limit, offset], row_to_session)?;
    rows.collect()
}

/// Update session status.
pub fn update_status(session_id: &str, status: SessionStatus) -> SqliteResult<bool> {
    let conn = get_connection()?;
    let affected = update_status_row(&conn, session_id, status, None)?;
    if affected {
        sync_orgtrack_mirror(session_id);
    }
    Ok(affected)
}

fn update_status_row(
    conn: &Connection,
    session_id: &str,
    status: SessionStatus,
    error: Option<&str>,
) -> SqliteResult<bool> {
    let now = now_iso();
    let affected = match (status.is_terminal(), error) {
        (true, Some(error)) => conn.execute(
            "UPDATE code_sessions SET status = ?2, error_message = ?3, pid = NULL, updated_at = ?4 WHERE session_id = ?1",
            params![session_id, status.as_ref(), error, now],
        )?,
        (false, Some(error)) => conn.execute(
            "UPDATE code_sessions SET status = ?2, error_message = ?3, updated_at = ?4 WHERE session_id = ?1",
            params![session_id, status.as_ref(), error, now],
        )?,
        (true, None) => conn.execute(
            "UPDATE code_sessions SET status = ?2, pid = NULL, updated_at = ?3 WHERE session_id = ?1",
            params![session_id, status.as_ref(), now],
        )?,
        (false, None) => conn.execute(
            "UPDATE code_sessions SET status = ?2, updated_at = ?3 WHERE session_id = ?1",
            params![session_id, status.as_ref(), now],
        )?,
    };
    Ok(affected > 0)
}

/// Update session status with error message.
pub fn update_status_with_error(
    session_id: &str,
    status: SessionStatus,
    error: &str,
) -> SqliteResult<bool> {
    let conn = get_connection()?;
    let affected = update_status_row(&conn, session_id, status, Some(error))?;
    if affected {
        sync_orgtrack_mirror(session_id);
    }
    Ok(affected)
}

/// Atomically accept a CLI turn: the session and its intent become running
/// together, so reconnect cannot observe a split-brain lifecycle snapshot.
pub fn accept_cli_turn(
    session_id: &str,
    turn_intent_id: &str,
    client_message_id: &str,
) -> Result<(), String> {
    let conn = get_connection().map_err(|err| err.to_string())?;
    let tx = conn
        .unchecked_transaction()
        .map_err(|err| err.to_string())?;
    if !update_status_row(&tx, session_id, SessionStatus::Running, None)
        .map_err(|err| err.to_string())?
    {
        return Err(format!("session not found: {session_id}"));
    }
    session_persistence::turn_intents::upsert_initial_on(
        &tx,
        session_id,
        turn_intent_id,
        Some(client_message_id),
        session_persistence::turn_intents::TurnIntentSource::UserSubmit,
        session_persistence::turn_intents::TurnIntentStatus::Queued,
    )
    .map_err(|err| err.to_string())?;
    session_persistence::turn_intents::update_status_on(
        &tx,
        session_id,
        turn_intent_id,
        session_persistence::turn_intents::TurnIntentStatus::Running,
    )
    .map_err(|err| err.to_string())?;
    tx.commit().map_err(|err| err.to_string())?;
    sync_orgtrack_mirror(session_id);
    Ok(())
}

/// Atomically persist a CLI session status and the matching intent terminal.
pub fn update_cli_turn_lifecycle(
    session_id: &str,
    status: SessionStatus,
    error: Option<&str>,
    turn_intent: Option<(&str, session_persistence::turn_intents::TurnIntentStatus)>,
) -> Result<(), String> {
    let conn = get_connection().map_err(|err| err.to_string())?;
    let tx = conn
        .unchecked_transaction()
        .map_err(|err| err.to_string())?;
    if !update_status_row(&tx, session_id, status, error).map_err(|err| err.to_string())? {
        return Err(format!("session not found: {session_id}"));
    }
    if let Some((turn_intent_id, intent_status)) = turn_intent {
        session_persistence::turn_intents::update_status_on(
            &tx,
            session_id,
            turn_intent_id,
            intent_status,
        )
        .map_err(|err| err.to_string())?;
    }
    tx.commit().map_err(|err| err.to_string())?;
    sync_orgtrack_mirror(session_id);
    Ok(())
}

/// Store the PID of the CLI subprocess.
pub fn update_pid(session_id: &str, pid: u32) -> SqliteResult<bool> {
    let conn = get_connection()?;
    let affected = conn.execute(
        "UPDATE code_sessions SET pid = ?2, updated_at = ?3 WHERE session_id = ?1",
        params![session_id, pid as i64, now_iso()],
    )?;
    Ok(affected > 0)
}

/// Clear the PID after the CLI subprocess exits.
pub fn clear_pid(session_id: &str) -> SqliteResult<bool> {
    let conn = get_connection()?;
    let affected = conn.execute(
        "UPDATE code_sessions SET pid = NULL, updated_at = ?2 WHERE session_id = ?1",
        params![session_id, now_iso()],
    )?;
    Ok(affected > 0)
}

// `updated_at` invariant — same as the parallel comment in
// `agent_core/core/session/persistence/crud/ops.rs`. `code_sessions.updated_at`
// reflects real conversation / lifecycle activity (status transitions,
// pid changes, worktree merges, message edits via `truncate_chunks_after`).
// Per-session config / composer state writes (model, draft, reply pin,
// proxy creds rotation, internal cli_session_id assignment) leave it
// alone so the sidebar order and Kanban time filter stay tied to user-
// visible activity.

fn resume_profile_key(account_id: Option<&str>) -> String {
    account_id
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("__session__")
        .to_string()
}

/// Store the CLI agent's own session/conversation ID for resume support.
/// Internal bookkeeping — does not bump `updated_at`.
pub fn update_cli_session_id(session_id: &str, cli_session_id: &str) -> SqliteResult<bool> {
    let conn = get_connection()?;
    let account_id: Option<String> = conn
        .query_row(
            "SELECT account_id FROM code_sessions WHERE session_id = ?1",
            params![session_id],
            |row| row.get(0),
        )
        .optional()?;
    update_cli_session_id_for_account(session_id, account_id.as_deref(), cli_session_id)
}

/// Store a CLI native session ID under the account/profile that launched the
/// process, not whatever account the session row may point at when the process
/// exits. This prevents a slow old process from writing account A's native
/// conversation id into account B's resume slot after a mid-turn switch.
pub fn update_cli_session_id_for_account(
    session_id: &str,
    account_id: Option<&str>,
    cli_session_id: &str,
) -> SqliteResult<bool> {
    let conn = get_connection()?;
    let profile_key = resume_profile_key(account_id);
    let tx = conn.unchecked_transaction()?;
    let affected = tx.execute(
        "UPDATE code_sessions
         SET cli_session_id = CASE
             WHEN account_id IS ?3 THEN ?2
             ELSE cli_session_id
         END
         WHERE session_id = ?1",
        params![session_id, cli_session_id, account_id],
    )?;
    if affected == 0 {
        tx.commit()?;
        return Ok(false);
    }
    tx.execute(
        "INSERT INTO code_session_cli_resume_state
            (session_id, profile_key, cli_session_id, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(session_id, profile_key)
         DO UPDATE SET cli_session_id = excluded.cli_session_id,
                       updated_at = excluded.updated_at",
        params![session_id, profile_key, cli_session_id, now_iso()],
    )?;
    // Append-only binding ledger (native-transcript replay + sidebar dedup
    // keep recognizing superseded forks after account switch / message edit).
    let binding = conn
        .query_row(
            "SELECT COALESCE(cli_agent_type, platform) FROM code_sessions WHERE session_id = ?1",
            params![session_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten()
        .as_deref()
        .and_then(key_vault::key_store::ModelType::from_str)
        .as_ref()
        .and_then(super::super::native_transcript::native_transcript_binding);
    if let Some(binding) = binding {
        tx.execute(
            "INSERT OR IGNORE INTO code_session_native_transcript_ids
                (session_id, source, source_session_id, bound_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![session_id, binding.source, cli_session_id, now_iso()],
        )?;
        // Close the dedup race window immediately (the next source scan
        // re-derives the same verdict from the ledger): the imported twin
        // must not appear in the sidebar for up to one scan cadence.
        // Suffix form covers Codex, whose imported key is the rollout stem
        // (`rollout-<timestamp>-<thread-uuid>`) around the bound bare uuid.
        tx.execute(
            "UPDATE imported_history_session_cache
             SET listable = 0
             WHERE source = ?1
               AND (source_session_id = ?2 OR source_session_id LIKE '%-' || ?2)",
            params![binding.source, cli_session_id],
        )
        .ok();
    }
    tx.commit()?;
    Ok(true)
}

/// Whether this session persists transcript chunks to `code_session_chunks`
/// (legacy mode) or relies on the CLI's native store (`transcript_source =
/// 'native'`). The column is frozen at creation, so the answer is memoized
/// process-wide — chunk gates on the hot streaming path never re-query.
pub fn session_persists_chunks(session_id: &str) -> bool {
    use std::collections::HashMap;
    use std::sync::{OnceLock, RwLock};
    static CACHE: OnceLock<RwLock<HashMap<String, bool>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| RwLock::new(HashMap::new()));
    if let Some(&persists) = cache
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(session_id)
    {
        return persists;
    }
    let source: Option<String> = (|| -> SqliteResult<Option<String>> {
        let conn = get_connection()?;
        conn.query_row(
            "SELECT COALESCE(transcript_source, 'chunks') FROM code_sessions WHERE session_id = ?1",
            params![session_id],
            |row| row.get(0),
        )
        .optional()
    })()
    // Fail toward persisting: losing a transcript is worse than a redundant
    // chunk row for a native session.
    .unwrap_or(None);
    let Some(source) = source else {
        // Row not visible yet (or DB error): persist, but don't memoize a
        // guess — the next call after creation sees the real value.
        return true;
    };
    let persists = source != super::super::native_transcript::TRANSCRIPT_SOURCE_NATIVE;
    cache
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(session_id.to_string(), persists);
    persists
}

/// Latest native transcript id bound to this managed session for `source`
/// (account switches / message-edit forks append; replay follows the newest).
pub fn latest_native_transcript_id(session_id: &str, source: &str) -> SqliteResult<Option<String>> {
    let conn = get_connection()?;
    conn.query_row(
        "SELECT source_session_id
         FROM code_session_native_transcript_ids
         WHERE session_id = ?1 AND source = ?2
         ORDER BY bound_at DESC
         LIMIT 1",
        params![session_id, source],
        |row| row.get(0),
    )
    .optional()
}

pub fn get_cli_session_id_for_account(
    session_id: &str,
    account_id: Option<&str>,
) -> SqliteResult<Option<String>> {
    let conn = get_connection()?;
    let profile_key = resume_profile_key(account_id);
    conn.query_row(
        "SELECT cli_session_id
         FROM code_session_cli_resume_state
         WHERE session_id = ?1 AND profile_key = ?2",
        params![session_id, profile_key],
        |row| row.get(0),
    )
    .optional()
}

pub(super) fn bump_history_mutation_with_tx(
    tx: &rusqlite::Transaction<'_>,
    session_id: &str,
    mutation_reason: &str,
    mutated_at: &str,
) -> SqliteResult<()> {
    tx.execute(
        "INSERT INTO code_session_history_mutations
            (session_id, epoch, reason, mutated_at)
         VALUES (?1, 1, ?2, ?3)
         ON CONFLICT(session_id)
         DO UPDATE SET epoch = epoch + 1,
                       reason = excluded.reason,
                       mutated_at = excluded.mutated_at",
        params![session_id, mutation_reason, mutated_at],
    )?;
    Ok(())
}

pub(super) fn clear_cli_resume_state_with_tx(
    tx: &rusqlite::Transaction<'_>,
    session_id: &str,
    updated_at: Option<&str>,
    mutation_reason: &str,
) -> SqliteResult<bool> {
    tx.execute(
        "DELETE FROM code_session_cli_resume_state WHERE session_id = ?1",
        params![session_id],
    )?;

    let affected = if let Some(timestamp) = updated_at {
        tx.execute(
            "UPDATE code_sessions SET cli_session_id = NULL, updated_at = ?2 WHERE session_id = ?1",
            params![session_id, timestamp],
        )?
    } else {
        tx.execute(
            "UPDATE code_sessions SET cli_session_id = NULL WHERE session_id = ?1",
            params![session_id],
        )?
    };

    if affected > 0 {
        let mutated_at = updated_at.map(str::to_string).unwrap_or_else(now_iso);
        bump_history_mutation_with_tx(tx, session_id, mutation_reason, &mutated_at)?;
    }

    Ok(affected > 0)
}

pub fn clear_cli_resume_state(session_id: &str, mutation_reason: &str) -> SqliteResult<bool> {
    let conn = get_connection()?;
    let tx = conn.unchecked_transaction()?;
    let updated_at = now_iso();
    let cleared =
        clear_cli_resume_state_with_tx(&tx, session_id, Some(&updated_at), mutation_reason)?;
    tx.commit()?;
    Ok(cleared)
}

pub fn get_history_mutation(session_id: &str) -> SqliteResult<Option<CliHistoryMutation>> {
    let conn = get_connection()?;
    conn.query_row(
        "SELECT session_id, epoch, reason, mutated_at
         FROM code_session_history_mutations
         WHERE session_id = ?1",
        params![session_id],
        |row| {
            Ok(CliHistoryMutation {
                session_id: row.get(0)?,
                epoch: row.get(1)?,
                reason: row.get(2)?,
                mutated_at: row.get(3)?,
            })
        },
    )
    .optional()
}

fn mapped_cli_session_id_for_account_with_conn(
    conn: &rusqlite::Connection,
    session_id: &str,
    account_id: Option<&str>,
) -> SqliteResult<Option<String>> {
    let profile_key = resume_profile_key(account_id);
    conn.query_row(
        "SELECT cli_session_id
         FROM code_session_cli_resume_state
         WHERE session_id = ?1 AND profile_key = ?2",
        params![session_id, profile_key],
        |row| row.get(0),
    )
    .optional()
}

/// Update the display name for a CLI session.
/// Metadata write — does not bump `updated_at`.
pub fn update_name(session_id: &str, name: &str) -> SqliteResult<bool> {
    let conn = get_connection()?;
    let affected = conn.execute(
        "UPDATE code_sessions SET name = ?2 WHERE session_id = ?1",
        params![session_id, name],
    )?;
    if affected > 0 {
        sync_orgtrack_mirror(session_id);
    }
    Ok(affected > 0)
}

/// Update the model and/or account_id for mid-session switching.
/// Config write — does not bump `updated_at`.
///
/// Transactional: the read of the current row + resume map and the UPDATE
/// happen atomically, so a concurrent writer (slow old runner committing a
/// fresh cli_session_id, health checker) cannot interleave between the read
/// and the write and make the carried `cli_session_id` stale.
pub fn update_model_and_account(
    session_id: &str,
    model: Option<&str>,
    account_id: Option<&str>,
) -> SqliteResult<bool> {
    let conn = get_connection()?;
    let tx = conn.unchecked_transaction()?;
    let current: Option<(Option<String>, Option<String>)> = tx
        .query_row(
            "SELECT account_id, cli_session_id FROM code_sessions WHERE session_id = ?1",
            params![session_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let mapped_cli_session_id = if let Some(target_account_id) = account_id {
        let mapped =
            mapped_cli_session_id_for_account_with_conn(&tx, session_id, Some(target_account_id))?;
        match (mapped, current.as_ref()) {
            (Some(cli_session_id), _) => Some(cli_session_id),
            (None, Some((current_account_id, current_cli_session_id)))
                if current_account_id.as_deref() == Some(target_account_id) =>
            {
                current_cli_session_id.clone()
            }
            (None, _) => None,
        }
    } else {
        None
    };
    let affected = match (model, account_id) {
        (Some(model), Some(account_id)) => tx.execute(
            "UPDATE code_sessions
             SET model = ?2,
                 account_id = ?3,
                 cli_session_id = ?4
             WHERE session_id = ?1",
            params![session_id, model, account_id, mapped_cli_session_id],
        )?,
        (Some(model), None) => tx.execute(
            "UPDATE code_sessions SET model = ?2 WHERE session_id = ?1",
            params![session_id, model],
        )?,
        (None, Some(account_id)) => tx.execute(
            "UPDATE code_sessions
             SET account_id = ?2,
                 cli_session_id = ?3
             WHERE session_id = ?1",
            params![session_id, account_id, mapped_cli_session_id],
        )?,
        (None, None) => 0,
    };
    tx.commit()?;
    if affected > 0 {
        sync_orgtrack_mirror(session_id);
    }
    Ok(affected > 0)
}

/// Update the per-session execution mode on a CLI session row.
/// Mirrors `agent_core::session::persistence::update_agent_exec_mode`.
/// Does not bump `updated_at`; this is composer control state, not activity.
pub fn update_agent_exec_mode(session_id: &str, mode: &str) -> SqliteResult<bool> {
    let parsed = AgentExecMode::parse(mode).ok_or_else(|| {
        rusqlite::Error::ToSqlConversionFailure(
            format!("unknown AgentExecMode value: {mode:?}").into(),
        )
    })?;
    let conn = get_connection()?;
    let affected = conn.execute(
        "UPDATE code_sessions SET agent_exec_mode = ?2 WHERE session_id = ?1",
        params![session_id, parsed.as_str()],
    )?;
    if affected > 0 {
        sync_orgtrack_mirror(session_id);
    }
    Ok(affected > 0)
}

/// Update the per-session unsent draft text on a CLI session row.
/// Mirror of `agent_core::session::persistence::update_draft_text` —
/// see that helper for the empty-string normalization rationale.
/// Composer state — does not bump `updated_at`.
pub fn update_draft_text(session_id: &str, text: Option<&str>) -> SqliteResult<bool> {
    let conn = get_connection()?;
    let normalized = match text {
        Some(s) if !s.is_empty() => Some(s),
        _ => None,
    };
    let affected = conn.execute(
        "UPDATE code_sessions SET draft_text = ?2 WHERE session_id = ?1",
        params![session_id, normalized],
    )?;
    Ok(affected > 0)
}

/// Update the per-session reply target event id on a CLI session row.
/// Composer state — does not bump `updated_at`.
pub fn update_reply_target_event_id(
    session_id: &str,
    event_id: Option<&str>,
) -> SqliteResult<bool> {
    let conn = get_connection()?;
    let normalized = match event_id {
        Some(s) if !s.is_empty() => Some(s),
        _ => None,
    };
    let affected = conn.execute(
        "UPDATE code_sessions SET reply_target_event_id = ?2 WHERE session_id = ?1",
        params![session_id, normalized],
    )?;
    Ok(affected > 0)
}

/// Update the sidebar pin state on a CLI session row.
pub fn update_pinned(session_id: &str, pinned: bool) -> SqliteResult<bool> {
    let conn = get_connection()?;
    let affected = conn.execute(
        "UPDATE code_sessions SET pinned = ?2 WHERE session_id = ?1",
        params![session_id, pinned],
    )?;
    Ok(affected > 0)
}

/// Update proxy credentials (token, URL, proxy_session_id) after re-allocation.
/// Token rotation is config — does not bump `updated_at`.
pub fn update_proxy_credentials(
    session_id: &str,
    proxy_token: &str,
    proxy_url: &str,
    proxy_session_id: Option<&str>,
) -> SqliteResult<bool> {
    let conn = get_connection()?;
    let affected = conn.execute(
        "UPDATE code_sessions SET proxy_token = ?2, proxy_url = ?3, proxy_session_id = ?4 WHERE session_id = ?1",
        params![session_id, proxy_token, proxy_url, proxy_session_id],
    )?;
    Ok(affected > 0)
}

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
    }
    Ok(affected > 0)
}

/// Sweep orphaned sessions on startup.
///
/// After an app crash or forced quit, CLI subprocess PIDs are stale and sessions
/// may be stuck in "running" or "pending". This marks them as "failed" and clears
/// their PID so the frontend no longer shows a spinning indicator.
///
/// Returns the orphaned `(session_id, pid)` pairs that still had a PID so the
/// caller can terminate the actual OS process trees. Without that kill, a
/// backend restart (dev hot-reload recompiles included) leaves the CLI agent
/// running unsupervised — it keeps editing files and can't be cancelled
/// because the new backend has no handle to it.
pub fn sweep_stale_sessions() -> SqliteResult<Vec<(String, i64)>> {
    let conn = get_connection()?;
    let orphans: Vec<(String, i64)> = {
        let mut stmt = conn.prepare(
            "SELECT session_id, pid FROM code_sessions WHERE status IN ('running', 'pending') AND pid IS NOT NULL",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    let affected = conn.execute(
        "UPDATE code_sessions SET status = 'failed', pid = NULL, error_message = 'Session interrupted by app restart', updated_at = ?1 WHERE status IN ('running', 'pending')",
        params![now_iso()],
    )?;
    if affected > 0 {
        tracing::info!(
            "[CLI Persistence] Swept {} stale sessions to 'failed' on startup ({} with live PIDs)",
            affected,
            orphans.len()
        );
    }
    Ok(orphans)
}

fn row_to_session(row: &rusqlite::Row) -> rusqlite::Result<CodeSession> {
    let status_str: String = row.get(2)?;
    let key_source_str: String = row.get(25)?;

    // DB columns must round-trip the typed enum. An unknown variant means
    // either DB corruption or an out-of-band write — surface it as a
    // `FromSqlConversionFailure` instead of silently mapping to a generic
    // default, which would mis-bill (key_source) or hide a stuck-state row
    // (status).
    let status = SessionStatus::parse(&status_str).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            2,
            rusqlite::types::Type::Text,
            format!("unknown SessionStatus value: {status_str:?}").into(),
        )
    })?;
    let key_source = KeySource::parse(&key_source_str).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            25,
            rusqlite::types::Type::Text,
            format!("unknown KeySource value: {key_source_str:?}").into(),
        )
    })?;
    let agent_exec_mode: Option<String> = row.get(26)?;
    if let Some(mode) = agent_exec_mode.as_deref() {
        if AgentExecMode::parse(mode).is_none() {
            return Err(rusqlite::Error::FromSqlConversionFailure(
                26,
                rusqlite::types::Type::Text,
                format!("unknown AgentExecMode value: {mode:?}").into(),
            ));
        }
    }

    Ok(CodeSession {
        session_id: row.get(0)?,
        name: row.get(1)?,
        status,
        flow: row.get(3)?,
        runner: row.get(4)?,
        cli_agent_type: row.get(5)?,
        model: row.get(6)?,
        tier: row.get(7)?,
        account_id: row.get(8)?,
        repo_path: row.get(9)?,
        branch: row.get(10)?,
        user_input: row.get(11)?,
        proxy_token: row.get(12)?,
        proxy_url: row.get(13)?,
        hosted_token: row.get(14)?,
        error_message: row.get(15)?,
        total_tokens: row.get(16)?,
        pid: row.get(17)?,
        cli_session_id: row.get(18)?,
        proxy_session_id: row.get(19)?,
        worktree_path: row.get(20)?,
        worktree_branch: row.get(21)?,
        base_branch: row.get(22)?,
        merge_status: row.get(23)?,
        background: row.get::<_, bool>(24).unwrap_or(false),
        key_source,
        agent_exec_mode,
        draft_text: row.get(27)?,
        reply_target_event_id: row.get(28)?,
        pinned: row.get::<_, bool>(29).unwrap_or(false),
        additional_directories: row
            .get::<_, Option<String>>(30)?
            .as_deref()
            .and_then(|s| serde_json::from_str::<Vec<String>>(s).ok())
            .filter(|v| !v.is_empty()),
        parent_session_id: row.get(31)?,
        org_member_id: row.get(32)?,
        org_id: row.get(33)?,
        project_id: row.get(34)?,
        project_name: row.get(35)?,
        project_slug: row.get(36)?,
        work_item_id: row.get(37)?,
        agent_role: row.get(38)?,
        created_at: row.get(39)?,
        updated_at: row.get(40)?,
        transcript_source: row.get(41)?,
    })
}

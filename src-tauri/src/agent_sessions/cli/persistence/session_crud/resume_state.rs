//! Per-account CLI native resume-id mapping and the history-mutation
//! epoch ledger that invalidates a stale resume handle.

use rusqlite::{params, OptionalExtension, Result as SqliteResult};

use database::db::get_connection;

use crate::agent_sessions::cli::native_transcript;
use crate::agent_sessions::cli::persistence::types::CliHistoryMutation;

use super::shared::now_iso;

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
        .and_then(native_transcript::native_transcript_binding);
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

pub(in crate::agent_sessions::cli::persistence) fn bump_history_mutation_with_tx(
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

pub(in crate::agent_sessions::cli::persistence) fn clear_cli_resume_state_with_tx(
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

pub(super) fn mapped_cli_session_id_for_account_with_conn(
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

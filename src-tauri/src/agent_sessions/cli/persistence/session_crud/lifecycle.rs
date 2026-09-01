//! Session lifecycle writes: status transitions, turn-intent acceptance
//! and terminals, subprocess PID bookkeeping, and the startup sweep.

use rusqlite::{params, Connection, Result as SqliteResult};

use database::db::get_connection;

use crate::agent_sessions::cli::types::SessionStatus;

use super::shared::{now_iso, sync_orgtrack_mirror};

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
    accept_cli_turn_with_source(
        session_id,
        turn_intent_id,
        Some(client_message_id),
        session_persistence::turn_intents::TurnIntentSource::UserSubmit,
    )
}

/// `accept_cli_turn` for a resumed session: same atomic acceptance, but the
/// intent is sourced as `Resume` and has no client message behind it — resume
/// replays the session's stored `user_input` instead of a fresh submit.
pub fn accept_cli_resume_turn(session_id: &str, turn_intent_id: &str) -> Result<(), String> {
    accept_cli_turn_with_source(
        session_id,
        turn_intent_id,
        None,
        session_persistence::turn_intents::TurnIntentSource::Resume,
    )
}

fn accept_cli_turn_with_source(
    session_id: &str,
    turn_intent_id: &str,
    client_message_id: Option<&str>,
    source: session_persistence::turn_intents::TurnIntentSource,
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
        client_message_id,
        None,
        source,
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

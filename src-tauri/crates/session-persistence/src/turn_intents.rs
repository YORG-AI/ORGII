//! Canonical user-intent lifecycle store (`session_turn_intents`).
//!
//! Each row represents one logical "user submission" identity, minted at the
//! user-intent boundary (ChatPanel submit, queue enqueue, force-send,
//! resume, mobile-remote, agent-org inbox). The same id propagates through
//! frontend optimistic events, the wire layer, the scheduler, the persisted
//! `user_message` event, and finally the turn indexer — so layers stop
//! independently inventing identity. See the design plan
//! `.orgii/plans/canonical-turnintentid-across-queue-events-index_*.plan.md`.
//!
//! The table is intentionally narrow:
//!
//! - `(session_id, turn_intent_id)` is the primary key.
//! - `status` walks a small state machine; illegal transitions return
//!   `Err(IntentTransitionError::IllegalTransition)` and leave the row
//!   untouched, so transient bugs in callers can't silently downgrade a
//!   running turn back to queued.
//!
//! Lifecycle ownership:
//!
//! - `agent_send_message` upserts at `queued` (or `accepted` for inline
//!   immediate dispatch — kept as the same state today, separated only when
//!   we wire the "dispatching" interrupt window).
//! - The scheduler worker promotes to `running` on first execution and to
//!   `completed` / `failed` / `cancelled` at the terminal state.
//! - `DialogScheduler::invalidate_pending` marks every queued intent for
//!   the session `stale`.

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Result as SqliteResult};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use super::connection::get_connection;

// ============================================
// Source / status enums (wire-stable strings)
// ============================================

/// Where the intent was minted. Stored as a stable lowercase string so log
/// scans and SQL filters don't depend on a serde feature flag.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnIntentSource {
    /// Direct ChatPanel submit (queue dispatch or inline).
    UserSubmit,
    /// Queue dispatcher promoting a previously enqueued item.
    Queue,
    /// Explicit Send-Now against a held queue item.
    ForceSend,
    /// Resume / wake / restored-draft re-submission.
    Resume,
    /// Agent-org inbox enqueue path.
    AgentOrg,
    /// Wingman inner loop.
    Wingman,
    /// Mobile-remote pairing dispatch.
    MobileRemote,
}

impl TurnIntentSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UserSubmit => "user_submit",
            Self::Queue => "queue",
            Self::ForceSend => "force_send",
            Self::Resume => "resume",
            Self::AgentOrg => "agent_org",
            Self::Wingman => "wingman",
            Self::MobileRemote => "mobile_remote",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "user_submit" => Self::UserSubmit,
            "queue" => Self::Queue,
            "force_send" => Self::ForceSend,
            "resume" => Self::Resume,
            "agent_org" => Self::AgentOrg,
            "wingman" => Self::Wingman,
            "mobile_remote" => Self::MobileRemote,
            _ => return None,
        })
    }
}

/// Lifecycle status. Transitions are enforced by [`update_status`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnIntentStatus {
    /// Frontend has mint and rendered the optimistic row but the backend
    /// has not yet accepted enqueue. Today the wire path is fast enough
    /// that this state is short-lived, but the slot exists so the round
    /// indexer can tell "queued in frontend only" apart from "accepted by
    /// backend".
    Optimistic,
    /// Scheduler accepted enqueue and is waiting to run.
    Queued,
    /// Worker actively executing this turn.
    Running,
    /// Turn finished without error.
    Completed,
    /// Turn produced a failure terminal.
    Failed,
    /// Turn was cancelled (user stop, abort, etc).
    Cancelled,
    /// Queue invalidated this entry before it started executing
    /// (rewind, generation bump, edit-resend invalidation).
    Stale,
    /// A duplicate idempotent request was merged into an already-live turn.
    /// This intent never entered the scheduler and will never create a round.
    Coalesced,
    /// The scheduler rejected this intent before execution (for example,
    /// queue full or closed). This intent will never create a round.
    Rejected,
}

impl TurnIntentStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Optimistic => "optimistic",
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Stale => "stale",
            Self::Coalesced => "coalesced",
            Self::Rejected => "rejected",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "optimistic" => Self::Optimistic,
            "queued" => Self::Queued,
            "running" => Self::Running,
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            "stale" => Self::Stale,
            "coalesced" => Self::Coalesced,
            "rejected" => Self::Rejected,
            _ => return None,
        })
    }

    /// True when the intent reached a terminal state and will never run
    /// (or re-run). The turn indexer uses this to drop / down-status rows.
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed
                | Self::Failed
                | Self::Cancelled
                | Self::Stale
                | Self::Coalesced
                | Self::Rejected
        )
    }

    /// True when the intent will never produce a durable round
    /// (currently only `Stale`). Cancelled is NOT in this set — a
    /// cancelled turn still has user-visible intent and gets a round.
    pub fn is_pre_durable_terminal(self) -> bool {
        matches!(self, Self::Stale | Self::Coalesced | Self::Rejected)
    }
}

// ============================================
// Domain types
// ============================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnIntentRow {
    pub session_id: String,
    pub turn_intent_id: String,
    pub client_message_id: Option<String>,
    pub source: TurnIntentSource,
    pub status: TurnIntentStatus,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, thiserror::Error)]
pub enum IntentError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("illegal turn intent transition: {from:?} -> {to:?}")]
    IllegalTransition {
        from: TurnIntentStatus,
        to: TurnIntentStatus,
    },
    #[error("turn intent {0} not found for session {1}")]
    NotFound(String, String),
    #[error("invalid stored status {0:?} for turn intent {1}")]
    InvalidStoredStatus(String, String),
}

/// Whitelist of state transitions. Anything outside this list is rejected.
fn transition_allowed(from: TurnIntentStatus, to: TurnIntentStatus) -> bool {
    use TurnIntentStatus::*;
    if from == to {
        return true;
    }
    match (from, to) {
        // Forward progress along the happy path.
        (Optimistic, Queued)
        | (Optimistic, Running)
        | (Queued, Running)
        | (Queued, Cancelled)
        | (Running, Completed)
        | (Running, Failed)
        | (Running, Cancelled) => true,
        // Pre-run invalidation paths.
        (Optimistic, Stale)
        | (Queued, Stale)
        | (Optimistic, Coalesced)
        | (Queued, Coalesced)
        | (Optimistic, Rejected)
        | (Queued, Rejected) => true,
        // Everything else is rejected; in particular a terminal can never
        // walk backwards into a non-terminal.
        _ => false,
    }
}

// ============================================
// CRUD
// ============================================

fn row_from_sql(row: &rusqlite::Row<'_>) -> SqliteResult<TurnIntentRow> {
    let source_str: String = row.get(3)?;
    let status_str: String = row.get(4)?;
    let source = TurnIntentSource::parse(&source_str).unwrap_or(TurnIntentSource::UserSubmit);
    let status = TurnIntentStatus::parse(&status_str).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            4,
            rusqlite::types::Type::Text,
            format!("unknown turn_intents.status value: {status_str}").into(),
        )
    })?;
    Ok(TurnIntentRow {
        session_id: row.get(0)?,
        turn_intent_id: row.get(1)?,
        client_message_id: row.get(2)?,
        source,
        status,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

/// Insert a new intent row at `status`, or — if a row already exists for
/// this `(session_id, turn_intent_id)` — return the existing row unchanged.
///
/// Idempotent under retries: a frontend that re-submits the same intent id
/// after an IPC blip won't duplicate the row. Status transitions go through
/// [`update_status`] separately.
pub fn upsert_initial(
    session_id: &str,
    turn_intent_id: &str,
    client_message_id: Option<&str>,
    source: TurnIntentSource,
    status: TurnIntentStatus,
) -> Result<TurnIntentRow, IntentError> {
    let conn = get_connection()?;
    upsert_initial_on(
        &conn,
        session_id,
        turn_intent_id,
        client_message_id,
        source,
        status,
    )
}

/// Connection-scoped variant for callers that atomically update adjacent
/// session lifecycle state in the same SQLite transaction.
pub fn upsert_initial_on(
    conn: &Connection,
    session_id: &str,
    turn_intent_id: &str,
    client_message_id: Option<&str>,
    source: TurnIntentSource,
    status: TurnIntentStatus,
) -> Result<TurnIntentRow, IntentError> {
    let now = Utc::now().to_rfc3339();
    let inserted = conn.execute(
        "INSERT OR IGNORE INTO session_turn_intents
            (session_id, turn_intent_id, client_message_id, source, status,
             created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        params![
            session_id,
            turn_intent_id,
            client_message_id,
            source.as_str(),
            status.as_str(),
            now,
        ],
    )?;
    if inserted == 1 {
        return Ok(TurnIntentRow {
            session_id: session_id.to_string(),
            turn_intent_id: turn_intent_id.to_string(),
            client_message_id: client_message_id.map(str::to_string),
            source,
            status,
            created_at: now.clone(),
            updated_at: now,
        });
    }
    get_intent(conn, session_id, turn_intent_id)?
        .ok_or_else(|| IntentError::NotFound(turn_intent_id.to_string(), session_id.to_string()))
}

/// Patch the status of an existing intent. Transition must be in the
/// whitelist; otherwise the row is left untouched and an error is returned.
pub fn update_status(
    session_id: &str,
    turn_intent_id: &str,
    new_status: TurnIntentStatus,
) -> Result<TurnIntentRow, IntentError> {
    let conn = get_connection()?;
    update_status_on(&conn, session_id, turn_intent_id, new_status)
}

/// Connection-scoped variant for atomic session + turn-intent transitions.
pub fn update_status_on(
    conn: &Connection,
    session_id: &str,
    turn_intent_id: &str,
    new_status: TurnIntentStatus,
) -> Result<TurnIntentRow, IntentError> {
    let existing = get_intent(conn, session_id, turn_intent_id)?
        .ok_or_else(|| IntentError::NotFound(turn_intent_id.to_string(), session_id.to_string()))?;
    if !transition_allowed(existing.status, new_status) {
        return Err(IntentError::IllegalTransition {
            from: existing.status,
            to: new_status,
        });
    }
    if existing.status == new_status {
        return Ok(existing);
    }
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE session_turn_intents
            SET status = ?3, updated_at = ?4
          WHERE session_id = ?1 AND turn_intent_id = ?2",
        params![session_id, turn_intent_id, new_status.as_str(), now],
    )?;
    let mut row = existing;
    row.status = new_status;
    row.updated_at = now;
    Ok(row)
}

/// Bulk-mark every still-pending (`Optimistic` / `Queued`) intent for the
/// session as `Stale`. Used by `DialogScheduler::invalidate_pending` so the
/// durable lifecycle log catches up with the in-memory generation bump.
///
/// Returns the number of rows transitioned.
pub fn mark_pending_stale(session_id: &str) -> Result<usize, IntentError> {
    let conn = get_connection()?;
    let now = Utc::now().to_rfc3339();
    let affected = conn.execute(
        "UPDATE session_turn_intents
            SET status = 'stale', updated_at = ?2
          WHERE session_id = ?1 AND status IN ('optimistic', 'queued')",
        params![session_id, now],
    )?;
    Ok(affected)
}

/// Close every in-flight intent left by a previous process.
///
/// The scheduler queue is memory-only, so after a process restart no
/// `optimistic` or `queued` row can still execute; they are stale. A `running`
/// row means the process died during execution and is recorded as failed.
/// This is intentionally connection-scoped so the app can call it from the
/// database initialization hook without recursively opening the database.
pub fn reconcile_in_flight_after_restart(conn: &Connection) -> Result<usize, IntentError> {
    let now = Utc::now().to_rfc3339();
    let affected = conn.execute(
        "UPDATE session_turn_intents
            SET status = CASE
                    WHEN status = 'running' THEN 'failed'
                    ELSE 'stale'
                END,
                updated_at = ?1
          WHERE status IN ('optimistic', 'queued', 'running')",
        [now],
    )?;
    Ok(affected)
}

/// Lookup a single intent row.
pub fn get_intent(
    conn: &Connection,
    session_id: &str,
    turn_intent_id: &str,
) -> SqliteResult<Option<TurnIntentRow>> {
    let mut stmt = conn.prepare_cached(
        "SELECT session_id, turn_intent_id, client_message_id, source, status,
                created_at, updated_at
           FROM session_turn_intents
          WHERE session_id = ?1 AND turn_intent_id = ?2",
    )?;
    stmt.query_row(params![session_id, turn_intent_id], row_from_sql)
        .optional()
}

/// All intent rows for a session, ordered by `created_at`. The turn indexer
/// uses this to look up lifecycle status alongside event-store rows.
pub fn list_for_session(session_id: &str) -> SqliteResult<Vec<TurnIntentRow>> {
    let conn = get_connection()?;
    let mut stmt = conn.prepare_cached(
        "SELECT session_id, turn_intent_id, client_message_id, source, status,
                created_at, updated_at
           FROM session_turn_intents
          WHERE session_id = ?1
          ORDER BY created_at ASC, turn_intent_id ASC",
    )?;
    let rows = stmt
        .query_map([session_id], row_from_sql)?
        .collect::<SqliteResult<Vec<_>>>()?;
    Ok(rows)
}

/// Latest lifecycle row for each requested session, read through one
/// connection so reconnect/focus reconciliation does not fan out into one
/// SQLite task per session.
pub fn latest_for_sessions(session_ids: &[String]) -> SqliteResult<HashMap<String, TurnIntentRow>> {
    let conn = get_connection()?;
    let mut stmt = conn.prepare_cached(
        "SELECT session_id, turn_intent_id, client_message_id, source, status,
                created_at, updated_at
           FROM session_turn_intents
          WHERE session_id = ?1
          ORDER BY updated_at DESC, created_at DESC
          LIMIT 1",
    )?;
    let mut latest = HashMap::with_capacity(session_ids.len());
    for session_id in session_ids {
        if let Some(row) = stmt.query_row([session_id], row_from_sql).optional()? {
            latest.insert(session_id.clone(), row);
        }
    }
    Ok(latest)
}

// ============================================
// Tests
// ============================================

#[cfg(test)]
mod tests {
    use super::*;

    fn with_temp_orgii_home<R>(run: impl FnOnce() -> R) -> R {
        let _guard = match crate::ORGII_HOME_TEST_LOCK.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        let previous = std::env::var("ORGII_HOME").ok();
        let root =
            std::env::temp_dir().join(format!("orgii-turn-intents-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("create temp ORGII_HOME");
        std::env::set_var("ORGII_HOME", &root);
        // Initialize the session schema so `session_turn_intents` exists.
        {
            let conn = get_connection().expect("open sessions DB");
            super::super::schema::init_session_tables(&conn).expect("init session schema for test");
        }
        let result = run();
        match previous {
            Some(value) => std::env::set_var("ORGII_HOME", value),
            None => std::env::remove_var("ORGII_HOME"),
        }
        let _ = std::fs::remove_dir_all(&root);
        result
    }

    fn fresh_intent(session: &str, intent: &str) -> TurnIntentRow {
        upsert_initial(
            session,
            intent,
            Some("client-1"),
            TurnIntentSource::UserSubmit,
            TurnIntentStatus::Queued,
        )
        .expect("first upsert succeeds")
    }

    #[test]
    fn upsert_is_idempotent_for_same_intent() {
        with_temp_orgii_home(|| {
            let session = "test-session-upsert";
            let intent = "intent-upsert-1";
            let _ = fresh_intent(session, intent);
            let again = upsert_initial(
                session,
                intent,
                Some("client-2"),
                TurnIntentSource::Queue,
                TurnIntentStatus::Running,
            )
            .expect("second upsert returns existing row");
            assert_eq!(again.status, TurnIntentStatus::Queued);
            assert_eq!(again.client_message_id.as_deref(), Some("client-1"));
            assert_eq!(again.source, TurnIntentSource::UserSubmit);
        });
    }

    #[test]
    fn legal_transitions_walk_to_terminal() {
        with_temp_orgii_home(|| {
            let session = "test-session-happy";
            let intent = "intent-happy-1";
            let _ = fresh_intent(session, intent);
            let running = update_status(session, intent, TurnIntentStatus::Running)
                .expect("queued -> running");
            assert_eq!(running.status, TurnIntentStatus::Running);
            let completed = update_status(session, intent, TurnIntentStatus::Completed)
                .expect("running -> completed");
            assert_eq!(completed.status, TurnIntentStatus::Completed);
        });
    }

    #[test]
    fn consumed_steering_intents_reach_terminal_on_success_and_persistence_failure() {
        with_temp_orgii_home(|| {
            for (suffix, terminal) in [
                ("success", TurnIntentStatus::Completed),
                ("persistence-failure", TurnIntentStatus::Failed),
            ] {
                let session = format!("test-steering-{suffix}");
                let intent = format!("intent-steering-{suffix}");
                let _ = fresh_intent(&session, &intent);
                update_status(&session, &intent, TurnIntentStatus::Running)
                    .expect("consumption must transition queued -> running");
                let record = update_status(&session, &intent, terminal)
                    .expect("consumed steering must reach a terminal state");
                assert_eq!(record.status, terminal);
                assert!(record.status.is_terminal());
            }
        });
    }

    #[test]
    fn terminal_cannot_walk_back_to_running() {
        with_temp_orgii_home(|| {
            let session = "test-session-bad-transition";
            let intent = "intent-bad-1";
            let _ = fresh_intent(session, intent);
            let _ = update_status(session, intent, TurnIntentStatus::Running);
            let _ = update_status(session, intent, TurnIntentStatus::Completed);
            let err = update_status(session, intent, TurnIntentStatus::Running)
                .expect_err("completed -> running must be rejected");
            match err {
                IntentError::IllegalTransition { from, to } => {
                    assert_eq!(from, TurnIntentStatus::Completed);
                    assert_eq!(to, TurnIntentStatus::Running);
                }
                other => panic!("unexpected error: {other:?}"),
            }
        });
    }

    #[test]
    fn stale_cannot_resurrect() {
        with_temp_orgii_home(|| {
            let session = "test-session-stale";
            let intent = "intent-stale-1";
            let _ = fresh_intent(session, intent);
            let staled = update_status(session, intent, TurnIntentStatus::Stale)
                .expect("queued -> stale legal");
            assert_eq!(staled.status, TurnIntentStatus::Stale);
            let err = update_status(session, intent, TurnIntentStatus::Running)
                .expect_err("stale -> running must be rejected");
            assert!(matches!(err, IntentError::IllegalTransition { .. }));
        });
    }

    #[test]
    fn queued_can_close_without_running_when_coalesced_or_rejected() {
        with_temp_orgii_home(|| {
            for (intent, terminal) in [
                ("intent-coalesced", TurnIntentStatus::Coalesced),
                ("intent-rejected", TurnIntentStatus::Rejected),
            ] {
                let _ = fresh_intent("test-session-pre-run-terminal", intent);
                let row = update_status("test-session-pre-run-terminal", intent, terminal)
                    .expect("queued intent may close before execution");
                assert!(row.status.is_terminal());
                assert!(row.status.is_pre_durable_terminal());
                let err = update_status(
                    "test-session-pre-run-terminal",
                    intent,
                    TurnIntentStatus::Running,
                )
                .expect_err("a pre-run terminal intent cannot resurrect");
                assert!(matches!(err, IntentError::IllegalTransition { .. }));
            }
        });
    }

    #[test]
    fn mark_pending_stale_only_touches_pending() {
        with_temp_orgii_home(|| {
            let session = "test-session-bulk-stale";
            let _ = upsert_initial(
                session,
                "pending-a",
                None,
                TurnIntentSource::UserSubmit,
                TurnIntentStatus::Queued,
            )
            .unwrap();
            let _ = upsert_initial(
                session,
                "pending-b",
                None,
                TurnIntentSource::Queue,
                TurnIntentStatus::Optimistic,
            )
            .unwrap();
            let _ = upsert_initial(
                session,
                "running-c",
                None,
                TurnIntentSource::UserSubmit,
                TurnIntentStatus::Queued,
            )
            .unwrap();
            let _ = update_status(session, "running-c", TurnIntentStatus::Running).unwrap();

            let affected = mark_pending_stale(session).expect("bulk mark");
            assert_eq!(affected, 2);

            let rows = list_for_session(session).unwrap();
            let by_id: std::collections::HashMap<_, _> = rows
                .into_iter()
                .map(|row| (row.turn_intent_id.clone(), row.status))
                .collect();
            assert_eq!(by_id["pending-a"], TurnIntentStatus::Stale);
            assert_eq!(by_id["pending-b"], TurnIntentStatus::Stale);
            assert_eq!(by_id["running-c"], TurnIntentStatus::Running);
        });
    }

    #[test]
    fn latest_for_sessions_returns_one_current_intent_per_requested_session() {
        with_temp_orgii_home(|| {
            let first_session = "test-session-batch-a";
            let second_session = "test-session-batch-b";
            let _ = fresh_intent(first_session, "intent-a-old");
            let _ =
                update_status(first_session, "intent-a-old", TurnIntentStatus::Running).unwrap();
            let _ =
                update_status(first_session, "intent-a-old", TurnIntentStatus::Completed).unwrap();
            let _ = fresh_intent(first_session, "intent-a-current");
            let _ = update_status(first_session, "intent-a-current", TurnIntentStatus::Running)
                .unwrap();
            let _ = fresh_intent(second_session, "intent-b-current");

            let rows = latest_for_sessions(&[
                first_session.to_string(),
                second_session.to_string(),
                "missing-session".to_string(),
            ])
            .unwrap();

            assert_eq!(rows.len(), 2);
            assert_eq!(rows[first_session].turn_intent_id, "intent-a-current");
            assert_eq!(rows[first_session].status, TurnIntentStatus::Running);
            assert_eq!(rows[second_session].turn_intent_id, "intent-b-current");
        });
    }

    #[test]
    fn restart_reconciliation_closes_every_in_flight_intent() {
        with_temp_orgii_home(|| {
            let session = "test-session-restart-intents";
            for (intent, status) in [
                ("optimistic-a", TurnIntentStatus::Optimistic),
                ("queued-b", TurnIntentStatus::Queued),
                ("running-c", TurnIntentStatus::Running),
                ("completed-d", TurnIntentStatus::Completed),
            ] {
                let _ = upsert_initial(
                    session,
                    intent,
                    None,
                    TurnIntentSource::AgentOrg,
                    TurnIntentStatus::Queued,
                )
                .unwrap();
                if status != TurnIntentStatus::Queued {
                    if status == TurnIntentStatus::Optimistic {
                        let conn = get_connection().unwrap();
                        conn.execute(
                            "UPDATE session_turn_intents SET status='optimistic' WHERE session_id=?1 AND turn_intent_id=?2",
                            params![session, intent],
                        )
                        .unwrap();
                    } else {
                        update_status(session, intent, TurnIntentStatus::Running).unwrap();
                        if status == TurnIntentStatus::Completed {
                            update_status(session, intent, TurnIntentStatus::Completed).unwrap();
                        }
                    }
                }
            }

            let conn = get_connection().unwrap();
            assert_eq!(reconcile_in_flight_after_restart(&conn).unwrap(), 3);
            let rows = list_for_session(session).unwrap();
            let by_id = rows
                .into_iter()
                .map(|row| (row.turn_intent_id, row.status))
                .collect::<std::collections::HashMap<_, _>>();
            assert_eq!(by_id["optimistic-a"], TurnIntentStatus::Stale);
            assert_eq!(by_id["queued-b"], TurnIntentStatus::Stale);
            assert_eq!(by_id["running-c"], TurnIntentStatus::Failed);
            assert_eq!(by_id["completed-d"], TurnIntentStatus::Completed);
        });
    }
}

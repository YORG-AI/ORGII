//! Monotonic Agent Org work observation and explicit completion intent.
//!
//! Timestamps are useful for display but are not a safe concurrency token.
//! This table records a small monotonic revision so Quiescence can prove that a
//! coordinator turn was presented with (and successfully observed) the latest
//! durable task mutation before announcing completion.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::coordination::agent_org_payload_limits::{
    validate_required_text, TASK_OUTPUT_SUMMARY_MAX_BYTES, TASK_OUTPUT_SUMMARY_MAX_CHARS,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOrgRunProgress {
    pub org_run_id: String,
    pub work_revision: i64,
    pub coordinator_presented_work_revision: Option<i64>,
    pub coordinator_observed_work_revision: Option<i64>,
    pub coordinator_trigger_sequence: i64,
    pub coordinator_claimed_trigger_sequence: i64,
    pub pending_trigger_kind: Option<String>,
    pub pending_trigger_id: Option<String>,
    pub pending_trigger_work_revision: Option<i64>,
    pub completion_requested: bool,
    pub completion_requested_at: Option<String>,
    pub completion_requested_work_revision: Option<i64>,
    pub completion_summary: Option<String>,
    pub updated_at: String,
}

struct CoordinatorTriggerClaim {
    work_revision: i64,
    trigger_sequence: i64,
    trigger_kind: Option<String>,
    trigger_id: Option<String>,
    trigger_revision: Option<i64>,
}

pub(super) fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_org_runtime_run_progress (
            org_run_id TEXT PRIMARY KEY,
            work_revision INTEGER NOT NULL DEFAULT 0 CHECK(work_revision >= 0),
            coordinator_presented_work_revision INTEGER,
            coordinator_observed_work_revision INTEGER,
            coordinator_trigger_sequence INTEGER NOT NULL DEFAULT 0 CHECK(coordinator_trigger_sequence >= 0),
            coordinator_claimed_trigger_sequence INTEGER NOT NULL DEFAULT 0 CHECK(coordinator_claimed_trigger_sequence >= 0 AND coordinator_claimed_trigger_sequence <= coordinator_trigger_sequence),
            pending_trigger_kind TEXT,
            pending_trigger_id TEXT,
            pending_trigger_work_revision INTEGER,
            completion_requested INTEGER NOT NULL DEFAULT 0,
            completion_requested_at TEXT,
            completion_requested_work_revision INTEGER,
            completion_summary TEXT,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(org_run_id) REFERENCES agent_org_runtime_runs(id) ON DELETE CASCADE
        );",
    )?;
    // Existing runs predate the revision table. Revision zero means "no
    // post-migration task mutation observed yet"; subsequent mutations use
    // the same monotonic bump path as new runs.
    conn.execute(
        "INSERT INTO agent_org_runtime_run_progress (org_run_id, updated_at)
         SELECT run.id, run.updated_at FROM agent_org_runtime_runs run
         WHERE NOT EXISTS (
             SELECT 1 FROM agent_org_runtime_run_progress progress
             WHERE progress.org_run_id=run.id
         )",
        [],
    )?;
    Ok(())
}

pub(super) fn ensure_progress_in_conn(conn: &Connection, org_run_id: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO agent_org_runtime_run_progress (org_run_id, updated_at)
         VALUES (?1, ?2)
         ON CONFLICT(org_run_id) DO NOTHING",
        params![org_run_id, chrono::Utc::now().to_rfc3339()],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

/// Increment the durable work revision once for one effective task mutation.
///
/// A new mutation invalidates an earlier explicit completion request. The
/// coordinator must observe the new revision and request completion again.
pub(crate) fn bump_work_revision_in_tx(tx: &Connection, org_run_id: &str) -> Result<i64, String> {
    ensure_progress_in_conn(tx, org_run_id)?;
    tx.execute(
        "UPDATE agent_org_runtime_run_progress
         SET work_revision = work_revision + 1,
             coordinator_trigger_sequence = CASE
                 WHEN coordinator_claimed_trigger_sequence < coordinator_trigger_sequence
                 THEN coordinator_trigger_sequence
                 ELSE coordinator_trigger_sequence + 1
             END,
             pending_trigger_kind = 'task_graph',
             pending_trigger_id = CAST(work_revision + 1 AS TEXT),
             pending_trigger_work_revision = work_revision + 1,
             completion_requested = 0,
             completion_requested_at = NULL,
             completion_requested_work_revision = NULL,
             completion_summary = NULL,
             updated_at = ?2
         WHERE org_run_id = ?1",
        params![org_run_id, chrono::Utc::now().to_rfc3339()],
    )
    .map_err(|err| err.to_string())?;
    tx.query_row(
        "SELECT work_revision FROM agent_org_runtime_run_progress WHERE org_run_id=?1",
        params![org_run_id],
        |row| row.get(0),
    )
    .map_err(|err| err.to_string())
}

/// Coalesce a durable Coordinator trigger into the one pending doorbell slot.
/// While a previous trigger is unclaimed, later facts update its bounded
/// identity/revision without allocating more Provider wakes. Once a Turn has
/// claimed the slot, the first later fact advances the sequence exactly once.
pub(crate) fn record_coordinator_trigger_in_tx(
    tx: &Connection,
    org_run_id: &str,
    trigger_kind: &str,
    trigger_id: &str,
) -> Result<i64, String> {
    let trigger_kind = trigger_kind.trim();
    let trigger_id = trigger_id.trim();
    if trigger_kind.is_empty() || trigger_id.is_empty() {
        return Err("Coordinator trigger kind/id must not be empty".to_string());
    }
    let run_exists: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_org_runtime_runs WHERE id=?1)",
            [org_run_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    // Agent Inbox retains read compatibility for historical/isolated rows
    // whose org_run_id predates the canonical Run table. Such a row is not a
    // valid wake source, so it must not create an orphan progress record or
    // turn an otherwise valid Inbox insert into a foreign-key failure.
    if !run_exists {
        return Ok(0);
    }
    ensure_progress_in_conn(tx, org_run_id)?;
    let before: (i64, i64) = tx
        .query_row(
            "SELECT coordinator_trigger_sequence,coordinator_claimed_trigger_sequence
             FROM agent_org_runtime_run_progress WHERE org_run_id=?1",
            [org_run_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|error| error.to_string())?;
    tx.execute(
        "UPDATE agent_org_runtime_run_progress
         SET coordinator_trigger_sequence = CASE
                 WHEN coordinator_claimed_trigger_sequence < coordinator_trigger_sequence
                 THEN coordinator_trigger_sequence
                 ELSE coordinator_trigger_sequence + 1
             END,
             pending_trigger_kind=?2,
             pending_trigger_id=?3,
             pending_trigger_work_revision=work_revision,
             updated_at=?4
         WHERE org_run_id=?1",
        params![
            org_run_id,
            trigger_kind,
            trigger_id,
            chrono::Utc::now().to_rfc3339()
        ],
    )
    .map_err(|error| error.to_string())?;
    let sequence = tx
        .query_row(
            "SELECT coordinator_trigger_sequence
         FROM agent_org_runtime_run_progress WHERE org_run_id=?1",
            [org_run_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    tracing::debug!(
        org_run_id,
        trigger_kind,
        trigger_id,
        trigger_sequence = sequence,
        coalesced = before.1 < before.0,
        "[agent_org_metric] coordinator_trigger_recorded"
    );
    Ok(sequence)
}

pub(super) fn load_progress_with_conn(
    conn: &Connection,
    org_run_id: &str,
) -> Result<Option<AgentOrgRunProgress>, String> {
    conn.query_row(
        "SELECT org_run_id, work_revision,
                coordinator_presented_work_revision,
                coordinator_observed_work_revision,
                coordinator_trigger_sequence,
                coordinator_claimed_trigger_sequence,
                pending_trigger_kind,pending_trigger_id,pending_trigger_work_revision,
                completion_requested, completion_requested_at,
                completion_requested_work_revision, completion_summary,
                updated_at
         FROM agent_org_runtime_run_progress
         WHERE org_run_id=?1",
        params![org_run_id],
        row_to_progress,
    )
    .optional()
    .map_err(|err| err.to_string())
}

pub(super) fn stage_coordinator_presented_with_conn(
    conn: &Connection,
    org_run_id: &str,
) -> Result<Option<i64>, String> {
    ensure_progress_in_conn(conn, org_run_id)?;
    let run_is_running: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_org_runtime_runs WHERE id=?1 AND status='running')",
            params![org_run_id],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())?;
    if !run_is_running {
        return Ok(None);
    }
    let revision: i64 = conn
        .query_row(
            "SELECT work_revision FROM agent_org_runtime_run_progress WHERE org_run_id=?1",
            params![org_run_id],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())?;
    conn.execute(
        "UPDATE agent_org_runtime_run_progress
         SET coordinator_presented_work_revision=?2, updated_at=?3
         WHERE org_run_id=?1",
        params![org_run_id, revision, chrono::Utc::now().to_rfc3339()],
    )
    .map_err(|err| err.to_string())?;
    Ok(Some(revision))
}

pub(super) fn claim_coordinator_trigger_with_conn(
    conn: &Connection,
    org_run_id: &str,
    session_id: &str,
    turn_intent_id: &str,
) -> Result<Option<i64>, String> {
    ensure_progress_in_conn(conn, org_run_id)?;
    let context = crate::coordination::agent_org_turn_contexts::require_context_with_connection(
        conn,
        session_id,
        turn_intent_id,
    )?;
    if context.org_run_id != org_run_id
        || context.turn_kind
            != crate::coordination::agent_org_turn_contexts::AgentOrgTurnKind::Coordinator
    {
        return Err(
            "agent_org_turn_context_invalid: Coordinator trigger claim authority mismatch"
                .to_string(),
        );
    }
    let claim: Option<CoordinatorTriggerClaim> = conn
        .query_row(
            "SELECT work_revision,coordinator_trigger_sequence,
                    pending_trigger_kind,pending_trigger_id,pending_trigger_work_revision
             FROM agent_org_runtime_run_progress progress
             JOIN agent_org_runtime_runs run ON run.id=progress.org_run_id
             WHERE progress.org_run_id=?1 AND run.status='running'",
            [org_run_id],
            |row| {
                Ok(CoordinatorTriggerClaim {
                    work_revision: row.get(0)?,
                    trigger_sequence: row.get(1)?,
                    trigger_kind: row.get(2)?,
                    trigger_id: row.get(3)?,
                    trigger_revision: row.get(4)?,
                })
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some(CoordinatorTriggerClaim {
        work_revision,
        trigger_sequence,
        trigger_kind,
        trigger_id,
        trigger_revision,
    }) = claim
    else {
        return Ok(None);
    };
    if trigger_sequence < 1 || trigger_kind.is_none() || trigger_id.is_none() {
        return Err(
            "agent_org_turn_context_invalid: Coordinator Turn has no durable trigger to claim"
                .to_string(),
        );
    }
    conn.execute(
        "UPDATE agent_org_runtime_run_progress
         SET coordinator_presented_work_revision=?2,
             coordinator_claimed_trigger_sequence=?3,
             updated_at=?4
         WHERE org_run_id=?1",
        params![
            org_run_id,
            work_revision,
            trigger_sequence,
            chrono::Utc::now().to_rfc3339()
        ],
    )
    .map_err(|error| error.to_string())?;
    let updated = conn
        .execute(
            "UPDATE agent_org_runtime_turn_contexts
             SET coordinator_trigger_sequence=?4,
                 coordinator_trigger_kind=?5,
                 coordinator_trigger_id=?6,
                 coordinator_work_revision=?7,
                 terminal_reason=NULL
             WHERE org_run_id=?1 AND session_id=?2 AND turn_intent_id=?3
               AND turn_kind='coordinator'",
            params![
                org_run_id,
                session_id,
                turn_intent_id,
                trigger_sequence,
                trigger_kind,
                trigger_id,
                trigger_revision.unwrap_or(work_revision),
            ],
        )
        .map_err(|error| error.to_string())?;
    if updated != 1 {
        return Err(
            "agent_org_turn_context_invalid: Coordinator trigger claim lost exact Turn".to_string(),
        );
    }
    Ok(Some(work_revision))
}

pub(super) fn mark_coordinator_observed_revision_with_conn(
    conn: &Connection,
    org_run_id: &str,
    presented_work_revision: i64,
) -> Result<Option<i64>, String> {
    ensure_progress_in_conn(conn, org_run_id)?;
    if presented_work_revision < 0 {
        return Err(format!(
            "invalid coordinator presented work revision: {presented_work_revision}"
        ));
    }
    let updated = conn
        .execute(
            "UPDATE agent_org_runtime_run_progress
         SET coordinator_observed_work_revision = CASE
                 WHEN coordinator_observed_work_revision IS NULL
                   OR ?2 > coordinator_observed_work_revision
                   THEN ?2
                 ELSE coordinator_observed_work_revision
             END,
             updated_at=?3
         WHERE org_run_id=?1
           AND ?2 <= work_revision",
            params![
                org_run_id,
                presented_work_revision,
                chrono::Utc::now().to_rfc3339()
            ],
        )
        .map_err(|err| err.to_string())?;
    if updated != 1 {
        return Err(format!(
            "coordinator presented work revision {presented_work_revision} is newer than the current revision for run {org_run_id}"
        ));
    }
    conn.query_row(
        "SELECT coordinator_observed_work_revision
         FROM agent_org_runtime_run_progress WHERE org_run_id=?1",
        params![org_run_id],
        |row| row.get(0),
    )
    .map_err(|err| err.to_string())
}

pub(super) fn record_completion_request_in_tx(
    tx: &Connection,
    org_run_id: &str,
    summary: &str,
) -> Result<AgentOrgRunProgress, String> {
    let summary = summary.trim();
    validate_required_text(
        "Agent Org completion summary",
        summary,
        TASK_OUTPUT_SUMMARY_MAX_CHARS,
        TASK_OUTPUT_SUMMARY_MAX_BYTES,
    )?;
    ensure_progress_in_conn(tx, org_run_id)?;
    let now = chrono::Utc::now().to_rfc3339();
    let updated = tx
        .execute(
            "UPDATE agent_org_runtime_run_progress
             SET completion_requested=1,
                 completion_requested_at=?2,
                 completion_requested_work_revision=work_revision,
                 completion_summary=?3,
                 updated_at=?2
             WHERE org_run_id=?1",
            params![org_run_id, &now, summary],
        )
        .map_err(|err| err.to_string())?;
    if updated != 1 {
        return Err(format!("agent_org_run_progress_not_found: {org_run_id}"));
    }
    load_progress_with_conn(tx, org_run_id)?
        .ok_or_else(|| format!("agent_org_run_progress_not_found_after_update: {org_run_id}"))
}

fn row_to_progress(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentOrgRunProgress> {
    let completion_requested: i64 = row.get(9)?;
    Ok(AgentOrgRunProgress {
        org_run_id: row.get(0)?,
        work_revision: row.get(1)?,
        coordinator_presented_work_revision: row.get(2)?,
        coordinator_observed_work_revision: row.get(3)?,
        coordinator_trigger_sequence: row.get(4)?,
        coordinator_claimed_trigger_sequence: row.get(5)?,
        pending_trigger_kind: row.get(6)?,
        pending_trigger_id: row.get(7)?,
        pending_trigger_work_revision: row.get(8)?,
        completion_requested: completion_requested != 0,
        completion_requested_at: row.get(10)?,
        completion_requested_work_revision: row.get(11)?,
        completion_summary: row.get(12)?,
        updated_at: row.get(13)?,
    })
}

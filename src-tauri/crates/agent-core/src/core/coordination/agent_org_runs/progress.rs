//! Monotonic Task-board freshness and explicit completion intent.
//!
//! `work_revision` is deliberately not a Coordinator doorbell. Exact formal
//! facts and their delivery attempts live in `FormalTriggerReceipt`; this
//! table only proves which Task snapshot a Coordinator Turn observed before
//! requesting completion.

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
    pub completion_requested: bool,
    pub completion_requested_at: Option<String>,
    pub completion_requested_work_revision: Option<i64>,
    pub completion_summary: Option<String>,
    pub updated_at: String,
}

pub(super) fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_org_runtime_run_progress (
            org_run_id TEXT PRIMARY KEY,
            work_revision INTEGER NOT NULL DEFAULT 0 CHECK(work_revision >= 0),
            coordinator_presented_work_revision INTEGER,
            coordinator_observed_work_revision INTEGER,
            completion_requested INTEGER NOT NULL DEFAULT 0,
            completion_requested_at TEXT,
            completion_requested_work_revision INTEGER,
            completion_summary TEXT,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(org_run_id) REFERENCES agent_org_runtime_runs(id) ON DELETE CASCADE
        );",
    )?;
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
    .map_err(|error| error.to_string())?;
    Ok(())
}

/// Increment Task-board freshness once for one effective Task mutation. This
/// does not create Provider work; the mutation owner records its exact formal
/// receipt separately when Coordinator action is required.
pub(crate) fn bump_work_revision_in_tx(tx: &Connection, org_run_id: &str) -> Result<i64, String> {
    ensure_progress_in_conn(tx, org_run_id)?;
    tx.execute(
        "UPDATE agent_org_runtime_run_progress
         SET work_revision=work_revision+1,
             completion_requested=0,
             completion_requested_at=NULL,
             completion_requested_work_revision=NULL,
             completion_summary=NULL,
             updated_at=?2
         WHERE org_run_id=?1",
        params![org_run_id, chrono::Utc::now().to_rfc3339()],
    )
    .map_err(|error| error.to_string())?;
    tx.query_row(
        "SELECT work_revision FROM agent_org_runtime_run_progress WHERE org_run_id=?1",
        [org_run_id],
        |row| row.get(0),
    )
    .map_err(|error| error.to_string())
}

pub(super) fn load_progress_with_conn(
    conn: &Connection,
    org_run_id: &str,
) -> Result<Option<AgentOrgRunProgress>, String> {
    conn.query_row(
        "SELECT org_run_id,work_revision,coordinator_presented_work_revision,
                coordinator_observed_work_revision,completion_requested,
                completion_requested_at,completion_requested_work_revision,
                completion_summary,updated_at
         FROM agent_org_runtime_run_progress WHERE org_run_id=?1",
        [org_run_id],
        row_to_progress,
    )
    .optional()
    .map_err(|error| error.to_string())
}

pub(super) fn stage_coordinator_presented_with_conn(
    conn: &Connection,
    org_run_id: &str,
) -> Result<Option<i64>, String> {
    ensure_progress_in_conn(conn, org_run_id)?;
    let revision = conn
        .query_row(
            "SELECT progress.work_revision
             FROM agent_org_runtime_run_progress progress
             JOIN agent_org_runtime_runs run ON run.id=progress.org_run_id
             WHERE progress.org_run_id=?1 AND run.status='running'",
            [org_run_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some(revision) = revision else {
        return Ok(None);
    };
    conn.execute(
        "UPDATE agent_org_runtime_run_progress
         SET coordinator_presented_work_revision=?2,updated_at=?3
         WHERE org_run_id=?1",
        params![org_run_id, revision, chrono::Utc::now().to_rfc3339()],
    )
    .map_err(|error| error.to_string())?;
    Ok(Some(revision))
}

pub(super) fn stage_coordinator_presented_for_turn_with_conn(
    conn: &Connection,
    org_run_id: &str,
    session_id: &str,
    turn_intent_id: &str,
) -> Result<Option<i64>, String> {
    let context = crate::coordination::agent_org_turn_contexts::require_context_with_connection(
        conn,
        session_id,
        turn_intent_id,
    )?;
    if context.org_run_id != org_run_id
        || context.turn_kind
            != crate::coordination::agent_org_turn_contexts::AgentOrgTurnKind::Coordinator
        || context.source_kind
            != crate::coordination::agent_org_turn_contexts::AgentOrgTurnSourceKind::RootTurn
    {
        return Err(
            "agent_org_turn_context_invalid: Coordinator freshness authority mismatch".to_string(),
        );
    }
    let revision = stage_coordinator_presented_with_conn(conn, org_run_id)?;
    if let Some(revision) = revision {
        let updated = conn
            .execute(
                "UPDATE agent_org_runtime_turn_contexts
                 SET coordinator_work_revision=?4,terminal_reason=NULL
                 WHERE org_run_id=?1 AND session_id=?2 AND turn_intent_id=?3
                   AND turn_kind='coordinator' AND source_kind='root_turn'",
                params![org_run_id, session_id, turn_intent_id, revision],
            )
            .map_err(|error| error.to_string())?;
        if updated != 1 {
            return Err(
                "agent_org_turn_context_invalid: Coordinator freshness staging lost exact Turn"
                    .to_string(),
            );
        }
    }
    Ok(revision)
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
             SET coordinator_observed_work_revision=CASE
                    WHEN coordinator_observed_work_revision IS NULL
                      OR ?2>coordinator_observed_work_revision THEN ?2
                    ELSE coordinator_observed_work_revision
                 END,
                 updated_at=?3
             WHERE org_run_id=?1 AND ?2<=work_revision",
            params![
                org_run_id,
                presented_work_revision,
                chrono::Utc::now().to_rfc3339()
            ],
        )
        .map_err(|error| error.to_string())?;
    if updated != 1 {
        return Err(format!(
            "coordinator presented work revision {presented_work_revision} is newer than the current revision for run {org_run_id}"
        ));
    }
    conn.query_row(
        "SELECT coordinator_observed_work_revision
         FROM agent_org_runtime_run_progress WHERE org_run_id=?1",
        [org_run_id],
        |row| row.get(0),
    )
    .map_err(|error| error.to_string())
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
             SET completion_requested=1,completion_requested_at=?2,
                 completion_requested_work_revision=work_revision,
                 completion_summary=?3,updated_at=?2
             WHERE org_run_id=?1",
            params![org_run_id, &now, summary],
        )
        .map_err(|error| error.to_string())?;
    if updated != 1 {
        return Err(format!("agent_org_run_progress_not_found: {org_run_id}"));
    }
    load_progress_with_conn(tx, org_run_id)?
        .ok_or_else(|| format!("agent_org_run_progress_not_found_after_update: {org_run_id}"))
}

fn row_to_progress(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentOrgRunProgress> {
    let completion_requested: i64 = row.get(4)?;
    Ok(AgentOrgRunProgress {
        org_run_id: row.get(0)?,
        work_revision: row.get(1)?,
        coordinator_presented_work_revision: row.get(2)?,
        coordinator_observed_work_revision: row.get(3)?,
        completion_requested: completion_requested != 0,
        completion_requested_at: row.get(5)?,
        completion_requested_work_revision: row.get(6)?,
        completion_summary: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

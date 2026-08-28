//! Irreversible Agent Org Archive fence and bounded runtime teardown receipts.
//!
//! The database transaction owns the terminal decision. Runtime shutdown is
//! post-commit evidence only and can never reopen the Team.

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;

use super::agent_org_ownership::load_team_for_run;
use super::agent_org_runs::AgentOrgRunStatus;
use super::agent_org_tasks::{
    AgentOrgTaskStore, SystemArchiveOrRecovery, SystemTaskOperation, TaskTerminalReason,
};

pub const ARCHIVE_TEARDOWN_MAX_ATTEMPTS: i64 = 3;
pub const ARCHIVE_TEARDOWN_DEADLINE_SECS: i64 = 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ArchiveTeardownStatus {
    Pending,
    Quiesced,
    RetainedRuntime,
}

impl ArchiveTeardownStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Quiesced => "quiesced",
            Self::RetainedRuntime => "retained_runtime",
        }
    }

    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "pending" => Ok(Self::Pending),
            "quiesced" => Ok(Self::Quiesced),
            "retained_runtime" => Ok(Self::RetainedRuntime),
            other => Err(format!("unknown Archive teardown status: {other:?}")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveTeardownSummary {
    pub receipt_id: String,
    pub status: ArchiveTeardownStatus,
    pub attempt_count: i64,
    pub retained_runtime_count: usize,
    pub deadline_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveCancellationCounts {
    pub tasks: usize,
    pub turns: usize,
    pub inbox_deliveries: usize,
    pub plan_approvals: usize,
    pub interventions: usize,
    pub pause_continuations: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveRunOutcome {
    pub request_id: String,
    pub run_id: String,
    pub receipt_id: String,
    pub transitioned: bool,
    pub archive_generation: i64,
    pub archived_at: String,
    pub cancellations: ArchiveCancellationCounts,
    pub teardown: ArchiveTeardownSummary,
}

#[derive(Debug)]
pub(crate) struct ArchiveCommit {
    pub outcome: ArchiveRunOutcome,
    pub owns_teardown: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ArchiveTeardownTarget {
    pub receipt_id: String,
    pub run_id: String,
    pub session_id: String,
    pub member_id: Option<String>,
    pub attempt_count: i64,
}

pub(super) fn create_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_org_runtime_archive_episodes (
            archive_receipt_id TEXT PRIMARY KEY CHECK(length(trim(archive_receipt_id)) > 0),
            org_run_id TEXT NOT NULL UNIQUE,
            archive_request_id TEXT NOT NULL CHECK(length(trim(archive_request_id)) > 0),
            archive_generation INTEGER NOT NULL CHECK(archive_generation >= 2),
            teardown_status TEXT NOT NULL CHECK(teardown_status IN (
                'pending','quiesced','retained_runtime'
            )),
            teardown_attempt_count INTEGER NOT NULL DEFAULT 0
                CHECK(teardown_attempt_count BETWEEN 0 AND 3),
            retained_runtime_count INTEGER NOT NULL DEFAULT 0
                CHECK(retained_runtime_count >= 0),
            task_cancel_count INTEGER NOT NULL DEFAULT 0 CHECK(task_cancel_count >= 0),
            turn_cancel_count INTEGER NOT NULL DEFAULT 0 CHECK(turn_cancel_count >= 0),
            inbox_cancel_count INTEGER NOT NULL DEFAULT 0 CHECK(inbox_cancel_count >= 0),
            approval_cancel_count INTEGER NOT NULL DEFAULT 0 CHECK(approval_cancel_count >= 0),
            intervention_cancel_count INTEGER NOT NULL DEFAULT 0 CHECK(intervention_cancel_count >= 0),
            pause_continuation_cancel_count INTEGER NOT NULL DEFAULT 0
                CHECK(pause_continuation_cancel_count >= 0),
            deadline_at TEXT NOT NULL,
            last_error TEXT,
            archived_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            quiesced_at TEXT,
            UNIQUE(org_run_id, archive_request_id),
            FOREIGN KEY(org_run_id) REFERENCES agent_org_runtime_runs(id) ON DELETE CASCADE,
            CHECK(
                (teardown_status='quiesced' AND quiesced_at IS NOT NULL
                 AND retained_runtime_count=0)
                OR
                (teardown_status<>'quiesced' AND quiesced_at IS NULL)
            )
        );
        CREATE INDEX IF NOT EXISTS idx_agent_org_runtime_archive_pending
            ON agent_org_runtime_archive_episodes(teardown_status, deadline_at);

        CREATE TABLE IF NOT EXISTS agent_org_runtime_archive_teardowns (
            teardown_id TEXT PRIMARY KEY CHECK(length(trim(teardown_id)) > 0),
            archive_receipt_id TEXT NOT NULL,
            org_run_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            member_id TEXT,
            captured_parent_session_id TEXT,
            teardown_status TEXT NOT NULL CHECK(teardown_status IN (
                'pending','quiesced','retained_runtime'
            )),
            attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 3),
            runtime_lease_id TEXT,
            dialog_turn_generation TEXT,
            last_error TEXT,
            released_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(archive_receipt_id, session_id),
            FOREIGN KEY(archive_receipt_id)
                REFERENCES agent_org_runtime_archive_episodes(archive_receipt_id) ON DELETE CASCADE,
            FOREIGN KEY(org_run_id) REFERENCES agent_org_runtime_runs(id) ON DELETE CASCADE,
            CHECK(
                (teardown_status='quiesced' AND released_at IS NOT NULL)
                OR
                (teardown_status<>'quiesced' AND released_at IS NULL)
            ),
            CHECK(
                (runtime_lease_id IS NULL AND dialog_turn_generation IS NULL)
                OR runtime_lease_id IS NOT NULL
            )
        );
        CREATE INDEX IF NOT EXISTS idx_agent_org_runtime_archive_teardown_pending
            ON agent_org_runtime_archive_teardowns(
                archive_receipt_id, teardown_status, session_id
            );",
    )
}

pub(crate) fn archive_run_commit(run_id: &str, request_id: &str) -> Result<ArchiveCommit, String> {
    validate_request_id(request_id)?;
    database::db::with_sessions_writer(|| {
        let mut conn = database::db::get_connection().map_err(|error| error.to_string())?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;

        if let Some(outcome) = outcome_for_request(&tx, run_id, request_id, false)? {
            tx.commit().map_err(|error| error.to_string())?;
            return Ok(ArchiveCommit {
                outcome,
                owns_teardown: false,
            });
        }

        let run: Option<(String, i64)> = tx
            .query_row(
                "SELECT status,activation_generation
                 FROM agent_org_runtime_runs WHERE id=?1",
                [run_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let Some((status_raw, generation)) = run else {
            return Err(format!("agent_org_run_not_found: {run_id}"));
        };
        let status = AgentOrgRunStatus::parse(&status_raw)
            .ok_or_else(|| format!("unknown Agent Org run status: {status_raw:?}"))?;
        match status {
            AgentOrgRunStatus::Starting => {
                return Err(format!(
                    "team_not_ready: Agent Org run {run_id} is still materializing"
                ));
            }
            AgentOrgRunStatus::Archived => {
                return Err(format!(
                    "team_archived: Agent Org run {run_id} is already read-only"
                ));
            }
            AgentOrgRunStatus::Idle
            | AgentOrgRunStatus::Running
            | AgentOrgRunStatus::Paused
            | AgentOrgRunStatus::Failed => {}
        }

        let archive_generation = generation
            .checked_add(1)
            .ok_or_else(|| format!("Agent Org run {run_id} generation overflow"))?;
        let receipt_id = uuid::Uuid::new_v4().to_string();
        let archived_at = chrono::Utc::now();
        let archived_at_text = archived_at.to_rfc3339();
        let deadline_at =
            (archived_at + chrono::Duration::seconds(ARCHIVE_TEARDOWN_DEADLINE_SECS)).to_rfc3339();

        let changed = tx
            .execute(
                "UPDATE agent_org_runtime_runs
                 SET status='archived',activation_generation=?2,archived_at=?3,
                     archive_receipt_id=?4,updated_at=?3
                 WHERE id=?1 AND status=?5 AND activation_generation=?6",
                params![
                    run_id,
                    archive_generation,
                    &archived_at_text,
                    &receipt_id,
                    status.as_str(),
                    generation
                ],
            )
            .map_err(|error| error.to_string())?;
        if changed != 1 {
            return Err(format!(
                "Agent Org run {run_id} changed while Archive was committing"
            ));
        }
        tx.execute(
            "INSERT INTO agent_org_runtime_archive_episodes (
                archive_receipt_id,org_run_id,archive_request_id,archive_generation,
                teardown_status,deadline_at,archived_at,updated_at
             ) VALUES (?1,?2,?3,?4,'pending',?5,?6,?6)",
            params![
                &receipt_id,
                run_id,
                request_id,
                archive_generation,
                &deadline_at,
                &archived_at_text
            ],
        )
        .map_err(|error| error.to_string())?;

        let ownership = load_team_for_run(&tx, run_id)?;
        for session in &ownership.sessions {
            tx.execute(
                "INSERT INTO agent_org_runtime_archive_teardowns (
                    teardown_id,archive_receipt_id,org_run_id,session_id,member_id,
                    captured_parent_session_id,teardown_status,created_at,updated_at
                 ) VALUES (?1,?2,?3,?4,?5,?6,'pending',?7,?7)",
                params![
                    uuid::Uuid::new_v4().to_string(),
                    &receipt_id,
                    run_id,
                    &session.session_id,
                    session.member_id.as_deref(),
                    session.parent_session_id.as_deref(),
                    &archived_at_text
                ],
            )
            .map_err(|error| error.to_string())?;
        }

        let task_actor = SystemArchiveOrRecovery::new(
            &receipt_id,
            archive_generation,
            SystemTaskOperation::ArchiveCancel,
        )?;
        let tasks = AgentOrgTaskStore::cancel_open_for_archive_with_connection(
            &tx,
            &task_actor,
            run_id,
            &TaskTerminalReason {
                code: "team_archived".to_string(),
                message: "The Team was archived; unfinished work was cancelled.".to_string(),
                source_event_id: None,
            },
        )?;
        let turns = tx
            .execute(
                "UPDATE session_turn_intents
                 SET status='cancelled',updated_at=?2
                 WHERE org_run_id=?1 AND status IN ('optimistic','queued','running')",
                params![run_id, &archived_at_text],
            )
            .map_err(|error| error.to_string())?;

        tx.execute(
            "DELETE FROM agent_org_runtime_inbox_materializations
             WHERE inbox_id IN (
                 SELECT inbox.id FROM agent_org_runtime_inbox inbox
                 WHERE inbox.org_run_id=?1 AND inbox.read_at IS NULL
                   AND NOT EXISTS (
                       SELECT 1 FROM agent_org_runtime_inbox_delivery_resolutions resolution
                       WHERE resolution.inbox_id=inbox.id
                   )
             )",
            [run_id],
        )
        .map_err(|error| error.to_string())?;
        let inbox_deliveries = tx
            .execute(
                "INSERT INTO agent_org_runtime_inbox_delivery_resolutions (
                    inbox_id,org_run_id,resolution_kind,resolved_by_member_id,
                    reason,replacement_inbox_id,replacement_task_id,created_at
                 )
                 SELECT inbox.id,inbox.org_run_id,'cancelled','system:archive',
                        'team_archived',NULL,NULL,?2
                 FROM agent_org_runtime_inbox inbox
                 WHERE inbox.org_run_id=?1 AND inbox.read_at IS NULL
                   AND NOT EXISTS (
                       SELECT 1 FROM agent_org_runtime_inbox_delivery_resolutions resolution
                       WHERE resolution.inbox_id=inbox.id
                   )",
                params![run_id, &archived_at_text],
            )
            .map_err(|error| error.to_string())?;
        let plan_approvals = tx
            .execute(
                "UPDATE agent_org_runtime_plan_decisions
                 SET status='cancelled',decision_by='automatic',feedback='team_archived',
                     resolved_at=?2
                 WHERE status='pending' AND plan_revision_id IN (
                     SELECT plan_revision_id FROM agent_org_runtime_plan_revisions
                     WHERE org_run_id=?1
                 )",
                params![run_id, &archived_at_text],
            )
            .map_err(|error| error.to_string())?;
        let interventions = tx
            .execute(
                "UPDATE agent_org_runtime_member_interventions
                 SET status='failed',failure_reason='team_archived',cleared_at=?2,updated_at=?2
                 WHERE org_run_id=?1
                   AND status IN ('yield_requested','active','return_requested')",
                params![run_id, &archived_at_text],
            )
            .map_err(|error| error.to_string())?;
        tx.execute(
            "UPDATE agent_org_runtime_member_intervention_turns
             SET status='cancelled',terminal_at=?2,failure_reason='team_archived'
             WHERE intervention_receipt_id IN (
                 SELECT intervention_receipt_id
                 FROM agent_org_runtime_member_interventions
                 WHERE org_run_id=?1
             ) AND status IN ('queued','running')",
            params![run_id, &archived_at_text],
        )
        .map_err(|error| error.to_string())?;
        let pause_continuations = tx
            .execute(
                "UPDATE agent_org_runtime_pause_handoffs
                 SET continuation_status='skipped',skip_reason='team_archived',updated_at=?2
                 WHERE org_run_id=?1 AND continuation_status='queued'",
                params![run_id, &archived_at_text],
            )
            .map_err(|error| error.to_string())?;

        tx.execute(
            "UPDATE agent_org_runtime_archive_episodes
             SET task_cancel_count=?2,turn_cancel_count=?3,inbox_cancel_count=?4,
                 approval_cancel_count=?5,intervention_cancel_count=?6,
                 pause_continuation_cancel_count=?7,updated_at=?8
             WHERE archive_receipt_id=?1",
            params![
                &receipt_id,
                tasks as i64,
                turns as i64,
                inbox_deliveries as i64,
                plan_approvals as i64,
                interventions as i64,
                pause_continuations as i64,
                &archived_at_text
            ],
        )
        .map_err(|error| error.to_string())?;

        let outcome = outcome_for_request(&tx, run_id, request_id, true)?
            .ok_or_else(|| "Archive receipt disappeared before commit".to_string())?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok(ArchiveCommit {
            outcome,
            owns_teardown: true,
        })
    })
}

pub(crate) fn teardown_targets(receipt_id: &str) -> Result<Vec<ArchiveTeardownTarget>, String> {
    let conn = database::db::get_connection().map_err(|error| error.to_string())?;
    let mut statement = conn
        .prepare(
            "SELECT teardown.archive_receipt_id,teardown.org_run_id,
                    teardown.session_id,teardown.member_id,teardown.attempt_count
             FROM agent_org_runtime_archive_teardowns teardown
             JOIN agent_org_runtime_archive_episodes archive
               ON archive.archive_receipt_id=teardown.archive_receipt_id
             WHERE teardown.archive_receipt_id=?1
               AND archive.teardown_status='pending'
               AND teardown.teardown_status='pending'
             ORDER BY teardown.session_id",
        )
        .map_err(|error| error.to_string())?;
    let targets = statement
        .query_map([receipt_id], |row| {
            Ok(ArchiveTeardownTarget {
                receipt_id: row.get(0)?,
                run_id: row.get(1)?,
                session_id: row.get(2)?,
                member_id: row.get(3)?,
                attempt_count: row.get(4)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(targets)
}

pub(crate) fn record_teardown_attempt(
    target: &ArchiveTeardownTarget,
    runtime_lease_id: Option<&str>,
    dialog_turn_generation: Option<&str>,
    released: bool,
    error: Option<&str>,
) -> Result<ArchiveTeardownSummary, String> {
    database::db::with_sessions_writer(|| {
        let mut conn = database::db::get_connection().map_err(|error| error.to_string())?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;
        let now = chrono::Utc::now().to_rfc3339();
        let archive: Option<(String, i64)> = tx
            .query_row(
                "SELECT teardown_status,teardown_attempt_count
                 FROM agent_org_runtime_archive_episodes
                 WHERE archive_receipt_id=?1 AND org_run_id=?2",
                params![&target.receipt_id, &target.run_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let Some((archive_status, _)) = archive else {
            return Err("archive_teardown_receipt_not_found".to_string());
        };
        if archive_status != ArchiveTeardownStatus::Pending.as_str() {
            let summary = load_summary(&tx, &target.receipt_id)?;
            tx.commit().map_err(|error| error.to_string())?;
            return Ok(summary);
        }

        let next_attempt = target
            .attempt_count
            .checked_add(1)
            .ok_or_else(|| "archive teardown attempt overflow".to_string())?;
        let target_status = if released {
            ArchiveTeardownStatus::Quiesced
        } else if next_attempt >= ARCHIVE_TEARDOWN_MAX_ATTEMPTS {
            ArchiveTeardownStatus::RetainedRuntime
        } else {
            ArchiveTeardownStatus::Pending
        };
        let changed = tx
            .execute(
                "UPDATE agent_org_runtime_archive_teardowns
                 SET teardown_status=?4,attempt_count=?5,runtime_lease_id=?6,
                     dialog_turn_generation=?7,last_error=?8,
                     released_at=CASE WHEN ?4='quiesced' THEN ?9 ELSE NULL END,
                     updated_at=?9
                 WHERE archive_receipt_id=?1 AND org_run_id=?2 AND session_id=?3
                   AND teardown_status='pending' AND attempt_count=?10",
                params![
                    &target.receipt_id,
                    &target.run_id,
                    &target.session_id,
                    target_status.as_str(),
                    next_attempt,
                    runtime_lease_id,
                    dialog_turn_generation,
                    error,
                    &now,
                    target.attempt_count
                ],
            )
            .map_err(|error| error.to_string())?;
        if changed != 1 {
            let summary = load_summary(&tx, &target.receipt_id)?;
            tx.commit().map_err(|error| error.to_string())?;
            return Ok(summary);
        }
        recompute_archive_summary(&tx, &target.receipt_id, error, &now)?;
        let summary = load_summary(&tx, &target.receipt_id)?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok(summary)
    })
}

pub(crate) fn mark_deadline_expired(receipt_id: &str) -> Result<ArchiveTeardownSummary, String> {
    database::db::with_sessions_writer(|| {
        let mut conn = database::db::get_connection().map_err(|error| error.to_string())?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;
        let now = chrono::Utc::now().to_rfc3339();
        tx.execute(
            "UPDATE agent_org_runtime_archive_teardowns
             SET teardown_status='retained_runtime',last_error='archive_teardown_deadline',
                 updated_at=?2
             WHERE archive_receipt_id=?1 AND teardown_status='pending'",
            params![receipt_id, &now],
        )
        .map_err(|error| error.to_string())?;
        recompute_archive_summary(&tx, receipt_id, Some("archive_teardown_deadline"), &now)?;
        let summary = load_summary(&tx, receipt_id)?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok(summary)
    })
}

pub(crate) fn pending_receipt_ids(limit: usize) -> Result<Vec<String>, String> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    let conn = database::db::get_connection().map_err(|error| error.to_string())?;
    let mut statement = conn
        .prepare(
            "SELECT archive_receipt_id FROM agent_org_runtime_archive_episodes
             WHERE teardown_status='pending'
             ORDER BY archived_at ASC LIMIT ?1",
        )
        .map_err(|error| error.to_string())?;
    let receipt_ids = statement
        .query_map([limit as i64], |row| row.get(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(receipt_ids)
}

pub fn summary_for_run(run_id: &str) -> Result<Option<ArchiveTeardownSummary>, String> {
    let conn = database::db::get_connection().map_err(|error| error.to_string())?;
    summary_for_run_with_connection(&conn, run_id)
}

/// Canonical Team Session scope for debug/WebDriver runtime evidence. Kept
/// out of release builds so the production API surface remains unchanged.
#[cfg(debug_assertions)]
pub fn debug_owned_session_ids_for_run(run_id: &str) -> Result<Vec<String>, String> {
    let conn = database::db::get_connection().map_err(|error| error.to_string())?;
    Ok(load_team_for_run(&conn, run_id)?
        .sessions
        .into_iter()
        .map(|session| session.session_id)
        .collect())
}

pub(crate) fn summary_for_run_with_connection(
    conn: &Connection,
    run_id: &str,
) -> Result<Option<ArchiveTeardownSummary>, String> {
    let receipt_id: Option<String> = conn
        .query_row(
            "SELECT archive_receipt_id FROM agent_org_runtime_archive_episodes
             WHERE org_run_id=?1",
            [run_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    receipt_id
        .map(|receipt_id| load_summary(conn, &receipt_id))
        .transpose()
}

fn recompute_archive_summary(
    conn: &Connection,
    receipt_id: &str,
    error: Option<&str>,
    now: &str,
) -> Result<(), String> {
    let (pending, retained, max_attempt): (i64, i64, i64) = conn
        .query_row(
            "SELECT
                 SUM(CASE WHEN teardown_status='pending' THEN 1 ELSE 0 END),
                 SUM(CASE WHEN teardown_status='retained_runtime' THEN 1 ELSE 0 END),
                 COALESCE(MAX(attempt_count),0)
             FROM agent_org_runtime_archive_teardowns
             WHERE archive_receipt_id=?1",
            [receipt_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|error| error.to_string())?;
    let status = if pending > 0 {
        ArchiveTeardownStatus::Pending
    } else if retained > 0 {
        ArchiveTeardownStatus::RetainedRuntime
    } else {
        ArchiveTeardownStatus::Quiesced
    };
    conn.execute(
        "UPDATE agent_org_runtime_archive_episodes
         SET teardown_status=?2,teardown_attempt_count=?3,
             retained_runtime_count=?4,last_error=COALESCE(?5,last_error),
             quiesced_at=CASE WHEN ?2='quiesced' THEN ?6 ELSE NULL END,
             updated_at=?6
         WHERE archive_receipt_id=?1",
        params![
            receipt_id,
            status.as_str(),
            max_attempt,
            retained,
            error,
            now
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn outcome_for_request(
    conn: &Connection,
    run_id: &str,
    request_id: &str,
    transitioned: bool,
) -> Result<Option<ArchiveRunOutcome>, String> {
    conn.query_row(
        "SELECT archive_request_id,org_run_id,archive_receipt_id,archive_generation,
                archived_at,task_cancel_count,turn_cancel_count,inbox_cancel_count,
                approval_cancel_count,intervention_cancel_count,
                pause_continuation_cancel_count,teardown_status,
                teardown_attempt_count,retained_runtime_count,deadline_at
         FROM agent_org_runtime_archive_episodes
         WHERE org_run_id=?1 AND archive_request_id=?2",
        params![run_id, request_id],
        |row| {
            let status_raw: String = row.get(11)?;
            let status = ArchiveTeardownStatus::parse(&status_raw).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    11,
                    rusqlite::types::Type::Text,
                    error.into(),
                )
            })?;
            Ok(ArchiveRunOutcome {
                request_id: row.get(0)?,
                run_id: row.get(1)?,
                receipt_id: row.get(2)?,
                transitioned,
                archive_generation: row.get(3)?,
                archived_at: row.get(4)?,
                cancellations: ArchiveCancellationCounts {
                    tasks: row.get::<_, i64>(5)? as usize,
                    turns: row.get::<_, i64>(6)? as usize,
                    inbox_deliveries: row.get::<_, i64>(7)? as usize,
                    plan_approvals: row.get::<_, i64>(8)? as usize,
                    interventions: row.get::<_, i64>(9)? as usize,
                    pause_continuations: row.get::<_, i64>(10)? as usize,
                },
                teardown: ArchiveTeardownSummary {
                    receipt_id: row.get(2)?,
                    status,
                    attempt_count: row.get(12)?,
                    retained_runtime_count: row.get::<_, i64>(13)? as usize,
                    deadline_at: row.get(14)?,
                },
            })
        },
    )
    .optional()
    .map_err(|error| error.to_string())
}

fn load_summary(conn: &Connection, receipt_id: &str) -> Result<ArchiveTeardownSummary, String> {
    conn.query_row(
        "SELECT teardown_status,teardown_attempt_count,retained_runtime_count,deadline_at
         FROM agent_org_runtime_archive_episodes WHERE archive_receipt_id=?1",
        [receipt_id],
        |row| {
            let status_raw: String = row.get(0)?;
            let status = ArchiveTeardownStatus::parse(&status_raw).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Text,
                    error.into(),
                )
            })?;
            Ok(ArchiveTeardownSummary {
                receipt_id: receipt_id.to_string(),
                status,
                attempt_count: row.get(1)?,
                retained_runtime_count: row.get::<_, i64>(2)? as usize,
                deadline_at: row.get(3)?,
            })
        },
    )
    .map_err(|error| error.to_string())
}

fn validate_request_id(request_id: &str) -> Result<(), String> {
    uuid::Uuid::parse_str(request_id)
        .map(|_| ())
        .map_err(|_| "Archive request_id must be a UUID".to_string())
}

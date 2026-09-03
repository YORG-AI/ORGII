//! Durable Pause/Resume episodes for Agent Org formal work.
//!
//! The run lifecycle fence and the list of captured formal Turns are committed
//! together. Runtime teardown is deliberately post-commit and records evidence
//! back into these receipts; it never owns the Paused decision.

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;

use crate::coordination::agent_org_turn_contexts::{accept_with_connection, AgentOrgTurnAdmission};

const FORMAL_TURN_KINDS: [&str; 2] = ["coordinator", "task_execution"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PauseRunOutcome {
    pub request_id: String,
    pub run_id: String,
    pub episode_id: String,
    pub transitioned: bool,
    pub pause_generation: i64,
    pub captured_turn_count: usize,
    pub draining_turn_count: usize,
    pub timed_out_turn_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeRunOutcome {
    pub request_id: String,
    pub run_id: String,
    pub episode_id: String,
    pub transitioned: bool,
    pub resume_generation: i64,
    pub continuation_count: usize,
    pub skipped_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PauseHandoffSummary {
    pub episode_id: String,
    pub pause_generation: i64,
    pub total_count: usize,
    pub draining_count: usize,
    pub timed_out_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RunningPauseHandoff {
    pub episode_id: String,
    pub run_id: String,
    pub session_id: String,
    pub turn_intent_id: String,
}

/// Internal ownership result for the process that actually committed the
/// Paused fence. Historical/idempotent callers receive the same wire outcome
/// but never start a second teardown owner.
pub(crate) struct PauseCommit {
    pub outcome: PauseRunOutcome,
    pub teardown_owner_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ContinuationDispatch {
    pub episode_id: String,
    pub run_id: String,
    pub session_id: String,
    pub turn_intent_id: String,
    pub turn_kind: String,
    pub task_id: Option<String>,
    pub member_dispatch_sequence: Option<i64>,
}

pub(super) fn create_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_org_runtime_pause_episodes (
            episode_id TEXT PRIMARY KEY CHECK(length(trim(episode_id)) > 0),
            org_run_id TEXT NOT NULL,
            pause_request_id TEXT NOT NULL CHECK(length(trim(pause_request_id)) > 0),
            pause_generation INTEGER NOT NULL CHECK(pause_generation >= 2),
            status TEXT NOT NULL CHECK(status IN ('active','consumed')),
            resume_request_id TEXT,
            resume_generation INTEGER,
            teardown_owner_id TEXT NOT NULL CHECK(length(trim(teardown_owner_id)) > 0),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            resumed_at TEXT,
            UNIQUE(org_run_id, pause_request_id),
            UNIQUE(resume_request_id),
            FOREIGN KEY(org_run_id) REFERENCES agent_org_runtime_runs(id) ON DELETE CASCADE,
            CHECK(
                (status='active' AND resume_request_id IS NULL
                 AND resume_generation IS NULL AND resumed_at IS NULL)
                OR
                (status='consumed' AND resume_request_id IS NOT NULL
                 AND resume_generation IS NOT NULL AND resume_generation > pause_generation
                 AND resumed_at IS NOT NULL)
            )
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_org_runtime_pause_one_active
            ON agent_org_runtime_pause_episodes(org_run_id)
            WHERE status='active';
        CREATE INDEX IF NOT EXISTS idx_agent_org_runtime_pause_request
            ON agent_org_runtime_pause_episodes(org_run_id, pause_request_id);

        CREATE TABLE IF NOT EXISTS agent_org_runtime_pause_handoffs (
            handoff_id TEXT PRIMARY KEY CHECK(length(trim(handoff_id)) > 0),
            episode_id TEXT NOT NULL,
            org_run_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            original_turn_intent_id TEXT NOT NULL,
            turn_kind TEXT NOT NULL CHECK(turn_kind IN ('coordinator','task_execution')),
            participant_id TEXT NOT NULL,
            task_id TEXT,
            original_owner_member_id TEXT,
            original_activation_generation INTEGER NOT NULL CHECK(original_activation_generation >= 1),
            original_intent_status TEXT NOT NULL CHECK(original_intent_status IN ('queued','running')),
            drain_status TEXT NOT NULL CHECK(drain_status IN (
                'waiting','released','runtime_absent','timed_out'
            )),
            runtime_lease_id TEXT,
            dialog_turn_generation TEXT,
            yield_requested_at TEXT,
            released_at TEXT,
            drain_timeout_at TEXT,
            drain_error TEXT,
            continuation_turn_intent_id TEXT,
            continuation_status TEXT CHECK(continuation_status IN ('queued','dispatched','skipped')),
            skip_reason TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(episode_id, session_id, original_turn_intent_id),
            UNIQUE(continuation_turn_intent_id),
            FOREIGN KEY(episode_id) REFERENCES agent_org_runtime_pause_episodes(episode_id) ON DELETE CASCADE,
            FOREIGN KEY(org_run_id) REFERENCES agent_org_runtime_runs(id) ON DELETE CASCADE,
            FOREIGN KEY(session_id, original_turn_intent_id)
                REFERENCES agent_org_runtime_turn_contexts(session_id, turn_intent_id)
                ON DELETE CASCADE,
            CHECK(
                (turn_kind='coordinator' AND task_id IS NULL AND original_owner_member_id IS NULL)
                OR
                (turn_kind='task_execution' AND task_id IS NOT NULL
                 AND original_owner_member_id=participant_id)
            ),
            CHECK(
                (runtime_lease_id IS NULL AND dialog_turn_generation IS NULL)
                OR
                (runtime_lease_id IS NOT NULL AND dialog_turn_generation IS NOT NULL)
            ),
            CHECK(
                (continuation_status IS NULL AND continuation_turn_intent_id IS NULL AND skip_reason IS NULL)
                OR
                (continuation_status IN ('queued','dispatched')
                 AND continuation_turn_intent_id IS NOT NULL AND skip_reason IS NULL)
                OR
                (continuation_status='skipped' AND skip_reason IS NOT NULL)
            )
        );
        CREATE INDEX IF NOT EXISTS idx_agent_org_runtime_pause_capture
            ON agent_org_runtime_turn_contexts(
                org_run_id, activation_generation, turn_kind, session_id, turn_intent_id
            )
            WHERE turn_kind IN ('coordinator','task_execution');
        CREATE INDEX IF NOT EXISTS idx_agent_org_runtime_pause_drain
            ON agent_org_runtime_pause_handoffs(episode_id, drain_status, session_id);
        CREATE INDEX IF NOT EXISTS idx_agent_org_runtime_pause_dispatch
            ON agent_org_runtime_pause_handoffs(continuation_status, org_run_id, session_id);",
    )
}

pub fn pause_run(run_id: &str, request_id: &str) -> Result<PauseRunOutcome, String> {
    pause_run_commit(run_id, request_id).map(|commit| commit.outcome)
}

pub(crate) fn pause_run_commit(run_id: &str, request_id: &str) -> Result<PauseCommit, String> {
    validate_request_id(request_id)?;
    database::db::with_sessions_writer(|| {
        let mut conn = database::db::get_connection().map_err(|error| error.to_string())?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;

        if let Some(outcome) = pause_outcome_for_request(&tx, run_id, request_id, true)? {
            tx.commit().map_err(|error| error.to_string())?;
            return Ok(PauseCommit {
                outcome,
                teardown_owner_id: None,
            });
        }

        let run: Option<(String, i64)> = tx
            .query_row(
                "SELECT status, activation_generation FROM agent_org_runtime_runs WHERE id=?1",
                [run_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let Some((status, generation)) = run else {
            return Err(format!("Agent Org run {run_id} does not exist"));
        };
        if status == "paused" {
            let mut outcome = active_pause_outcome(&tx, run_id)?
                .ok_or_else(|| format!("paused Agent Org run {run_id} has no active episode"))?;
            outcome.request_id = request_id.to_string();
            outcome.transitioned = false;
            tx.commit().map_err(|error| error.to_string())?;
            return Ok(PauseCommit {
                outcome,
                teardown_owner_id: None,
            });
        }
        if status != "running" {
            if status == "archived" {
                return Err(format!(
                    "team_archived: Agent Org run {run_id} is read-only"
                ));
            }
            return Err(format!(
                "Agent Org run {run_id} is {status}; only a Working Team can be paused"
            ));
        }

        let episode_id = uuid::Uuid::new_v4().to_string();
        let teardown_owner_id = uuid::Uuid::new_v4().to_string();
        let pause_generation = generation
            .checked_add(1)
            .ok_or_else(|| format!("Agent Org run {run_id} generation overflow"))?;
        let now = chrono::Utc::now().to_rfc3339();

        let changed = tx
            .execute(
                "UPDATE agent_org_runtime_runs
                 SET status='paused', activation_generation=?2, updated_at=?3
                 WHERE id=?1 AND status='running' AND activation_generation=?4",
                params![run_id, pause_generation, &now, generation],
            )
            .map_err(|error| error.to_string())?;
        if changed != 1 {
            return Err(format!(
                "Agent Org run {run_id} changed while Pause was committing"
            ));
        }
        tx.execute(
            "INSERT INTO agent_org_runtime_pause_episodes (
                episode_id,org_run_id,pause_request_id,pause_generation,status,
                teardown_owner_id,created_at,updated_at
             ) VALUES (?1,?2,?3,?4,'active',?5,?6,?6)",
            params![
                &episode_id,
                run_id,
                request_id,
                pause_generation,
                &teardown_owner_id,
                &now
            ],
        )
        .map_err(|error| error.to_string())?;

        let mut statement = tx
            .prepare(
                "SELECT context.session_id,context.turn_intent_id,context.turn_kind,
                        context.participant_id,context.task_id,context.owner_member_id,
                        context.activation_generation,intent.status
                 FROM agent_org_runtime_turn_contexts context
                 JOIN session_turn_intents intent
                   ON intent.session_id=context.session_id
                  AND intent.turn_intent_id=context.turn_intent_id
                 WHERE context.org_run_id=?1
                   AND context.activation_generation=?2
                   AND context.turn_kind IN (?3,?4)
                   AND intent.org_run_id=?1
                   AND intent.status IN ('queued','running')
                 ORDER BY context.context_id ASC",
            )
            .map_err(|error| error.to_string())?;
        let captures = statement
            .query_map(
                params![
                    run_id,
                    generation,
                    FORMAL_TURN_KINDS[0],
                    FORMAL_TURN_KINDS[1]
                ],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, i64>(6)?,
                        row.get::<_, String>(7)?,
                    ))
                },
            )
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        drop(statement);

        for (
            session_id,
            intent_id,
            kind,
            participant,
            task_id,
            owner,
            turn_generation,
            intent_status,
        ) in &captures
        {
            let drain_status = if intent_status == "queued" {
                "runtime_absent"
            } else {
                "waiting"
            };
            let released_at = (drain_status == "runtime_absent").then_some(now.as_str());
            tx.execute(
                "INSERT INTO agent_org_runtime_pause_handoffs (
                    handoff_id,episode_id,org_run_id,session_id,original_turn_intent_id,
                    turn_kind,participant_id,task_id,original_owner_member_id,
                    original_activation_generation,original_intent_status,drain_status,
                    released_at,created_at,updated_at
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?14)",
                params![
                    uuid::Uuid::new_v4().to_string(),
                    &episode_id,
                    run_id,
                    session_id,
                    intent_id,
                    kind,
                    participant,
                    task_id,
                    owner,
                    turn_generation,
                    intent_status,
                    drain_status,
                    released_at,
                    &now,
                ],
            )
            .map_err(|error| error.to_string())?;
        }

        tx.execute(
            "UPDATE session_turn_intents
             SET status='stale', updated_at=?2
             WHERE org_run_id=?1 AND status='queued'
               AND EXISTS (
                 SELECT 1 FROM agent_org_runtime_pause_handoffs handoff
                 WHERE handoff.episode_id=?3
                   AND handoff.session_id=session_turn_intents.session_id
                   AND handoff.original_turn_intent_id=session_turn_intents.turn_intent_id
               )",
            params![run_id, &now, &episode_id],
        )
        .map_err(|error| error.to_string())?;

        tx.commit().map_err(|error| error.to_string())?;
        let draining = captures.iter().filter(|item| item.7 == "running").count();
        Ok(PauseCommit {
            outcome: PauseRunOutcome {
                request_id: request_id.to_string(),
                run_id: run_id.to_string(),
                episode_id,
                transitioned: true,
                pause_generation,
                captured_turn_count: captures.len(),
                draining_turn_count: draining,
                timed_out_turn_count: 0,
            },
            teardown_owner_id: Some(teardown_owner_id),
        })
    })
}

pub fn resume_run(run_id: &str, request_id: &str) -> Result<ResumeRunOutcome, String> {
    validate_request_id(request_id)?;
    database::db::with_sessions_writer(|| {
        let mut conn = database::db::get_connection().map_err(|error| error.to_string())?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;

        if let Some(outcome) = resume_outcome_for_request(&tx, run_id, request_id, true)? {
            tx.commit().map_err(|error| error.to_string())?;
            return Ok(outcome);
        }

        let run: Option<(String, i64, Option<String>)> = tx
            .query_row(
                "SELECT status,activation_generation,root_session_id
                 FROM agent_org_runtime_runs WHERE id=?1",
                [run_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let Some((status, generation, root_session_id)) = run else {
            return Err(format!("Agent Org run {run_id} does not exist"));
        };
        if status != "paused" {
            if status == "archived" {
                return Err(format!(
                    "team_archived: Agent Org run {run_id} cannot be resumed"
                ));
            }
            return Err(format!(
                "Agent Org run {run_id} is {status}; only a Paused Team can be resumed"
            ));
        }
        let episode: Option<(String, i64)> = tx
            .query_row(
                "SELECT episode_id,pause_generation
                 FROM agent_org_runtime_pause_episodes
                 WHERE org_run_id=?1 AND status='active'",
                [run_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let Some((episode_id, pause_generation)) = episode else {
            return Err(format!(
                "paused Agent Org run {run_id} has no active episode"
            ));
        };
        if generation != pause_generation {
            return Err(format!(
                "Pause episode generation {pause_generation} does not match run generation {generation}"
            ));
        }
        let resume_generation = generation
            .checked_add(1)
            .ok_or_else(|| format!("Agent Org run {run_id} generation overflow"))?;
        let now = chrono::Utc::now().to_rfc3339();
        let changed = tx
            .execute(
                "UPDATE agent_org_runtime_runs
                 SET status='running',activation_generation=?2,updated_at=?3
                 WHERE id=?1 AND status='paused' AND activation_generation=?4",
                params![run_id, resume_generation, &now, generation],
            )
            .map_err(|error| error.to_string())?;
        if changed != 1 {
            return Err(format!(
                "Agent Org run {run_id} changed while Resume was committing"
            ));
        }

        let handoffs = load_handoffs_for_resume(&tx, &episode_id)?;
        let mut continuation_count = 0usize;
        let mut skipped_count = 0usize;
        for handoff in handoffs {
            let skip_reason =
                continuation_skip_reason(&tx, run_id, root_session_id.as_deref(), &handoff)?;
            if let Some(reason) = skip_reason {
                tx.execute(
                    "UPDATE agent_org_runtime_pause_handoffs
                     SET continuation_status='skipped',skip_reason=?2,updated_at=?3
                     WHERE handoff_id=?1 AND continuation_status IS NULL",
                    params![&handoff.handoff_id, reason, &now],
                )
                .map_err(|error| error.to_string())?;
                resolve_terminal_task_assignment_after_resume_skip(
                    &tx, run_id, &handoff, &reason, &now,
                )?;
                skipped_count += 1;
                continue;
            }

            let continuation_turn_intent_id = format!("agent-org-cont-{}", uuid::Uuid::new_v4());
            let admission = match handoff.turn_kind.as_str() {
                "coordinator" => AgentOrgTurnAdmission::coordinator(
                    run_id,
                    &handoff.session_id,
                    &continuation_turn_intent_id,
                    Some(continuation_turn_intent_id.clone()),
                    crate::foundation::session_bridge::TurnIntentBridgeSource::Resume,
                ),
                "task_execution" => AgentOrgTurnAdmission::task_continuation(
                    run_id,
                    &handoff.session_id,
                    &continuation_turn_intent_id,
                    Some(continuation_turn_intent_id.clone()),
                    handoff
                        .task_id
                        .as_deref()
                        .ok_or_else(|| "Task handoff has no task_id".to_string())?,
                    handoff
                        .owner_member_id
                        .as_deref()
                        .ok_or_else(|| "Task handoff has no owner".to_string())?,
                    resume_generation,
                ),
                other => return Err(format!("unknown formal handoff kind {other:?}")),
            };
            accept_with_connection(&tx, &admission)?;
            tx.execute(
                "UPDATE agent_org_runtime_pause_handoffs
                 SET continuation_turn_intent_id=?2,continuation_status='queued',updated_at=?3
                 WHERE handoff_id=?1 AND continuation_status IS NULL",
                params![&handoff.handoff_id, &continuation_turn_intent_id, &now],
            )
            .map_err(|error| error.to_string())?;
            continuation_count += 1;
        }

        tx.execute(
            "UPDATE agent_org_runtime_pause_episodes
             SET status='consumed',resume_request_id=?2,resume_generation=?3,
                 resumed_at=?4,updated_at=?4
             WHERE episode_id=?1 AND status='active'",
            params![&episode_id, request_id, resume_generation, &now],
        )
        .map_err(|error| error.to_string())?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok(ResumeRunOutcome {
            request_id: request_id.to_string(),
            run_id: run_id.to_string(),
            episode_id,
            transitioned: true,
            resume_generation,
            continuation_count,
            skipped_count,
        })
    })
}

#[derive(Debug)]
struct ResumeHandoff {
    handoff_id: String,
    session_id: String,
    turn_kind: String,
    task_id: Option<String>,
    owner_member_id: Option<String>,
    original_intent_status: String,
}

fn load_handoffs_for_resume(
    conn: &Connection,
    episode_id: &str,
) -> Result<Vec<ResumeHandoff>, String> {
    let mut statement = conn
        .prepare(
            "SELECT handoff_id,session_id,turn_kind,task_id,original_owner_member_id,
                    original_intent_status
             FROM agent_org_runtime_pause_handoffs
             WHERE episode_id=?1 ORDER BY created_at ASC,handoff_id ASC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([episode_id], |row| {
            Ok(ResumeHandoff {
                handoff_id: row.get(0)?,
                session_id: row.get(1)?,
                turn_kind: row.get(2)?,
                task_id: row.get(3)?,
                owner_member_id: row.get(4)?,
                original_intent_status: row.get(5)?,
            })
        })
        .map_err(|error| error.to_string())?;
    let result = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(result)
}

fn continuation_skip_reason(
    conn: &Connection,
    run_id: &str,
    root_session_id: Option<&str>,
    handoff: &ResumeHandoff,
) -> Result<Option<String>, String> {
    let materialized = |member_id: &str| -> Result<bool, String> {
        conn.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM agent_org_runtime_member_materializations materialization
                JOIN agent_sessions session
                  ON session.session_id=materialization.session_id
                WHERE materialization.org_run_id=?1
                  AND materialization.member_id=?2
                  AND materialization.session_id=?3
                  AND materialization.status='succeeded'
                  AND session.agent_definition_id=materialization.agent_id
                  AND session.org_member_id=materialization.member_id
                  AND NOT EXISTS (
                    SELECT 1 FROM agent_org_runtime_member_materializations newer
                    WHERE newer.org_run_id=materialization.org_run_id
                      AND newer.member_id=materialization.member_id
                      AND newer.status='succeeded'
                      AND newer.generation>materialization.generation
                  )
             )",
            params![run_id, member_id, &handoff.session_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())
    };

    if handoff.turn_kind == "coordinator" {
        if root_session_id != Some(handoff.session_id.as_str()) {
            return Ok(Some("coordinator_session_changed".to_string()));
        }
        if !materialized(super::agent_org_runs::COORDINATOR_MEMBER_ID)? {
            return Ok(Some("coordinator_materialization_changed".to_string()));
        }
        return Ok(None);
    }

    let task_id = handoff
        .task_id
        .as_deref()
        .ok_or_else(|| "Task handoff has no task_id".to_string())?;
    let owner = handoff
        .owner_member_id
        .as_deref()
        .ok_or_else(|| "Task handoff has no owner".to_string())?;
    let task: Option<(String, Option<String>)> = conn
        .query_row(
            "SELECT status,owner FROM agent_org_runtime_tasks WHERE org_run_id=?1 AND id=?2",
            params![run_id, task_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some((status, current_owner)) = task else {
        return Ok(Some("task_missing".to_string()));
    };
    if !matches!(status.as_str(), "pending" | "in_progress") {
        return Ok(Some(format!("task_{status}")));
    }
    if current_owner.as_deref() != Some(owner) {
        return Ok(Some("task_owner_changed".to_string()));
    }
    if !materialized(owner)? {
        return Ok(Some("member_materialization_changed".to_string()));
    }
    let _ = &handoff.original_intent_status;
    Ok(None)
}

/// A Task can become terminal after its assignment was materialized but before
/// the old Turn acknowledges that Inbox row. Pause correctly rejects the late
/// acknowledgement, and Resume correctly skips the terminal Task; resolve the
/// now-undeliverable assignment in the same Resume transaction so it cannot
/// keep the Run non-quiescent or wake the old owner again.
fn resolve_terminal_task_assignment_after_resume_skip(
    conn: &Connection,
    run_id: &str,
    handoff: &ResumeHandoff,
    skip_reason: &str,
    now: &str,
) -> Result<(), String> {
    if handoff.turn_kind != "task_execution"
        || !matches!(
            skip_reason,
            "task_completed" | "task_failed" | "task_cancelled"
        )
    {
        return Ok(());
    }
    let task_id = handoff
        .task_id
        .as_deref()
        .ok_or_else(|| "terminal Task handoff has no task_id".to_string())?;
    let owner = handoff
        .owner_member_id
        .as_deref()
        .ok_or_else(|| "terminal Task handoff has no owner".to_string())?;
    let resolution_reason = format!("pause_resume_{skip_reason}");
    conn.execute(
        "INSERT OR IGNORE INTO agent_org_runtime_inbox_delivery_resolutions (
             inbox_id,org_run_id,resolution_kind,resolved_by_member_id,reason,
             replacement_inbox_id,replacement_task_id,created_at
         )
         SELECT inbox.id,inbox.org_run_id,'cancelled','coordinator',?4,NULL,NULL,?5
         FROM agent_org_runtime_inbox inbox
         WHERE inbox.org_run_id=?1
           AND inbox.recipient_member_id=?2
           AND inbox.payload_kind='task_assigned'
           AND json_extract(inbox.payload_json,'$.task_id')=?3
           AND inbox.read_at IS NULL",
        params![run_id, owner, task_id, &resolution_reason, now],
    )
    .map_err(|error| error.to_string())?;
    conn.execute(
        "DELETE FROM agent_org_runtime_inbox_materializations
         WHERE inbox_id IN (
             SELECT resolution.inbox_id
             FROM agent_org_runtime_inbox_delivery_resolutions resolution
             WHERE resolution.org_run_id=?1
               AND resolution.resolution_kind='cancelled'
               AND resolution.reason=?2
         )",
        params![run_id, &resolution_reason],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) fn list_running_handoffs(
    episode_id: &str,
    teardown_owner_id: &str,
) -> Result<Vec<RunningPauseHandoff>, String> {
    let conn = database::db::get_connection().map_err(|error| error.to_string())?;
    let mut statement = conn
        .prepare(
            "SELECT handoff.episode_id,handoff.org_run_id,handoff.session_id,
                    handoff.original_turn_intent_id
             FROM agent_org_runtime_pause_handoffs handoff
             JOIN agent_org_runtime_pause_episodes episode
               ON episode.episode_id=handoff.episode_id
             WHERE handoff.episode_id=?1 AND episode.teardown_owner_id=?2
               AND handoff.original_intent_status='running'
               AND handoff.drain_status='waiting'
             ORDER BY handoff.session_id ASC,handoff.created_at ASC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![episode_id, teardown_owner_id], |row| {
            Ok(RunningPauseHandoff {
                episode_id: row.get(0)?,
                run_id: row.get(1)?,
                session_id: row.get(2)?,
                turn_intent_id: row.get(3)?,
            })
        })
        .map_err(|error| error.to_string())?;
    let result = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(result)
}

pub(crate) fn bind_runtime_and_request_yield(
    episode_id: &str,
    session_id: &str,
    turn_intent_id: &str,
    runtime_lease_id: &str,
    dialog_turn_generation: &str,
) -> Result<bool, String> {
    let now = chrono::Utc::now().to_rfc3339();
    database::db::with_sessions_writer(|| {
        let conn = database::db::get_connection().map_err(|error| error.to_string())?;
        conn.execute(
            "UPDATE agent_org_runtime_pause_handoffs
             SET runtime_lease_id=?4,dialog_turn_generation=?5,yield_requested_at=?6,updated_at=?6
             WHERE episode_id=?1 AND session_id=?2 AND original_turn_intent_id=?3
               AND drain_status='waiting' AND runtime_lease_id IS NULL",
            params![
                episode_id,
                session_id,
                turn_intent_id,
                runtime_lease_id,
                dialog_turn_generation,
                &now
            ],
        )
        .map(|changed| changed == 1)
        .map_err(|error| error.to_string())
    })
}

pub(crate) fn mark_runtime_absent(
    episode_id: &str,
    session_id: &str,
    turn_intent_id: &str,
) -> Result<bool, String> {
    let now = chrono::Utc::now().to_rfc3339();
    database::db::with_sessions_writer(|| {
        let conn = database::db::get_connection().map_err(|error| error.to_string())?;
        conn.execute(
            "UPDATE agent_org_runtime_pause_handoffs
             SET drain_status='runtime_absent',released_at=?4,updated_at=?4
             WHERE episode_id=?1 AND session_id=?2 AND original_turn_intent_id=?3
               AND drain_status IN ('waiting','timed_out') AND runtime_lease_id IS NULL",
            params![episode_id, session_id, turn_intent_id, &now],
        )
        .map(|changed| changed == 1)
        .map_err(|error| error.to_string())
    })
}

pub(crate) fn mark_released(
    session_id: &str,
    turn_intent_id: &str,
    runtime_lease_id: &str,
    dialog_turn_generation: &str,
) -> Result<Option<String>, String> {
    let now = chrono::Utc::now().to_rfc3339();
    database::db::with_sessions_writer(|| {
        let conn = database::db::get_connection().map_err(|error| error.to_string())?;
        conn.query_row(
            "UPDATE agent_org_runtime_pause_handoffs
                 SET drain_status='released',released_at=?5,updated_at=?5
                 WHERE session_id=?1 AND original_turn_intent_id=?2
                   AND runtime_lease_id=?3 AND dialog_turn_generation=?4
                   AND drain_status IN ('waiting','timed_out')
                 RETURNING episode_id",
            params![
                session_id,
                turn_intent_id,
                runtime_lease_id,
                dialog_turn_generation,
                &now
            ],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())
    })
}

pub(crate) fn bound_episode_for_runtime(
    session_id: &str,
    turn_intent_id: &str,
    runtime_lease_id: &str,
    dialog_turn_generation: &str,
) -> Result<Option<String>, String> {
    let conn = database::db::get_connection().map_err(|error| error.to_string())?;
    conn.query_row(
        "SELECT episode_id FROM agent_org_runtime_pause_handoffs
         WHERE session_id=?1 AND original_turn_intent_id=?2
           AND runtime_lease_id=?3 AND dialog_turn_generation=?4
           AND drain_status IN ('waiting','timed_out')
         ORDER BY created_at DESC LIMIT 1",
        params![
            session_id,
            turn_intent_id,
            runtime_lease_id,
            dialog_turn_generation
        ],
        |row| row.get(0),
    )
    .optional()
    .map_err(|error| error.to_string())
}

pub(crate) fn mark_unresolved_timed_out(episode_id: &str) -> Result<usize, String> {
    let now = chrono::Utc::now().to_rfc3339();
    database::db::with_sessions_writer(|| {
        let conn = database::db::get_connection().map_err(|error| error.to_string())?;
        conn.execute(
            "UPDATE agent_org_runtime_pause_handoffs
             SET drain_status='timed_out',drain_timeout_at=?2,
                 drain_error='runtime did not yield within 10 seconds',updated_at=?2
             WHERE episode_id=?1 AND drain_status='waiting'",
            params![episode_id, &now],
        )
        .map_err(|error| error.to_string())
    })
}

pub fn pause_summary_for_run(run_id: &str) -> Result<Option<PauseHandoffSummary>, String> {
    let conn = database::db::get_connection().map_err(|error| error.to_string())?;
    pause_summary_with_connection(&conn, run_id)
}

pub fn pause_summary_with_connection(
    conn: &Connection,
    run_id: &str,
) -> Result<Option<PauseHandoffSummary>, String> {
    conn.query_row(
        "SELECT episode.episode_id,episode.pause_generation,
                COUNT(handoff.handoff_id),
                COALESCE(SUM(CASE WHEN handoff.drain_status IN ('waiting','timed_out') THEN 1 ELSE 0 END),0),
                COALESCE(SUM(CASE WHEN handoff.drain_timeout_at IS NOT NULL THEN 1 ELSE 0 END),0)
         FROM agent_org_runtime_pause_episodes episode
         LEFT JOIN agent_org_runtime_pause_handoffs handoff ON handoff.episode_id=episode.episode_id
         WHERE episode.org_run_id=?1
         GROUP BY episode.episode_id,episode.pause_generation,episode.created_at
         ORDER BY episode.created_at DESC LIMIT 1",
        [run_id],
        |row| {
            Ok(PauseHandoffSummary {
                episode_id: row.get(0)?,
                pause_generation: row.get(1)?,
                total_count: row.get::<_, i64>(2)? as usize,
                draining_count: row.get::<_, i64>(3)? as usize,
                timed_out_count: row.get::<_, i64>(4)? as usize,
            })
        },
    )
    .optional()
    .map_err(|error| error.to_string())
}

pub(crate) fn list_dispatchable_continuations(
    limit: usize,
) -> Result<Vec<ContinuationDispatch>, String> {
    let conn = database::db::get_connection().map_err(|error| error.to_string())?;
    let mut statement = conn
        .prepare(
            "SELECT handoff.episode_id,handoff.org_run_id,handoff.session_id,
                    handoff.continuation_turn_intent_id,handoff.turn_kind,handoff.task_id,
                    context.member_dispatch_sequence
             FROM agent_org_runtime_pause_handoffs handoff
             JOIN agent_org_runtime_pause_episodes episode ON episode.episode_id=handoff.episode_id
             JOIN agent_org_runtime_runs run ON run.id=handoff.org_run_id
             JOIN agent_org_runtime_turn_contexts context
               ON context.session_id=handoff.session_id
              AND context.turn_intent_id=handoff.continuation_turn_intent_id
             JOIN session_turn_intents intent
               ON intent.session_id=handoff.session_id
              AND intent.turn_intent_id=handoff.continuation_turn_intent_id
             WHERE episode.status='consumed' AND run.status='running'
               AND handoff.continuation_status='queued'
               AND handoff.drain_status IN ('released','runtime_absent')
               AND intent.status='queued'
             ORDER BY CASE WHEN context.member_dispatch_sequence IS NULL THEN 0 ELSE 1 END,
                      context.dispatch_member_id,context.member_dispatch_sequence,handoff.created_at
             LIMIT ?1",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([i64::try_from(limit).unwrap_or(i64::MAX)], |row| {
            Ok(ContinuationDispatch {
                episode_id: row.get(0)?,
                run_id: row.get(1)?,
                session_id: row.get(2)?,
                turn_intent_id: row.get(3)?,
                turn_kind: row.get(4)?,
                task_id: row.get(5)?,
                member_dispatch_sequence: row.get(6)?,
            })
        })
        .map_err(|error| error.to_string())?;
    let result = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(result)
}

pub(crate) fn continuation_participant_ids(episode_id: &str) -> Result<Vec<String>, String> {
    let conn = database::db::get_connection().map_err(|error| error.to_string())?;
    let mut statement = conn
        .prepare(
            "SELECT DISTINCT participant_id
             FROM agent_org_runtime_pause_handoffs
             WHERE episode_id=?1 AND continuation_status IN ('queued','dispatched')
             ORDER BY participant_id ASC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([episode_id], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    let result = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(result)
}

/// Resolve the transient provider instruction for one already-claimed
/// continuation. The receipt, current run fence, and base intent must all
/// still agree; callers persist neither this text nor a synthetic Inbox row.
pub(crate) fn continuation_nudge_for_turn(
    session_id: &str,
    turn_intent_id: &str,
) -> Result<Option<String>, String> {
    let conn = database::db::get_connection().map_err(|error| error.to_string())?;
    let continuation: Option<(String, Option<String>)> = conn
        .query_row(
            "SELECT handoff.turn_kind,handoff.task_id
             FROM agent_org_runtime_pause_handoffs handoff
             JOIN agent_org_runtime_pause_episodes episode
               ON episode.episode_id=handoff.episode_id
             JOIN agent_org_runtime_runs run ON run.id=handoff.org_run_id
             JOIN session_turn_intents intent
               ON intent.session_id=handoff.session_id
              AND intent.turn_intent_id=handoff.continuation_turn_intent_id
             WHERE handoff.session_id=?1
               AND handoff.continuation_turn_intent_id=?2
               AND handoff.continuation_status='dispatched'
               AND episode.status='consumed'
               AND run.status='running'
               AND intent.status IN ('queued','running')",
            params![session_id, turn_intent_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    match continuation {
        None => Ok(None),
        Some((kind, Some(task_id))) if kind == "task_execution" => Ok(Some(format!(
            "<system-reminder>Continue the paused Agent Org task {task_id} from its persisted Task, Inbox, and conversation state. Do not create a replacement Task.</system-reminder>"
        ))),
        Some((kind, None)) if kind == "coordinator" => Ok(Some(
            "<system-reminder>Continue coordinating the paused Agent Org run from its persisted Task, Inbox, and conversation state. Do not restart work that is already terminal.</system-reminder>"
                .to_string(),
        )),
        Some((kind, task_id)) => Err(format!(
            "invalid Agent Org continuation receipt kind={kind:?}, task_id={task_id:?}"
        )),
    }
}

/// Atomically grant one dispatcher ownership of a queued continuation.
pub(crate) fn claim_continuation_dispatch(
    episode_id: &str,
    turn_intent_id: &str,
) -> Result<bool, String> {
    database::db::with_sessions_writer(|| {
        let conn = database::db::get_connection().map_err(|error| error.to_string())?;
        conn.execute(
            "UPDATE agent_org_runtime_pause_handoffs
             SET continuation_status='dispatched',updated_at=?3
             WHERE episode_id=?1 AND continuation_turn_intent_id=?2
               AND continuation_status='queued'",
            params![episode_id, turn_intent_id, chrono::Utc::now().to_rfc3339()],
        )
        .map(|changed| changed == 1)
        .map_err(|error| error.to_string())
    })
}

/// Return a failed in-process dispatch to the durable queue. The exact base
/// intent must still be queued; once it starts or terminates, replaying it
/// would be unsafe.
pub(crate) fn requeue_continuation_dispatch(
    episode_id: &str,
    turn_intent_id: &str,
) -> Result<bool, String> {
    database::db::with_sessions_writer(|| {
        let conn = database::db::get_connection().map_err(|error| error.to_string())?;
        conn.execute(
            "UPDATE agent_org_runtime_pause_handoffs
             SET continuation_status='queued',updated_at=?3
             WHERE episode_id=?1 AND continuation_turn_intent_id=?2
               AND continuation_status='dispatched'
               AND EXISTS (
                 SELECT 1 FROM session_turn_intents intent
                 WHERE intent.session_id=agent_org_runtime_pause_handoffs.session_id
                   AND intent.turn_intent_id=?2 AND intent.status='queued'
               )",
            params![episode_id, turn_intent_id, chrono::Utc::now().to_rfc3339()],
        )
        .map(|changed| changed == 1)
        .map_err(|error| error.to_string())
    })
}

/// A process restart proves every pre-restart in-memory runtime is absent.
/// Keep timeout evidence, but unblock any durable continuation that was
/// correctly waiting for that old process-owned lease.
pub(crate) fn reconcile_runtime_absence_after_restart(conn: &Connection) -> Result<usize, String> {
    let now = chrono::Utc::now().to_rfc3339();
    let tx = database::db::begin_immediate(conn).map_err(|error| error.to_string())?;
    let runtime_rows = tx
        .execute(
            "UPDATE agent_org_runtime_pause_handoffs
         SET drain_status='runtime_absent',released_at=COALESCE(released_at,?1),updated_at=?1
         WHERE drain_status IN ('waiting','timed_out')",
            [&now],
        )
        .map_err(|error| error.to_string())?;
    // A claimed continuation may have crossed the scheduler boundary before
    // the process died. Requeue the same durable intent (never insert a new
    // continuation) so restart recovery is at-most-one by receipt while still
    // making progress from persisted Task/Inbox state.
    let intent_rows = tx
        .execute(
            "UPDATE session_turn_intents AS intent
             SET status='queued',updated_at=?1
             WHERE intent.status='running'
               AND EXISTS (
                 SELECT 1 FROM agent_org_runtime_pause_handoffs handoff
                 JOIN agent_org_runtime_pause_episodes episode
                   ON episode.episode_id=handoff.episode_id
                 JOIN agent_org_runtime_runs run ON run.id=handoff.org_run_id
                 WHERE handoff.session_id=intent.session_id
                   AND handoff.continuation_turn_intent_id=intent.turn_intent_id
                   AND handoff.continuation_status='dispatched'
                   AND episode.status='consumed'
                   AND run.status='running'
               )",
            [&now],
        )
        .map_err(|error| error.to_string())?;
    let dispatch_rows = tx
        .execute(
            "UPDATE agent_org_runtime_pause_handoffs
             SET continuation_status='queued',updated_at=?1
             WHERE continuation_status='dispatched'
               AND EXISTS (
                 SELECT 1 FROM session_turn_intents intent
                 WHERE intent.session_id=agent_org_runtime_pause_handoffs.session_id
                   AND intent.turn_intent_id=agent_org_runtime_pause_handoffs.continuation_turn_intent_id
                   AND intent.status='queued'
               )",
            [&now],
        )
        .map_err(|error| error.to_string())?;
    tx.commit().map_err(|error| error.to_string())?;
    Ok(runtime_rows + intent_rows + dispatch_rows)
}

fn validate_request_id(request_id: &str) -> Result<(), String> {
    uuid::Uuid::parse_str(request_id)
        .map(|_| ())
        .map_err(|_| "Pause/Resume request_id must be a UUID".to_string())
}

fn active_pause_outcome(
    conn: &Connection,
    run_id: &str,
) -> Result<Option<PauseRunOutcome>, String> {
    let request_id: Option<String> = conn
        .query_row(
            "SELECT pause_request_id FROM agent_org_runtime_pause_episodes
             WHERE org_run_id=?1 AND status='active'",
            [run_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    request_id
        .map(|request| pause_outcome_for_request(conn, run_id, &request, false))
        .transpose()
        .map(|value| value.flatten())
}

fn pause_outcome_for_request(
    conn: &Connection,
    run_id: &str,
    request_id: &str,
    transitioned: bool,
) -> Result<Option<PauseRunOutcome>, String> {
    conn.query_row(
        "SELECT episode.episode_id,episode.pause_generation,
                COUNT(handoff.handoff_id),
                COALESCE(SUM(CASE WHEN handoff.drain_status IN ('waiting','timed_out') THEN 1 ELSE 0 END),0),
                COALESCE(SUM(CASE WHEN handoff.drain_timeout_at IS NOT NULL THEN 1 ELSE 0 END),0)
         FROM agent_org_runtime_pause_episodes episode
         LEFT JOIN agent_org_runtime_pause_handoffs handoff ON handoff.episode_id=episode.episode_id
         WHERE episode.org_run_id=?1 AND episode.pause_request_id=?2
         GROUP BY episode.episode_id,episode.pause_generation",
        params![run_id, request_id],
        |row| {
            Ok(PauseRunOutcome {
                request_id: request_id.to_string(),
                run_id: run_id.to_string(),
                episode_id: row.get(0)?,
                transitioned,
                pause_generation: row.get(1)?,
                captured_turn_count: row.get::<_, i64>(2)? as usize,
                draining_turn_count: row.get::<_, i64>(3)? as usize,
                timed_out_turn_count: row.get::<_, i64>(4)? as usize,
            })
        },
    )
    .optional()
    .map_err(|error| error.to_string())
}

fn resume_outcome_for_request(
    conn: &Connection,
    run_id: &str,
    request_id: &str,
    transitioned: bool,
) -> Result<Option<ResumeRunOutcome>, String> {
    conn.query_row(
        "SELECT episode.episode_id,episode.resume_generation,
                COALESCE(SUM(CASE WHEN handoff.continuation_status IN ('queued','dispatched') THEN 1 ELSE 0 END),0),
                COALESCE(SUM(CASE WHEN handoff.continuation_status='skipped' THEN 1 ELSE 0 END),0)
         FROM agent_org_runtime_pause_episodes episode
         LEFT JOIN agent_org_runtime_pause_handoffs handoff ON handoff.episode_id=episode.episode_id
         WHERE episode.org_run_id=?1 AND episode.resume_request_id=?2
         GROUP BY episode.episode_id,episode.resume_generation",
        params![run_id, request_id],
        |row| {
            Ok(ResumeRunOutcome {
                request_id: request_id.to_string(),
                run_id: run_id.to_string(),
                episode_id: row.get(0)?,
                transitioned,
                resume_generation: row.get(1)?,
                continuation_count: row.get::<_, i64>(2)? as usize,
                skipped_count: row.get::<_, i64>(3)? as usize,
            })
        },
    )
    .optional()
    .map_err(|error| error.to_string())
}

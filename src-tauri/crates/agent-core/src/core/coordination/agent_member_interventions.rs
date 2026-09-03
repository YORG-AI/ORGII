//! Durable direct-user work and intervention receipts for Agent Org Members.
//!
//! The receipt is the authoritative handoff between a formal TaskExecution
//! and the Member's direct user-directed FIFO. It has no TTL: page changes,
//! elapsed time, and process restarts never imply Return to Work.

use rusqlite::{params, Connection, OptionalExtension, Result as SqliteResult};
use serde::Serialize;

use database::db::{get_connection, with_sessions_writer};

use super::agent_org_runs::AgentOrgRunStatus;
use super::agent_org_runs::COORDINATOR_MEMBER_ID;
use super::agent_org_turn_contexts::{self, AgentOrgTurnAdmission, AgentOrgTurnContext};
use crate::foundation::session_bridge::TurnIntentBridgeStatus;

mod persistence;

const ACTIVE_STATUSES_SQL: &str = "'yield_requested','active','return_requested'";
pub const DEFAULT_USER_DIRECTED_QUEUE_CAP: i64 = 32;

pub fn can_enter_member_intervention(member_id: &str) -> bool {
    member_id != COORDINATOR_MEMBER_ID
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MemberInterventionStatus {
    YieldRequested,
    Active,
    ReturnRequested,
    Cleared,
    Failed,
}

impl MemberInterventionStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::YieldRequested => "yield_requested",
            Self::Active => "active",
            Self::ReturnRequested => "return_requested",
            Self::Cleared => "cleared",
            Self::Failed => "failed",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "yield_requested" => Self::YieldRequested,
            "active" => Self::Active,
            "return_requested" => Self::ReturnRequested,
            "cleared" => Self::Cleared,
            "failed" => Self::Failed,
            _ => return None,
        })
    }

    pub fn is_active(self) -> bool {
        matches!(
            self,
            Self::YieldRequested | Self::Active | Self::ReturnRequested
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReturnToWorkOutcome {
    RestoredTask,
    ClearedPaused,
    ClearedIdle,
    NoLongerNeeded,
    AlreadyApplied,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AppliedReturnToWorkOutcome {
    RestoredTask,
    ClearedPaused,
    ClearedIdle,
    NoLongerNeeded,
}

impl AppliedReturnToWorkOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RestoredTask => "restored_task",
            Self::ClearedPaused => "cleared_paused",
            Self::ClearedIdle => "cleared_idle",
            Self::NoLongerNeeded => "no_longer_needed",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "restored_task" => Self::RestoredTask,
            "cleared_paused" => Self::ClearedPaused,
            "cleared_idle" => Self::ClearedIdle,
            "no_longer_needed" => Self::NoLongerNeeded,
            _ => return None,
        })
    }
}

impl From<AppliedReturnToWorkOutcome> for ReturnToWorkOutcome {
    fn from(value: AppliedReturnToWorkOutcome) -> Self {
        match value {
            AppliedReturnToWorkOutcome::RestoredTask => Self::RestoredTask,
            AppliedReturnToWorkOutcome::ClearedPaused => Self::ClearedPaused,
            AppliedReturnToWorkOutcome::ClearedIdle => Self::ClearedIdle,
            AppliedReturnToWorkOutcome::NoLongerNeeded => Self::NoLongerNeeded,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMemberInterventionRecord {
    pub intervention_receipt_id: String,
    pub org_run_id: String,
    pub member_id: String,
    pub agent_id: String,
    pub session_id: String,
    pub status: MemberInterventionStatus,
    pub source_event_id: String,
    pub original_task_id: Option<String>,
    pub original_turn_intent_id: Option<String>,
    pub original_member_dispatch_sequence: Option<i64>,
    pub runtime_lease_id: Option<String>,
    pub dialog_turn_generation: Option<String>,
    pub queued_user_directed_count: i64,
    pub entered_at: String,
    pub last_user_activity_at: String,
    pub yield_requested_at: Option<String>,
    pub yield_released_at: Option<String>,
    pub yield_timed_out_at: Option<String>,
    pub return_request_id: Option<String>,
    pub return_outcome: Option<AppliedReturnToWorkOutcome>,
    pub continuation_turn_intent_id: Option<String>,
    pub cleared_revision: Option<i64>,
    pub cleared_at: Option<String>,
    pub failure_reason: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct EnqueueUserDirectedWorkParams {
    pub org_run_id: String,
    pub session_id: String,
    pub member_id: String,
    pub turn_intent_id: String,
    pub client_message_id: Option<String>,
    pub source_event_id: String,
    pub dispatch_content: String,
    pub source_display_content: String,
    pub source_images: Option<Vec<String>>,
    pub queue_cap: i64,
}

#[derive(Debug, Clone)]
pub(crate) struct EnqueueUserDirectedWorkResult {
    pub context: AgentOrgTurnContext,
    pub intervention: AgentMemberInterventionRecord,
    /// Durable state of this exact chain Turn. Exact retries read this state
    /// back instead of asking the in-memory scheduler to enqueue it again.
    pub turn_status: String,
    pub should_request_yield: bool,
    pub duplicate: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct RecoverableUserDirectedWork {
    pub org_run_id: String,
    pub session_id: String,
    pub turn_intent_id: String,
    pub source_event_id: String,
    pub dispatch_content: String,
    pub display_content: String,
    pub images: Option<Vec<String>>,
    pub client_message_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReturnToWorkResult {
    pub outcome: ReturnToWorkOutcome,
    /// The durable business resolution. Unlike `outcome`, this remains the
    /// original four-way result when an exact request is replayed and
    /// `outcome` is `already_applied`.
    pub applied_outcome: AppliedReturnToWorkOutcome,
    pub had_original_formal_work: bool,
    pub intervention_receipt_id: String,
    pub request_id: String,
    pub cleared_revision: i64,
    pub cleared_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub continuation_turn_intent_id: Option<String>,
}

pub fn init_schema(conn: &Connection) -> SqliteResult<()> {
    create_schema(conn)
}

pub(crate) use persistence::create_schema;
use persistence::{get_by_receipt_with_connection, row_to_intervention, INTERVENTION_SELECT};

pub struct AgentMemberInterventionStore;

impl AgentMemberInterventionStore {
    /// Atomically accept a DirectMember source, allocate its one Member FIFO
    /// sequence, and append it to exactly one durable intervention chain.
    pub(crate) fn enqueue_user_directed_work(
        params: EnqueueUserDirectedWorkParams,
    ) -> Result<EnqueueUserDirectedWorkResult, String> {
        if !can_enter_member_intervention(&params.member_id) {
            return Err(
                "user_directed_target_invalid: canonical Root is not a Member direct target"
                    .to_string(),
            );
        }
        if params.source_display_content.trim().is_empty() {
            return Err("user_directed_source_invalid: direct content is empty".to_string());
        }
        if params.dispatch_content.trim().is_empty() {
            return Err("user_directed_source_invalid: dispatch content is empty".to_string());
        }
        let queue_cap = if params.queue_cap > 0 {
            params.queue_cap
        } else {
            DEFAULT_USER_DIRECTED_QUEUE_CAP
        };

        let result = with_sessions_writer(|| -> Result<EnqueueUserDirectedWorkResult, String> {
            let mut conn = get_connection().map_err(|error| error.to_string())?;
            let tx = conn
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .map_err(|error| error.to_string())?;
            validate_direct_source(&tx, &params)?;

            let existing_chain: Option<(String, i64, String, String, String)> = tx
                .query_row(
                    "SELECT intervention_receipt_id,member_dispatch_sequence,
                            dispatch_content,display_content,status
                     FROM agent_org_runtime_member_intervention_turns
                     WHERE session_id=?1 AND turn_intent_id=?2",
                    params![&params.session_id, &params.turn_intent_id],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                        ))
                    },
                )
                .optional()
                .map_err(|error| error.to_string())?;

            if existing_chain.is_none() {
                let queued_count: i64 = tx
                    .query_row(
                        "SELECT COUNT(*)
                         FROM agent_org_runtime_turn_contexts context
                         JOIN session_turn_intents intent
                           ON intent.session_id=context.session_id
                          AND intent.turn_intent_id=context.turn_intent_id
                         WHERE context.org_run_id=?1
                           AND context.dispatch_member_id=?2
                           AND context.turn_kind='user_directed_work'
                           AND intent.status IN ('queued','running')",
                        params![&params.org_run_id, &params.member_id],
                        |row| row.get(0),
                    )
                    .map_err(|error| error.to_string())?;
                if queued_count >= queue_cap {
                    return Err(format!(
                        "user_directed_queue_full: Member {} already has {queued_count} queued/running direct Turns (cap {queue_cap})",
                        params.member_id
                    ));
                }
            }

            let admission = AgentOrgTurnAdmission::direct_member(
                &params.org_run_id,
                &params.session_id,
                &params.turn_intent_id,
                params.client_message_id.clone(),
                &params.member_id,
                &params.source_event_id,
            );
            let context = agent_org_turn_contexts::accept_with_connection(&tx, &admission)?;
            let sequence = context.member_dispatch_sequence.ok_or_else(|| {
                "agent_org_turn_context_invalid: UserDirectedWork has no Member FIFO sequence"
                    .to_string()
            })?;

            if let Some((
                receipt_id,
                existing_sequence,
                existing_dispatch_content,
                existing_display_content,
                existing_status,
            )) = existing_chain
            {
                if existing_sequence != sequence
                    || existing_dispatch_content != params.dispatch_content
                    || existing_display_content != params.source_display_content
                {
                    return Err(
                        "user_directed_replay_conflict: Member sequence or content changed"
                            .to_string(),
                    );
                }
                let intervention =
                    get_by_receipt_with_connection(&tx, &receipt_id)?.ok_or_else(|| {
                        "user_directed_replay_conflict: receipt disappeared".to_string()
                    })?;
                tx.commit().map_err(|error| error.to_string())?;
                return Ok(EnqueueUserDirectedWorkResult {
                    context,
                    should_request_yield: false,
                    intervention,
                    turn_status: existing_status,
                    duplicate: true,
                });
            }

            let active_receipt_id: Option<String> = tx
                .query_row(
                    &format!(
                        "SELECT intervention_receipt_id
                         FROM agent_org_runtime_member_interventions
                         WHERE org_run_id=?1 AND member_id=?2
                           AND status IN ({ACTIVE_STATUSES_SQL})"
                    ),
                    params![&params.org_run_id, &params.member_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| error.to_string())?;

            let now = chrono::Utc::now().to_rfc3339();
            let (receipt_id, should_request_yield) = match active_receipt_id {
                Some(receipt_id) => (receipt_id, false),
                None => {
                    let original = running_formal_turn(&tx, &params)?;
                    let agent_id: String = tx
                        .query_row(
                            "SELECT agent_id
                             FROM agent_org_runtime_member_materializations
                             WHERE org_run_id=?1 AND member_id=?2 AND session_id=?3
                               AND status='succeeded'
                             ORDER BY generation DESC LIMIT 1",
                            params![&params.org_run_id, &params.member_id, &params.session_id],
                            |row| row.get(0),
                        )
                        .map_err(|error| error.to_string())?;
                    let receipt_id = format!("intervention_{}", uuid::Uuid::new_v4());
                    let status = if original.is_some() {
                        MemberInterventionStatus::YieldRequested
                    } else {
                        MemberInterventionStatus::Active
                    };
                    let (task_id, turn_id, original_sequence) = original
                        .clone()
                        .map(|value| (Some(value.0), Some(value.1), Some(value.2)))
                        .unwrap_or((None, None, None));
                    tx.execute(
                        "INSERT INTO agent_org_runtime_member_interventions (
                            intervention_receipt_id,org_run_id,member_id,agent_id,session_id,
                            status,source_event_id,original_task_id,original_turn_intent_id,
                            original_member_dispatch_sequence,entered_at,last_user_activity_at,
                            yield_requested_at,updated_at
                         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?11,?12,?11)",
                        params![
                            &receipt_id,
                            &params.org_run_id,
                            &params.member_id,
                            &agent_id,
                            &params.session_id,
                            status.as_str(),
                            &params.source_event_id,
                            task_id.as_deref(),
                            turn_id.as_deref(),
                            original_sequence,
                            &now,
                            original.as_ref().map(|_| now.as_str()),
                        ],
                    )
                    .map_err(|error| error.to_string())?;
                    (receipt_id, original.is_some())
                }
            };

            let chain_position: i64 = tx
                .query_row(
                    "SELECT COALESCE(MAX(chain_position),0)+1
                     FROM agent_org_runtime_member_intervention_turns
                     WHERE intervention_receipt_id=?1",
                    [&receipt_id],
                    |row| row.get(0),
                )
                .map_err(|error| error.to_string())?;
            tx.execute(
                "INSERT INTO agent_org_runtime_member_intervention_turns (
                    intervention_receipt_id,session_id,turn_intent_id,source_event_id,
                    dispatch_content,display_content,member_dispatch_sequence,
                    chain_position,status,enqueued_at
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'queued',?9)",
                params![
                    &receipt_id,
                    &params.session_id,
                    &params.turn_intent_id,
                    &params.source_event_id,
                    &params.dispatch_content,
                    &params.source_display_content,
                    sequence,
                    chain_position,
                    &now,
                ],
            )
            .map_err(|error| error.to_string())?;
            tx.execute(
                "UPDATE agent_org_runtime_member_interventions
                 SET last_user_activity_at=?2,updated_at=?2
                 WHERE intervention_receipt_id=?1",
                params![&receipt_id, &now],
            )
            .map_err(|error| error.to_string())?;

            let intervention = get_by_receipt_with_connection(&tx, &receipt_id)?
                .ok_or_else(|| "accepted intervention receipt disappeared".to_string())?;
            tx.commit().map_err(|error| error.to_string())?;
            Ok(EnqueueUserDirectedWorkResult {
                context,
                intervention,
                turn_status: "queued".to_string(),
                should_request_yield,
                duplicate: false,
            })
        })?;

        crate::coordination::agent_org_run_events::notify_agent_org_run_changed(
            &result.intervention.org_run_id,
        );
        Ok(result)
    }

    pub fn bind_runtime_and_request_yield(
        receipt_id: &str,
        original_turn_intent_id: &str,
        runtime_lease_id: &str,
        dialog_turn_generation: &str,
    ) -> Result<bool, String> {
        with_sessions_writer(|| {
            let conn = get_connection().map_err(|error| error.to_string())?;
            let now = chrono::Utc::now().to_rfc3339();
            conn.execute(
                "UPDATE agent_org_runtime_member_interventions
                 SET runtime_lease_id=?3,dialog_turn_generation=?4,
                     yield_requested_at=COALESCE(yield_requested_at,?5),updated_at=?5
                 WHERE intervention_receipt_id=?1
                   AND original_turn_intent_id=?2
                   AND status='yield_requested'
                   AND runtime_lease_id IS NULL",
                params![
                    receipt_id,
                    original_turn_intent_id,
                    runtime_lease_id,
                    dialog_turn_generation,
                    now,
                ],
            )
            .map(|count| count == 1)
            .map_err(|error| error.to_string())
        })
    }

    pub fn bound_receipt_for_runtime(
        session_id: &str,
        original_turn_intent_id: &str,
        runtime_lease_id: &str,
        dialog_turn_generation: &str,
    ) -> Result<Option<String>, String> {
        let conn = get_connection().map_err(|error| error.to_string())?;
        conn.query_row(
            "SELECT intervention_receipt_id
             FROM agent_org_runtime_member_interventions
             WHERE session_id=?1 AND original_turn_intent_id=?2
               AND runtime_lease_id=?3 AND dialog_turn_generation=?4
               AND status='yield_requested'",
            params![
                session_id,
                original_turn_intent_id,
                runtime_lease_id,
                dialog_turn_generation,
            ],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())
    }

    pub fn receipt_for_original_turn(
        session_id: &str,
        original_turn_intent_id: &str,
    ) -> Result<Option<String>, String> {
        let conn = get_connection().map_err(|error| error.to_string())?;
        conn.query_row(
            "SELECT intervention_receipt_id
             FROM agent_org_runtime_member_interventions
             WHERE session_id=?1 AND original_turn_intent_id=?2
               AND status='yield_requested'",
            params![session_id, original_turn_intent_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())
    }

    pub fn open_receipt_for_original_turn(
        session_id: &str,
        original_turn_intent_id: &str,
    ) -> Result<Option<String>, String> {
        let conn = get_connection().map_err(|error| error.to_string())?;
        conn.query_row(
            "SELECT intervention_receipt_id
             FROM agent_org_runtime_member_interventions
             WHERE session_id=?1 AND original_turn_intent_id=?2
               AND status IN ('yield_requested','active','return_requested')",
            params![session_id, original_turn_intent_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())
    }

    pub fn mark_yield_released(
        receipt_id: &str,
        runtime_lease_id: &str,
        dialog_turn_generation: &str,
    ) -> Result<bool, String> {
        let changed = with_sessions_writer(|| {
            let conn = get_connection().map_err(|error| error.to_string())?;
            let now = chrono::Utc::now().to_rfc3339();
            conn.execute(
                "UPDATE agent_org_runtime_member_interventions
                 SET status='active',yield_released_at=?4,
                     yield_timed_out_at=CASE
                       WHEN yield_requested_at IS NOT NULL
                        AND (unixepoch(?4)-unixepoch(yield_requested_at))>=10
                       THEN COALESCE(yield_timed_out_at,?4)
                       ELSE yield_timed_out_at
                     END,
                     updated_at=?4
                 WHERE intervention_receipt_id=?1 AND status='yield_requested'
                   AND runtime_lease_id=?2 AND dialog_turn_generation=?3",
                params![receipt_id, runtime_lease_id, dialog_turn_generation, now],
            )
            .map(|count| count == 1)
            .map_err(|error| error.to_string())
        })?;
        if changed {
            notify_run_for_receipt(receipt_id);
            if let Ok(Some(record)) = Self::get_by_receipt(receipt_id) {
                let suspend_ms = record
                    .yield_requested_at
                    .as_deref()
                    .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
                    .map(|started| {
                        chrono::Utc::now()
                            .signed_duration_since(started.with_timezone(&chrono::Utc))
                            .num_milliseconds()
                            .max(0)
                    });
                tracing::info!(
                    event = "agent_org_user_directed_yield_released",
                    org_run_id = %record.org_run_id,
                    session_id = %record.session_id,
                    intervention_receipt_id = %record.intervention_receipt_id,
                    suspend_ms = ?suspend_ms,
                    slo_exceeded = suspend_ms.is_some_and(|value| value > 5_000),
                    hard_wait_exceeded = suspend_ms.is_some_and(|value| value > 10_000),
                    "released the exact formal runtime for direct work"
                );
            }
        }
        Ok(changed)
    }

    pub fn mark_yield_timeout(receipt_id: &str) -> Result<bool, String> {
        let changed = with_sessions_writer(|| {
            let conn = get_connection().map_err(|error| error.to_string())?;
            let now = chrono::Utc::now().to_rfc3339();
            conn.execute(
                "UPDATE agent_org_runtime_member_interventions
                 SET yield_timed_out_at=COALESCE(yield_timed_out_at,?2),updated_at=?2
                 WHERE intervention_receipt_id=?1 AND status='yield_requested'",
                params![receipt_id, now],
            )
            .map(|count| count == 1)
            .map_err(|error| error.to_string())
        })?;
        if changed {
            notify_run_for_receipt(receipt_id);
        }
        Ok(changed)
    }

    pub fn mark_turn_running(session_id: &str, turn_intent_id: &str) -> Result<bool, String> {
        let changed = with_sessions_writer(|| {
            let conn = get_connection().map_err(|error| error.to_string())?;
            Self::mark_turn_running_with_connection(&conn, session_id, turn_intent_id)
        })?;
        if changed {
            notify_run_for_turn(session_id, turn_intent_id);
        }
        Ok(changed)
    }

    pub(crate) fn mark_turn_running_with_connection(
        conn: &Connection,
        session_id: &str,
        turn_intent_id: &str,
    ) -> Result<bool, String> {
        let now = chrono::Utc::now().to_rfc3339();
        let changed = conn
            .execute(
                "UPDATE agent_org_runtime_member_intervention_turns AS chain
                 SET status='running',started_at=COALESCE(started_at,?3)
                 WHERE chain.session_id=?1 AND chain.turn_intent_id=?2
                   AND chain.status='queued'
                   AND EXISTS (
                       SELECT 1 FROM agent_org_runtime_member_interventions intervention
                       WHERE intervention.intervention_receipt_id=chain.intervention_receipt_id
                         AND intervention.status='active'
                   )
                   AND NOT EXISTS (
                       SELECT 1 FROM agent_org_runtime_member_intervention_turns earlier
                       WHERE earlier.intervention_receipt_id=chain.intervention_receipt_id
                         AND earlier.member_dispatch_sequence<chain.member_dispatch_sequence
                         AND earlier.status IN ('queued','running')
                   )",
                params![session_id, turn_intent_id, now],
            )
            .map_err(|error| error.to_string())?;
        if changed == 0 {
            conn.execute(
                "UPDATE session_turn_intents SET status='queued',updated_at=?3
                 WHERE session_id=?1 AND turn_intent_id=?2 AND status='running'",
                params![session_id, turn_intent_id, chrono::Utc::now().to_rfc3339()],
            )
            .map_err(|error| error.to_string())?;
        }
        Ok(changed == 1)
    }

    pub fn mark_turn_terminal(
        session_id: &str,
        turn_intent_id: &str,
        status: &str,
        failure_reason: Option<&str>,
    ) -> Result<bool, String> {
        if !matches!(status, "completed" | "failed" | "cancelled" | "abandoned") {
            return Err(format!("invalid UserDirectedWork terminal status {status}"));
        }
        let changed = update_chain_status(session_id, turn_intent_id, status, failure_reason)?;
        if changed {
            notify_run_for_turn(session_id, turn_intent_id);
        }
        Ok(changed)
    }

    /// Read pending direct Turns that never began Provider execution. Startup
    /// may enqueue these exact identities again; running/abandoned rows are
    /// intentionally excluded because their side effects are not replayable.
    pub(crate) fn recoverable_queued_turns(
        limit: usize,
    ) -> Result<Vec<RecoverableUserDirectedWork>, String> {
        let conn = get_connection().map_err(|error| error.to_string())?;
        let mut statement = conn
            .prepare(
                "SELECT context.org_run_id,chain.session_id,chain.turn_intent_id,
                        chain.source_event_id,chain.dispatch_content,
                        chain.display_content,intent.client_message_id,event.result_json
                 FROM agent_org_runtime_member_intervention_turns chain
                 JOIN agent_org_runtime_member_interventions intervention
                   ON intervention.intervention_receipt_id=chain.intervention_receipt_id
                 JOIN agent_org_runtime_turn_contexts context
                   ON context.session_id=chain.session_id
                  AND context.turn_intent_id=chain.turn_intent_id
                 JOIN session_turn_intents intent
                   ON intent.session_id=chain.session_id
                  AND intent.turn_intent_id=chain.turn_intent_id
                 JOIN events event
                   ON event.id=chain.source_event_id
                  AND event.session_id=chain.session_id
                 JOIN agent_org_runtime_runs run ON run.id=context.org_run_id
                 WHERE chain.status='queued' AND intent.status='queued'
                   AND context.turn_kind='user_directed_work'
                   AND context.source_kind='direct_member'
                   AND intervention.status IN ('yield_requested','active','return_requested')
                   AND run.status IN ('running','idle','paused')
                 ORDER BY context.org_run_id,context.member_dispatch_sequence
                 LIMIT ?1",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([limit as i64], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, String>(7)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        let mut recovered = Vec::new();
        for row in rows {
            let (
                org_run_id,
                session_id,
                turn_intent_id,
                source_event_id,
                dispatch_content,
                display_content,
                client_message_id,
                source_result_json,
            ) = row.map_err(|error| error.to_string())?;
            let source_result: serde_json::Value = serde_json::from_str(&source_result_json)
                .map_err(|error| {
                    format!(
                        "user_directed_source_invalid: bad recovery source JSON for {source_event_id}: {error}"
                    )
                })?;
            recovered.push(RecoverableUserDirectedWork {
                org_run_id,
                session_id,
                turn_intent_id,
                source_event_id,
                dispatch_content,
                display_content,
                images: direct_source_images(&source_result)?,
                client_message_id,
            });
        }
        Ok(recovered)
    }

    pub(crate) fn requeue_direct_after_recovery_enqueue_failure(
        session_id: &str,
        turn_intent_id: &str,
    ) -> Result<bool, String> {
        with_sessions_writer(|| {
            let conn = get_connection().map_err(|error| error.to_string())?;
            let changed = conn
                .execute(
                    "UPDATE session_turn_intents AS intent
                     SET status='queued',updated_at=?3
                     WHERE intent.session_id=?1 AND intent.turn_intent_id=?2
                       AND intent.status='rejected'
                       AND EXISTS (
                           SELECT 1
                           FROM agent_org_runtime_member_intervention_turns chain
                           JOIN agent_org_runtime_member_interventions intervention
                             ON intervention.intervention_receipt_id=chain.intervention_receipt_id
                           WHERE chain.session_id=intent.session_id
                             AND chain.turn_intent_id=intent.turn_intent_id
                             AND chain.status='queued'
                             AND intervention.status IN ('yield_requested','active','return_requested')
                       )",
                    params![
                        session_id,
                        turn_intent_id,
                        chrono::Utc::now().to_rfc3339()
                    ],
                )
                .map_err(|error| error.to_string())?;
            Ok(changed == 1)
        })
    }

    /// Cancel exactly the oldest queued direct Turn for one Session. The
    /// intervention receipt deliberately remains active: Stop is not Return.
    pub fn cancel_next_queued_turn(session_id: &str) -> Result<Option<String>, String> {
        let cancelled = with_sessions_writer(|| {
            let mut conn = get_connection().map_err(|error| error.to_string())?;
            let tx = conn
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .map_err(|error| error.to_string())?;
            let turn_intent_id: Option<String> = tx
                .query_row(
                    "SELECT chain.turn_intent_id
                     FROM agent_org_runtime_member_intervention_turns chain
                     JOIN agent_org_runtime_member_interventions intervention
                       ON intervention.intervention_receipt_id=chain.intervention_receipt_id
                     WHERE chain.session_id=?1 AND chain.status='queued'
                       AND intervention.status IN ('yield_requested','active','return_requested')
                     ORDER BY chain.member_dispatch_sequence ASC LIMIT 1",
                    [session_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| error.to_string())?;
            let Some(turn_intent_id) = turn_intent_id else {
                tx.commit().map_err(|error| error.to_string())?;
                return Ok(None);
            };
            let now = chrono::Utc::now().to_rfc3339();
            let changed = tx
                .execute(
                    "UPDATE agent_org_runtime_member_intervention_turns
                     SET status='cancelled',terminal_at=?3,failure_reason='user_stop'
                     WHERE session_id=?1 AND turn_intent_id=?2 AND status='queued'",
                    params![session_id, &turn_intent_id, &now],
                )
                .map_err(|error| error.to_string())?;
            if changed != 1 {
                return Err("user_directed_stop_conflict: queued Turn changed".to_string());
            }
            tx.execute(
                "UPDATE session_turn_intents SET status='cancelled',updated_at=?3
                 WHERE session_id=?1 AND turn_intent_id=?2 AND status IN ('queued','running')",
                params![session_id, &turn_intent_id, &now],
            )
            .map_err(|error| error.to_string())?;
            tx.commit().map_err(|error| error.to_string())?;
            Ok(Some(turn_intent_id))
        })?;
        if let Some(turn_intent_id) = cancelled.as_deref() {
            notify_run_for_turn(session_id, turn_intent_id);
        }
        Ok(cancelled)
    }

    /// Persist cancellation for one exact direct Turn before signalling the
    /// in-memory scheduler. This closes the dequeue-to-begin-turn race: even
    /// if the worker has claimed the message, Provider execution cannot start
    /// from a chain row that is already terminal.
    pub fn cancel_turn(session_id: &str, turn_intent_id: &str) -> Result<bool, String> {
        let (handled, terminalized) = with_sessions_writer(|| -> Result<(bool, bool), String> {
            let mut conn = get_connection().map_err(|error| error.to_string())?;
            let tx = conn
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .map_err(|error| error.to_string())?;
            let status: Option<String> = tx
                .query_row(
                    "SELECT chain.status
                     FROM agent_org_runtime_member_intervention_turns chain
                     JOIN agent_org_runtime_member_interventions intervention
                       ON intervention.intervention_receipt_id=chain.intervention_receipt_id
                     WHERE chain.session_id=?1 AND chain.turn_intent_id=?2
                       AND chain.status IN ('queued','running')
                       AND intervention.status IN ('yield_requested','active','return_requested')",
                    params![session_id, turn_intent_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| error.to_string())?;
            let Some(status) = status else {
                tx.commit().map_err(|error| error.to_string())?;
                return Ok((false, false));
            };
            if status == "running" {
                // The provider/tool loop now owns terminal evidence. Keep the
                // chain nonterminal until cancellation actually reaches its
                // finalizer so Return cannot race still-running side effects.
                tx.commit().map_err(|error| error.to_string())?;
                return Ok((true, false));
            }
            let now = chrono::Utc::now().to_rfc3339();
            let changed = tx
                .execute(
                    "UPDATE agent_org_runtime_member_intervention_turns
                     SET status='cancelled',terminal_at=?3,failure_reason='user_stop'
                     WHERE session_id=?1 AND turn_intent_id=?2
                       AND status IN ('queued','running')",
                    params![session_id, turn_intent_id, &now],
                )
                .map_err(|error| error.to_string())?;
            if changed == 1 {
                tx.execute(
                    "UPDATE session_turn_intents SET status='cancelled',updated_at=?3
                     WHERE session_id=?1 AND turn_intent_id=?2
                       AND status IN ('queued','running')",
                    params![session_id, turn_intent_id, &now],
                )
                .map_err(|error| error.to_string())?;
            }
            tx.commit().map_err(|error| error.to_string())?;
            Ok((changed == 1, changed == 1))
        })?;
        if terminalized {
            notify_run_for_turn(session_id, turn_intent_id);
        }
        Ok(handled)
    }

    /// Apply one idempotent Return to Work transition. The receipt id and
    /// request id are both mandatory; Session alone is never sufficient
    /// authority to clear whichever intervention happens to be current.
    pub fn return_to_work(
        session_id: &str,
        receipt_id: &str,
        request_id: &str,
    ) -> Result<ReturnToWorkResult, String> {
        if request_id.trim().is_empty() {
            return Err("return_request_invalid: requestId is required".to_string());
        }
        let result = with_sessions_writer(|| -> Result<ReturnToWorkResult, String> {
            let mut conn = get_connection().map_err(|error| error.to_string())?;
            let tx = conn
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .map_err(|error| error.to_string())?;
            let receipt = get_by_receipt_with_connection(&tx, receipt_id)?
                .ok_or_else(|| format!("intervention_receipt_not_found: {receipt_id}"))?;
            if receipt.session_id != session_id {
                return Err(
                    "return_request_invalid: receipt belongs to another Session".to_string()
                );
            }
            if !receipt.status.is_active() {
                if receipt.return_request_id.as_deref() == Some(request_id) {
                    let applied_outcome = receipt.return_outcome.ok_or_else(|| {
                        "return_receipt_corrupt: applied Return has no durable outcome".to_string()
                    })?;
                    let cleared_revision = receipt.cleared_revision.ok_or_else(|| {
                        "return_receipt_corrupt: applied Return has no cleared revision".to_string()
                    })?;
                    let cleared_at = receipt.cleared_at.ok_or_else(|| {
                        "return_receipt_corrupt: applied Return has no cleared time".to_string()
                    })?;
                    tx.commit().map_err(|error| error.to_string())?;
                    return Ok(ReturnToWorkResult {
                        outcome: ReturnToWorkOutcome::AlreadyApplied,
                        applied_outcome,
                        had_original_formal_work: receipt.original_task_id.is_some()
                            && receipt.original_turn_intent_id.is_some(),
                        intervention_receipt_id: receipt_id.to_string(),
                        request_id: request_id.to_string(),
                        cleared_revision,
                        cleared_at,
                        continuation_turn_intent_id: receipt.continuation_turn_intent_id,
                    });
                }
                return Err(
                    "intervention_no_longer_active: receipt was already cleared".to_string()
                );
            }

            let active_direct_count: i64 = tx
                .query_row(
                    "SELECT COUNT(*)
                     FROM agent_org_runtime_member_intervention_turns
                     WHERE intervention_receipt_id=?1 AND status IN ('queued','running')",
                    [receipt_id],
                    |row| row.get(0),
                )
                .map_err(|error| error.to_string())?;
            if active_direct_count > 0 {
                return Err(format!(
                    "user_directed_work_active: {active_direct_count} direct Turn(s) must finish or Stop before Return"
                ));
            }
            if receipt.status == MemberInterventionStatus::YieldRequested {
                return Err(
                    "user_directed_handoff_pending: wait for the original Turn to yield before Return"
                        .to_string(),
                );
            }

            let run: Option<(String, i64)> = tx
                .query_row(
                    "SELECT status,activation_generation
                     FROM agent_org_runtime_runs WHERE id=?1",
                    [&receipt.org_run_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(|error| error.to_string())?;
            let (run_status_raw, activation_generation) =
                run.ok_or_else(|| "return_request_invalid: Team no longer exists".to_string())?;
            let run_status = AgentOrgRunStatus::parse(&run_status_raw).ok_or_else(|| {
                format!("return_request_invalid: unknown Team status {run_status_raw}")
            })?;

            tx.execute(
                "UPDATE agent_org_runtime_member_interventions
                 SET status='return_requested',return_request_id=?2,updated_at=?3
                 WHERE intervention_receipt_id=?1
                   AND status IN ('yield_requested','active','return_requested')",
                params![receipt_id, request_id, chrono::Utc::now().to_rfc3339()],
            )
            .map_err(|error| error.to_string())?;

            let mut continuation_turn_intent_id = None;
            let outcome = match run_status {
                AgentOrgRunStatus::Paused => AppliedReturnToWorkOutcome::ClearedPaused,
                AgentOrgRunStatus::Idle => AppliedReturnToWorkOutcome::ClearedIdle,
                AgentOrgRunStatus::Starting
                | AgentOrgRunStatus::Failed
                | AgentOrgRunStatus::Archived => AppliedReturnToWorkOutcome::NoLongerNeeded,
                AgentOrgRunStatus::Running => {
                    match (
                        receipt.original_task_id.as_deref(),
                        receipt.original_turn_intent_id.as_deref(),
                    ) {
                        (Some(task_id), Some(_)) => {
                            let still_owned_open: bool = tx
                                .query_row(
                                    "SELECT EXISTS(
                                         SELECT 1 FROM agent_org_runtime_tasks
                                         WHERE org_run_id=?1 AND id=?2 AND owner=?3
                                           AND status IN ('pending','in_progress')
                                     )",
                                    params![&receipt.org_run_id, task_id, &receipt.member_id],
                                    |row| row.get(0),
                                )
                                .map_err(|error| error.to_string())?;
                            if still_owned_open {
                                let continuation_id =
                                    format!("udw_return_{}", uuid::Uuid::new_v4());
                                let admission = AgentOrgTurnAdmission::task_continuation(
                                    &receipt.org_run_id,
                                    &receipt.session_id,
                                    &continuation_id,
                                    Some(format!("udw-return:{receipt_id}")),
                                    task_id,
                                    &receipt.member_id,
                                    activation_generation,
                                );
                                agent_org_turn_contexts::accept_with_connection(&tx, &admission)?;
                                continuation_turn_intent_id = Some(continuation_id);
                                AppliedReturnToWorkOutcome::RestoredTask
                            } else {
                                AppliedReturnToWorkOutcome::NoLongerNeeded
                            }
                        }
                        _ => AppliedReturnToWorkOutcome::NoLongerNeeded,
                    }
                }
            };

            let cleared_revision: i64 = tx
                .query_row(
                    "SELECT COALESCE(MAX(cleared_revision),0)+1
                     FROM agent_org_runtime_member_interventions WHERE org_run_id=?1",
                    [&receipt.org_run_id],
                    |row| row.get(0),
                )
                .map_err(|error| error.to_string())?;
            let now = chrono::Utc::now().to_rfc3339();
            let updated = tx
                .execute(
                    "UPDATE agent_org_runtime_member_interventions
                     SET status='cleared',return_outcome=?3,
                         continuation_turn_intent_id=?4,cleared_revision=?5,
                         cleared_at=?6,updated_at=?6
                     WHERE intervention_receipt_id=?1 AND return_request_id=?2
                       AND status='return_requested'",
                    params![
                        receipt_id,
                        request_id,
                        outcome.as_str(),
                        continuation_turn_intent_id.as_deref(),
                        cleared_revision,
                        now,
                    ],
                )
                .map_err(|error| error.to_string())?;
            if updated != 1 {
                return Err("return_request_conflict: receipt changed concurrently".to_string());
            }
            tx.commit().map_err(|error| error.to_string())?;
            Ok(ReturnToWorkResult {
                outcome: outcome.into(),
                applied_outcome: outcome,
                had_original_formal_work: receipt.original_task_id.is_some()
                    && receipt.original_turn_intent_id.is_some(),
                intervention_receipt_id: receipt_id.to_string(),
                request_id: request_id.to_string(),
                cleared_revision,
                cleared_at: now,
                continuation_turn_intent_id,
            })
        })?;
        if let Some(record) = Self::get_by_receipt(receipt_id)? {
            crate::coordination::agent_org_run_events::notify_agent_org_run_changed(
                &record.org_run_id,
            );
        }
        Ok(result)
    }

    pub fn continuation_is_dispatchable(
        session_id: &str,
        turn_intent_id: &str,
    ) -> Result<bool, String> {
        let conn = get_connection().map_err(|error| error.to_string())?;
        conn.query_row(
            "SELECT EXISTS(
                 SELECT 1
                 FROM agent_org_runtime_member_interventions intervention
                 JOIN session_turn_intents intent
                   ON intent.session_id=intervention.session_id
                  AND intent.turn_intent_id=intervention.continuation_turn_intent_id
                 WHERE intervention.session_id=?1
                   AND intervention.continuation_turn_intent_id=?2
                   AND intervention.status='cleared'
                   AND intervention.return_outcome='restored_task'
                   AND intent.status=?3
             )",
            params![
                session_id,
                turn_intent_id,
                TurnIntentBridgeStatus::Queued.as_str()
            ],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())
    }

    /// One-shot startup recovery for Return transactions that committed their
    /// unique continuation before the in-memory FIFO accepted it.
    pub(crate) fn dispatchable_return_continuations(
        limit: usize,
    ) -> Result<Vec<AgentMemberInterventionRecord>, String> {
        let conn = get_connection().map_err(|error| error.to_string())?;
        let mut statement = conn
            .prepare(&format!(
                "{INTERVENTION_SELECT}
                 JOIN session_turn_intents intent
                   ON intent.session_id=intervention.session_id
                  AND intent.turn_intent_id=intervention.continuation_turn_intent_id
                 WHERE intervention.status='cleared'
                   AND intervention.return_outcome='restored_task'
                   AND intent.status='queued'
                 ORDER BY intervention.cleared_revision,intervention.intervention_receipt_id
                 LIMIT ?1"
            ))
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([limit as i64], row_to_intervention)
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }

    pub(crate) fn requeue_return_continuation_after_enqueue_failure(
        session_id: &str,
        turn_intent_id: &str,
    ) -> Result<bool, String> {
        with_sessions_writer(|| {
            let conn = get_connection().map_err(|error| error.to_string())?;
            let changed = conn
                .execute(
                    "UPDATE session_turn_intents AS intent
                     SET status='queued',updated_at=?3
                     WHERE intent.session_id=?1 AND intent.turn_intent_id=?2
                       AND intent.status='rejected'
                       AND EXISTS (
                           SELECT 1 FROM agent_org_runtime_member_interventions intervention
                           WHERE intervention.session_id=intent.session_id
                             AND intervention.continuation_turn_intent_id=intent.turn_intent_id
                             AND intervention.status='cleared'
                             AND intervention.return_outcome='restored_task'
                       )",
                    params![session_id, turn_intent_id, chrono::Utc::now().to_rfc3339()],
                )
                .map_err(|error| error.to_string())?;
            Ok(changed == 1)
        })
    }

    pub fn get_by_receipt(
        receipt_id: &str,
    ) -> Result<Option<AgentMemberInterventionRecord>, String> {
        let conn = get_connection().map_err(|error| error.to_string())?;
        get_by_receipt_with_connection(&conn, receipt_id)
    }

    pub fn get(
        org_run_id: &str,
        member_id: &str,
    ) -> Result<Option<AgentMemberInterventionRecord>, String> {
        let conn = get_connection().map_err(|error| error.to_string())?;
        conn.query_row(
            &format!(
                "{INTERVENTION_SELECT}
                 WHERE intervention.org_run_id=?1 AND intervention.member_id=?2
                 ORDER BY intervention.entered_at DESC LIMIT 1"
            ),
            params![org_run_id, member_id],
            row_to_intervention,
        )
        .optional()
        .map_err(|error| error.to_string())
    }

    pub fn active_for_member(
        org_run_id: &str,
        member_id: &str,
    ) -> Result<Option<AgentMemberInterventionRecord>, String> {
        if member_id == COORDINATOR_MEMBER_ID {
            return Ok(None);
        }
        let conn = get_connection().map_err(|error| error.to_string())?;
        conn.query_row(
            &format!(
                "{INTERVENTION_SELECT}
                 WHERE intervention.org_run_id=?1 AND intervention.member_id=?2
                   AND intervention.status IN ({ACTIVE_STATUSES_SQL})"
            ),
            params![org_run_id, member_id],
            row_to_intervention,
        )
        .optional()
        .map_err(|error| error.to_string())
    }

    pub fn active_for_session(
        session_id: &str,
    ) -> Result<Option<AgentMemberInterventionRecord>, String> {
        let conn = get_connection().map_err(|error| error.to_string())?;
        conn.query_row(
            &format!(
                "{INTERVENTION_SELECT}
                 WHERE intervention.session_id=?1
                   AND intervention.status IN ({ACTIVE_STATUSES_SQL})
                 ORDER BY intervention.updated_at DESC LIMIT 1"
            ),
            [session_id],
            row_to_intervention,
        )
        .optional()
        .map_err(|error| error.to_string())
    }

    pub fn list_active(org_run_id: &str) -> Result<Vec<AgentMemberInterventionRecord>, String> {
        let conn = get_connection().map_err(|error| error.to_string())?;
        Self::list_active_with_connection(&conn, org_run_id)
    }

    pub(crate) fn list_active_with_connection(
        conn: &Connection,
        org_run_id: &str,
    ) -> Result<Vec<AgentMemberInterventionRecord>, String> {
        let mut statement = conn
            .prepare(&format!(
                "{INTERVENTION_SELECT}
                 WHERE intervention.org_run_id=?1
                   AND intervention.status IN ({ACTIVE_STATUSES_SQL})
                   AND intervention.member_id<>?2
                 ORDER BY intervention.last_user_activity_at DESC"
            ))
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(
                params![org_run_id, COORDINATOR_MEMBER_ID],
                row_to_intervention,
            )
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }

    /// Test-only shortcut for fixtures that need to model an already-cleared
    /// intervention. Production Return, Archive, and Delete use their exact
    /// receipt/lifecycle transactions instead.
    #[cfg(test)]
    pub fn clear(org_run_id: &str, member_id: &str) -> Result<bool, String> {
        let now = chrono::Utc::now().to_rfc3339();
        let changed = with_sessions_writer(|| -> Result<bool, String> {
            let conn = get_connection().map_err(|error| error.to_string())?;
            let revision: i64 = conn
                .query_row(
                    "SELECT COALESCE(MAX(cleared_revision),0)+1
                     FROM agent_org_runtime_member_interventions WHERE org_run_id=?1",
                    [org_run_id],
                    |row| row.get(0),
                )
                .map_err(|error| error.to_string())?;
            conn.execute(
                &format!(
                    "UPDATE agent_org_runtime_member_interventions
                     SET status='cleared',cleared_revision=?3,cleared_at=?4,updated_at=?4
                     WHERE org_run_id=?1 AND member_id=?2
                       AND status IN ({ACTIVE_STATUSES_SQL})"
                ),
                params![org_run_id, member_id, revision, now],
            )
            .map(|count| count > 0)
            .map_err(|error| error.to_string())
        })?;
        if changed {
            crate::coordination::agent_org_run_events::notify_agent_org_run_changed(org_run_id);
        }
        Ok(changed)
    }

    #[cfg(test)]
    pub fn enter(
        params: EnterMemberInterventionParams,
    ) -> Result<AgentMemberInterventionRecord, String> {
        if !can_enter_member_intervention(&params.member_id) {
            return Err("coordinator cannot enter member intervention".to_string());
        }
        with_sessions_writer(|| {
            let conn = get_connection().map_err(|error| error.to_string())?;
            let receipt_id = format!("test_intervention_{}", uuid::Uuid::new_v4());
            let now = chrono::Utc::now().to_rfc3339();
            conn.execute(
                "INSERT INTO agent_org_runtime_member_interventions (
                    intervention_receipt_id,org_run_id,member_id,agent_id,session_id,status,
                    source_event_id,entered_at,last_user_activity_at,updated_at
                 ) VALUES (?1,?2,?3,?4,?5,'active',?6,?7,?7,?7)",
                params![
                    &receipt_id,
                    &params.org_run_id,
                    &params.member_id,
                    &params.agent_id,
                    &params.session_id,
                    format!("test-source-{receipt_id}"),
                    &now,
                ],
            )
            .map_err(|error| error.to_string())?;
            get_by_receipt_with_connection(&conn, &receipt_id)?
                .ok_or_else(|| "test intervention disappeared".to_string())
        })
    }
}

#[cfg(test)]
#[derive(Debug, Clone)]
pub struct EnterMemberInterventionParams {
    pub org_run_id: String,
    pub member_id: String,
    pub agent_id: String,
    pub session_id: String,
}

fn validate_direct_source(
    conn: &Connection,
    params: &EnqueueUserDirectedWorkParams,
) -> Result<(), String> {
    let source: Option<(String, Option<String>, String)> = conn
        .query_row(
            "SELECT result_json,meta_json,event_type
             FROM events WHERE id=?1 AND session_id=?2 AND function_name='user_message'",
            params![&params.source_event_id, &params.session_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some((result_json, meta_json, event_type)) = source else {
        return Err(format!(
            "user_directed_source_invalid: EventStore event {} is not canonical for Session {}",
            params.source_event_id, params.session_id
        ));
    };
    if event_type != "raw" {
        return Err("user_directed_source_invalid: source is not a raw user event".to_string());
    }
    let result: serde_json::Value = serde_json::from_str(&result_json)
        .map_err(|error| format!("user_directed_source_invalid: bad result JSON: {error}"))?;
    let meta: serde_json::Value = meta_json
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(|error| format!("user_directed_source_invalid: bad meta JSON: {error}"))?
        .unwrap_or(serde_json::Value::Null);
    let exact = result
        .get("syntheticUserInput")
        .and_then(|value| value.as_bool())
        == Some(true)
        && result
            .get("agentOrgDirectSource")
            .and_then(|value| value.as_bool())
            == Some(true)
        && result.get("turnIntentId").and_then(|value| value.as_str())
            == Some(params.turn_intent_id.as_str())
        && result
            .pointer("/message/content")
            .and_then(|value| value.as_str())
            == Some(params.source_display_content.as_str())
        && direct_source_images(&result)?.as_deref() == params.source_images.as_deref()
        && meta.get("source").and_then(|value| value.as_str()) == Some("user");
    if !exact {
        return Err(format!(
            "user_directed_source_invalid: EventStore event {} does not match user/source/Turn/content",
            params.source_event_id
        ));
    }
    Ok(())
}

fn direct_source_images(result: &serde_json::Value) -> Result<Option<Vec<String>>, String> {
    let Some(images) = result.get("images") else {
        return Ok(None);
    };
    let images = images.as_array().ok_or_else(|| {
        "user_directed_source_invalid: source images must be a string array".to_string()
    })?;
    if images.is_empty() {
        return Ok(None);
    }
    images
        .iter()
        .map(|image| {
            image.as_str().map(str::to_string).ok_or_else(|| {
                "user_directed_source_invalid: source images must be a string array".to_string()
            })
        })
        .collect::<Result<Vec<_>, _>>()
        .map(Some)
}

fn running_formal_turn(
    conn: &Connection,
    params: &EnqueueUserDirectedWorkParams,
) -> Result<Option<(String, String, i64)>, String> {
    let mut statement = conn
        .prepare(
            "SELECT context.task_id,context.turn_intent_id,context.member_dispatch_sequence
             FROM agent_org_runtime_turn_contexts context
             JOIN session_turn_intents intent
               ON intent.session_id=context.session_id
              AND intent.turn_intent_id=context.turn_intent_id
             WHERE context.org_run_id=?1 AND context.session_id=?2
               AND context.participant_id=?3
               AND context.turn_kind='task_execution'
               AND intent.status='running'
             ORDER BY context.context_id DESC LIMIT 2",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(
            params![&params.org_run_id, &params.session_id, &params.member_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    match rows.as_slice() {
        [] => Ok(None),
        [only] => Ok(Some(only.clone())),
        _ => Err(
            "agent_org_turn_context_invalid: multiple running TaskExecution Turns for one Member"
                .to_string(),
        ),
    }
}

fn update_chain_status(
    session_id: &str,
    turn_intent_id: &str,
    status: &str,
    failure_reason: Option<&str>,
) -> Result<bool, String> {
    with_sessions_writer(|| {
        let mut conn = get_connection().map_err(|error| error.to_string())?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;
        let now = chrono::Utc::now().to_rfc3339();
        let changed = tx
            .execute(
                "UPDATE agent_org_runtime_member_intervention_turns
             SET status=?4,terminal_at=?3,failure_reason=?5
             WHERE session_id=?1 AND turn_intent_id=?2 AND status IN ('queued','running')",
                params![session_id, turn_intent_id, now, status, failure_reason],
            )
            .map_err(|error| error.to_string())?;
        if changed == 1 {
            let intent_status = match status {
                "completed" => "completed",
                "failed" | "abandoned" => "failed",
                "cancelled" => "cancelled",
                _ => unreachable!("validated direct terminal status"),
            };
            tx.execute(
                "UPDATE session_turn_intents
                 SET status=?3,updated_at=?4
                 WHERE session_id=?1 AND turn_intent_id=?2
                   AND status IN ('queued','running')",
                params![session_id, turn_intent_id, intent_status, &now],
            )
            .map_err(|error| error.to_string())?;
        }
        if changed == 1 && matches!(status, "failed" | "abandoned") {
            let failure_code = if status == "abandoned" {
                "user_directed_turn_abandoned"
            } else {
                "user_directed_turn_failed"
            };
            tx.execute(
                "UPDATE agent_org_runtime_member_interventions
                 SET failure_reason=?3,updated_at=?4
                 WHERE intervention_receipt_id=(
                     SELECT intervention_receipt_id
                     FROM agent_org_runtime_member_intervention_turns
                     WHERE session_id=?1 AND turn_intent_id=?2
                 )",
                params![session_id, turn_intent_id, failure_code, now],
            )
            .map_err(|error| error.to_string())?;
        }
        tx.commit().map_err(|error| error.to_string())?;
        Ok(changed == 1)
    })
}

fn notify_run_for_receipt(receipt_id: &str) {
    if let Ok(Some(record)) = AgentMemberInterventionStore::get_by_receipt(receipt_id) {
        crate::coordination::agent_org_run_events::notify_agent_org_run_changed(&record.org_run_id);
    }
}

fn notify_run_for_turn(session_id: &str, turn_intent_id: &str) {
    let run_id = get_connection().ok().and_then(|conn| {
        conn.query_row(
            "SELECT intervention.org_run_id
             FROM agent_org_runtime_member_intervention_turns chain
             JOIN agent_org_runtime_member_interventions intervention
               ON intervention.intervention_receipt_id=chain.intervention_receipt_id
             WHERE chain.session_id=?1 AND chain.turn_intent_id=?2",
            params![session_id, turn_intent_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten()
    });
    if let Some(run_id) = run_id {
        crate::coordination::agent_org_run_events::notify_agent_org_run_changed(&run_id);
    }
}

#[cfg(test)]
#[path = "agent_member_interventions_tests.rs"]
mod tests;

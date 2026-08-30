//! Canonical Agent Org formal-work quiescence facts and decision policy.
//!
//! Every caller (watchdog inspection, lifecycle reconciliation, completion
//! snapshots) must reason from this same typed assessment. This prevents a
//! weaker pre-check from declaring a terminal candidate that the atomic
//! reconciler then rejects for a different set of rules.

use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::foundation::session_bridge::IN_FLIGHT_TURN_INTENT_STATUSES;
use crate::session::SessionStatus;

use super::progress::{load_progress_with_conn, AgentOrgRunProgress};
use super::{AgentOrgRunStatus, AgentOrgRunStore};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOrgQuiescenceSessionFact {
    pub session_id: String,
    pub member_id: Option<String>,
    pub status: SessionStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOrgQuiescenceFacts {
    pub run_status: Option<AgentOrgRunStatus>,
    pub activation_generation: Option<i64>,
    pub root_session_id: Option<String>,
    pub root_status: Option<SessionStatus>,
    pub worker_sessions: Vec<AgentOrgQuiescenceSessionFact>,
    pub task_count: usize,
    pub unresolved_task_count: usize,
    pub corrupt_task_count: usize,
    pub pending_task_count: usize,
    pub in_progress_task_count: usize,
    pub completed_task_count: usize,
    pub unresolved_handoff_count: usize,
    /// All unread rows remain visible in Run View/history. Only exact Task
    /// inputs, user-directed rows, and rows backed by a live formal receipt
    /// may prevent certificate/finality convergence.
    pub unread_inbox_count: usize,
    pub blocking_unread_inbox_count: usize,
    pub in_flight_turn_intent_count: usize,
    pub unknown_turn_intent_count: usize,
    pub pending_formal_materialization_count: usize,
    pub active_recovery_reservation_count: usize,
    pub pending_plan_approval_count: usize,
    pub progress: Option<AgentOrgRunProgress>,
    pub completion_certificate:
        Option<crate::coordination::agent_org_run_completion::RunCompletionCertificate>,
    pub final_summary_receipt:
        Option<crate::coordination::agent_org_final_summary::FinalSummaryReceipt>,
    pub completion_publication_complete: bool,
}

impl AgentOrgQuiescenceFacts {
    /// Canonical set of non-quiescent worker member ids for UI/task
    /// projections. Keeping the status classification here prevents Run View,
    /// task_list, and the reconciler from growing subtly different ideas of
    /// what "active" means.
    pub fn active_member_ids(&self) -> Vec<String> {
        let mut member_ids = self
            .worker_sessions
            .iter()
            .filter(|session| !session_is_quiescent(session.status))
            .map(|session| {
                session
                    .member_id
                    .clone()
                    .unwrap_or_else(|| session.session_id.clone())
            })
            .collect::<Vec<_>>();
        member_ids.sort();
        member_ids.dedup();
        member_ids
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentOrgQuiescenceDecision {
    KeepWorking,
    Quiescent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentOrgQuiescenceBlocker {
    RunMissing,
    RunNotRunning {
        status: AgentOrgRunStatus,
    },
    RootSessionMissing,
    SessionsActive {
        session_ids: Vec<String>,
    },
    OpenTasks {
        count: usize,
    },
    CorruptTaskData {
        count: usize,
    },
    UnresolvedTaskHandoffs {
        count: usize,
    },
    MissingCompletionCertificate,
    StaleCompletionCertificate {
        certificate_work_revision: i64,
        current_work_revision: i64,
    },
    CompletionCertificateNotPublished,
    EmptyTaskBoardRequiresCompletionIntent,
    StaleCompletionIntent {
        requested_work_revision: Option<i64>,
        current_work_revision: i64,
    },
    CoordinatorHasNotObservedLatestWork {
        observed_work_revision: Option<i64>,
        current_work_revision: i64,
    },
    UnreadInbox {
        count: usize,
    },
    InFlightTurnIntents {
        count: usize,
    },
    UnknownTurnIntents {
        count: usize,
    },
    PendingFormalMaterializations {
        count: usize,
    },
    ActiveRecoveryReservations {
        count: usize,
    },
    PendingPlanApprovals {
        count: usize,
    },
    ProgressStateMissing,
    /// The terminal status is authoritative and is never reopened, but the
    /// retained facts disagree with the invariants that normally gate that
    /// transition. This is diagnostic state for repair/audit surfaces, not a
    /// request to mutate the run back to Running.
    QuietStateInconsistent {
        status: AgentOrgRunStatus,
        root_session_missing: bool,
        active_session_count: usize,
        open_task_count: usize,
        corrupt_task_count: usize,
        unread_inbox_count: usize,
        in_flight_turn_intent_count: usize,
        unknown_turn_intent_count: usize,
        pending_formal_materialization_count: usize,
        active_recovery_reservation_count: usize,
        pending_plan_approval_count: usize,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOrgQuiescenceAssessment {
    pub facts: AgentOrgQuiescenceFacts,
    pub decision: AgentOrgQuiescenceDecision,
    pub blockers: Vec<AgentOrgQuiescenceBlocker>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOrgQuiescenceProjection {
    pub decision: AgentOrgQuiescenceDecision,
    pub blockers: Vec<AgentOrgQuiescenceBlocker>,
}

/// Exact effects that the currently executing coordinator turn will commit
/// if (and only if) that turn succeeds.  These counts are not caller hints:
/// they are revalidated from durable intent/materialization rows inside the
/// same read transaction as the quiescence snapshot.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AgentOrgGuaranteedTurnEffects {
    pub current_coordinator_turn: bool,
    pub in_flight_turn_intents: usize,
    pub unread_inbox_rows: usize,
    /// Exact roster members whose projected, system-authored `MemberIdle`
    /// row is part of this Coordinator Turn's materialized inbox batch. The
    /// row is emitted only after the member's provider/tool loop has ended;
    /// its persisted Turn-intent bookkeeping may still lag by a few
    /// milliseconds. Completion validation can therefore project that one
    /// exact worker Turn as terminal without treating an arbitrary session
    /// status as proof.
    pub terminal_member_ids: Vec<String>,
    pub terminal_worker_turn_intents: usize,
}

impl AgentOrgQuiescenceAssessment {
    /// Canonical prospective certificate used by the coordinator inside its
    /// current turn. It answers one narrow question: "if this coordinator
    /// turn succeeds now, will the strict reconciler be able to complete?"
    ///
    /// Only effects guaranteed by successful turn finalization are projected:
    /// the root session becomes quiescent, and the revision staged into this
    /// prompt becomes observed. Every worker, task, inbox, approval,
    /// intervention, corruption, and turn-intent blocker remains unchanged.
    pub fn after_successful_coordinator_turn(&self) -> AgentOrgQuiescenceProjection {
        self.after_successful_coordinator_turn_with_effects(AgentOrgGuaranteedTurnEffects {
            current_coordinator_turn: true,
            ..AgentOrgGuaranteedTurnEffects::default()
        })
    }

    pub fn after_successful_coordinator_turn_with_effects(
        &self,
        effects: AgentOrgGuaranteedTurnEffects,
    ) -> AgentOrgQuiescenceProjection {
        if self.facts.run_status != Some(AgentOrgRunStatus::Running)
            || !effects.current_coordinator_turn
        {
            return AgentOrgQuiescenceProjection {
                decision: self.decision,
                blockers: self.blockers.clone(),
            };
        }
        let root_session_id = self.facts.root_session_id.as_deref();
        let presented_current_revision = self.facts.progress.as_ref().is_some_and(|progress| {
            progress.coordinator_presented_work_revision == Some(progress.work_revision)
        });
        let terminal_member_ids = effects
            .terminal_member_ids
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        let terminal_session_ids = self
            .facts
            .worker_sessions
            .iter()
            .filter(|session| {
                session
                    .member_id
                    .as_deref()
                    .is_some_and(|member_id| terminal_member_ids.contains(member_id))
            })
            .map(|session| session.session_id.as_str())
            .collect::<HashSet<_>>();
        let mut blockers = Vec::new();
        for blocker in &self.blockers {
            match blocker {
                AgentOrgQuiescenceBlocker::SessionsActive { session_ids } => {
                    let remaining = session_ids
                        .iter()
                        .filter(|session_id| {
                            Some(session_id.as_str()) != root_session_id
                                && !terminal_session_ids.contains(session_id.as_str())
                        })
                        .cloned()
                        .collect::<Vec<_>>();
                    if !remaining.is_empty() {
                        blockers.push(AgentOrgQuiescenceBlocker::SessionsActive {
                            session_ids: remaining,
                        });
                    }
                }
                AgentOrgQuiescenceBlocker::CoordinatorHasNotObservedLatestWork { .. }
                    if presented_current_revision => {}
                AgentOrgQuiescenceBlocker::UnreadInbox { count } => {
                    let remaining = count.saturating_sub(effects.unread_inbox_rows);
                    if remaining > 0 {
                        blockers.push(AgentOrgQuiescenceBlocker::UnreadInbox { count: remaining });
                    }
                }
                AgentOrgQuiescenceBlocker::InFlightTurnIntents { count } => {
                    let remaining = count.saturating_sub(
                        effects
                            .in_flight_turn_intents
                            .saturating_add(effects.terminal_worker_turn_intents),
                    );
                    if remaining > 0 {
                        blockers.push(AgentOrgQuiescenceBlocker::InFlightTurnIntents {
                            count: remaining,
                        });
                    }
                }
                other => blockers.push(other.clone()),
            }
        }
        AgentOrgQuiescenceProjection {
            decision: if blockers.is_empty() {
                AgentOrgQuiescenceDecision::Quiescent
            } else {
                AgentOrgQuiescenceDecision::KeepWorking
            },
            blockers,
        }
    }
}

pub(crate) fn guaranteed_current_turn_effects_with_connection(
    conn: &Connection,
    run_id: &str,
    root_session_id: Option<&str>,
    dispatching_session_id: &str,
    turn_intent_id: &str,
    projected_inbox_ids: &[i64],
) -> Result<AgentOrgGuaranteedTurnEffects, String> {
    if root_session_id != Some(dispatching_session_id)
        || dispatching_session_id.trim().is_empty()
        || turn_intent_id.trim().is_empty()
    {
        return Ok(AgentOrgGuaranteedTurnEffects::default());
    }

    let in_flight_turn_intents: bool = conn
        .query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM session_turn_intents
                 WHERE session_id=?1 AND turn_intent_id=?2 AND org_run_id=?3
                   AND status IN (?4, ?5, ?6)
             )",
            params![
                dispatching_session_id,
                turn_intent_id,
                run_id,
                IN_FLIGHT_TURN_INTENT_STATUSES[0],
                IN_FLIGHT_TURN_INTENT_STATUSES[1],
                IN_FLIGHT_TURN_INTENT_STATUSES[2],
            ],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())?;

    // The production drain batch is bounded. Deduplicate the typed ids and
    // validate each exact row/receipt pair instead of interpolating an IN
    // list or counting every receipt ever owned by this Session.
    let mut unique_ids = projected_inbox_ids
        .iter()
        .copied()
        .filter(|id| *id > 0)
        .collect::<Vec<_>>();
    unique_ids.sort_unstable();
    unique_ids.dedup();
    let mut unread_inbox_rows = 0usize;
    let mut member_idle_rows = Vec::new();
    let mut stmt = conn
        .prepare(
            "SELECT inbox.payload_kind,inbox.payload_json,inbox.sender_agent_id,inbox.created_at
             FROM agent_org_runtime_inbox inbox
             JOIN agent_org_runtime_inbox_materializations receipt
               ON receipt.inbox_id=inbox.id AND receipt.session_id=?2
             WHERE inbox.id=?1 AND inbox.org_run_id=?3 AND inbox.read_at IS NULL
               AND inbox.delivery_class='formal_work'
               AND NOT EXISTS (
                   SELECT 1 FROM agent_org_runtime_inbox_delivery_resolutions resolution
                   WHERE resolution.inbox_id=inbox.id
               )",
        )
        .map_err(|err| err.to_string())?;
    for inbox_id in unique_ids {
        let projected = stmt
            .query_row(params![inbox_id, dispatching_session_id, run_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .optional()
            .map_err(|err| err.to_string())?;
        let Some((payload_kind, payload_json, sender_agent_id, created_at)) = projected else {
            continue;
        };
        unread_inbox_rows += 1;
        if payload_kind != "member_idle"
            || sender_agent_id != crate::coordination::agent_inbox::SYSTEM_SENDER_ID
        {
            continue;
        }
        let Ok(message) =
            serde_json::from_str::<crate::coordination::agent_inbox::AgentMessage>(&payload_json)
        else {
            continue;
        };
        if message.validate().is_err() || message.kind_tag() != payload_kind {
            continue;
        }
        if let crate::coordination::agent_inbox::AgentMessage::MemberIdle { member_id, .. } =
            message
        {
            member_idle_rows.push((member_id, created_at));
        }
    }

    // A stale MemberIdle row must never mask a newer formal worker Turn. Map
    // each exact row only when there is zero or one in-flight TaskExecution
    // for that member and the Turn did not begin after the idle receipt.
    let mut terminal_member_ids = Vec::new();
    let mut terminal_worker_turn_intents = 0usize;
    let mut considered_member_ids = HashSet::new();
    let mut active_turn_stmt = conn
        .prepare(
            "SELECT intent.created_at
             FROM agent_org_runtime_turn_contexts context
             JOIN session_turn_intents intent
               ON intent.session_id=context.session_id
              AND intent.turn_intent_id=context.turn_intent_id
             WHERE context.org_run_id=?1 AND context.turn_kind='task_execution'
               AND context.participant_id=?2
               AND intent.status IN (?3,?4,?5)
             ORDER BY intent.created_at,intent.turn_intent_id",
        )
        .map_err(|err| err.to_string())?;
    for (member_id, idle_created_at) in member_idle_rows.into_iter().rev() {
        if !considered_member_ids.insert(member_id.clone()) {
            continue;
        }
        let active_turns = active_turn_stmt
            .query_map(
                params![
                    run_id,
                    &member_id,
                    IN_FLIGHT_TURN_INTENT_STATUSES[0],
                    IN_FLIGHT_TURN_INTENT_STATUSES[1],
                    IN_FLIGHT_TURN_INTENT_STATUSES[2],
                ],
                |row| row.get::<_, String>(0),
            )
            .map_err(|err| err.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())?;
        if active_turns.len() <= 1
            && active_turns
                .first()
                .is_none_or(|turn_created_at| turn_created_at <= &idle_created_at)
        {
            terminal_member_ids.push(member_id);
            terminal_worker_turn_intents += active_turns.len();
        }
    }
    terminal_member_ids.sort();
    terminal_member_ids.dedup();

    Ok(AgentOrgGuaranteedTurnEffects {
        current_coordinator_turn: in_flight_turn_intents,
        in_flight_turn_intents: usize::from(in_flight_turn_intents),
        unread_inbox_rows,
        terminal_member_ids,
        terminal_worker_turn_intents,
    })
}

pub(super) fn load_and_assess(
    conn: &Connection,
    run_id: &str,
) -> Result<AgentOrgQuiescenceAssessment, String> {
    let run_row: Option<(String, Option<String>, i64)> = conn
        .query_row(
            "SELECT status, root_session_id, activation_generation
             FROM agent_org_runtime_runs WHERE id=?1",
            params![run_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|err| err.to_string())?;
    let Some((run_status_raw, root_session_id, activation_generation)) = run_row else {
        return Ok(assess_quiescence(AgentOrgQuiescenceFacts {
            run_status: None,
            activation_generation: None,
            root_session_id: None,
            root_status: None,
            worker_sessions: Vec::new(),
            task_count: 0,
            unresolved_task_count: 0,
            corrupt_task_count: 0,
            pending_task_count: 0,
            in_progress_task_count: 0,
            completed_task_count: 0,
            unresolved_handoff_count: 0,
            unread_inbox_count: 0,
            blocking_unread_inbox_count: 0,
            in_flight_turn_intent_count: 0,
            unknown_turn_intent_count: 0,
            pending_formal_materialization_count: 0,
            active_recovery_reservation_count: 0,
            pending_plan_approval_count: 0,
            progress: None,
            completion_certificate: None,
            final_summary_receipt: None,
            completion_publication_complete: false,
        }));
    };
    let run_status = AgentOrgRunStatus::parse(&run_status_raw)
        .ok_or_else(|| format!("unknown Agent Org run status: {run_status_raw}"))?;
    let work_episode_id =
        crate::coordination::agent_org_work_episodes::current_with_connection(conn, run_id)?
            .map(|episode| episode.id);

    let root_status = match root_session_id.as_deref() {
        Some(session_id) => conn
            .query_row(
                "SELECT status FROM agent_sessions WHERE session_id=?1",
                params![session_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|err| err.to_string())?
            .map(|raw| {
                SessionStatus::parse(&raw)
                    .ok_or_else(|| format!("unknown root session status for {session_id}: {raw:?}"))
            })
            .transpose()?,
        None => None,
    };

    // Use the same cross-transport canonical worker projection as Run View
    // and recovery.  Duplicating the Rust/CLI queries here used to let a stale
    // session for the same member block quiescence even though the UI and
    // watchdog correctly selected the freshest one.
    let formal_turn_session_ids = {
        let mut statement = conn
            .prepare(
                "SELECT DISTINCT context.session_id
                 FROM agent_org_runtime_turn_contexts context
                 JOIN session_turn_intents intent
                   ON intent.session_id=context.session_id
                  AND intent.turn_intent_id=context.turn_intent_id
                 WHERE context.org_run_id=?1
                   AND (context.turn_kind='task_execution'
                        OR (context.turn_kind='coordinator'
                            AND context.source_kind='root_turn'))
                   AND intent.status IN ('optimistic','queued','running')",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([run_id], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<HashSet<_>, _>>()
            .map_err(|error| error.to_string())?
    };
    let worker_sessions =
        AgentOrgRunStore::list_descendant_worker_sessions_with_connection(conn, run_id)?
            .into_iter()
            .map(|session| {
                let status = if session.status == SessionStatus::Running
                    && !formal_turn_session_ids.contains(&session.session_id)
                {
                    // A warm or UDW-only Member runtime is activity, not a
                    // formal-work blocker for Working -> Idle.
                    SessionStatus::Idle
                } else {
                    session.status
                };
                AgentOrgQuiescenceSessionFact {
                    session_id: session.session_id,
                    member_id: session.member_id,
                    status,
                }
            })
            .collect();

    let corrupt_task_predicate =
        crate::coordination::agent_org_tasks::corrupt_task_row_predicate_sql();
    let persisted_open_task_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM agent_org_runtime_tasks task
             JOIN agent_org_runtime_work_episode_tasks episode_task
               ON episode_task.org_run_id=task.org_run_id AND episode_task.task_id=task.id
             WHERE task.org_run_id=?1 AND episode_task.work_episode_id=?2
               AND task.status IN ('pending','in_progress')",
            params![run_id, work_episode_id.as_deref()],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())?;
    let corruption_projection = if persisted_open_task_count
        > crate::coordination::agent_org_payload_limits::TASK_RUN_MAX_OPEN_TASKS as i64
    {
        // An over-cap open board is one run-level corruption. Terminal
        // history remains valid and is intentionally excluded from the cap.
        "1".to_string()
    } else {
        format!("COALESCE(SUM(CASE WHEN {corrupt_task_predicate} THEN 1 ELSE 0 END), 0)")
    };
    let dependency_json_max =
        crate::coordination::agent_org_payload_limits::TASK_DEPENDENCY_JSON_MAX_BYTES;
    let metadata_max = crate::coordination::agent_org_payload_limits::TASK_METADATA_MAX_BYTES;
    let task_counts_sql = format!(
        "SELECT COUNT(*),
                COALESCE(SUM(CASE WHEN status IN ('pending','in_progress') THEN 1 ELSE 0 END), 0),
                {corruption_projection},
                COALESCE(SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN status='in_progress' THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END), 0)
         FROM (
             SELECT id, subject, description, active_form, owner, status,
                    execution_mode, output_json, failure_reason_json, cancel_reason_json,
                    created_by_participant_id, source_turn_intent_id,
                    originating_message_id, replaces_task_id, created_at, updated_at,
                    external_effect_unknown,
                    CASE WHEN length(CAST(blocked_by_json AS BLOB))<={dependency_json_max}
                         THEN blocked_by_json ELSE '!' END AS blocked_by_json,
                    CASE WHEN metadata_json IS NULL
                              OR length(CAST(metadata_json AS BLOB))<={metadata_max}
                         THEN metadata_json ELSE '!' END AS metadata_json
             FROM agent_org_runtime_tasks task
             JOIN agent_org_runtime_work_episode_tasks episode_task
               ON episode_task.org_run_id=task.org_run_id AND episode_task.task_id=task.id
             WHERE task.org_run_id=?1 AND episode_task.work_episode_id=?2
         ) AS bounded_tasks"
    );
    let (
        task_count,
        unresolved_task_count,
        episode_corrupt_task_count,
        pending_task_count,
        in_progress_task_count,
        completed_task_count,
    ): (i64, i64, i64, i64, i64, i64) = conn
        .query_row(
            &task_counts_sql,
            params![run_id, work_episode_id.as_deref()],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .map_err(|err| err.to_string())?;
    let unassociated_task_count =
        crate::coordination::agent_org_work_episodes::unassociated_task_count_with_connection(
            conn, run_id,
        )?;
    let corrupt_task_count = episode_corrupt_task_count
        .checked_add(unassociated_task_count)
        .ok_or_else(|| "Agent Org corrupt Task count overflow".to_string())?;
    let unread_inbox_count: i64 = conn
        .query_row(
            "SELECT COUNT(*)
             FROM agent_org_runtime_inbox
             WHERE org_run_id=?1 AND delivery_class='formal_work' AND read_at IS NULL
               AND NOT EXISTS (
                   SELECT 1 FROM agent_org_runtime_inbox_delivery_resolutions resolution
                   WHERE resolution.inbox_id=agent_org_runtime_inbox.id
               )",
            params![run_id],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())?;
    let blocking_unread_inbox_count: i64 = conn
        .query_row(
            "SELECT COUNT(*)
             FROM agent_org_runtime_inbox inbox
             WHERE inbox.org_run_id=?1 AND inbox.delivery_class='formal_work'
               AND inbox.read_at IS NULL
               AND NOT EXISTS (
                   SELECT 1 FROM agent_org_runtime_inbox_delivery_resolutions resolution
                   WHERE resolution.inbox_id=inbox.id
               )
               AND NOT (
                   inbox.payload_kind='shutdown_request'
                   AND NOT EXISTS (
                       SELECT 1 FROM agent_org_runtime_tasks task
                       WHERE task.org_run_id=inbox.org_run_id
                         AND task.owner=inbox.recipient_member_id
                         AND task.status IN ('pending','in_progress')
                   )
               )
               AND (
                   inbox.recipient_member_id<>'coordinator'
                   OR inbox.sender_agent_id=?2
                   OR EXISTS (
                       SELECT 1
                       FROM agent_org_runtime_formal_trigger_receipts receipt
                       WHERE receipt.inbox_id=inbox.id
                         AND receipt.status IN ('pending','materialized')
                   )
               )",
            params![run_id, crate::coordination::agent_inbox::USER_SENDER_ID],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())?;
    let in_flight_turn_intent_count: i64 = conn
        .query_row(
            "SELECT COUNT(*)
             FROM session_turn_intents intent
             JOIN agent_org_runtime_turn_contexts context
               ON context.session_id=intent.session_id
              AND context.turn_intent_id=intent.turn_intent_id
             WHERE intent.org_run_id=?1
               AND (context.turn_kind='task_execution'
                    OR (context.turn_kind='coordinator'
                        AND context.source_kind='root_turn'))
               AND intent.status IN (?2, ?3, ?4)",
            params![
                run_id,
                IN_FLIGHT_TURN_INTENT_STATUSES[0],
                IN_FLIGHT_TURN_INTENT_STATUSES[1],
                IN_FLIGHT_TURN_INTENT_STATUSES[2],
            ],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())?;
    let unknown_turn_intent_count: i64 = conn
        .query_row(
            "SELECT COUNT(*)
             FROM session_turn_intents intent
             JOIN agent_org_runtime_turn_contexts context
               ON context.session_id=intent.session_id
              AND context.turn_intent_id=intent.turn_intent_id
             WHERE intent.org_run_id=?1
               AND (context.turn_kind='task_execution'
                    OR (context.turn_kind='coordinator'
                        AND context.source_kind='root_turn'))
               AND intent.status NOT IN (
                   'optimistic', 'queued', 'running', 'completed', 'failed',
                   'cancelled', 'stale', 'coalesced', 'rejected'
               )",
            params![run_id],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())?;
    let pending_formal_materialization_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM agent_org_runtime_member_materializations
             WHERE org_run_id=?1 AND generation=?2
               AND authority_class IN ('starting', 'formal')
               AND status<>'succeeded'",
            params![run_id, activation_generation],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())?;
    let active_recovery_reservation_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM agent_org_runtime_recovery_attempts
             WHERE org_run_id=?1 AND reservation_token IS NOT NULL",
            params![run_id],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())?;
    let pending_plan_approval_count: i64 = conn
        .query_row(
            "SELECT COUNT(*)
             FROM agent_org_runtime_plan_revisions revision
             JOIN agent_org_runtime_plan_decisions decision
               ON decision.plan_revision_id=revision.plan_revision_id
             WHERE revision.org_run_id=?1 AND decision.status='pending'",
            params![run_id],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())?;
    let unresolved_handoff_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM agent_org_runtime_task_execution_handoffs handoff
             JOIN agent_org_runtime_work_episode_tasks episode_task
               ON episode_task.org_run_id=handoff.org_run_id
              AND episode_task.task_id=handoff.old_task_id
             WHERE handoff.org_run_id=?1 AND episode_task.work_episode_id=?2
               AND handoff.state IN ('requested','yielding','timeout','unknown','failed')
               AND handoff.resolution IS NULL",
            params![run_id, work_episode_id.as_deref()],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())?;
    let completion_certificate =
        crate::coordination::agent_org_run_completion::load_current_episode_with_connection(
            conn, run_id,
        )?;
    let final_summary_receipt =
        crate::coordination::agent_org_final_summary::active_for_run_with_connection(
            conn,
            run_id,
            activation_generation,
        )?;
    let completion_publication_complete = final_summary_receipt.as_ref().is_some_and(|receipt| {
        matches!(
            receipt.status,
            crate::coordination::agent_org_final_summary::FinalSummaryStatus::Persisted
                | crate::coordination::agent_org_final_summary::FinalSummaryStatus::Failed
        )
    });

    Ok(assess_quiescence(AgentOrgQuiescenceFacts {
        run_status: Some(run_status),
        activation_generation: Some(activation_generation),
        root_session_id,
        root_status,
        worker_sessions,
        task_count: count_to_usize("task", task_count)?,
        unresolved_task_count: count_to_usize("unresolved task", unresolved_task_count)?,
        corrupt_task_count: count_to_usize("corrupt task", corrupt_task_count)?,
        pending_task_count: count_to_usize("pending task", pending_task_count)?,
        in_progress_task_count: count_to_usize("in-progress task", in_progress_task_count)?,
        completed_task_count: count_to_usize("completed task", completed_task_count)?,
        unresolved_handoff_count: count_to_usize(
            "unresolved TaskExecution handoff",
            unresolved_handoff_count,
        )?,
        unread_inbox_count: count_to_usize("unread inbox", unread_inbox_count)?,
        blocking_unread_inbox_count: count_to_usize(
            "blocking unread inbox",
            blocking_unread_inbox_count,
        )?,
        in_flight_turn_intent_count: count_to_usize(
            "in-flight turn intent",
            in_flight_turn_intent_count,
        )?,
        unknown_turn_intent_count: count_to_usize(
            "unknown turn intent",
            unknown_turn_intent_count,
        )?,
        pending_formal_materialization_count: count_to_usize(
            "pending formal materialization",
            pending_formal_materialization_count,
        )?,
        active_recovery_reservation_count: count_to_usize(
            "active recovery reservation",
            active_recovery_reservation_count,
        )?,
        pending_plan_approval_count: count_to_usize(
            "pending plan approval",
            pending_plan_approval_count,
        )?,
        progress: load_progress_with_conn(conn, run_id)?,
        completion_certificate,
        final_summary_receipt,
        completion_publication_complete,
    }))
}

pub fn assess_quiescence(facts: AgentOrgQuiescenceFacts) -> AgentOrgQuiescenceAssessment {
    let mut blockers = Vec::new();
    let Some(run_status) = facts.run_status else {
        blockers.push(AgentOrgQuiescenceBlocker::RunMissing);
        return AgentOrgQuiescenceAssessment {
            decision: AgentOrgQuiescenceDecision::KeepWorking,
            facts,
            blockers,
        };
    };
    if run_status == AgentOrgRunStatus::Idle {
        if let Some(inconsistency) = quiet_state_inconsistency(&facts, run_status) {
            blockers.push(inconsistency);
        }
        return AgentOrgQuiescenceAssessment {
            facts,
            decision: AgentOrgQuiescenceDecision::Quiescent,
            blockers,
        };
    }
    if run_status != AgentOrgRunStatus::Running {
        blockers.push(AgentOrgQuiescenceBlocker::RunNotRunning { status: run_status });
        return AgentOrgQuiescenceAssessment {
            facts,
            decision: AgentOrgQuiescenceDecision::KeepWorking,
            blockers,
        };
    }

    if facts.root_session_id.is_none() || facts.root_status.is_none() {
        blockers.push(AgentOrgQuiescenceBlocker::RootSessionMissing);
    }
    let mut active_session_ids = Vec::new();
    if facts
        .root_status
        .is_some_and(|status| !session_is_quiescent(status))
    {
        if let Some(root_session_id) = facts.root_session_id.as_ref() {
            active_session_ids.push(root_session_id.clone());
        }
    }
    active_session_ids.extend(
        facts
            .worker_sessions
            .iter()
            .filter(|session| !session_is_quiescent(session.status))
            .map(|session| session.session_id.clone()),
    );
    if !active_session_ids.is_empty() {
        blockers.push(AgentOrgQuiescenceBlocker::SessionsActive {
            session_ids: active_session_ids,
        });
    }
    if facts.unresolved_task_count > 0 {
        blockers.push(AgentOrgQuiescenceBlocker::OpenTasks {
            count: facts.unresolved_task_count,
        });
    }
    if facts.corrupt_task_count > 0 {
        blockers.push(AgentOrgQuiescenceBlocker::CorruptTaskData {
            count: facts.corrupt_task_count,
        });
    }
    if facts.unresolved_handoff_count > 0 {
        blockers.push(AgentOrgQuiescenceBlocker::UnresolvedTaskHandoffs {
            count: facts.unresolved_handoff_count,
        });
    }
    if facts.blocking_unread_inbox_count > 0 {
        blockers.push(AgentOrgQuiescenceBlocker::UnreadInbox {
            count: facts.blocking_unread_inbox_count,
        });
    }
    if facts.in_flight_turn_intent_count > 0 {
        blockers.push(AgentOrgQuiescenceBlocker::InFlightTurnIntents {
            count: facts.in_flight_turn_intent_count,
        });
    }
    if facts.unknown_turn_intent_count > 0 {
        blockers.push(AgentOrgQuiescenceBlocker::UnknownTurnIntents {
            count: facts.unknown_turn_intent_count,
        });
    }
    if facts.pending_formal_materialization_count > 0 {
        blockers.push(AgentOrgQuiescenceBlocker::PendingFormalMaterializations {
            count: facts.pending_formal_materialization_count,
        });
    }
    if facts.active_recovery_reservation_count > 0 {
        blockers.push(AgentOrgQuiescenceBlocker::ActiveRecoveryReservations {
            count: facts.active_recovery_reservation_count,
        });
    }
    if facts.pending_plan_approval_count > 0 {
        blockers.push(AgentOrgQuiescenceBlocker::PendingPlanApprovals {
            count: facts.pending_plan_approval_count,
        });
    }

    match facts.progress.as_ref() {
        None => blockers.push(AgentOrgQuiescenceBlocker::ProgressStateMissing),
        Some(progress) => {
            if facts.task_count > 0 {
                match facts.completion_certificate.as_ref() {
                    None => blockers.push(AgentOrgQuiescenceBlocker::MissingCompletionCertificate),
                    Some(certificate) if certificate.work_revision != progress.work_revision => {
                        blockers.push(AgentOrgQuiescenceBlocker::StaleCompletionCertificate {
                            certificate_work_revision: certificate.work_revision,
                            current_work_revision: progress.work_revision,
                        });
                    }
                    Some(_) if !facts.completion_publication_complete => {
                        blockers.push(AgentOrgQuiescenceBlocker::CompletionCertificateNotPublished)
                    }
                    Some(_) => {}
                }
            }
            if progress.coordinator_observed_work_revision < Some(progress.work_revision) {
                blockers.push(
                    AgentOrgQuiescenceBlocker::CoordinatorHasNotObservedLatestWork {
                        observed_work_revision: progress.coordinator_observed_work_revision,
                        current_work_revision: progress.work_revision,
                    },
                );
            }
        }
    }

    let decision = if blockers.is_empty() {
        AgentOrgQuiescenceDecision::Quiescent
    } else {
        AgentOrgQuiescenceDecision::KeepWorking
    };
    AgentOrgQuiescenceAssessment {
        facts,
        decision,
        blockers,
    }
}

fn quiet_state_inconsistency(
    facts: &AgentOrgQuiescenceFacts,
    status: AgentOrgRunStatus,
) -> Option<AgentOrgQuiescenceBlocker> {
    let root_session_missing = facts.root_session_id.is_none() || facts.root_status.is_none();
    let active_session_count = usize::from(
        facts
            .root_status
            .is_some_and(|session| !session_is_quiescent(session)),
    ) + facts
        .worker_sessions
        .iter()
        .filter(|session| !session_is_quiescent(session.status))
        .count();
    let inconsistent = root_session_missing
        || active_session_count > 0
        || facts.unresolved_task_count > 0
        || facts.corrupt_task_count > 0
        || facts.blocking_unread_inbox_count > 0
        || facts.in_flight_turn_intent_count > 0
        || facts.unknown_turn_intent_count > 0
        || facts.pending_formal_materialization_count > 0
        || facts.active_recovery_reservation_count > 0
        || facts.pending_plan_approval_count > 0;
    inconsistent.then_some(AgentOrgQuiescenceBlocker::QuietStateInconsistent {
        status,
        root_session_missing,
        active_session_count,
        open_task_count: facts.unresolved_task_count,
        corrupt_task_count: facts.corrupt_task_count,
        unread_inbox_count: facts.blocking_unread_inbox_count,
        in_flight_turn_intent_count: facts.in_flight_turn_intent_count,
        unknown_turn_intent_count: facts.unknown_turn_intent_count,
        pending_formal_materialization_count: facts.pending_formal_materialization_count,
        active_recovery_reservation_count: facts.active_recovery_reservation_count,
        pending_plan_approval_count: facts.pending_plan_approval_count,
    })
}

pub(super) fn session_is_quiescent(status: SessionStatus) -> bool {
    matches!(
        status,
        SessionStatus::Idle
            | SessionStatus::Completed
            | SessionStatus::Failed
            | SessionStatus::Cancelled
            | SessionStatus::Abandoned
            | SessionStatus::Timeout
            | SessionStatus::Archived
    )
}

fn count_to_usize(label: &str, count: i64) -> Result<usize, String> {
    usize::try_from(count).map_err(|_| format!("invalid {label} count: {count}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn completed_board_facts(
        presented_revision: Option<i64>,
        worker_status: SessionStatus,
    ) -> AgentOrgQuiescenceFacts {
        AgentOrgQuiescenceFacts {
            run_status: Some(AgentOrgRunStatus::Running),
            activation_generation: Some(1),
            root_session_id: Some("root".to_string()),
            root_status: Some(SessionStatus::Running),
            worker_sessions: vec![AgentOrgQuiescenceSessionFact {
                session_id: "worker".to_string(),
                member_id: Some("member".to_string()),
                status: worker_status,
            }],
            task_count: 1,
            unresolved_task_count: 0,
            corrupt_task_count: 0,
            pending_task_count: 0,
            in_progress_task_count: 0,
            completed_task_count: 1,
            unresolved_handoff_count: 0,
            unread_inbox_count: 0,
            blocking_unread_inbox_count: 0,
            in_flight_turn_intent_count: 0,
            unknown_turn_intent_count: 0,
            pending_formal_materialization_count: 0,
            active_recovery_reservation_count: 0,
            pending_plan_approval_count: 0,
            progress: Some(AgentOrgRunProgress {
                org_run_id: "run".to_string(),
                work_revision: 2,
                coordinator_presented_work_revision: presented_revision,
                coordinator_observed_work_revision: Some(1),
                completion_requested: false,
                completion_requested_at: None,
                completion_requested_work_revision: None,
                completion_summary: None,
                updated_at: chrono::Utc::now().to_rfc3339(),
            }),
            completion_certificate: Some(
                crate::coordination::agent_org_run_completion::RunCompletionCertificate {
                    id: "certificate".to_string(),
                    org_run_id: "run".to_string(),
                    activation_generation: 1,
                    work_revision: 2,
                    request_id: "request".to_string(),
                    request_digest: "0".repeat(64),
                    outcome: crate::coordination::agent_org_run_completion::RunCompletionOutcome::Delivered,
                    summary: "done".to_string(),
                    coordinator_session_id: "root".to_string(),
                    coordinator_turn_intent_id: "turn".to_string(),
                    evidence_task_ids: Vec::new(),
                    closure_task_ids: vec!["task".to_string()],
                    task_output_refs: Vec::new(),
                    resolution_links: Vec::new(),
                    validator_version: 1,
                    created_at: chrono::Utc::now().to_rfc3339(),
                },
            ),
            final_summary_receipt: None,
            completion_publication_complete: true,
        }
    }

    #[test]
    fn prospective_certificate_allows_current_coordinator_turn_only() {
        let assessment = assess_quiescence(completed_board_facts(Some(2), SessionStatus::Idle));
        assert_eq!(assessment.decision, AgentOrgQuiescenceDecision::KeepWorking);
        let prospective = assessment.after_successful_coordinator_turn();
        assert_eq!(prospective.decision, AgentOrgQuiescenceDecision::Quiescent);
        assert!(prospective.blockers.is_empty());
    }

    #[test]
    fn prospective_certificate_rejects_stale_presented_revision() {
        let assessment = assess_quiescence(completed_board_facts(Some(1), SessionStatus::Idle));
        let prospective = assessment.after_successful_coordinator_turn();
        assert_eq!(
            prospective.decision,
            AgentOrgQuiescenceDecision::KeepWorking
        );
        assert!(prospective.blockers.iter().any(|blocker| matches!(
            blocker,
            AgentOrgQuiescenceBlocker::CoordinatorHasNotObservedLatestWork { .. }
        )));
    }

    #[test]
    fn certificate_cannot_quiesce_before_its_final_event_is_durable() {
        let mut facts = completed_board_facts(Some(2), SessionStatus::Idle);
        facts.completion_publication_complete = false;
        let prospective = assess_quiescence(facts).after_successful_coordinator_turn();
        assert_eq!(
            prospective.decision,
            AgentOrgQuiescenceDecision::KeepWorking
        );
        assert!(prospective.blockers.iter().any(|blocker| matches!(
            blocker,
            AgentOrgQuiescenceBlocker::CompletionCertificateNotPublished
        )));
    }

    #[test]
    fn prospective_certificate_never_hides_active_worker() {
        let assessment = assess_quiescence(completed_board_facts(Some(2), SessionStatus::Running));
        let prospective = assessment.after_successful_coordinator_turn();
        assert_eq!(
            prospective.decision,
            AgentOrgQuiescenceDecision::KeepWorking
        );
        assert!(prospective.blockers.iter().any(|blocker| matches!(
            blocker,
            AgentOrgQuiescenceBlocker::SessionsActive { session_ids }
                if session_ids == &["worker".to_string()]
        )));
    }

    #[test]
    fn exact_member_idle_effect_projects_only_that_worker_turn_terminal() {
        let mut facts = completed_board_facts(Some(2), SessionStatus::Running);
        facts.unread_inbox_count = 1;
        facts.blocking_unread_inbox_count = 1;
        facts.in_flight_turn_intent_count = 2;
        let assessment = assess_quiescence(facts);

        let without_idle = assessment.after_successful_coordinator_turn_with_effects(
            AgentOrgGuaranteedTurnEffects {
                current_coordinator_turn: true,
                in_flight_turn_intents: 1,
                unread_inbox_rows: 1,
                ..AgentOrgGuaranteedTurnEffects::default()
            },
        );
        assert_eq!(
            without_idle.decision,
            AgentOrgQuiescenceDecision::KeepWorking
        );

        let with_idle = assessment.after_successful_coordinator_turn_with_effects(
            AgentOrgGuaranteedTurnEffects {
                current_coordinator_turn: true,
                in_flight_turn_intents: 1,
                unread_inbox_rows: 1,
                terminal_member_ids: vec!["member".to_string()],
                terminal_worker_turn_intents: 1,
            },
        );
        assert_eq!(with_idle.decision, AgentOrgQuiescenceDecision::Quiescent);
        assert!(with_idle.blockers.is_empty());
    }

    #[test]
    fn guaranteed_effects_map_only_a_fresh_system_member_idle_to_the_active_worker_turn() {
        let conn = Connection::open_in_memory().expect("in-memory sqlite");
        conn.execute_batch(
            "CREATE TABLE session_turn_intents(
                 session_id TEXT,turn_intent_id TEXT,org_run_id TEXT,
                 status TEXT,created_at TEXT
             );
             CREATE TABLE agent_org_runtime_turn_contexts(
                 session_id TEXT,turn_intent_id TEXT,org_run_id TEXT,
                 turn_kind TEXT,participant_id TEXT
             );
             CREATE TABLE agent_org_runtime_inbox(
                 id INTEGER PRIMARY KEY,org_run_id TEXT,read_at TEXT,
                 payload_kind TEXT,payload_json TEXT,sender_agent_id TEXT,created_at TEXT,
                 delivery_class TEXT NOT NULL DEFAULT 'formal_work'
             );
             CREATE TABLE agent_org_runtime_inbox_materializations(
                 inbox_id INTEGER,session_id TEXT
             );
             CREATE TABLE agent_org_runtime_inbox_delivery_resolutions(inbox_id INTEGER);
             INSERT INTO session_turn_intents VALUES
                 ('root','root-turn','run','running','2026-01-01T00:00:00Z'),
                 ('worker','worker-turn','run','running','2026-01-01T00:00:01Z');
             INSERT INTO agent_org_runtime_turn_contexts VALUES
                 ('root','root-turn','run','coordinator','coordinator'),
                 ('worker','worker-turn','run','task_execution','member');
             INSERT INTO agent_org_runtime_inbox_materializations VALUES (7,'root');",
        )
        .expect("minimal durable facts");
        let idle = serde_json::to_string(
            &crate::coordination::agent_inbox::AgentMessage::MemberIdle {
                member_id: "member".to_string(),
                member_name: "Worker".to_string(),
                reason: crate::coordination::agent_inbox::MemberIdleReason::Available,
                current_mode: Some(crate::session::AgentExecMode::Build),
                summary: None,
                failure_reason: None,
                unfinished_task_ids: Vec::new(),
            },
        )
        .expect("member idle json");
        conn.execute(
            "INSERT INTO agent_org_runtime_inbox(
                 id,org_run_id,read_at,payload_kind,payload_json,sender_agent_id,created_at
             ) VALUES (7,'run',NULL,'member_idle',?1,'_system','2026-01-01T00:00:02Z')",
            [&idle],
        )
        .expect("fresh idle row");

        let effects = guaranteed_current_turn_effects_with_connection(
            &conn,
            "run",
            Some("root"),
            "root",
            "root-turn",
            &[7],
        )
        .expect("project exact current batch");
        assert_eq!(effects.unread_inbox_rows, 1);
        assert_eq!(effects.terminal_member_ids, vec!["member"]);
        assert_eq!(effects.terminal_worker_turn_intents, 1);

        conn.execute(
            "UPDATE agent_org_runtime_inbox SET created_at='2025-12-31T23:59:59Z' WHERE id=7",
            [],
        )
        .expect("make the idle row stale");
        let stale = guaranteed_current_turn_effects_with_connection(
            &conn,
            "run",
            Some("root"),
            "root",
            "root-turn",
            &[7],
        )
        .expect("stale row still drains but proves no current worker terminal");
        assert_eq!(stale.unread_inbox_rows, 1);
        assert!(stale.terminal_member_ids.is_empty());
        assert_eq!(stale.terminal_worker_turn_intents, 0);
    }

    #[test]
    fn idle_run_stays_quiescent_but_reports_inconsistent_retained_facts() {
        let mut facts = completed_board_facts(Some(2), SessionStatus::Idle);
        facts.run_status = Some(AgentOrgRunStatus::Idle);
        facts.root_status = Some(SessionStatus::Idle);
        facts.unresolved_task_count = 1;
        facts.corrupt_task_count = 1;
        facts.unread_inbox_count = 2;
        facts.blocking_unread_inbox_count = 2;

        let assessment = assess_quiescence(facts);
        assert_eq!(assessment.decision, AgentOrgQuiescenceDecision::Quiescent);
        assert!(matches!(
            assessment.blockers.as_slice(),
            [AgentOrgQuiescenceBlocker::QuietStateInconsistent {
                status: AgentOrgRunStatus::Idle,
                open_task_count: 1,
                corrupt_task_count: 1,
                unread_inbox_count: 2,
                ..
            }]
        ));
    }

    #[test]
    fn unknown_turn_materialization_and_reservation_fail_closed() {
        let mut facts = completed_board_facts(Some(2), SessionStatus::Idle);
        facts.root_status = Some(SessionStatus::Idle);
        facts
            .progress
            .as_mut()
            .expect("progress")
            .coordinator_observed_work_revision = Some(2);
        facts.unknown_turn_intent_count = 1;
        facts.pending_formal_materialization_count = 1;
        facts.active_recovery_reservation_count = 1;

        let assessment = assess_quiescence(facts);
        assert_eq!(assessment.decision, AgentOrgQuiescenceDecision::KeepWorking);
        assert!(assessment.blockers.iter().any(|blocker| matches!(
            blocker,
            AgentOrgQuiescenceBlocker::UnknownTurnIntents { count: 1 }
        )));
        assert!(assessment.blockers.iter().any(|blocker| matches!(
            blocker,
            AgentOrgQuiescenceBlocker::PendingFormalMaterializations { count: 1 }
        )));
        assert!(assessment.blockers.iter().any(|blocker| matches!(
            blocker,
            AgentOrgQuiescenceBlocker::ActiveRecoveryReservations { count: 1 }
        )));
    }
}

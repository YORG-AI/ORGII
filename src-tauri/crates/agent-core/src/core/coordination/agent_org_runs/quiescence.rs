//! Canonical Agent Org formal-work quiescence facts and decision policy.
//!
//! Every caller (watchdog inspection, lifecycle reconciliation, completion
//! snapshots) must reason from this same typed assessment. This prevents a
//! weaker pre-check from declaring a terminal candidate that the atomic
//! reconciler then rejects for a different set of rules.

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
    pub unread_inbox_count: usize,
    pub active_intervention_member_ids: Vec<String>,
    pub in_flight_turn_intent_count: usize,
    pub unknown_turn_intent_count: usize,
    pub pending_formal_materialization_count: usize,
    pub active_recovery_reservation_count: usize,
    pub pending_plan_approval_count: usize,
    pub progress: Option<AgentOrgRunProgress>,
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
    ActiveInterventions {
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
        active_intervention_count: usize,
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
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AgentOrgGuaranteedTurnEffects {
    pub current_coordinator_turn: bool,
    pub in_flight_turn_intents: usize,
    pub unread_inbox_rows: usize,
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
        let mut blockers = Vec::new();
        for blocker in &self.blockers {
            match blocker {
                AgentOrgQuiescenceBlocker::SessionsActive { session_ids } => {
                    let remaining = session_ids
                        .iter()
                        .filter(|session_id| Some(session_id.as_str()) != root_session_id)
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
                    let remaining = count.saturating_sub(effects.in_flight_turn_intents);
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
    let mut stmt = conn
        .prepare(
            "SELECT EXISTS(
                 SELECT 1
                 FROM agent_org_runtime_inbox inbox
                 JOIN agent_org_runtime_inbox_materializations receipt
                   ON receipt.inbox_id=inbox.id AND receipt.session_id=?2
                 WHERE inbox.id=?1 AND inbox.org_run_id=?3 AND inbox.read_at IS NULL
                   AND NOT EXISTS (
                       SELECT 1 FROM agent_org_runtime_inbox_delivery_resolutions resolution
                       WHERE resolution.inbox_id=inbox.id
                   )
             )",
        )
        .map_err(|err| err.to_string())?;
    for inbox_id in unique_ids {
        let is_guaranteed: bool = stmt
            .query_row(params![inbox_id, dispatching_session_id, run_id], |row| {
                row.get(0)
            })
            .map_err(|err| err.to_string())?;
        unread_inbox_rows += usize::from(is_guaranteed);
    }

    Ok(AgentOrgGuaranteedTurnEffects {
        current_coordinator_turn: in_flight_turn_intents,
        in_flight_turn_intents: usize::from(in_flight_turn_intents),
        unread_inbox_rows,
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
            unread_inbox_count: 0,
            active_intervention_member_ids: Vec::new(),
            in_flight_turn_intent_count: 0,
            unknown_turn_intent_count: 0,
            pending_formal_materialization_count: 0,
            active_recovery_reservation_count: 0,
            pending_plan_approval_count: 0,
            progress: None,
        }));
    };
    let run_status = AgentOrgRunStatus::parse(&run_status_raw)
        .ok_or_else(|| format!("unknown Agent Org run status: {run_status_raw}"))?;

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
    let worker_sessions =
        AgentOrgRunStore::list_descendant_worker_sessions_with_connection(conn, run_id)?
            .into_iter()
            .map(|session| AgentOrgQuiescenceSessionFact {
                session_id: session.session_id,
                member_id: session.member_id,
                status: session.status,
            })
            .collect();

    let corrupt_task_predicate =
        crate::coordination::agent_org_tasks::corrupt_task_row_predicate_sql();
    let persisted_open_task_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM agent_org_runtime_tasks
             WHERE org_run_id=?1 AND status IN ('pending','in_progress')",
            params![run_id],
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
                    CASE WHEN length(CAST(blocked_by_json AS BLOB))<={dependency_json_max}
                         THEN blocked_by_json ELSE '!' END AS blocked_by_json,
                    CASE WHEN metadata_json IS NULL
                              OR length(CAST(metadata_json AS BLOB))<={metadata_max}
                         THEN metadata_json ELSE '!' END AS metadata_json
             FROM agent_org_runtime_tasks WHERE org_run_id=?1
         ) AS bounded_tasks"
    );
    let (
        task_count,
        unresolved_task_count,
        corrupt_task_count,
        pending_task_count,
        in_progress_task_count,
        completed_task_count,
    ): (i64, i64, i64, i64, i64, i64) = conn
        .query_row(&task_counts_sql, params![run_id], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
            ))
        })
        .map_err(|err| err.to_string())?;
    let unread_inbox_count: i64 = conn
        .query_row(
            "SELECT COUNT(*)
             FROM agent_org_runtime_inbox
             WHERE org_run_id=?1 AND read_at IS NULL
               AND NOT EXISTS (
                   SELECT 1 FROM agent_org_runtime_inbox_delivery_resolutions resolution
                   WHERE resolution.inbox_id=agent_org_runtime_inbox.id
               )",
            params![run_id],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())?;
    let active_intervention_member_ids = {
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT member_id FROM agent_org_runtime_member_interventions
                 WHERE org_run_id=?1 AND member_id<>'coordinator'
                   AND cleared_at IS NULL
                   AND datetime(resume_after)>datetime(?2)
                 ORDER BY member_id ASC",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(params![run_id, chrono::Utc::now().to_rfc3339()], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|err| err.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())?
    };
    let in_flight_turn_intent_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM session_turn_intents
             WHERE org_run_id=?1 AND status IN (?2, ?3, ?4)",
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
            "SELECT COUNT(*) FROM session_turn_intents
             WHERE org_run_id=?1
               AND status NOT IN (
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
            "SELECT COUNT(*) FROM agent_org_runtime_plan_approvals
             WHERE org_run_id=?1 AND status='pending'",
            params![run_id],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())?;

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
        unread_inbox_count: count_to_usize("unread inbox", unread_inbox_count)?,
        active_intervention_member_ids,
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
    if facts.unread_inbox_count > 0 {
        blockers.push(AgentOrgQuiescenceBlocker::UnreadInbox {
            count: facts.unread_inbox_count,
        });
    }
    if !facts.active_intervention_member_ids.is_empty() {
        blockers.push(AgentOrgQuiescenceBlocker::ActiveInterventions {
            count: facts.active_intervention_member_ids.len(),
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
            if facts.task_count == 0 {
                if !progress.completion_requested {
                    blockers
                        .push(AgentOrgQuiescenceBlocker::EmptyTaskBoardRequiresCompletionIntent);
                } else if progress.completion_requested_work_revision
                    != Some(progress.work_revision)
                {
                    blockers.push(AgentOrgQuiescenceBlocker::StaleCompletionIntent {
                        requested_work_revision: progress.completion_requested_work_revision,
                        current_work_revision: progress.work_revision,
                    });
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
        || facts.unread_inbox_count > 0
        || !facts.active_intervention_member_ids.is_empty()
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
        unread_inbox_count: facts.unread_inbox_count,
        active_intervention_count: facts.active_intervention_member_ids.len(),
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
            unread_inbox_count: 0,
            active_intervention_member_ids: Vec::new(),
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
    fn idle_run_stays_quiescent_but_reports_inconsistent_retained_facts() {
        let mut facts = completed_board_facts(Some(2), SessionStatus::Idle);
        facts.run_status = Some(AgentOrgRunStatus::Idle);
        facts.root_status = Some(SessionStatus::Idle);
        facts.unresolved_task_count = 1;
        facts.corrupt_task_count = 1;
        facts.unread_inbox_count = 2;

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

//! Stable public blocker projection for Agent Org runtime convergence.
//!
//! Completion tools, Run View, logs, and UI all consume this one bounded
//! projection. IDs are operational identities only; prompt/message content is
//! intentionally excluded from this DTO.

use rusqlite::{params, Connection};
use serde::Serialize;

const BLOCKER_ID_LIMIT: usize = 16;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOrgRunWorkState {
    pub active_members: usize,
    pub in_flight_turns: usize,
    pub open_tasks: usize,
    pub blocking_inbox: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentOrgRunBlockerKind {
    ActiveMembers,
    InFlightTurns,
    OpenTasks,
    BlockingInbox,
    CorruptTaskData,
    UnknownTurnIntents,
    PendingFormalMaterializations,
    ActiveRecoveryReservations,
    PendingPlanApprovals,
    UnresolvedTaskHandoffs,
    StaleCompletionCertificate,
    TaskClosureIncomplete,
    InvalidScopeRemoval,
    InvalidReplacementChain,
    CompletionValidation,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOrgRunBlockerObject {
    pub object_kind: &'static str,
    pub id: String,
    pub display_name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentOrgRunBlockerRecoveryState {
    WaitingForRuntime,
    SystemRepairing,
    CoordinatorRepairAvailable,
    SystemAttentionRequired,
    UserActionRequired,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOrgRunBlocker {
    pub kind: AgentOrgRunBlockerKind,
    pub count: usize,
    pub objects: Vec<AgentOrgRunBlockerObject>,
    pub has_more: bool,
    pub display: String,
    pub reason_code: &'static str,
    pub source: &'static str,
    pub recovery_state: AgentOrgRunBlockerRecoveryState,
    pub requires_user_action: bool,
    pub user_action: Option<&'static str>,
}

pub fn work_state(
    quiescence: &super::agent_org_runs::AgentOrgQuiescenceAssessment,
) -> AgentOrgRunWorkState {
    AgentOrgRunWorkState {
        active_members: quiescence.facts.active_member_ids().len(),
        in_flight_turns: quiescence.facts.in_flight_turn_intent_count,
        open_tasks: quiescence.facts.unresolved_task_count,
        blocking_inbox: quiescence.facts.blocking_unread_inbox_count,
    }
}

pub fn build_with_connection(
    conn: &Connection,
    org_run_id: &str,
    quiescence: &super::agent_org_runs::AgentOrgQuiescenceAssessment,
) -> Result<Vec<AgentOrgRunBlocker>, String> {
    let mut blockers = Vec::new();
    let active_member_ids = quiescence.facts.active_member_ids();
    if !active_member_ids.is_empty() {
        blockers.push(blocker(
            AgentOrgRunBlockerKind::ActiveMembers,
            active_member_ids.len(),
            identity_objects("member", active_member_ids),
            "Members are still active",
            "agent_org_active_members",
            "agent_org_runtime_sessions",
            AgentOrgRunBlockerRecoveryState::WaitingForRuntime,
            None,
        ));
    }
    if quiescence.facts.in_flight_turn_intent_count > 0 {
        blockers.push(blocker(
            AgentOrgRunBlockerKind::InFlightTurns,
            quiescence.facts.in_flight_turn_intent_count,
            load_in_flight_turn_objects(conn, org_run_id)?,
            "Turns are still in flight",
            "agent_org_in_flight_turns",
            "session_turn_intents",
            AgentOrgRunBlockerRecoveryState::WaitingForRuntime,
            None,
        ));
    }
    if quiescence.facts.unresolved_task_count > 0 {
        blockers.push(blocker(
            AgentOrgRunBlockerKind::OpenTasks,
            quiescence.facts.unresolved_task_count,
            load_open_task_objects(conn, org_run_id)?,
            "Tasks are still open",
            "agent_org_open_tasks",
            "agent_org_runtime_tasks",
            AgentOrgRunBlockerRecoveryState::WaitingForRuntime,
            None,
        ));
    }
    if quiescence.facts.blocking_unread_inbox_count > 0 {
        blockers.extend(blocking_inbox_blockers(
            conn,
            org_run_id,
            quiescence.facts.blocking_unread_inbox_count,
        )?);
    }
    append_system_blockers(conn, org_run_id, quiescence, &mut blockers)?;
    Ok(blockers)
}

/// Convert the certificate owner's exact candidate assessment into the same
/// public DTO used by Run View and the completion tool. Guaranteed effects
/// have already been subtracted by the assessment, so its counts remain the
/// authority while bounded object lookups only add safe display identity.
pub fn build_from_candidate_with_connection(
    conn: &Connection,
    org_run_id: &str,
    assessment: &super::agent_org_run_completion::RunCompletionCandidateAssessment,
) -> Result<Vec<AgentOrgRunBlocker>, String> {
    use super::agent_org_run_completion::RunCompletionCandidateBlocker as Candidate;

    let mut blockers = Vec::new();
    for candidate in &assessment.blockers {
        let detail = match candidate {
            Candidate::RunUnavailable => blocker(
                AgentOrgRunBlockerKind::CompletionValidation,
                1,
                run_objects(org_run_id),
                "The Team is not available for completion",
                "run_completion_run_unavailable",
                "agent_org_runtime_runs",
                AgentOrgRunBlockerRecoveryState::SystemAttentionRequired,
                None,
            ),
            Candidate::StaleCoordinatorSnapshot => blocker(
                AgentOrgRunBlockerKind::CompletionValidation,
                1,
                run_objects(org_run_id),
                "The Coordinator view is stale",
                "run_completion_stale_coordinator_snapshot",
                "agent_org_runtime_turn_contexts",
                AgentOrgRunBlockerRecoveryState::SystemAttentionRequired,
                None,
            ),
            Candidate::SessionsActive { count, member_ids } => blocker(
                AgentOrgRunBlockerKind::ActiveMembers,
                *count,
                identity_objects("member", member_ids.clone()),
                "Members are still active",
                "agent_org_active_members",
                "agent_org_runtime_sessions",
                AgentOrgRunBlockerRecoveryState::WaitingForRuntime,
                None,
            ),
            Candidate::CorruptTaskData { count } => blocker(
                AgentOrgRunBlockerKind::CorruptTaskData,
                *count,
                run_objects(org_run_id),
                "Task data needs system repair",
                "agent_org_corrupt_task_data",
                "agent_org_runtime_tasks",
                AgentOrgRunBlockerRecoveryState::SystemAttentionRequired,
                None,
            ),
            Candidate::UnknownTurnIntents { count } => blocker(
                AgentOrgRunBlockerKind::UnknownTurnIntents,
                *count,
                bounded_for_count(load_unknown_turn_objects(conn, org_run_id)?, *count),
                "Turns are in an unknown state",
                "agent_org_unknown_turn_intents",
                "session_turn_intents",
                AgentOrgRunBlockerRecoveryState::SystemAttentionRequired,
                None,
            ),
            Candidate::PendingFormalMaterializations { count } => blocker(
                AgentOrgRunBlockerKind::PendingFormalMaterializations,
                *count,
                bounded_for_count(
                    load_pending_materialization_objects(conn, org_run_id)?,
                    *count,
                ),
                "Member startup is still being reconciled",
                "agent_org_pending_formal_materializations",
                "agent_org_runtime_member_materializations",
                AgentOrgRunBlockerRecoveryState::WaitingForRuntime,
                None,
            ),
            Candidate::ActiveRecoveryReservations { count } => blocker(
                AgentOrgRunBlockerKind::ActiveRecoveryReservations,
                *count,
                bounded_for_count(load_recovery_objects(conn, org_run_id)?, *count),
                "System recovery is in progress",
                "agent_org_active_recovery_reservations",
                "agent_org_runtime_recovery_attempts",
                AgentOrgRunBlockerRecoveryState::SystemRepairing,
                None,
            ),
            Candidate::PendingPlanApprovals { count } => {
                pending_plan_approval_blocker(conn, org_run_id, *count)?
            }
            Candidate::UnreadInbox { count } => {
                blockers.extend(blocking_inbox_blockers(conn, org_run_id, *count)?);
                continue;
            }
            Candidate::InFlightTurnIntents { count } => blocker(
                AgentOrgRunBlockerKind::InFlightTurns,
                *count,
                bounded_for_count(load_in_flight_turn_objects(conn, org_run_id)?, *count),
                "Turns are still in flight",
                "agent_org_in_flight_turns",
                "session_turn_intents",
                AgentOrgRunBlockerRecoveryState::WaitingForRuntime,
                None,
            ),
            Candidate::OpenTasks { count, task_ids } => blocker(
                AgentOrgRunBlockerKind::OpenTasks,
                *count,
                identity_objects("task", task_ids.clone()),
                "Tasks are still open",
                "agent_org_open_tasks",
                "agent_org_runtime_tasks",
                AgentOrgRunBlockerRecoveryState::WaitingForRuntime,
                None,
            ),
            Candidate::UnresolvedTaskHandoffs { count } => blocker(
                AgentOrgRunBlockerKind::UnresolvedTaskHandoffs,
                *count,
                bounded_for_count(load_handoff_objects(conn, org_run_id)?, *count),
                "A task handoff is unresolved",
                "agent_org_unresolved_task_handoffs",
                "agent_org_runtime_task_execution_handoffs",
                AgentOrgRunBlockerRecoveryState::UserActionRequired,
                Some("review_handoff"),
            ),
            Candidate::StaleCompletionCertificate {
                certificate_work_revision,
                current_work_revision,
            } => blocker(
                AgentOrgRunBlockerKind::StaleCompletionCertificate,
                1,
                vec![AgentOrgRunBlockerObject {
                    object_kind: "run",
                    id: org_run_id.to_string(),
                    display_name: format!(
                        "revision {certificate_work_revision} → {current_work_revision}"
                    ),
                }],
                "Completion evidence is stale",
                "agent_org_stale_completion_certificate",
                "agent_org_runtime_run_completion_certificates",
                AgentOrgRunBlockerRecoveryState::SystemAttentionRequired,
                None,
            ),
            Candidate::TaskClosureIncomplete { count, task_ids } => blocker(
                AgentOrgRunBlockerKind::TaskClosureIncomplete,
                *count,
                identity_objects("task", task_ids.clone()),
                "Task closure evidence is incomplete",
                "run_completion_delivery_closure_incomplete",
                "agent_org_runtime_tasks",
                AgentOrgRunBlockerRecoveryState::UserActionRequired,
                Some("review_tasks"),
            ),
            Candidate::InvalidScopeRemoval { task_ids } => blocker(
                AgentOrgRunBlockerKind::InvalidScopeRemoval,
                task_ids.len().max(1),
                identity_objects("task", task_ids.clone()),
                "Task scope-removal evidence is invalid",
                "run_completion_scope_removal_invalid",
                "agent_org_runtime_tasks",
                AgentOrgRunBlockerRecoveryState::UserActionRequired,
                Some("review_tasks"),
            ),
            Candidate::InvalidReplacementChain { task_ids } => blocker(
                AgentOrgRunBlockerKind::InvalidReplacementChain,
                task_ids.len().max(1),
                identity_objects("task", task_ids.clone()),
                "Task replacement evidence is invalid",
                "run_completion_replacement_chain_invalid",
                "agent_org_runtime_tasks",
                AgentOrgRunBlockerRecoveryState::UserActionRequired,
                Some("review_tasks"),
            ),
            Candidate::ValidationError => blocker(
                AgentOrgRunBlockerKind::CompletionValidation,
                1,
                run_objects(org_run_id),
                "Completion validation needs system attention",
                "run_completion_validation_failed",
                "agent_org_run_completion",
                AgentOrgRunBlockerRecoveryState::SystemAttentionRequired,
                None,
            ),
        };
        blockers.push(detail);
    }
    Ok(blockers)
}

// Keeping construction centralized makes every blocker carry the same public
// recovery contract. The fields deliberately mirror that DTO, so grouping them
// into an opaque bag would make call sites harder to audit.
#[allow(clippy::too_many_arguments)]
fn blocker(
    kind: AgentOrgRunBlockerKind,
    count: usize,
    mut objects: Vec<AgentOrgRunBlockerObject>,
    display: &str,
    reason_code: &'static str,
    source: &'static str,
    recovery_state: AgentOrgRunBlockerRecoveryState,
    user_action: Option<&'static str>,
) -> AgentOrgRunBlocker {
    let has_more = objects.len() < count || objects.len() > BLOCKER_ID_LIMIT;
    objects.truncate(BLOCKER_ID_LIMIT);
    let requires_user_action = user_action.is_some();
    AgentOrgRunBlocker {
        kind,
        count,
        objects,
        has_more,
        display: display.to_string(),
        reason_code,
        source,
        recovery_state,
        requires_user_action,
        user_action,
    }
}

fn append_system_blockers(
    conn: &Connection,
    org_run_id: &str,
    quiescence: &super::agent_org_runs::AgentOrgQuiescenceAssessment,
    blockers: &mut Vec<AgentOrgRunBlocker>,
) -> Result<(), String> {
    let facts = &quiescence.facts;
    if facts.corrupt_task_count > 0 {
        let predicate = crate::coordination::agent_org_tasks::corrupt_task_row_predicate_sql();
        let sql = format!(
            "SELECT task.id,task.subject FROM agent_org_runtime_tasks task
             WHERE task.org_run_id=?1 AND (
                 {predicate}
                 OR NOT EXISTS (
                     SELECT 1 FROM agent_org_runtime_work_episode_tasks episode_task
                     WHERE episode_task.org_run_id=task.org_run_id
                       AND episode_task.task_id=task.id
                 )
             ) ORDER BY task.id LIMIT ?2"
        );
        let mut objects = load_objects(conn, &sql, org_run_id, "task")?;
        if objects.is_empty() {
            objects = identity_objects("run", vec![org_run_id.to_string()]);
        }
        blockers.push(blocker(
            AgentOrgRunBlockerKind::CorruptTaskData,
            facts.corrupt_task_count,
            objects,
            "Task data needs system repair",
            "agent_org_corrupt_task_data",
            "agent_org_runtime_tasks",
            AgentOrgRunBlockerRecoveryState::SystemAttentionRequired,
            None,
        ));
    }
    if facts.unknown_turn_intent_count > 0 {
        blockers.push(blocker(
            AgentOrgRunBlockerKind::UnknownTurnIntents,
            facts.unknown_turn_intent_count,
            load_objects(
                conn,
                "SELECT intent.turn_intent_id,context.participant_id || ' turn'
                 FROM session_turn_intents intent
                 JOIN agent_org_runtime_turn_contexts context
                   ON context.session_id=intent.session_id
                  AND context.turn_intent_id=intent.turn_intent_id
                 WHERE intent.org_run_id=?1
                   AND intent.status NOT IN (
                       'optimistic','queued','running','completed','failed',
                       'cancelled','stale','coalesced','rejected'
                   )
                 ORDER BY intent.updated_at,intent.turn_intent_id LIMIT ?2",
                org_run_id,
                "turn",
            )?,
            "Turns are in an unknown state",
            "agent_org_unknown_turn_intents",
            "session_turn_intents",
            AgentOrgRunBlockerRecoveryState::SystemAttentionRequired,
            None,
        ));
    }
    if facts.pending_formal_materialization_count > 0 {
        blockers.push(blocker(
            AgentOrgRunBlockerKind::PendingFormalMaterializations,
            facts.pending_formal_materialization_count,
            load_objects(
                conn,
                "SELECT member_id,member_id
                 FROM agent_org_runtime_member_materializations
                 WHERE org_run_id=?1
                   AND generation=(
                       SELECT activation_generation
                       FROM agent_org_runtime_runs WHERE id=?1
                   )
                   AND authority_class IN ('starting','formal')
                   AND status<>'succeeded'
                 ORDER BY generation,member_id LIMIT ?2",
                org_run_id,
                "member",
            )?,
            "Member startup is still being reconciled",
            "agent_org_pending_formal_materializations",
            "agent_org_runtime_member_materializations",
            AgentOrgRunBlockerRecoveryState::WaitingForRuntime,
            None,
        ));
    }
    if facts.active_recovery_reservation_count > 0 {
        blockers.push(blocker(
            AgentOrgRunBlockerKind::ActiveRecoveryReservations,
            facts.active_recovery_reservation_count,
            load_objects(
                conn,
                "SELECT target_key,action_kind || ' → ' || target_key
                 FROM agent_org_runtime_recovery_attempts
                 WHERE org_run_id=?1 AND reservation_token IS NOT NULL
                 ORDER BY action_kind,target_key LIMIT ?2",
                org_run_id,
                "recovery",
            )?,
            "System recovery is in progress",
            "agent_org_active_recovery_reservations",
            "agent_org_runtime_recovery_attempts",
            AgentOrgRunBlockerRecoveryState::SystemRepairing,
            None,
        ));
    }
    if facts.pending_plan_approval_count > 0 {
        blockers.push(pending_plan_approval_blocker(
            conn,
            org_run_id,
            facts.pending_plan_approval_count,
        )?);
    }
    if facts.unresolved_handoff_count > 0 {
        blockers.push(blocker(
            AgentOrgRunBlockerKind::UnresolvedTaskHandoffs,
            facts.unresolved_handoff_count,
            load_objects(
                conn,
                "SELECT handoff.id,handoff.old_task_id || ' handoff'
                 FROM agent_org_runtime_task_execution_handoffs handoff
                 WHERE handoff.org_run_id=?1
                   AND handoff.state IN ('requested','yielding','timeout','unknown','failed')
                   AND handoff.resolution IS NULL
                   AND EXISTS (
                       SELECT 1
                       FROM agent_org_runtime_work_episode_tasks episode_task
                       JOIN agent_org_runtime_work_episodes episode
                         ON episode.id=episode_task.work_episode_id
                       WHERE episode_task.org_run_id=handoff.org_run_id
                         AND episode_task.task_id=handoff.old_task_id
                         AND episode.status='active'
                   )
                 ORDER BY handoff.requested_at,handoff.id LIMIT ?2",
                org_run_id,
                "handoff",
            )?,
            "A task handoff is unresolved",
            "agent_org_unresolved_task_handoffs",
            "agent_org_runtime_task_execution_handoffs",
            AgentOrgRunBlockerRecoveryState::UserActionRequired,
            Some("review_handoff"),
        ));
    }
    if let (Some(certificate), Some(progress)) = (
        facts.completion_certificate.as_ref(),
        facts.progress.as_ref(),
    ) {
        if certificate.work_revision != progress.work_revision {
            blockers.push(blocker(
                AgentOrgRunBlockerKind::StaleCompletionCertificate,
                1,
                vec![AgentOrgRunBlockerObject {
                    object_kind: "completion_certificate",
                    id: certificate.id.clone(),
                    display_name: format!(
                        "revision {} → {}",
                        certificate.work_revision, progress.work_revision
                    ),
                }],
                "Completion evidence is stale",
                "agent_org_stale_completion_certificate",
                "agent_org_runtime_run_completion_certificates",
                AgentOrgRunBlockerRecoveryState::SystemAttentionRequired,
                None,
            ));
        }
    }
    Ok(())
}

pub fn append_completion_failure(blockers: &mut Vec<AgentOrgRunBlocker>, error: &str) {
    let (kind, prefix, display, reason_code, source, recovery_state, action) =
        if let Some(ids) = error.strip_prefix("run_completion_delivery_closure_incomplete:") {
            (
                AgentOrgRunBlockerKind::TaskClosureIncomplete,
                Some(ids),
                "Task closure evidence is incomplete",
                "run_completion_delivery_closure_incomplete",
                "agent_org_runtime_tasks",
                AgentOrgRunBlockerRecoveryState::UserActionRequired,
                Some("review_tasks"),
            )
        } else if let Some(ids) = error
            .strip_prefix("run_completion_scope_removal_missing_source:")
            .or_else(|| error.strip_prefix("run_completion_scope_removal_source_invalid:"))
        {
            (
                AgentOrgRunBlockerKind::InvalidScopeRemoval,
                Some(ids),
                "Task scope-removal evidence is invalid",
                "run_completion_scope_removal_invalid",
                "agent_org_runtime_tasks",
                AgentOrgRunBlockerRecoveryState::UserActionRequired,
                Some("review_tasks"),
            )
        } else if let Some(ids) = error
            .strip_prefix("run_completion_replacement_chain_ambiguous:")
            .or_else(|| error.strip_prefix("run_completion_replacement_cycle:"))
        {
            (
                AgentOrgRunBlockerKind::InvalidReplacementChain,
                Some(ids),
                "Task replacement evidence is invalid",
                "run_completion_replacement_chain_invalid",
                "agent_org_runtime_tasks",
                AgentOrgRunBlockerRecoveryState::UserActionRequired,
                Some("review_tasks"),
            )
        } else {
            (
                AgentOrgRunBlockerKind::CompletionValidation,
                None,
                "Completion needs attention",
                "run_completion_validation_failed",
                "agent_org_run_completion",
                AgentOrgRunBlockerRecoveryState::SystemAttentionRequired,
                None,
            )
        };
    if matches!(kind, AgentOrgRunBlockerKind::CompletionValidation) && !blockers.is_empty() {
        return;
    }
    let objects = prefix.map_or_else(Vec::new, |ids| {
        identity_objects(
            "task",
            ids.split(',')
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .take(BLOCKER_ID_LIMIT)
                .map(str::to_string)
                .collect(),
        )
    });
    let count = objects.len().max(1);
    blockers.push(blocker(
        kind,
        count,
        objects,
        display,
        reason_code,
        source,
        recovery_state,
        action,
    ));
}

fn load_in_flight_turn_objects(
    conn: &Connection,
    org_run_id: &str,
) -> Result<Vec<AgentOrgRunBlockerObject>, String> {
    load_objects(
        conn,
        "SELECT intent.turn_intent_id,
                context.participant_id || ' turn'
         FROM session_turn_intents intent
         JOIN agent_org_runtime_turn_contexts context
           ON context.session_id=intent.session_id
          AND context.turn_intent_id=intent.turn_intent_id
         WHERE intent.org_run_id=?1
           AND (context.turn_kind='task_execution'
                OR (context.turn_kind='coordinator'
                    AND context.source_kind IN ('root_turn','group_root')))
           AND intent.status IN ('optimistic','queued','running')
         ORDER BY intent.updated_at,intent.turn_intent_id LIMIT ?2",
        org_run_id,
        "turn",
    )
}

fn load_unknown_turn_objects(
    conn: &Connection,
    org_run_id: &str,
) -> Result<Vec<AgentOrgRunBlockerObject>, String> {
    load_objects(
        conn,
        "SELECT intent.turn_intent_id,context.participant_id || ' turn'
         FROM session_turn_intents intent
         JOIN agent_org_runtime_turn_contexts context
           ON context.session_id=intent.session_id
          AND context.turn_intent_id=intent.turn_intent_id
         WHERE intent.org_run_id=?1
           AND intent.status NOT IN (
               'optimistic','queued','running','completed','failed',
               'cancelled','stale','coalesced','rejected'
           )
         ORDER BY intent.updated_at,intent.turn_intent_id LIMIT ?2",
        org_run_id,
        "turn",
    )
}

fn load_pending_materialization_objects(
    conn: &Connection,
    org_run_id: &str,
) -> Result<Vec<AgentOrgRunBlockerObject>, String> {
    load_objects(
        conn,
        "SELECT member_id,member_id
         FROM agent_org_runtime_member_materializations
         WHERE org_run_id=?1
           AND generation=(
               SELECT activation_generation FROM agent_org_runtime_runs WHERE id=?1
           )
           AND authority_class IN ('starting','formal') AND status<>'succeeded'
         ORDER BY generation,member_id LIMIT ?2",
        org_run_id,
        "member",
    )
}

fn load_recovery_objects(
    conn: &Connection,
    org_run_id: &str,
) -> Result<Vec<AgentOrgRunBlockerObject>, String> {
    load_objects(
        conn,
        "SELECT target_key,action_kind || ' → ' || target_key
         FROM agent_org_runtime_recovery_attempts
         WHERE org_run_id=?1 AND reservation_token IS NOT NULL
         ORDER BY action_kind,target_key LIMIT ?2",
        org_run_id,
        "recovery",
    )
}

fn load_plan_approval_objects(
    conn: &Connection,
    org_run_id: &str,
) -> Result<Vec<AgentOrgRunBlockerObject>, String> {
    load_objects(
        conn,
        "SELECT revision.plan_revision_id,revision.plan_title
         FROM agent_org_runtime_plan_revisions revision
         JOIN agent_org_runtime_plan_decisions decision
           ON decision.plan_revision_id=revision.plan_revision_id
         WHERE revision.org_run_id=?1 AND decision.status='pending'
         ORDER BY revision.created_at,revision.plan_revision_id LIMIT ?2",
        org_run_id,
        "plan_revision",
    )
}

fn pending_plan_approval_blocker(
    conn: &Connection,
    org_run_id: &str,
    count: usize,
) -> Result<AgentOrgRunBlocker, String> {
    let requires_user_action = conn
        .query_row(
            "SELECT EXISTS(
                 SELECT 1
                 FROM agent_org_runtime_plan_revisions revision
                 JOIN agent_org_runtime_plan_decisions decision
                   ON decision.plan_revision_id=revision.plan_revision_id
                 WHERE revision.org_run_id=?1 AND decision.status='pending'
                   AND decision.policy='user'
             )",
            [org_run_id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| error.to_string())?;
    Ok(blocker(
        AgentOrgRunBlockerKind::PendingPlanApprovals,
        count,
        bounded_for_count(load_plan_approval_objects(conn, org_run_id)?, count),
        if requires_user_action {
            "A plan needs your decision"
        } else {
            "A plan decision is being resolved"
        },
        "agent_org_pending_plan_approvals",
        "agent_org_runtime_plan_decisions",
        if requires_user_action {
            AgentOrgRunBlockerRecoveryState::UserActionRequired
        } else {
            AgentOrgRunBlockerRecoveryState::WaitingForRuntime
        },
        requires_user_action.then_some("review_plan"),
    ))
}

fn load_handoff_objects(
    conn: &Connection,
    org_run_id: &str,
) -> Result<Vec<AgentOrgRunBlockerObject>, String> {
    load_objects(
        conn,
        "SELECT handoff.id,handoff.old_task_id || ' handoff'
         FROM agent_org_runtime_task_execution_handoffs handoff
         WHERE handoff.org_run_id=?1
           AND handoff.state IN ('requested','yielding','timeout','unknown','failed')
           AND handoff.resolution IS NULL
           AND EXISTS (
               SELECT 1 FROM agent_org_runtime_work_episode_tasks episode_task
               JOIN agent_org_runtime_work_episodes episode
                 ON episode.id=episode_task.work_episode_id
               WHERE episode_task.org_run_id=handoff.org_run_id
                 AND episode_task.task_id=handoff.old_task_id
                 AND episode.status='active'
           )
         ORDER BY handoff.requested_at,handoff.id LIMIT ?2",
        org_run_id,
        "handoff",
    )
}

fn load_open_task_objects(
    conn: &Connection,
    org_run_id: &str,
) -> Result<Vec<AgentOrgRunBlockerObject>, String> {
    load_objects(
        conn,
        "SELECT task.id,task.subject FROM agent_org_runtime_tasks task
         JOIN agent_org_runtime_work_episode_tasks episode_task
           ON episode_task.org_run_id=task.org_run_id AND episode_task.task_id=task.id
         JOIN agent_org_runtime_work_episodes episode
           ON episode.id=episode_task.work_episode_id
         WHERE task.org_run_id=?1 AND episode.status='active'
           AND task.status IN ('pending','in_progress')
         ORDER BY task.created_at,task.id LIMIT ?2",
        org_run_id,
        "task",
    )
}

fn blocking_inbox_blockers(
    conn: &Connection,
    org_run_id: &str,
    expected_count: usize,
) -> Result<Vec<AgentOrgRunBlocker>, String> {
    let mut statement = conn
        .prepare(
            "SELECT CAST(inbox.id AS TEXT),
                    'Inbox ' || inbox.id || ' → ' || COALESCE(
                        json_extract(member.value,'$.name'),
                        inbox.recipient_member_id,
                        'unknown recipient'
                    )
             FROM agent_org_runtime_inbox inbox
             JOIN agent_org_runtime_runs run ON run.id=inbox.org_run_id
             LEFT JOIN json_each(
                 CASE WHEN json_valid(run.org_snapshot_json)
                      THEN json_extract(run.org_snapshot_json,'$.members') ELSE '[]' END
             ) member
               ON json_extract(member.value,'$.memberId')=inbox.recipient_member_id
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
                       SELECT 1 FROM agent_org_runtime_formal_trigger_receipts receipt
                       WHERE receipt.inbox_id=inbox.id
                         AND receipt.status IN ('pending','materialized')
                   )
               )
             ORDER BY inbox.id LIMIT ?3",
        )
        .map_err(|error| error.to_string())?;
    let objects = statement
        .query_map(
            params![
                org_run_id,
                super::agent_inbox::USER_SENDER_ID,
                BLOCKER_ID_LIMIT as i64,
            ],
            |row| {
                Ok(AgentOrgRunBlockerObject {
                    object_kind: "inbox",
                    id: row.get(0)?,
                    display_name: row.get(1)?,
                })
            },
        )
        .map_err(|error| error.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())?;
    let mut unbound = Vec::new();
    let mut unavailable = Vec::new();
    let mut waiting = Vec::new();
    let mut attention = Vec::new();
    for object in objects {
        let inbox_id = object
            .id
            .parse::<i64>()
            .map_err(|error| format!("invalid blocking Inbox id {}: {error}", object.id))?;
        match super::agent_inbox::AgentInboxStore::repair_eligibility_for_inbox_with_connection(
            conn, org_run_id, inbox_id,
        )? {
            Some(super::agent_inbox::InboxRepairEligibility::UnboundCoordinatorTaskMessage) => {
                unbound.push(object)
            }
            Some(super::agent_inbox::InboxRepairEligibility::PermanentlyUnavailableRecipient) => {
                unavailable.push(object)
            }
            Some(super::agent_inbox::InboxRepairEligibility::NotRepairable { reason })
                if reason == "recoverable_canonical_delivery" =>
            {
                waiting.push(object)
            }
            Some(super::agent_inbox::InboxRepairEligibility::NotRepairable { .. }) | None => {
                attention.push(object)
            }
        }
    }

    let classified_count = unbound.len() + unavailable.len() + waiting.len() + attention.len();
    let mut blockers = Vec::new();
    if !unbound.is_empty() {
        blockers.push(blocker(
            AgentOrgRunBlockerKind::BlockingInbox,
            unbound.len(),
            unbound,
            "A historical task message can be repaired by the Coordinator",
            "unbound_coordinator_task_message",
            "agent_org_runtime_inbox_task_bindings",
            AgentOrgRunBlockerRecoveryState::CoordinatorRepairAvailable,
            None,
        ));
    }
    if !unavailable.is_empty() {
        blockers.push(blocker(
            AgentOrgRunBlockerKind::BlockingInbox,
            unavailable.len(),
            unavailable,
            "Inbox work targets a permanently unavailable member",
            "permanently_unavailable_inbox_recipient",
            "agent_org_runtime_inbox",
            AgentOrgRunBlockerRecoveryState::CoordinatorRepairAvailable,
            None,
        ));
    }
    if !waiting.is_empty() {
        blockers.push(blocker(
            AgentOrgRunBlockerKind::BlockingInbox,
            waiting.len(),
            waiting,
            "Inbox work is waiting for its runtime",
            "agent_org_blocking_inbox",
            "agent_org_runtime_inbox",
            AgentOrgRunBlockerRecoveryState::WaitingForRuntime,
            None,
        ));
    }
    if !attention.is_empty() {
        blockers.push(blocker(
            AgentOrgRunBlockerKind::BlockingInbox,
            attention.len(),
            attention,
            "Inbox data needs system attention",
            "agent_org_unrepairable_blocking_inbox",
            "agent_org_runtime_inbox",
            AgentOrgRunBlockerRecoveryState::SystemAttentionRequired,
            None,
        ));
    }
    if expected_count > classified_count {
        blockers.push(blocker(
            AgentOrgRunBlockerKind::BlockingInbox,
            expected_count - classified_count,
            Vec::new(),
            "Additional Inbox work is waiting",
            "agent_org_blocking_inbox",
            "agent_org_runtime_inbox",
            AgentOrgRunBlockerRecoveryState::WaitingForRuntime,
            None,
        ));
    }
    Ok(blockers)
}

fn load_objects(
    conn: &Connection,
    sql: &str,
    org_run_id: &str,
    object_kind: &'static str,
) -> Result<Vec<AgentOrgRunBlockerObject>, String> {
    let mut statement = conn.prepare(sql).map_err(|error| error.to_string())?;
    let ids = statement
        .query_map(params![org_run_id, BLOCKER_ID_LIMIT as i64], |row| {
            Ok(AgentOrgRunBlockerObject {
                object_kind,
                id: row.get(0)?,
                display_name: row.get(1)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())?;
    Ok(ids)
}

fn identity_objects(object_kind: &'static str, ids: Vec<String>) -> Vec<AgentOrgRunBlockerObject> {
    ids.into_iter()
        .map(|id| AgentOrgRunBlockerObject {
            object_kind,
            display_name: id.clone(),
            id,
        })
        .collect()
}

fn run_objects(org_run_id: &str) -> Vec<AgentOrgRunBlockerObject> {
    identity_objects("run", vec![org_run_id.to_string()])
}

fn bounded_for_count(
    mut objects: Vec<AgentOrgRunBlockerObject>,
    count: usize,
) -> Vec<AgentOrgRunBlockerObject> {
    objects.truncate(count.min(BLOCKER_ID_LIMIT));
    objects
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_blocker_shape_is_bounded_stable_and_content_free() {
        let objects = (0..20)
            .map(|index| AgentOrgRunBlockerObject {
                object_kind: "turn",
                id: format!("turn-{index:02}"),
                display_name: format!("Member {index} turn"),
            })
            .collect();
        let detail = blocker(
            AgentOrgRunBlockerKind::InFlightTurns,
            20,
            objects,
            "Turns are still in flight",
            "agent_org_in_flight_turns",
            "session_turn_intents",
            AgentOrgRunBlockerRecoveryState::WaitingForRuntime,
            None,
        );
        let value = serde_json::to_value(&detail).expect("serialize public blocker");
        assert_eq!(value["kind"], "inFlightTurns");
        assert_eq!(value["count"], 20);
        assert_eq!(value["objects"].as_array().unwrap().len(), 16);
        assert_eq!(value["hasMore"], true);
        assert_eq!(value["recoveryState"], "waiting_for_runtime");
        assert_eq!(value["requiresUserAction"], false);
        assert!(value["userAction"].is_null());
        assert!(value.get("prompt").is_none());
        assert!(value.get("content").is_none());
    }

    #[test]
    fn completion_closure_failure_uses_task_identities_and_user_action() {
        let mut blockers = Vec::new();
        append_completion_failure(
            &mut blockers,
            "run_completion_delivery_closure_incomplete:task-b,task-a",
        );
        assert_eq!(blockers.len(), 1);
        let blocker = &blockers[0];
        assert_eq!(blocker.kind, AgentOrgRunBlockerKind::TaskClosureIncomplete);
        assert!(blocker.requires_user_action);
        assert_eq!(blocker.user_action, Some("review_tasks"));
        assert_eq!(
            blocker
                .objects
                .iter()
                .map(|object| object.id.as_str())
                .collect::<Vec<_>>(),
            vec!["task-b", "task-a"]
        );
    }
}

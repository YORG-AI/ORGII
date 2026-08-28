//! Atomic Planning Task completion owned by an immutable PlanRevision
//! decision.
//!
//! The Planner Turn is immutable provenance.  A later Pause/Resume may fence
//! that Turn, so the current User/Coordinator/Automatic decision authority is
//! validated independently before the TaskOutput and Task terminal state are
//! written in the caller-owned Plan transaction.

use rusqlite::{params, Connection, OptionalExtension};

use crate::coordination::agent_org_runs::{AgentOrgRunStatus, COORDINATOR_MEMBER_ID};
use crate::coordination::agent_org_turn_contexts::{
    require_context_with_connection, AgentOrgTurnKind,
};

use super::super::actor::{
    PlanDecisionTaskAuthority, TaskActorAudit, TaskActorKind, TaskGraphWriterAdmin,
    TaskOwnerExecution,
};
use super::super::helpers::{
    encode_optional_json, insert_task_history_event_as, now_rfc3339, row_to_task, SELECT_COLUMNS,
};
use super::super::{
    task_execution_mode, Task, TaskExecutionMode, TaskMutationOutcome, TaskOutput, TaskOutputInput,
    TaskStatus, TASK_EVENT_UPDATED,
};
use super::validation::ensure_run_allows_task_mutation;
use super::AgentOrgTaskStore;

impl AgentOrgTaskStore {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn complete_planning_task_for_decision_in_tx(
        tx: &Connection,
        authority: PlanDecisionTaskAuthority,
        org_run_id: &str,
        task_id: &str,
        source_member_id: &str,
        source_session_id: &str,
        source_turn_intent_id: &str,
        plan_revision_id: &str,
        output: TaskOutputInput,
    ) -> Result<TaskMutationOutcome, String> {
        if plan_revision_id.trim().is_empty() {
            return Err("plan_revision_id must not be empty".to_string());
        }
        ensure_run_allows_task_mutation(tx, org_run_id)?;
        let audit = validate_plan_decision_authority(
            tx,
            &authority,
            org_run_id,
            task_id,
            source_member_id,
            source_session_id,
            source_turn_intent_id,
            plan_revision_id,
        )?;
        let sql = format!(
            "SELECT {SELECT_COLUMNS} FROM agent_org_runtime_tasks
             WHERE org_run_id = ?1 AND id = ?2"
        );
        let previous: Option<Task> = tx
            .query_row(&sql, params![org_run_id, task_id], row_to_task)
            .optional()
            .map_err(|err| err.to_string())?;
        let Some(previous) = previous else {
            return Err(format!("task_not_found: {task_id} in run {org_run_id}"));
        };
        if previous.owner.as_deref() != Some(source_member_id) {
            return Err(format!(
                "plan_task_owner_mismatch: task {task_id} is owned by {:?}, not {source_member_id}",
                previous.owner
            ));
        }
        if previous.status != TaskStatus::InProgress {
            return Err(format!(
                "plan_task_not_in_progress: task {task_id} is {}",
                previous.status.as_wire()
            ));
        }
        if task_execution_mode(&previous) != TaskExecutionMode::Plan {
            return Err(format!(
                "plan_task_execution_mode_mismatch: task {task_id} is not a plan task"
            ));
        }

        let mut current = previous.clone();
        current.output = Some(TaskOutput {
            summary: output.summary,
            content: output.content,
            artifact_ids: output.artifact_ids,
            plan_revision_id: Some(plan_revision_id.to_string()),
            produced_by_member_id: source_member_id.to_string(),
            produced_at: now_rfc3339(),
        });
        current.status = TaskStatus::Completed;
        current.updated_at = now_rfc3339();
        super::validation::validate_task_model_invariants(tx, &current)?;
        let output_json = encode_optional_json("task output", current.output.as_ref())?;
        let changed = tx
            .execute(
                "UPDATE agent_org_runtime_tasks
                 SET status = ?1, output_json = ?2, updated_at = ?3
                 WHERE org_run_id = ?4 AND id = ?5 AND status = ?6 AND owner = ?7",
                params![
                    current.status.as_wire(),
                    output_json.as_deref(),
                    &current.updated_at,
                    org_run_id,
                    task_id,
                    TaskStatus::InProgress.as_wire(),
                    source_member_id,
                ],
            )
            .map_err(|err| err.to_string())?;
        if changed != 1 {
            return Err(format!(
                "{}: plan task {task_id} changed before approval committed",
                super::TASK_MUTATION_CONFLICT_ERROR
            ));
        }
        insert_task_history_event_as(
            tx,
            org_run_id,
            task_id,
            TASK_EVENT_UPDATED,
            Some(&previous),
            &current,
            &audit,
        )?;
        crate::coordination::agent_org_runs::bump_work_revision_in_tx(tx, org_run_id)?;
        Ok(TaskMutationOutcome {
            previous,
            current,
            owner_changed: false,
            status_changed: true,
            became_completed: true,
            became_ready: false,
        })
    }
}

#[allow(clippy::too_many_arguments)]
fn validate_plan_decision_authority(
    conn: &Connection,
    authority: &PlanDecisionTaskAuthority,
    org_run_id: &str,
    task_id: &str,
    source_member_id: &str,
    source_session_id: &str,
    source_turn_intent_id: &str,
    plan_revision_id: &str,
) -> Result<TaskActorAudit, String> {
    let source = require_context_with_connection(conn, source_session_id, source_turn_intent_id)?;
    if source.org_run_id != org_run_id
        || source.turn_kind != AgentOrgTurnKind::TaskExecution
        || source.task_id.as_deref() != Some(task_id)
        || source.owner_member_id.as_deref() != Some(source_member_id)
        || source.participant_id != source_member_id
    {
        return Err("plan_revision_source_context_mismatch".to_string());
    }
    let exact_pending_revision: bool = conn
        .query_row(
            "SELECT EXISTS(
                 SELECT 1
                 FROM agent_org_runtime_plan_revisions revision
                 JOIN agent_org_runtime_plan_decisions decision
                   ON decision.plan_revision_id=revision.plan_revision_id
                 WHERE revision.plan_revision_id=?1 AND revision.org_run_id=?2
                   AND revision.source_task_id=?3 AND revision.source_member_id=?4
                   AND revision.source_session_id=?5
                   AND revision.source_turn_intent_id=?6
                   AND decision.status='pending'
             )",
            params![
                plan_revision_id,
                org_run_id,
                task_id,
                source_member_id,
                source_session_id,
                source_turn_intent_id,
            ],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if !exact_pending_revision {
        return Err("agent_org_plan_approval_stale_revision".to_string());
    }

    let (status_raw, generation, root_session_id): (String, i64, Option<String>) = conn
        .query_row(
            "SELECT status,activation_generation,root_session_id
             FROM agent_org_runtime_runs WHERE id=?1",
            [org_run_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|error| error.to_string())?;
    let status = AgentOrgRunStatus::parse(&status_raw)
        .ok_or_else(|| format!("unknown Agent Org run status: {status_raw}"))?;
    if status != AgentOrgRunStatus::Running {
        return Err(crate::coordination::agent_org_runs::mutation_blocked_error(
            org_run_id,
            status.as_str(),
        ));
    }

    match authority {
        PlanDecisionTaskAuthority::User {
            root_session_id: claimed_root,
        } => {
            if root_session_id.as_deref() != Some(claimed_root.as_str()) {
                return Err("plan_decision_user_requires_canonical_root_session".to_string());
            }
            Ok(TaskActorAudit {
                kind: TaskActorKind::System,
                participant_id: "user:plan_decision".to_string(),
                turn_intent_id: None,
                activation_generation: generation,
            })
        }
        PlanDecisionTaskAuthority::Coordinator {
            session_id,
            turn_intent_id,
        } => {
            let decision = TaskGraphWriterAdmin::new(session_id, turn_intent_id)?
                .validate(conn, org_run_id)?;
            if decision.participant_id != COORDINATOR_MEMBER_ID {
                return Err("plan_decision_coordinator_context_mismatch".to_string());
            }
            Ok(TaskActorAudit {
                kind: TaskActorKind::GraphWriter,
                participant_id: COORDINATOR_MEMBER_ID.to_string(),
                turn_intent_id: Some(turn_intent_id.clone()),
                activation_generation: generation,
            })
        }
        PlanDecisionTaskAuthority::Automatic {
            session_id,
            turn_intent_id,
        } => {
            if session_id != source_session_id || turn_intent_id != source_turn_intent_id {
                return Err("plan_decision_automatic_source_mismatch".to_string());
            }
            let decision = TaskOwnerExecution::new(session_id, turn_intent_id)?
                .validate(conn, org_run_id, task_id)?;
            if decision.participant_id != source_member_id {
                return Err("plan_decision_automatic_context_mismatch".to_string());
            }
            Ok(TaskActorAudit {
                kind: TaskActorKind::System,
                participant_id: "system:plan_decision:automatic".to_string(),
                turn_intent_id: Some(turn_intent_id.clone()),
                activation_generation: generation,
            })
        }
    }
}

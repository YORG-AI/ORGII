//! Receipt-gated system recovery for failed or intentionally stopped Owners.

use database::db::{get_connection, with_sessions_writer};
use rusqlite::{params, OptionalExtension};

use super::super::actor::TaskActorAudit;
use super::super::helpers::{
    encode_metadata, encode_optional_json, insert_task_history_event_as, now_rfc3339, row_to_task,
    SELECT_COLUMNS,
};
use super::super::SystemTaskOperation;
use super::super::{
    SystemArchiveOrRecovery, Task, TaskAnnotationKind, TaskStatus, TaskTerminalReason,
    TASK_EVENT_RELEASED,
};
use super::validation::validate_task_model_invariants;
use super::AgentOrgTaskStore;

impl AgentOrgTaskStore {
    pub(crate) fn recover_task_execution_failure(
        session_id: &str,
        failed_turn_intent_id: &str,
    ) -> Result<Vec<Task>, String> {
        let updated = with_sessions_writer(|| -> Result<Vec<Task>, String> {
            let mut conn = get_connection().map_err(|error| error.to_string())?;
            let tx = conn
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .map_err(|error| error.to_string())?;
            let context = crate::coordination::agent_org_turn_contexts::require_task_failure_recovery_context_with_connection(
                &tx,
                session_id,
                failed_turn_intent_id,
            )?;
            let task_id = context
                .task_id
                .as_deref()
                .ok_or_else(|| "task_failure_recovery_context_missing_task".to_string())?;
            let owner_member_id = context
                .owner_member_id
                .as_deref()
                .ok_or_else(|| "task_failure_recovery_context_missing_owner".to_string())?;
            let activation_generation = context
                .activation_generation
                .ok_or_else(|| "task_failure_recovery_context_missing_generation".to_string())?;
            let fingerprint =
                crate::coordination::agent_org_watchdog::task_failure_recovery_fingerprint(
                    task_id,
                    failed_turn_intent_id,
                    activation_generation,
                );
            if crate::coordination::agent_org_watchdog::task_failure_recovery_already_processed_with_connection(
                &tx,
                &context.org_run_id,
                &fingerprint,
            )? {
                return Ok(Vec::new());
            }

            // Revalidate after the idempotency probe so a replay of an already
            // committed failure is a no-op, while an unprocessed late callback
            // still fails closed on Task/Owner/run/snapshot/generation drift.
            crate::coordination::agent_org_turn_contexts::revalidate_context_with_connection(
                &tx,
                session_id,
                failed_turn_intent_id,
            )?;
            let sql = format!(
                "SELECT {SELECT_COLUMNS} FROM agent_org_runtime_tasks task
                 WHERE task.org_run_id=?1 AND task.id=?2 AND task.owner=?3
                   AND task.status='in_progress'
                   AND EXISTS (
                       SELECT 1 FROM agent_org_runtime_task_events event
                       WHERE event.org_run_id=task.org_run_id
                         AND event.task_id=task.id
                         AND event.previous_status='pending'
                         AND event.next_status='in_progress'
                         AND event.actor_kind='owner_execution'
                         AND event.actor_member_id=?3
                         AND event.source_turn_intent_id=?4
                         AND event.created_at=task.updated_at
                         AND event.rowid=(
                             SELECT MAX(latest.rowid)
                             FROM agent_org_runtime_task_events latest
                             WHERE latest.org_run_id=task.org_run_id
                               AND latest.task_id=task.id
                         )
                   )"
            );
            let previous = tx
                .query_row(
                    &sql,
                    params![
                        &context.org_run_id,
                        task_id,
                        owner_member_id,
                        failed_turn_intent_id
                    ],
                    row_to_task,
                )
                .optional()
                .map_err(|error| error.to_string())?
                .ok_or_else(|| {
                    format!(
                        "task_failure_recovery_turn_or_target_changed: {}/{}",
                        context.org_run_id, task_id
                    )
                })?;
            let reservation = crate::coordination::agent_org_watchdog::reserve_task_failure_recovery_with_connection(
                &tx,
                &context.org_run_id,
                task_id,
                &fingerprint,
                activation_generation,
            )?;
            let operation = if reservation.exhausted {
                SystemTaskOperation::RecoveryFail
            } else {
                SystemTaskOperation::RecoveryRequeue
            };
            let actor =
                SystemArchiveOrRecovery::new(reservation.token, reservation.generation, operation)?;
            let mut audit = actor.validate(&tx, &context.org_run_id, task_id)?;
            audit.turn_intent_id = Some(failed_turn_intent_id.to_string());
            let updated = recover_task_in_tx(
                &tx,
                previous,
                owner_member_id,
                RecoveryMode::Failure {
                    exhausted: reservation.exhausted,
                },
                &audit,
            )?;
            release_reservation_in_tx(&tx, &context.org_run_id, &actor, task_id)?;
            crate::coordination::agent_org_runs::bump_work_revision_in_tx(
                &tx,
                &context.org_run_id,
            )?;
            tx.commit().map_err(|error| error.to_string())?;
            Ok(vec![updated])
        })?;
        if let Some(task) = updated.first() {
            crate::coordination::agent_org_run_events::notify_agent_org_run_changed(
                &task.org_run_id,
            );
        }
        Ok(updated)
    }

    pub(crate) fn release_owner_for_shutdown(
        actor: SystemArchiveOrRecovery,
        org_run_id: &str,
        owner_member_id: &str,
    ) -> Result<Vec<Task>, String> {
        release_owned_tasks_for_shutdown(actor, org_run_id, owner_member_id)
    }

    #[cfg(test)]
    pub fn dispose_open_tasks_for_shutdown(
        org_run_id: &str,
        owner_member_id: &str,
    ) -> Result<Vec<Task>, String> {
        let reservation = crate::coordination::agent_org_watchdog::reserve_task_shutdown_release(
            org_run_id,
            owner_member_id,
        )?;
        let actor = SystemArchiveOrRecovery::new(
            reservation.token,
            reservation.generation,
            SystemTaskOperation::ShutdownRelease,
        )?;
        Self::release_owner_for_shutdown(actor, org_run_id, owner_member_id)
    }
}

#[derive(Debug, Clone, Copy)]
enum RecoveryMode {
    Failure { exhausted: bool },
    Shutdown,
}

fn release_owned_tasks_for_shutdown(
    actor: SystemArchiveOrRecovery,
    org_run_id: &str,
    owner_member_id: &str,
) -> Result<Vec<Task>, String> {
    let updated = with_sessions_writer(|| -> Result<Vec<Task>, String> {
        let mut conn = get_connection().map_err(|error| error.to_string())?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;
        let audit = actor.validate(&tx, org_run_id, owner_member_id)?;
        let sql = format!(
            "SELECT {SELECT_COLUMNS} FROM agent_org_runtime_tasks
             WHERE org_run_id=?1 AND owner=?2 AND status IN ('pending','in_progress')
             ORDER BY created_at ASC,id ASC"
        );
        let owned = {
            let mut stmt = tx.prepare(&sql).map_err(|error| error.to_string())?;
            let rows = stmt
                .query_map(params![org_run_id, owner_member_id], row_to_task)
                .map_err(|error| error.to_string())?;
            rows.map(|row| row.map_err(|error| error.to_string()))
                .collect::<Result<Vec<_>, _>>()?
        };
        let mut updated = Vec::with_capacity(owned.len());
        for previous in owned {
            updated.push(recover_task_in_tx(
                &tx,
                previous,
                owner_member_id,
                RecoveryMode::Shutdown,
                &audit,
            )?);
        }
        release_reservation_in_tx(&tx, org_run_id, &actor, owner_member_id)?;
        if !updated.is_empty() {
            crate::coordination::agent_org_runs::bump_work_revision_in_tx(&tx, org_run_id)?;
        }
        tx.commit().map_err(|error| error.to_string())?;
        Ok(updated)
    })?;
    if !updated.is_empty() {
        crate::coordination::agent_org_run_events::notify_agent_org_run_changed(org_run_id);
    }
    Ok(updated)
}

fn recover_task_in_tx(
    tx: &rusqlite::Transaction<'_>,
    previous: Task,
    owner_member_id: &str,
    mode: RecoveryMode,
    audit: &TaskActorAudit,
) -> Result<Task, String> {
    let mut task = previous.clone();
    let exhausted = matches!(mode, RecoveryMode::Failure { exhausted: true });
    if exhausted {
        task.status = TaskStatus::Failed;
        task.failure_reason = Some(TaskTerminalReason {
            code: "system.recovery_budget_exhausted".to_string(),
            message: "Automatic Owner recovery budget was exhausted".to_string(),
        });
    } else {
        task.status = TaskStatus::Pending;
        task.owner = None;
        ensure_recovery_candidate(&mut task, owner_member_id)?;
    }
    task.updated_at = now_rfc3339();
    validate_task_model_invariants(tx, &task)?;
    let metadata_json = encode_metadata(task.metadata.as_ref())?;
    let failure_reason_json =
        encode_optional_json("task failure reason", task.failure_reason.as_ref())?;
    let changed = tx
        .execute(
            "UPDATE agent_org_runtime_tasks
             SET owner=?1,status=?2,metadata_json=?3,failure_reason_json=?4,
                 output_json=NULL,cancel_reason_json=NULL,updated_at=?5
             WHERE org_run_id=?6 AND id=?7 AND owner=?8
               AND status IN ('pending','in_progress')",
            params![
                task.owner.as_deref(),
                task.status.as_wire(),
                metadata_json.as_deref(),
                failure_reason_json.as_deref(),
                &task.updated_at,
                &task.org_run_id,
                &task.id,
                owner_member_id,
            ],
        )
        .map_err(|error| error.to_string())?;
    if changed != 1 {
        return Err(format!(
            "task_mutation_conflict: recovery target {} changed",
            task.id
        ));
    }
    insert_task_history_event_as(
        tx,
        &task.org_run_id,
        &task.id,
        TASK_EVENT_RELEASED,
        Some(&previous),
        &task,
        audit,
    )?;
    let annotation_body = if exhausted {
        "Automatic recovery budget exhausted; Task was failed"
    } else if matches!(mode, RecoveryMode::Shutdown) {
        "Owner shutdown released Task to the explicit assignment pool"
    } else {
        "Owner turn failed; Task was restored to ownerless pending"
    };
    tx.execute(
        "INSERT INTO agent_org_runtime_task_annotations(
            id,org_run_id,task_id,kind,body,actor_kind,
            actor_participant_id,source_turn_intent_id,created_at
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![
            uuid::Uuid::new_v4().to_string(),
            &task.org_run_id,
            &task.id,
            TaskAnnotationKind::AuditNote.as_wire(),
            annotation_body,
            audit.kind.as_wire(),
            &audit.participant_id,
            audit.turn_intent_id.as_deref(),
            &task.updated_at,
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(task)
}

fn release_reservation_in_tx(
    tx: &rusqlite::Transaction<'_>,
    org_run_id: &str,
    actor: &SystemArchiveOrRecovery,
    target_key: &str,
) -> Result<(), String> {
    let changed = tx
        .execute(
            "UPDATE agent_org_runtime_recovery_attempts SET reservation_token=NULL
             WHERE org_run_id=?1 AND reservation_token=?2
               AND action_kind=?3 AND target_key=?4",
            params![
                org_run_id,
                actor.receipt_id(),
                actor.action_kind(),
                target_key
            ],
        )
        .map_err(|error| error.to_string())?;
    if changed != 1 {
        return Err("system_task_recovery_receipt_release_failed".to_string());
    }
    Ok(())
}

fn ensure_recovery_candidate(task: &mut Task, owner_member_id: &str) -> Result<(), String> {
    let mut metadata = match task.metadata.take() {
        Some(serde_json::Value::Object(object)) => object,
        Some(_) => return Err("task metadata must be an object".to_string()),
        None => serde_json::Map::new(),
    };
    let mut eligible = match metadata.get(super::super::TASK_METADATA_ELIGIBLE_MEMBER_IDS) {
        Some(value) => value
            .as_array()
            .cloned()
            .ok_or_else(|| "eligible_member_ids must be an array".to_string())?,
        None => Vec::new(),
    };
    if !eligible
        .iter()
        .any(|value| value.as_str() == Some(owner_member_id))
    {
        eligible.push(serde_json::Value::String(owner_member_id.to_string()));
    }
    metadata.insert(
        super::super::TASK_METADATA_ELIGIBLE_MEMBER_IDS.to_string(),
        serde_json::Value::Array(eligible),
    );
    task.metadata = Some(serde_json::Value::Object(metadata));
    Ok(())
}

//! Canonical Agent Org Task state machine. Every method validates its typed actor
//! against persisted Turn context after beginning the IMMEDIATE transaction.

use database::db::{get_connection, with_sessions_writer};
use rusqlite::{params, OptionalExtension};

use crate::coordination::agent_org_payload_limits::{
    validate_task_dependency_ids, validate_task_identifier,
};

use super::super::actor::TaskActorAudit;
use super::super::helpers::{
    encode_json_array, encode_metadata, encode_optional_json, insert_task_history_event_as,
    list_tasks_with_conn, now_rfc3339, row_to_task, SELECT_COLUMNS,
};
use super::super::{
    task_dependency_closure, CreatePendingTaskParams, PendingTaskGraphPatch,
    SystemArchiveOrRecovery, Task, TaskCreateSchedulingPolicy, TaskGraphWriterAdmin,
    TaskMutationOutcome, TaskOutput, TaskOutputInput, TaskOwnerExecution, TaskStatus,
    TaskTerminalReason, TASK_EVENT_CREATED, TASK_EVENT_UPDATED,
    TASK_GRAPH_OPEN_WORK_CONFLICT_ERROR, TASK_MUTATION_CONFLICT_ERROR,
    TASK_TERMINAL_IMMUTABLE_ERROR,
};
use super::dependencies::canonicalize_dependencies;
use super::validation::{
    ensure_task_run_capacity, validate_task_model_invariants, validate_task_text_fields,
};
use super::AgentOrgTaskStore;

impl AgentOrgTaskStore {
    /// Cancel every non-terminal Task as part of the caller-owned Archive
    /// transaction. The Archive receipt is the typed system authority; Task
    /// rows and their audit events therefore commit or roll back with the
    /// Team terminal fence.
    pub(crate) fn cancel_open_for_archive_with_connection(
        tx: &rusqlite::Transaction<'_>,
        actor: &SystemArchiveOrRecovery,
        org_run_id: &str,
        reason: &TaskTerminalReason,
    ) -> Result<usize, String> {
        let audit = actor.validate(tx, org_run_id, "all_open_tasks")?;
        let mut tasks = list_tasks_with_conn(tx, org_run_id)?;
        let now = now_rfc3339();
        let mut cancelled = 0usize;
        for task in &mut tasks {
            if !task.status.is_open() {
                continue;
            }
            let previous = task.clone();
            task.status = TaskStatus::Cancelled;
            task.output = None;
            task.failure_reason = None;
            task.cancel_reason = Some(reason.clone());
            task.updated_at = now.clone();
            validate_task_model_invariants(tx, task)?;
            update_task_row(tx, task)?;
            insert_task_history_event_as(
                tx,
                org_run_id,
                &task.id,
                TASK_EVENT_UPDATED,
                Some(&previous),
                task,
                &audit,
            )?;
            cancelled += 1;
        }
        if cancelled > 0 {
            crate::coordination::agent_org_runs::bump_work_revision_in_tx(tx, org_run_id)?;
        }
        Ok(cancelled)
    }

    pub fn create_pending_with_transactional_effects<T>(
        actor: TaskGraphWriterAdmin,
        params: CreatePendingTaskParams,
        scheduling_policy: TaskCreateSchedulingPolicy,
        effects: impl FnOnce(&rusqlite::Connection, &Task, &[Task]) -> Result<T, String>,
    ) -> Result<(Task, T), String> {
        validate_create_params(&params)?;
        let run_id = params.org_run_id.clone();
        let (task, effect) = with_sessions_writer(|| -> Result<(Task, T), String> {
            let mut conn = get_connection().map_err(|error| error.to_string())?;
            let tx = conn
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .map_err(|error| error.to_string())?;
            let audit = actor.validate(&tx, &run_id)?;
            let mut tasks = list_tasks_with_conn(&tx, &run_id)?;
            ensure_task_run_capacity(tasks.iter().filter(|task| task.status.is_open()).count(), 1)?;
            let now = now_rfc3339();
            let task = pending_task_from_params(params, &audit, &now)?;
            validate_task_model_invariants(&tx, &task)?;
            validate_replacement_reference(&tx, &task)?;
            tasks.push(task);
            canonicalize_dependencies(&mut tasks, &run_id)?;
            let task = tasks
                .last()
                .cloned()
                .expect("candidate graph includes newly-created task");
            enforce_scheduling_policy(&task, &tasks, scheduling_policy)?;
            insert_task_row(&tx, &task)?;
            insert_task_history_event_as(
                &tx,
                &run_id,
                &task.id,
                TASK_EVENT_CREATED,
                None,
                &task,
                &audit,
            )?;
            crate::coordination::agent_org_runs::bump_work_revision_in_tx(&tx, &run_id)?;
            let effect = effects(&tx, &task, &tasks)?;
            tx.commit().map_err(|error| error.to_string())?;
            Ok((task, effect))
        })?;
        crate::coordination::agent_org_run_events::notify_agent_org_run_changed(&run_id);
        Ok((task, effect))
    }

    pub fn create_pending_batch_with_transactional_effects<T>(
        actor: TaskGraphWriterAdmin,
        params_list: Vec<CreatePendingTaskParams>,
        allow_parallel_with_existing_open_tasks: bool,
        effects: impl FnOnce(&rusqlite::Connection, &[Task], &[Task]) -> Result<T, String>,
    ) -> Result<(Vec<Task>, T), String> {
        if params_list.is_empty() {
            return Err("task graph must contain at least one task".to_string());
        }
        for params in &params_list {
            validate_create_params(params)?;
        }
        let run_id = params_list[0].org_run_id.clone();
        if params_list.iter().any(|params| params.org_run_id != run_id) {
            return Err("every task in a graph must belong to the same org run".to_string());
        }
        let (created, effect) = with_sessions_writer(|| -> Result<(Vec<Task>, T), String> {
            let mut conn = get_connection().map_err(|error| error.to_string())?;
            let tx = conn
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .map_err(|error| error.to_string())?;
            let audit = actor.validate(&tx, &run_id)?;
            let mut tasks = list_tasks_with_conn(&tx, &run_id)?;
            let existing_count = tasks.len();
            ensure_task_run_capacity(
                tasks.iter().filter(|task| task.status.is_open()).count(),
                params_list.len(),
            )?;
            let now = now_rfc3339();
            let mut ids = tasks
                .iter()
                .map(|task| task.id.as_str())
                .collect::<std::collections::HashSet<_>>();
            for params in &params_list {
                if !ids.insert(params.id.as_str()) {
                    return Err(format!("duplicate task id: {}", params.id));
                }
            }
            for params in params_list {
                let task = pending_task_from_params(params, &audit, &now)?;
                validate_task_model_invariants(&tx, &task)?;
                validate_replacement_reference(&tx, &task)?;
                tasks.push(task);
            }
            canonicalize_dependencies(&mut tasks, &run_id)?;
            if !allow_parallel_with_existing_open_tasks {
                let referenced = tasks[existing_count..]
                    .iter()
                    .flat_map(|task| task.blocked_by.iter())
                    .cloned()
                    .collect::<Vec<_>>();
                let covered = task_dependency_closure(&referenced, &tasks[..existing_count]);
                let omitted = tasks[..existing_count]
                    .iter()
                    .filter(|task| task.status.is_open() && !covered.contains(&task.id))
                    .map(|task| task.id.clone())
                    .collect::<Vec<_>>();
                if !omitted.is_empty() {
                    return Err(format!(
                        "{TASK_GRAPH_OPEN_WORK_CONFLICT_ERROR}:{}",
                        omitted.join(",")
                    ));
                }
            }
            let created = tasks[existing_count..].to_vec();
            for task in &created {
                insert_task_row(&tx, task)?;
                insert_task_history_event_as(
                    &tx,
                    &run_id,
                    &task.id,
                    TASK_EVENT_CREATED,
                    None,
                    task,
                    &audit,
                )?;
            }
            crate::coordination::agent_org_runs::bump_work_revision_in_tx(&tx, &run_id)?;
            let effect = effects(&tx, &created, &tasks)?;
            tx.commit().map_err(|error| error.to_string())?;
            Ok((created, effect))
        })?;
        crate::coordination::agent_org_run_events::notify_agent_org_run_changed(&run_id);
        Ok((created, effect))
    }

    pub fn patch_pending_with_transactional_effects<T>(
        actor: TaskGraphWriterAdmin,
        org_run_id: &str,
        task_id: &str,
        expected_updated_at: &str,
        patch: PendingTaskGraphPatch,
        effects: impl FnOnce(&rusqlite::Connection, &TaskMutationOutcome, &[Task]) -> Result<T, String>,
    ) -> Result<(TaskMutationOutcome, T), String> {
        if let Some(blocked_by) = patch.blocked_by.as_ref() {
            validate_task_dependency_ids("blocked_by", blocked_by)?;
        }
        let run_id = org_run_id.to_string();
        let (outcome, effect) = with_sessions_writer(|| -> Result<_, String> {
            let mut conn = get_connection().map_err(|error| error.to_string())?;
            let tx = conn
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .map_err(|error| error.to_string())?;
            let audit = actor.validate(&tx, &run_id)?;
            let mut tasks = list_tasks_with_conn(&tx, &run_id)?;
            let index = tasks
                .iter()
                .position(|task| task.id == task_id)
                .ok_or_else(|| format!("task_not_found: {task_id} in run {run_id}"))?;
            let previous = tasks[index].clone();
            if previous.updated_at != expected_updated_at {
                return Err(format!(
                    "{TASK_MUTATION_CONFLICT_ERROR}: task {task_id} changed after authorization"
                ));
            }
            if previous.status != TaskStatus::Pending {
                return Err(format!(
                    "task_graph_edit_requires_pending: task {task_id} is {}",
                    previous.status.as_wire()
                ));
            }
            let task = &mut tasks[index];
            if let Some(subject) = patch.subject {
                task.subject = subject;
            }
            if let Some(description) = patch.description {
                task.description = description;
            }
            if let Some(active_form) = patch.active_form {
                task.active_form = active_form;
            }
            if let Some(owner) = patch.owner {
                task.owner = owner;
            }
            if let Some(execution_mode) = patch.execution_mode {
                task.execution_mode = execution_mode;
            }
            if let Some(blocked_by) = patch.blocked_by {
                task.blocked_by = blocked_by;
            }
            if let Some(metadata) = patch.metadata {
                task.metadata = metadata;
            }
            task.updated_at = now_rfc3339();
            validate_task_model_invariants(&tx, task)?;
            canonicalize_dependencies(&mut tasks, &run_id)?;
            let current = tasks[index].clone();
            update_task_row(&tx, &current)?;
            insert_task_history_event_as(
                &tx,
                &run_id,
                task_id,
                TASK_EVENT_UPDATED,
                Some(&previous),
                &current,
                &audit,
            )?;
            crate::coordination::agent_org_runs::bump_work_revision_in_tx(&tx, &run_id)?;
            let outcome = mutation_outcome(previous, current, &tasks);
            let effect = effects(&tx, &outcome, &tasks)?;
            tx.commit().map_err(|error| error.to_string())?;
            Ok((outcome, effect))
        })?;
        crate::coordination::agent_org_run_events::notify_agent_org_run_changed(&run_id);
        Ok((outcome, effect))
    }

    pub fn cancel_with_transactional_effects<T>(
        actor: TaskGraphWriterAdmin,
        org_run_id: &str,
        task_id: &str,
        expected_updated_at: &str,
        reason: TaskTerminalReason,
        effects: impl FnOnce(&rusqlite::Connection, &TaskMutationOutcome, &[Task]) -> Result<T, String>,
    ) -> Result<(TaskMutationOutcome, T), String> {
        if reason.code.starts_with("system.") {
            return Err(
                "system.* cancel reason codes are reserved for system recovery".to_string(),
            );
        }
        mutate_lifecycle(
            org_run_id,
            task_id,
            Some(expected_updated_at),
            |tx, _previous| actor.validate(tx, org_run_id),
            move |task, _audit| {
                if task.status.is_terminal() {
                    return Err(format!(
                        "{TASK_TERMINAL_IMMUTABLE_ERROR}: task {} is {}",
                        task.id,
                        task.status.as_wire()
                    ));
                }
                task.status = TaskStatus::Cancelled;
                task.cancel_reason = Some(reason);
                Ok(())
            },
            effects,
        )
    }

    pub fn cancel_and_replace_with_transactional_effects<T>(
        actor: TaskGraphWriterAdmin,
        org_run_id: &str,
        task_id: &str,
        expected_updated_at: &str,
        reason: TaskTerminalReason,
        mut replacement: CreatePendingTaskParams,
        effects: impl FnOnce(
            &rusqlite::Connection,
            &TaskMutationOutcome,
            &Task,
            &[Task],
        ) -> Result<T, String>,
    ) -> Result<(TaskMutationOutcome, Task, T), String> {
        if reason.code.starts_with("system.") {
            return Err(
                "system.* cancel reason codes are reserved for system recovery".to_string(),
            );
        }
        validate_create_params(&replacement)?;
        if replacement.org_run_id != org_run_id {
            return Err("replacement must belong to the same org run".to_string());
        }
        replacement.replaces_task_id = Some(task_id.to_string());
        let run_id = org_run_id.to_string();
        let old_task_id = task_id.to_string();
        let (outcome, replacement_task, effect) = with_sessions_writer(|| -> Result<_, String> {
            let mut conn = get_connection().map_err(|error| error.to_string())?;
            let tx = conn
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .map_err(|error| error.to_string())?;
            let audit = actor.validate(&tx, &run_id)?;
            let mut tasks = list_tasks_with_conn(&tx, &run_id)?;
            let old_index = tasks
                .iter()
                .position(|task| task.id == old_task_id)
                .ok_or_else(|| format!("task_not_found: {old_task_id} in run {run_id}"))?;
            let previous = tasks[old_index].clone();
            if previous.updated_at != expected_updated_at {
                return Err(format!(
                        "{TASK_MUTATION_CONFLICT_ERROR}: task {old_task_id} changed after authorization"
                    ));
            }
            if previous.status.is_terminal() {
                return Err(format!(
                    "{TASK_TERMINAL_IMMUTABLE_ERROR}: task {old_task_id} is {}",
                    previous.status.as_wire()
                ));
            }
            ensure_task_run_capacity(
                tasks
                    .iter()
                    .filter(|task| task.status.is_open())
                    .count()
                    .saturating_sub(1),
                1,
            )?;
            let now = now_rfc3339();
            tasks[old_index].status = TaskStatus::Cancelled;
            tasks[old_index].cancel_reason = Some(reason);
            tasks[old_index].updated_at = now.clone();
            validate_task_model_invariants(&tx, &tasks[old_index])?;
            let cancelled = tasks[old_index].clone();
            update_task_row(&tx, &cancelled)?;

            let replacement_task = pending_task_from_params(replacement, &audit, &now)?;
            validate_task_model_invariants(&tx, &replacement_task)?;
            tasks.push(replacement_task);
            canonicalize_dependencies(&mut tasks, &run_id)?;
            let replacement_task = tasks
                .last()
                .cloned()
                .expect("replacement remains in candidate graph");
            insert_task_row(&tx, &replacement_task)?;
            insert_task_history_event_as(
                &tx,
                &run_id,
                &old_task_id,
                TASK_EVENT_UPDATED,
                Some(&previous),
                &cancelled,
                &audit,
            )?;
            insert_task_history_event_as(
                &tx,
                &run_id,
                &replacement_task.id,
                TASK_EVENT_CREATED,
                None,
                &replacement_task,
                &audit,
            )?;
            crate::coordination::agent_org_runs::bump_work_revision_in_tx(&tx, &run_id)?;
            let outcome = mutation_outcome(previous, cancelled, &tasks);
            let effect = effects(&tx, &outcome, &replacement_task, &tasks)?;
            tx.commit().map_err(|error| error.to_string())?;
            Ok((outcome, replacement_task, effect))
        })?;
        crate::coordination::agent_org_run_events::notify_agent_org_run_changed(&run_id);
        Ok((outcome, replacement_task, effect))
    }

    pub fn owner_start_with_transactional_effects<T>(
        actor: TaskOwnerExecution,
        org_run_id: &str,
        task_id: &str,
        effects: impl FnOnce(&rusqlite::Connection, &TaskMutationOutcome, &[Task]) -> Result<T, String>,
    ) -> Result<(TaskMutationOutcome, T), String> {
        mutate_lifecycle(
            org_run_id,
            task_id,
            None,
            |tx, _previous| actor.validate(tx, org_run_id, task_id),
            |task, audit| {
                if task.status != TaskStatus::Pending {
                    return Err(format!(
                        "task_owner_start_requires_pending: task {} is {}",
                        task.id,
                        task.status.as_wire()
                    ));
                }
                if task.owner.as_deref() != Some(audit.participant_id.as_str()) {
                    return Err("task_owner_mismatch".to_string());
                }
                task.status = TaskStatus::InProgress;
                Ok(())
            },
            effects,
        )
    }

    pub fn owner_complete_with_transactional_effects<T>(
        actor: TaskOwnerExecution,
        org_run_id: &str,
        task_id: &str,
        output: TaskOutputInput,
        effects: impl FnOnce(&rusqlite::Connection, &TaskMutationOutcome, &[Task]) -> Result<T, String>,
    ) -> Result<(TaskMutationOutcome, T), String> {
        mutate_lifecycle(
            org_run_id,
            task_id,
            None,
            |tx, _previous| actor.validate(tx, org_run_id, task_id),
            move |task, audit| {
                require_in_progress_owner(task, audit)?;
                task.status = TaskStatus::Completed;
                task.output = Some(TaskOutput {
                    summary: output.summary,
                    content: output.content,
                    artifact_ids: output.artifact_ids,
                    produced_by_member_id: audit.participant_id.clone(),
                    produced_at: now_rfc3339(),
                });
                Ok(())
            },
            effects,
        )
    }

    pub fn owner_fail_with_transactional_effects<T>(
        actor: TaskOwnerExecution,
        org_run_id: &str,
        task_id: &str,
        reason: TaskTerminalReason,
        effects: impl FnOnce(&rusqlite::Connection, &TaskMutationOutcome, &[Task]) -> Result<T, String>,
    ) -> Result<(TaskMutationOutcome, T), String> {
        if reason.code.starts_with("system.") {
            return Err(
                "system.* failure reason codes are reserved for system recovery".to_string(),
            );
        }
        mutate_lifecycle(
            org_run_id,
            task_id,
            None,
            |tx, _previous| actor.validate(tx, org_run_id, task_id),
            move |task, audit| {
                require_in_progress_owner(task, audit)?;
                task.status = TaskStatus::Failed;
                task.failure_reason = Some(reason);
                Ok(())
            },
            effects,
        )
    }
}

fn validate_create_params(params: &CreatePendingTaskParams) -> Result<(), String> {
    validate_task_identifier("task id", &params.id)?;
    validate_task_dependency_ids("blocked_by", &params.blocked_by)?;
    validate_task_text_fields(
        &params.subject,
        &params.description,
        params.active_form.as_deref(),
    )?;
    if params.org_run_id.trim().is_empty() {
        return Err("org_run_id must be non-empty".to_string());
    }
    Ok(())
}

fn pending_task_from_params(
    params: CreatePendingTaskParams,
    audit: &TaskActorAudit,
    now: &str,
) -> Result<Task, String> {
    let source_turn_intent_id = audit
        .turn_intent_id
        .clone()
        .ok_or_else(|| "graph writer source turn is required".to_string())?;
    Ok(Task {
        id: params.id,
        org_run_id: params.org_run_id,
        subject: params.subject,
        description: params.description,
        active_form: params.active_form,
        owner: params.owner,
        status: TaskStatus::Pending,
        execution_mode: params.execution_mode,
        blocks: Vec::new(),
        blocked_by: params.blocked_by,
        metadata: params.metadata,
        output: None,
        failure_reason: None,
        cancel_reason: None,
        created_by_participant_id: audit.participant_id.clone(),
        source_turn_intent_id,
        originating_message_id: params.originating_message_id,
        replaces_task_id: params.replaces_task_id,
        created_at: now.to_string(),
        updated_at: now.to_string(),
    })
}

fn validate_replacement_reference(tx: &rusqlite::Connection, task: &Task) -> Result<(), String> {
    let Some(replaced_id) = task.replaces_task_id.as_deref() else {
        return Ok(());
    };
    let replaced_status: Option<String> = tx
        .query_row(
            "SELECT status FROM agent_org_runtime_tasks WHERE org_run_id=?1 AND id=?2",
            params![&task.org_run_id, replaced_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if replaced_status.as_deref() != Some(TaskStatus::Cancelled.as_wire()) {
        return Err("replacement must reference a cancelled task in the same run".to_string());
    }
    Ok(())
}

fn enforce_scheduling_policy(
    task: &Task,
    tasks: &[Task],
    policy: TaskCreateSchedulingPolicy,
) -> Result<(), String> {
    if policy.allow_parallel_with_unlisted_open_tasks {
        return Ok(());
    }
    let covered = task_dependency_closure(&task.blocked_by, tasks);
    let omitted = tasks
        .iter()
        .filter(|candidate| candidate.id != task.id && candidate.status.is_open())
        .filter(|candidate| !covered.contains(&candidate.id))
        .map(|candidate| candidate.id.clone())
        .collect::<Vec<_>>();
    if omitted.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "{TASK_GRAPH_OPEN_WORK_CONFLICT_ERROR}:{}",
            omitted.join(",")
        ))
    }
}

fn insert_task_row(tx: &rusqlite::Connection, task: &Task) -> Result<(), String> {
    let blocked_by_json = encode_json_array(&task.blocked_by)?;
    let metadata_json = encode_metadata(task.metadata.as_ref())?;
    let output_json = encode_optional_json("task output", task.output.as_ref())?;
    let failure_reason_json =
        encode_optional_json("task failure reason", task.failure_reason.as_ref())?;
    let cancel_reason_json =
        encode_optional_json("task cancel reason", task.cancel_reason.as_ref())?;
    tx.execute(
        "INSERT INTO agent_org_runtime_tasks (
            id, org_run_id, subject, description, active_form, owner, status,
            execution_mode, blocked_by_json, metadata_json, output_json,
            failure_reason_json, cancel_reason_json, created_by_participant_id,
            source_turn_intent_id, originating_message_id, replaces_task_id,
            created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                   ?13, ?14, ?15, ?16, ?17, ?18, ?19)",
        params![
            &task.id,
            &task.org_run_id,
            &task.subject,
            &task.description,
            task.active_form.as_deref(),
            task.owner.as_deref(),
            task.status.as_wire(),
            task.execution_mode.as_wire(),
            &blocked_by_json,
            metadata_json.as_deref(),
            output_json.as_deref(),
            failure_reason_json.as_deref(),
            cancel_reason_json.as_deref(),
            &task.created_by_participant_id,
            &task.source_turn_intent_id,
            task.originating_message_id.as_deref(),
            task.replaces_task_id.as_deref(),
            &task.created_at,
            &task.updated_at,
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn update_task_row(tx: &rusqlite::Connection, task: &Task) -> Result<(), String> {
    let blocked_by_json = encode_json_array(&task.blocked_by)?;
    let metadata_json = encode_metadata(task.metadata.as_ref())?;
    let output_json = encode_optional_json("task output", task.output.as_ref())?;
    let failure_reason_json =
        encode_optional_json("task failure reason", task.failure_reason.as_ref())?;
    let cancel_reason_json =
        encode_optional_json("task cancel reason", task.cancel_reason.as_ref())?;
    let changed = tx
        .execute(
            "UPDATE agent_org_runtime_tasks SET
                subject=?1, description=?2, active_form=?3, owner=?4, status=?5,
                execution_mode=?6, blocked_by_json=?7, metadata_json=?8,
                output_json=?9, failure_reason_json=?10, cancel_reason_json=?11,
                updated_at=?12
             WHERE org_run_id=?13 AND id=?14",
            params![
                &task.subject,
                &task.description,
                task.active_form.as_deref(),
                task.owner.as_deref(),
                task.status.as_wire(),
                task.execution_mode.as_wire(),
                &blocked_by_json,
                metadata_json.as_deref(),
                output_json.as_deref(),
                failure_reason_json.as_deref(),
                cancel_reason_json.as_deref(),
                &task.updated_at,
                &task.org_run_id,
                &task.id,
            ],
        )
        .map_err(|error| error.to_string())?;
    if changed != 1 {
        return Err(format!("task_not_found: {}", task.id));
    }
    Ok(())
}

fn mutate_lifecycle<T>(
    org_run_id: &str,
    task_id: &str,
    expected_updated_at: Option<&str>,
    validate_actor: impl FnOnce(&rusqlite::Connection, &Task) -> Result<TaskActorAudit, String>,
    mutation: impl FnOnce(&mut Task, &TaskActorAudit) -> Result<(), String>,
    effects: impl FnOnce(&rusqlite::Connection, &TaskMutationOutcome, &[Task]) -> Result<T, String>,
) -> Result<(TaskMutationOutcome, T), String> {
    let run_id = org_run_id.to_string();
    let task_id = task_id.to_string();
    let (outcome, effect) = with_sessions_writer(|| -> Result<_, String> {
        let mut conn = get_connection().map_err(|error| error.to_string())?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;
        let sql = format!(
            "SELECT {SELECT_COLUMNS} FROM agent_org_runtime_tasks
             WHERE org_run_id=?1 AND id=?2"
        );
        let previous: Task = tx
            .query_row(&sql, params![&run_id, &task_id], row_to_task)
            .optional()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("task_not_found: {task_id} in run {run_id}"))?;
        if expected_updated_at.is_some_and(|expected| expected != previous.updated_at) {
            return Err(format!(
                "{TASK_MUTATION_CONFLICT_ERROR}: task {task_id} changed after authorization"
            ));
        }
        let audit = validate_actor(&tx, &previous)?;
        let mut tasks = list_tasks_with_conn(&tx, &run_id)?;
        let index = tasks
            .iter()
            .position(|task| task.id == task_id)
            .expect("task selected above remains in same transaction");
        if previous.status == TaskStatus::Pending {
            let graph = super::super::TaskGraphIndex::new(&tasks);
            let starting = matches!(
                audit.kind,
                super::super::actor::TaskActorKind::OwnerExecution
            );
            if starting && !graph.is_ready(&previous) {
                return Err("task_dependencies_not_completed".to_string());
            }
        }
        let task = &mut tasks[index];
        mutation(task, &audit)?;
        task.updated_at = now_rfc3339();
        validate_task_model_invariants(&tx, task)?;
        let current = task.clone();
        update_task_row(&tx, &current)?;
        insert_task_history_event_as(
            &tx,
            &run_id,
            &task_id,
            TASK_EVENT_UPDATED,
            Some(&previous),
            &current,
            &audit,
        )?;
        crate::coordination::agent_org_runs::bump_work_revision_in_tx(&tx, &run_id)?;
        let outcome = mutation_outcome(previous, current, &tasks);
        let effect = effects(&tx, &outcome, &tasks)?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok((outcome, effect))
    })?;
    crate::coordination::agent_org_run_events::notify_agent_org_run_changed(&run_id);
    Ok((outcome, effect))
}

fn require_in_progress_owner(task: &Task, audit: &TaskActorAudit) -> Result<(), String> {
    if task.status != TaskStatus::InProgress {
        return Err(format!(
            "task_owner_terminal_requires_in_progress: task {} is {}",
            task.id,
            task.status.as_wire()
        ));
    }
    if task.owner.as_deref() != Some(audit.participant_id.as_str()) {
        return Err("task_owner_mismatch".to_string());
    }
    Ok(())
}

fn mutation_outcome(previous: Task, current: Task, tasks: &[Task]) -> TaskMutationOutcome {
    let current_graph = super::super::TaskGraphIndex::new(tasks);
    let mut previous_tasks = tasks.to_vec();
    if let Some(task) = previous_tasks
        .iter_mut()
        .find(|task| task.id == previous.id)
    {
        *task = previous.clone();
    }
    let previous_graph = super::super::TaskGraphIndex::new(&previous_tasks);
    let was_ready = previous.owner.is_some()
        && previous.status == TaskStatus::Pending
        && previous_graph.is_ready(&previous);
    let is_ready = current.owner.is_some()
        && current.status == TaskStatus::Pending
        && current_graph.is_ready(&current);
    TaskMutationOutcome {
        owner_changed: previous.owner != current.owner,
        status_changed: previous.status != current.status,
        became_completed: previous.status != TaskStatus::Completed
            && current.status == TaskStatus::Completed,
        became_ready: !was_ready && is_ready,
        previous,
        current,
    }
}

//! Canonical Agent Org Task state machine. Every method validates its typed actor
//! against persisted Turn context after beginning the IMMEDIATE transaction.

use std::collections::HashMap;

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
use super::super::UserTaskHandoffAdmin;
use super::super::{
    task_dependency_closure, CreatePendingTaskParams, PendingTaskGraphPatch,
    SystemArchiveOrRecovery, Task, TaskCancelAndReplaceInput, TaskCreateSchedulingPolicy,
    TaskGraphWriterAdmin, TaskMutationOutcome, TaskOutput, TaskOutputInput, TaskOwnerExecution,
    TaskStatus, TaskTerminalReason, TASK_ACTIVE_EPISODE_DUPLICATE_ERROR, TASK_EVENT_CREATED,
    TASK_EVENT_UPDATED, TASK_GRAPH_OPEN_WORK_CONFLICT_ERROR, TASK_METADATA_ELIGIBLE_MEMBER_IDS,
    TASK_METADATA_EXECUTION_MODE, TASK_METADATA_OUTPUT, TASK_METADATA_REQUIRED_ROLE,
    TASK_TERMINAL_IMMUTABLE_ERROR,
};
use super::dependencies::canonicalize_dependencies;
use super::validation::{
    ensure_current_generation_has_no_certificate, ensure_run_allows_task_mutation,
    ensure_task_run_capacity, validate_task_model_invariants, validate_task_text_fields,
};
use super::AgentOrgTaskStore;

enum TaskGraphMutationActor {
    Turn(TaskGraphWriterAdmin),
    User(UserTaskHandoffAdmin),
}

impl TaskGraphMutationActor {
    fn validate(
        &self,
        conn: &rusqlite::Connection,
        org_run_id: &str,
    ) -> Result<TaskActorAudit, String> {
        match self {
            Self::Turn(actor) => actor.validate(conn, org_run_id),
            Self::User(actor) => actor.validate(conn, org_run_id),
        }
    }

    fn user_request_id(&self) -> Option<&str> {
        match self {
            Self::Turn(_) => None,
            Self::User(actor) => Some(actor.request_id()),
        }
    }
}

fn task_assignment_is_materialized_for_turn(
    conn: &rusqlite::Connection,
    context: &crate::coordination::agent_org_turn_contexts::AgentOrgTurnContext,
    task_id: &str,
    projected_inbox_ids: &[i64],
) -> Result<bool, String> {
    let owner_member_id = context
        .owner_member_id
        .as_deref()
        .ok_or_else(|| "TaskExecution context has no owner_member_id".to_string())?;
    let mut statement = conn
        .prepare(
            "SELECT EXISTS(
                 SELECT 1
                 FROM agent_org_runtime_inbox inbox
                 JOIN agent_org_runtime_inbox_materializations materialization
                   ON materialization.inbox_id=inbox.id
                  AND materialization.session_id=?2
                 WHERE inbox.id=?1
                   AND inbox.org_run_id=?3
                   AND inbox.recipient_member_id=?4
                   AND inbox.delivery_class='formal_work'
                   AND inbox.read_at IS NULL
                   AND inbox.payload_kind='task_assigned'
                   AND json_valid(inbox.payload_json)
                   AND json_type(inbox.payload_json,'$.task_id')='text'
                   AND json_extract(inbox.payload_json,'$.task_id')=?5
                   AND NOT EXISTS (
                       SELECT 1
                       FROM agent_org_runtime_inbox_delivery_resolutions resolution
                       WHERE resolution.inbox_id=inbox.id
                   )
             )",
        )
        .map_err(|error| error.to_string())?;
    for inbox_id in projected_inbox_ids {
        let matches: bool = statement
            .query_row(
                params![
                    inbox_id,
                    &context.session_id,
                    &context.org_run_id,
                    owner_member_id,
                    task_id,
                ],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if matches {
            return Ok(true);
        }
    }
    Ok(false)
}

impl AgentOrgTaskStore {
    pub(crate) fn cancel_open_for_user_abandon_with_connection(
        conn: &rusqlite::Connection,
        actor: UserTaskHandoffAdmin,
        org_run_id: &str,
        reason: &TaskTerminalReason,
    ) -> Result<Vec<Task>, String> {
        validate_terminal_reason_source(conn, org_run_id, reason, true, Some(actor.request_id()))?;
        let audit = actor.validate(conn, org_run_id)?;
        let episode =
            crate::coordination::agent_org_work_episodes::active_with_connection(conn, org_run_id)?
                .ok_or_else(|| "task_abandon_no_active_work_episode".to_string())?;
        let episode_task_ids =
            crate::coordination::agent_org_work_episodes::task_ids_with_connection(
                conn,
                org_run_id,
                &episode.id,
            )?
            .into_iter()
            .collect::<std::collections::HashSet<_>>();
        let mut tasks = list_tasks_with_conn(conn, org_run_id)?;
        let now = now_rfc3339();
        let mut changed = false;
        for task in &mut tasks {
            if !task.status.is_open() || !episode_task_ids.contains(&task.id) {
                continue;
            }
            let previous = task.clone();
            task.status = TaskStatus::Cancelled;
            task.output = None;
            task.failure_reason = None;
            task.cancel_reason = Some(reason.clone());
            task.updated_at = now.clone();
            validate_task_model_invariants(conn, task)?;
            update_task_row(conn, task)?;
            insert_task_history_event_as(
                conn,
                org_run_id,
                &task.id,
                TASK_EVENT_UPDATED,
                Some(&previous),
                task,
                &audit,
            )?;
            changed = true;
        }
        if changed {
            crate::coordination::agent_org_runs::bump_work_revision_in_tx(conn, org_run_id)?;
        }
        Ok(tasks)
    }

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
        let run_id = params.org_run_id.clone();
        let (task, effect) = with_sessions_writer(|| -> Result<(Task, T), String> {
            let conn = get_connection().map_err(|error| error.to_string())?;
            let tx = database::db::begin_immediate(&conn).map_err(|error| error.to_string())?;
            let result =
                Self::create_pending_in_tx(&tx, actor, params, scheduling_policy, effects)?;
            tx.commit().map_err(|error| error.to_string())?;
            Ok(result)
        })?;
        crate::coordination::agent_org_run_events::notify_agent_org_run_changed(&run_id);
        Ok((task, effect))
    }

    pub(crate) fn create_pending_in_tx<T>(
        conn: &rusqlite::Connection,
        actor: TaskGraphWriterAdmin,
        params: CreatePendingTaskParams,
        scheduling_policy: TaskCreateSchedulingPolicy,
        effects: impl FnOnce(&rusqlite::Connection, &Task, &[Task]) -> Result<T, String>,
    ) -> Result<(Task, T), String> {
        validate_create_params(&params)?;
        let run_id = params.org_run_id.clone();
        let audit = actor.validate(conn, &run_id)?;
        ensure_current_generation_has_no_certificate(conn, &run_id, audit.activation_generation)?;
        if params.replaces_task_id.is_none() {
            let source_turn_intent_id = audit
                .turn_intent_id
                .as_deref()
                .ok_or_else(|| "graph writer source turn is required".to_string())?;
            crate::coordination::agent_org_work_episodes::validate_new_task_admission_in_tx(
                conn,
                &run_id,
                source_turn_intent_id,
            )?;
        }
        let mut tasks = list_tasks_with_conn(conn, &run_id)?;
        ensure_task_run_capacity(tasks.iter().filter(|task| task.status.is_open()).count(), 1)?;
        let now = now_rfc3339();
        let task = pending_task_from_params(params, &audit, &now)?;
        validate_task_model_invariants(conn, &task)?;
        validate_replacement_reference(conn, &task)?;
        tasks.push(task);
        canonicalize_dependencies(&mut tasks, &run_id)?;
        let task = tasks
            .last()
            .cloned()
            .expect("candidate graph includes newly-created task");
        enforce_scheduling_policy(&task, &tasks, scheduling_policy)?;
        insert_task_row(conn, &task)?;
        insert_task_history_event_as(
            conn,
            &run_id,
            &task.id,
            TASK_EVENT_CREATED,
            None,
            &task,
            &audit,
        )?;
        crate::coordination::agent_org_runs::bump_work_revision_in_tx(conn, &run_id)?;
        let effect = effects(conn, &task, &tasks)?;
        Ok((task, effect))
    }

    pub fn create_pending_batch_with_transactional_effects<T>(
        actor: TaskGraphWriterAdmin,
        params_list: Vec<CreatePendingTaskParams>,
        allow_parallel_with_existing_open_tasks: bool,
        effects: impl FnOnce(&rusqlite::Connection, &[Task], &[Task]) -> Result<T, String>,
    ) -> Result<(Vec<Task>, T), String> {
        let run_id = params_list
            .first()
            .map(|params| params.org_run_id.clone())
            .ok_or_else(|| "task graph must contain at least one task".to_string())?;
        let (created, effect) = with_sessions_writer(|| -> Result<(Vec<Task>, T), String> {
            let conn = get_connection().map_err(|error| error.to_string())?;
            let tx = database::db::begin_immediate(&conn).map_err(|error| error.to_string())?;
            let result = Self::create_pending_batch_in_tx(
                &tx,
                actor,
                params_list,
                allow_parallel_with_existing_open_tasks,
                effects,
            )?;
            tx.commit().map_err(|error| error.to_string())?;
            Ok(result)
        })?;
        crate::coordination::agent_org_run_events::notify_agent_org_run_changed(&run_id);
        Ok((created, effect))
    }

    pub(crate) fn create_pending_batch_in_tx<T>(
        conn: &rusqlite::Connection,
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
        let audit = actor.validate(conn, &run_id)?;
        ensure_current_generation_has_no_certificate(conn, &run_id, audit.activation_generation)?;
        if params_list
            .iter()
            .any(|params| params.replaces_task_id.is_none())
        {
            let source_turn_intent_id = audit
                .turn_intent_id
                .as_deref()
                .ok_or_else(|| "graph writer source turn is required".to_string())?;
            crate::coordination::agent_org_work_episodes::validate_new_task_admission_in_tx(
                conn,
                &run_id,
                source_turn_intent_id,
            )?;
        }
        let mut tasks = list_tasks_with_conn(conn, &run_id)?;
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
            validate_task_model_invariants(conn, &task)?;
            validate_replacement_reference(conn, &task)?;
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
            insert_task_row(conn, task)?;
            insert_task_history_event_as(
                conn,
                &run_id,
                &task.id,
                TASK_EVENT_CREATED,
                None,
                task,
                &audit,
            )?;
        }
        crate::coordination::agent_org_runs::bump_work_revision_in_tx(conn, &run_id)?;
        let effect = effects(conn, &created, &tasks)?;
        Ok((created, effect))
    }

    pub fn patch_pending_with_transactional_effects<T>(
        actor: TaskGraphWriterAdmin,
        org_run_id: &str,
        task_id: &str,
        patch: PendingTaskGraphPatch,
        effects: impl FnOnce(&rusqlite::Connection, &TaskMutationOutcome, &[Task]) -> Result<T, String>,
    ) -> Result<(TaskMutationOutcome, T), String> {
        let run_id = org_run_id.to_string();
        let (outcome, effect) = with_sessions_writer(|| -> Result<_, String> {
            let conn = get_connection().map_err(|error| error.to_string())?;
            let tx = database::db::begin_immediate(&conn).map_err(|error| error.to_string())?;
            let result = Self::patch_pending_in_tx(&tx, actor, &run_id, task_id, patch, effects)?;
            tx.commit().map_err(|error| error.to_string())?;
            Ok(result)
        })?;
        crate::coordination::agent_org_run_events::notify_agent_org_run_changed(&run_id);
        Ok((outcome, effect))
    }

    pub(crate) fn patch_pending_in_tx<T>(
        conn: &rusqlite::Connection,
        actor: TaskGraphWriterAdmin,
        org_run_id: &str,
        task_id: &str,
        patch: PendingTaskGraphPatch,
        effects: impl FnOnce(&rusqlite::Connection, &TaskMutationOutcome, &[Task]) -> Result<T, String>,
    ) -> Result<(TaskMutationOutcome, T), String> {
        if let Some(blocked_by) = patch.blocked_by.as_ref() {
            validate_task_dependency_ids("blocked_by", blocked_by)?;
        }
        ensure_run_allows_task_mutation(conn, org_run_id)?;
        let audit = actor.validate(conn, org_run_id)?;
        let mut tasks = list_tasks_with_conn(conn, org_run_id)?;
        let index = tasks
            .iter()
            .position(|task| task.id == task_id)
            .ok_or_else(|| format!("task_not_found: {task_id} in run {org_run_id}"))?;
        let previous = tasks[index].clone();
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
        apply_metadata_merge_patch(
            task,
            patch.metadata_merge_patch,
            patch.eligible_member_ids,
            patch.required_role,
        )?;
        task.updated_at = now_rfc3339();
        validate_task_model_invariants(conn, task)?;
        canonicalize_dependencies(&mut tasks, org_run_id)?;
        let current = tasks[index].clone();
        update_task_row(conn, &current)?;
        insert_task_history_event_as(
            conn,
            org_run_id,
            task_id,
            TASK_EVENT_UPDATED,
            Some(&previous),
            &current,
            &audit,
        )?;
        crate::coordination::agent_org_runs::bump_work_revision_in_tx(conn, org_run_id)?;
        let outcome = mutation_outcome(previous, current, &tasks);
        let effect = effects(conn, &outcome, &tasks)?;
        Ok((outcome, effect))
    }

    pub fn cancel_with_transactional_effects<T>(
        actor: TaskGraphWriterAdmin,
        org_run_id: &str,
        task_id: &str,
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
            |tx, previous| {
                if previous.status == TaskStatus::InProgress {
                    return Err("task_in_progress_requires_execution_handoff".to_string());
                }
                actor.validate(tx, org_run_id)
            },
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

    pub(crate) fn cancel_with_handoff_in_tx<T>(
        conn: &rusqlite::Connection,
        actor: TaskGraphWriterAdmin,
        org_run_id: &str,
        task_id: &str,
        reason: TaskTerminalReason,
        handoff: &crate::coordination::agent_org_task_execution_fence::TaskExecutionHandoffAuthority,
        effects: impl FnOnce(&rusqlite::Connection, &TaskMutationOutcome, &[Task]) -> Result<T, String>,
    ) -> Result<(TaskMutationOutcome, T), String> {
        Self::cancel_in_tx_impl(
            conn,
            TaskGraphMutationActor::Turn(actor),
            org_run_id,
            task_id,
            reason,
            Some(handoff),
            effects,
        )
    }

    pub(crate) fn cancel_with_user_handoff_in_tx<T>(
        conn: &rusqlite::Connection,
        actor: UserTaskHandoffAdmin,
        org_run_id: &str,
        task_id: &str,
        reason: TaskTerminalReason,
        handoff: Option<
            &crate::coordination::agent_org_task_execution_fence::TaskExecutionHandoffAuthority,
        >,
        effects: impl FnOnce(&rusqlite::Connection, &TaskMutationOutcome, &[Task]) -> Result<T, String>,
    ) -> Result<(TaskMutationOutcome, T), String> {
        Self::cancel_in_tx_impl(
            conn,
            TaskGraphMutationActor::User(actor),
            org_run_id,
            task_id,
            reason,
            handoff,
            effects,
        )
    }

    fn cancel_in_tx_impl<T>(
        conn: &rusqlite::Connection,
        actor: TaskGraphMutationActor,
        org_run_id: &str,
        task_id: &str,
        reason: TaskTerminalReason,
        handoff: Option<
            &crate::coordination::agent_org_task_execution_fence::TaskExecutionHandoffAuthority,
        >,
        effects: impl FnOnce(&rusqlite::Connection, &TaskMutationOutcome, &[Task]) -> Result<T, String>,
    ) -> Result<(TaskMutationOutcome, T), String> {
        let reason_for_validation = reason.clone();
        let user_request_id = actor.user_request_id().map(str::to_string);
        if reason.code.starts_with("system.") {
            return Err(
                "system.* cancel reason codes are reserved for system recovery".to_string(),
            );
        }
        mutate_lifecycle_in_tx(
            conn,
            org_run_id,
            task_id,
            |tx, previous| {
                if previous.status == TaskStatus::InProgress
                    && !handoff.is_some_and(|authority| authority.matches(org_run_id, task_id))
                {
                    return Err("task_in_progress_requires_execution_handoff".to_string());
                }
                validate_terminal_reason_source(
                    tx,
                    org_run_id,
                    &reason_for_validation,
                    true,
                    user_request_id.as_deref(),
                )?;
                actor.validate(tx, org_run_id)
            },
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
        reason: TaskTerminalReason,
        replacement: CreatePendingTaskParams,
        effects: impl FnOnce(
            &rusqlite::Connection,
            &TaskMutationOutcome,
            &Task,
            &[Task],
        ) -> Result<T, String>,
    ) -> Result<(TaskMutationOutcome, Task, T), String> {
        let run_id = org_run_id.to_string();
        let (outcome, replacement_task, effect) = with_sessions_writer(|| -> Result<_, String> {
            let conn = get_connection().map_err(|error| error.to_string())?;
            let tx = database::db::begin_immediate(&conn).map_err(|error| error.to_string())?;
            let result = Self::cancel_and_replace_in_tx(
                &tx,
                actor,
                &run_id,
                task_id,
                reason,
                replacement,
                effects,
            )?;
            tx.commit().map_err(|error| error.to_string())?;
            Ok(result)
        })?;
        crate::coordination::agent_org_run_events::notify_agent_org_run_changed(&run_id);
        Ok((outcome, replacement_task, effect))
    }

    pub(crate) fn cancel_and_replace_in_tx<T>(
        conn: &rusqlite::Connection,
        actor: TaskGraphWriterAdmin,
        org_run_id: &str,
        task_id: &str,
        reason: TaskTerminalReason,
        replacement: CreatePendingTaskParams,
        effects: impl FnOnce(
            &rusqlite::Connection,
            &TaskMutationOutcome,
            &Task,
            &[Task],
        ) -> Result<T, String>,
    ) -> Result<(TaskMutationOutcome, Task, T), String> {
        Self::cancel_and_replace_in_tx_impl(
            conn,
            TaskGraphMutationActor::Turn(actor),
            org_run_id,
            task_id,
            TaskCancelAndReplaceInput {
                reason,
                replacement,
                handoff: None,
            },
            effects,
        )
    }

    pub(crate) fn cancel_and_replace_with_handoff_in_tx<T>(
        conn: &rusqlite::Connection,
        actor: TaskGraphWriterAdmin,
        org_run_id: &str,
        task_id: &str,
        input: TaskCancelAndReplaceInput<'_>,
        effects: impl FnOnce(
            &rusqlite::Connection,
            &TaskMutationOutcome,
            &Task,
            &[Task],
        ) -> Result<T, String>,
    ) -> Result<(TaskMutationOutcome, Task, T), String> {
        Self::cancel_and_replace_in_tx_impl(
            conn,
            TaskGraphMutationActor::Turn(actor),
            org_run_id,
            task_id,
            input,
            effects,
        )
    }

    pub(crate) fn cancel_and_replace_with_user_handoff_in_tx<T>(
        conn: &rusqlite::Connection,
        actor: UserTaskHandoffAdmin,
        org_run_id: &str,
        task_id: &str,
        input: TaskCancelAndReplaceInput<'_>,
        effects: impl FnOnce(
            &rusqlite::Connection,
            &TaskMutationOutcome,
            &Task,
            &[Task],
        ) -> Result<T, String>,
    ) -> Result<(TaskMutationOutcome, Task, T), String> {
        Self::cancel_and_replace_in_tx_impl(
            conn,
            TaskGraphMutationActor::User(actor),
            org_run_id,
            task_id,
            input,
            effects,
        )
    }

    fn cancel_and_replace_in_tx_impl<T>(
        conn: &rusqlite::Connection,
        actor: TaskGraphMutationActor,
        org_run_id: &str,
        task_id: &str,
        input: TaskCancelAndReplaceInput<'_>,
        effects: impl FnOnce(
            &rusqlite::Connection,
            &TaskMutationOutcome,
            &Task,
            &[Task],
        ) -> Result<T, String>,
    ) -> Result<(TaskMutationOutcome, Task, T), String> {
        let TaskCancelAndReplaceInput {
            reason,
            mut replacement,
            handoff,
        } = input;
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
        validate_terminal_reason_source(conn, org_run_id, &reason, true, actor.user_request_id())?;
        let audit = actor.validate(conn, org_run_id)?;
        let mut tasks = list_tasks_with_conn(conn, org_run_id)?;
        let old_index = tasks
            .iter()
            .position(|task| task.id == task_id)
            .ok_or_else(|| format!("task_not_found: {task_id} in run {org_run_id}"))?;
        let previous = tasks[old_index].clone();
        if previous.status.is_terminal() {
            return Err(format!(
                "{TASK_TERMINAL_IMMUTABLE_ERROR}: task {task_id} is {}",
                previous.status.as_wire()
            ));
        }
        if previous.status == TaskStatus::InProgress
            && !handoff.is_some_and(|authority| authority.matches(org_run_id, task_id))
        {
            return Err("task_in_progress_requires_execution_handoff".to_string());
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
        validate_task_model_invariants(conn, &tasks[old_index])?;
        let cancelled = tasks[old_index].clone();
        update_task_row(conn, &cancelled)?;

        let replacement_task = pending_task_from_params(replacement, &audit, &now)?;
        validate_task_model_invariants(conn, &replacement_task)?;
        tasks.push(replacement_task);
        canonicalize_dependencies(&mut tasks, org_run_id)?;
        let replacement_task = tasks
            .last()
            .cloned()
            .expect("replacement remains in candidate graph");
        insert_task_row(conn, &replacement_task)?;
        insert_task_history_event_as(
            conn,
            org_run_id,
            task_id,
            TASK_EVENT_UPDATED,
            Some(&previous),
            &cancelled,
            &audit,
        )?;
        insert_task_history_event_as(
            conn,
            org_run_id,
            &replacement_task.id,
            TASK_EVENT_CREATED,
            None,
            &replacement_task,
            &audit,
        )?;
        crate::coordination::agent_org_runs::bump_work_revision_in_tx(conn, org_run_id)?;
        let outcome = mutation_outcome(previous, cancelled, &tasks);
        let effect = effects(conn, &outcome, &replacement_task, &tasks)?;
        Ok((outcome, replacement_task, effect))
    }

    pub fn owner_start_with_transactional_effects<T>(
        actor: TaskOwnerExecution,
        org_run_id: &str,
        task_id: &str,
        effects: impl FnOnce(&rusqlite::Connection, &TaskMutationOutcome, &[Task]) -> Result<T, String>,
    ) -> Result<(TaskMutationOutcome, T), String> {
        let run_id = org_run_id.to_string();
        let task_id = task_id.to_string();
        let result = with_sessions_writer(|| -> Result<_, String> {
            let conn = get_connection().map_err(|error| error.to_string())?;
            let tx = database::db::begin_immediate(&conn).map_err(|error| error.to_string())?;
            let result = Self::owner_start_in_tx(&tx, actor, &run_id, &task_id, effects)?;
            tx.commit().map_err(|error| error.to_string())?;
            Ok(result)
        })?;
        if result.0.status_changed {
            crate::coordination::agent_org_run_events::notify_agent_org_run_changed(&run_id);
        }
        Ok(result)
    }

    pub(crate) fn owner_start_in_tx<T>(
        conn: &rusqlite::Connection,
        actor: TaskOwnerExecution,
        org_run_id: &str,
        task_id: &str,
        effects: impl FnOnce(&rusqlite::Connection, &TaskMutationOutcome, &[Task]) -> Result<T, String>,
    ) -> Result<(TaskMutationOutcome, T), String> {
        let current_status: Option<String> = conn
            .query_row(
                "SELECT status FROM agent_org_runtime_tasks
                 WHERE org_run_id=?1 AND id=?2",
                params![org_run_id, task_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if current_status.as_deref() == Some(TaskStatus::InProgress.as_wire()) {
            let audit = actor.validate(conn, org_run_id, task_id)?;
            let tasks = list_tasks_with_conn(conn, org_run_id)?;
            let current = tasks
                .iter()
                .find(|task| task.id == task_id)
                .cloned()
                .ok_or_else(|| format!("task_not_found: {task_id} in run {org_run_id}"))?;
            if current.owner.as_deref() != Some(audit.participant_id.as_str()) {
                return Err("task_owner_mismatch".to_string());
            }
            // The turn processor owns the Pending -> InProgress transition
            // after materializing the exact TaskAssigned input and before the
            // Provider call. A model may still obey the prompt and call
            // task_update(start); acknowledge that call without manufacturing
            // another Task event or work revision.
            let outcome = mutation_outcome(current.clone(), current, &tasks);
            let effect = effects(conn, &outcome, &tasks)?;
            return Ok((outcome, effect));
        }
        mutate_lifecycle_in_tx(
            conn,
            org_run_id,
            task_id,
            |tx, _previous| {
                let audit = actor.validate(tx, org_run_id, task_id)?;
                if crate::coordination::agent_org_task_handoffs::replacement_dispatch_is_blocked_with_connection(
                    tx, org_run_id, task_id,
                )? {
                    return Err("task_execution_handoff_replacement_not_released".to_string());
                }
                Ok(audit)
            },
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

    /// Atomically align the durable Task status with a TaskExecution Turn
    /// immediately before its Provider call. A Pending Task may start only
    /// after the exact TaskAssigned row has been durably materialized into
    /// this member Session; already-running continuations are idempotent.
    pub(crate) fn start_task_execution_turn_in_tx(
        conn: &rusqlite::Connection,
        context: &crate::coordination::agent_org_turn_contexts::AgentOrgTurnContext,
        projected_inbox_ids: &[i64],
    ) -> Result<bool, String> {
        if context.turn_kind
            != crate::coordination::agent_org_turn_contexts::AgentOrgTurnKind::TaskExecution
        {
            return Ok(false);
        }
        let task_id = context
            .task_id
            .as_deref()
            .ok_or_else(|| "TaskExecution context has no task_id".to_string())?;
        let actor = TaskOwnerExecution::new(&context.session_id, &context.turn_intent_id)?;
        let (outcome, ()) = Self::owner_start_in_tx(
            conn,
            actor,
            &context.org_run_id,
            task_id,
            |conn, outcome, _tasks| {
                if outcome.previous.status == TaskStatus::Pending
                    && !task_assignment_is_materialized_for_turn(
                        conn,
                        context,
                        task_id,
                        projected_inbox_ids,
                    )?
                {
                    return Err("task_execution_start_requires_materialized_assignment".to_string());
                }
                Ok(())
            },
        )?;
        Ok(outcome.status_changed)
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
            |tx, _previous| actor.validate(tx, org_run_id, task_id),
            move |task, audit| {
                require_in_progress_owner(task, audit)?;
                task.status = TaskStatus::Completed;
                task.output = Some(TaskOutput {
                    summary: output.summary,
                    content: output.content,
                    artifact_ids: output.artifact_ids,
                    plan_revision_id: None,
                    produced_by_member_id: audit.participant_id.clone(),
                    produced_at: now_rfc3339(),
                });
                Ok(())
            },
            effects,
        )
    }

    pub(crate) fn owner_complete_in_tx<T>(
        conn: &rusqlite::Connection,
        actor: TaskOwnerExecution,
        org_run_id: &str,
        task_id: &str,
        output: TaskOutputInput,
        effects: impl FnOnce(&rusqlite::Connection, &TaskMutationOutcome, &[Task]) -> Result<T, String>,
    ) -> Result<(TaskMutationOutcome, T), String> {
        mutate_lifecycle_in_tx(
            conn,
            org_run_id,
            task_id,
            |tx, _previous| actor.validate(tx, org_run_id, task_id),
            move |task, audit| {
                require_in_progress_owner(task, audit)?;
                task.status = TaskStatus::Completed;
                task.output = Some(TaskOutput {
                    summary: output.summary,
                    content: output.content,
                    artifact_ids: output.artifact_ids,
                    plan_revision_id: None,
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
        let reason_for_validation = reason.clone();
        mutate_lifecycle(
            org_run_id,
            task_id,
            |tx, _previous| {
                validate_terminal_reason_source(
                    tx,
                    org_run_id,
                    &reason_for_validation,
                    false,
                    None,
                )?;
                actor.validate(tx, org_run_id, task_id)
            },
            move |task, audit| {
                require_in_progress_owner(task, audit)?;
                task.status = TaskStatus::Failed;
                task.failure_reason = Some(reason);
                Ok(())
            },
            effects,
        )
    }

    pub(crate) fn owner_fail_in_tx<T>(
        conn: &rusqlite::Connection,
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
        let reason_for_validation = reason.clone();
        mutate_lifecycle_in_tx(
            conn,
            org_run_id,
            task_id,
            |tx, _previous| {
                validate_terminal_reason_source(
                    tx,
                    org_run_id,
                    &reason_for_validation,
                    false,
                    None,
                )?;
                actor.validate(tx, org_run_id, task_id)
            },
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

fn validate_terminal_reason_source(
    conn: &rusqlite::Connection,
    org_run_id: &str,
    reason: &TaskTerminalReason,
    allow_user_scope_removed: bool,
    run_view_request_id: Option<&str>,
) -> Result<(), String> {
    let source = reason.source_event_id.as_deref();
    if reason.code == "user_scope_removed" {
        if !allow_user_scope_removed {
            return Err("user_scope_removed is valid only for Task cancellation".to_string());
        }
        let source = source
            .filter(|source| !source.trim().is_empty())
            .ok_or_else(|| "user_scope_removed requires source_event_id".to_string())?;
        let is_exact_run_view_request = run_view_request_id == Some(source);
        if !is_exact_run_view_request
            && !crate::coordination::agent_org_run_completion::valid_team_user_event(
                conn, org_run_id, source,
            )?
        {
            return Err(
                "user_scope_removed source_event_id is neither a current Team user event nor the exact Run View request".to_string(),
            );
        }
    } else if source.is_some() {
        return Err("source_event_id is reserved for user_scope_removed".to_string());
    }
    Ok(())
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

fn apply_metadata_merge_patch(
    task: &mut Task,
    merge_patch: Option<serde_json::Value>,
    eligible_member_ids: Option<Vec<String>>,
    required_role: Option<String>,
) -> Result<(), String> {
    let mut metadata = match task.metadata.take() {
        Some(serde_json::Value::Object(object)) => object,
        Some(_) => return Err("persisted task metadata is not an object".to_string()),
        None => serde_json::Map::new(),
    };
    if let Some(merge_patch) = merge_patch {
        let patch = merge_patch
            .as_object()
            .ok_or_else(|| "metadata patch must be an object".to_string())?;
        for (key, value) in patch {
            if [
                TASK_METADATA_ELIGIBLE_MEMBER_IDS,
                TASK_METADATA_REQUIRED_ROLE,
                TASK_METADATA_EXECUTION_MODE,
                TASK_METADATA_OUTPUT,
            ]
            .contains(&key.as_str())
            {
                return Err(format!(
                    "metadata contains reserved Agent Org task field: {key}; use the typed parameter instead"
                ));
            }
            if value.is_null() {
                metadata.remove(key);
            } else {
                metadata.insert(key.clone(), value.clone());
            }
        }
    }
    if let Some(eligible_member_ids) = eligible_member_ids {
        metadata.insert(
            TASK_METADATA_ELIGIBLE_MEMBER_IDS.to_string(),
            serde_json::json!(eligible_member_ids),
        );
    }
    if let Some(required_role) = required_role {
        let required_role = required_role.trim();
        if required_role.is_empty() {
            metadata.remove(TASK_METADATA_REQUIRED_ROLE);
        } else {
            metadata.insert(
                TASK_METADATA_REQUIRED_ROLE.to_string(),
                serde_json::Value::String(required_role.to_string()),
            );
        }
    }
    task.metadata = (!metadata.is_empty()).then_some(serde_json::Value::Object(metadata));
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
        activation_generation: audit.activation_generation,
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
    let terminal = replaced_status
        .as_deref()
        .is_some_and(|status| matches!(status, "completed" | "failed" | "cancelled"));
    if !terminal {
        return Err("replacement must reference a terminal task in the same run".to_string());
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
    ensure_no_active_episode_semantic_duplicate(tx, task)?;
    let blocked_by_json = encode_json_array(&task.blocked_by)?;
    let metadata_json = encode_metadata(task.metadata.as_ref())?;
    let output_json = encode_optional_json("task output", task.output.as_ref())?;
    let failure_reason_json =
        encode_optional_json("task failure reason", task.failure_reason.as_ref())?;
    let cancel_reason_json =
        encode_optional_json("task cancel reason", task.cancel_reason.as_ref())?;
    tx.execute(
        "INSERT INTO agent_org_runtime_tasks (
            id, org_run_id, activation_generation, subject, description, active_form, owner, status,
            execution_mode, blocked_by_json, metadata_json, output_json,
            failure_reason_json, cancel_reason_json, created_by_participant_id,
            source_turn_intent_id, originating_message_id, replaces_task_id,
            created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                   ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
        params![
            &task.id,
            &task.org_run_id,
            task.activation_generation,
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
    if let Some(replaces_task_id) = task.replaces_task_id.as_deref() {
        crate::coordination::agent_org_work_episodes::associate_replacement_task_in_tx(
            tx,
            &task.org_run_id,
            &task.id,
            replaces_task_id,
            task.activation_generation,
            &task.source_turn_intent_id,
        )?;
    } else {
        crate::coordination::agent_org_work_episodes::associate_task_in_tx(
            tx,
            &task.org_run_id,
            &task.id,
            task.activation_generation,
            &task.source_turn_intent_id,
        )?;
    }
    Ok(())
}

fn ensure_no_active_episode_semantic_duplicate(
    conn: &rusqlite::Connection,
    incoming: &Task,
) -> Result<(), String> {
    if incoming.replaces_task_id.is_some() {
        return Ok(());
    }
    crate::coordination::agent_org_work_episodes::validate_new_task_admission_in_tx(
        conn,
        &incoming.org_run_id,
        &incoming.source_turn_intent_id,
    )?;
    let Some(active_episode) =
        crate::coordination::agent_org_work_episodes::active_with_connection(
            conn,
            &incoming.org_run_id,
        )?
    else {
        return Ok(());
    };
    let sql = format!(
        "SELECT {SELECT_COLUMNS} FROM agent_org_runtime_tasks
         WHERE org_run_id=?1 AND id IN (
             SELECT task_id FROM agent_org_runtime_work_episode_tasks
             WHERE org_run_id=?1 AND work_episode_id=?2
         )"
    );
    let mut statement = conn.prepare(&sql).map_err(|error| error.to_string())?;
    let existing = statement
        .query_map(
            params![&incoming.org_run_id, &active_episode.id],
            row_to_task,
        )
        .map_err(|error| error.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())?;
    let incoming_subject = normalize_task_identity_text(&incoming.subject);
    let incoming_description = normalize_task_identity_text(&incoming.description);
    let incoming_goal = normalized_task_goal(&incoming_subject, &incoming_description);
    let incoming_required_role = normalized_task_required_role(incoming);
    if let Some(duplicate) = existing.iter().find(|candidate| {
        if candidate.execution_mode != incoming.execution_mode
            || candidate.owner != incoming.owner
            || normalized_task_required_role(candidate) != incoming_required_role
        {
            return false;
        }
        let candidate_subject = normalize_task_identity_text(&candidate.subject);
        let candidate_description = normalize_task_identity_text(&candidate.description);
        (candidate_subject == incoming_subject && candidate_description == incoming_description)
            || has_high_goal_similarity(
                &normalized_task_goal(&candidate_subject, &candidate_description),
                &incoming_goal,
            )
    }) {
        return Err(format!(
            "{TASK_ACTIVE_EPISODE_DUPLICATE_ERROR}:{}",
            duplicate.id
        ));
    }
    Ok(())
}

fn normalized_task_required_role(task: &Task) -> Option<String> {
    task.metadata
        .as_ref()
        .and_then(|metadata| metadata.get(TASK_METADATA_REQUIRED_ROLE))
        .and_then(serde_json::Value::as_str)
        .map(normalize_task_identity_text)
}

fn normalize_task_identity_text(value: &str) -> String {
    let mut normalized = String::new();
    let mut pending_separator = false;
    for character in value.chars() {
        if character.is_alphanumeric() {
            if pending_separator && !normalized.is_empty() {
                normalized.push(' ');
            }
            normalized.extend(character.to_lowercase());
            pending_separator = false;
        } else {
            pending_separator = true;
        }
    }
    normalized
}

fn normalized_task_goal(subject: &str, description: &str) -> String {
    format!("{subject}\n{description}")
}

/// Deterministic near-duplicate check over Unicode character pairs. This
/// catches a Coordinator emitting the same responsibility twice with tiny
/// wording or punctuation changes, including CJK text, without introducing a
/// model call or an unbounded fuzzy search. The owner/role/mode fence above is
/// mandatory before this score is considered.
fn has_high_goal_similarity(left: &str, right: &str) -> bool {
    if left == right {
        return true;
    }
    let left_pairs = character_pair_counts(left);
    let right_pairs = character_pair_counts(right);
    let left_total = left_pairs.values().sum::<usize>();
    let right_total = right_pairs.values().sum::<usize>();
    if left_total < 8 || right_total < 8 {
        return false;
    }
    let overlap = left_pairs
        .iter()
        .map(|(pair, left_count)| {
            right_pairs
                .get(pair)
                .map_or(0, |right_count| (*left_count).min(*right_count))
        })
        .sum::<usize>();
    // Sørensen-Dice >= 0.90, compared as integers to avoid float drift.
    20 * overlap >= 9 * (left_total + right_total)
}

fn character_pair_counts(value: &str) -> HashMap<(char, char), usize> {
    let compact = value.chars().filter(|character| !character.is_whitespace());
    let mut previous = None;
    let mut pairs = HashMap::new();
    for character in compact {
        if let Some(previous) = previous {
            *pairs.entry((previous, character)).or_insert(0) += 1;
        }
        previous = Some(character);
    }
    pairs
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
    validate_actor: impl FnOnce(&rusqlite::Connection, &Task) -> Result<TaskActorAudit, String>,
    mutation: impl FnOnce(&mut Task, &TaskActorAudit) -> Result<(), String>,
    effects: impl FnOnce(&rusqlite::Connection, &TaskMutationOutcome, &[Task]) -> Result<T, String>,
) -> Result<(TaskMutationOutcome, T), String> {
    let run_id = org_run_id.to_string();
    let task_id = task_id.to_string();
    let (outcome, effect) = with_sessions_writer(|| -> Result<_, String> {
        let conn = get_connection().map_err(|error| error.to_string())?;
        let tx = database::db::begin_immediate(&conn).map_err(|error| error.to_string())?;
        let result =
            mutate_lifecycle_in_tx(&tx, &run_id, &task_id, validate_actor, mutation, effects)?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok(result)
    })?;
    crate::coordination::agent_org_run_events::notify_agent_org_run_changed(&run_id);
    Ok((outcome, effect))
}

fn mutate_lifecycle_in_tx<T>(
    conn: &rusqlite::Connection,
    org_run_id: &str,
    task_id: &str,
    validate_actor: impl FnOnce(&rusqlite::Connection, &Task) -> Result<TaskActorAudit, String>,
    mutation: impl FnOnce(&mut Task, &TaskActorAudit) -> Result<(), String>,
    effects: impl FnOnce(&rusqlite::Connection, &TaskMutationOutcome, &[Task]) -> Result<T, String>,
) -> Result<(TaskMutationOutcome, T), String> {
    ensure_run_allows_task_mutation(conn, org_run_id)?;
    let sql = format!(
        "SELECT {SELECT_COLUMNS} FROM agent_org_runtime_tasks
         WHERE org_run_id=?1 AND id=?2"
    );
    let previous: Task = conn
        .query_row(&sql, params![org_run_id, task_id], row_to_task)
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("task_not_found: {task_id} in run {org_run_id}"))?;
    let audit = validate_actor(conn, &previous)?;
    let mut tasks = list_tasks_with_conn(conn, org_run_id)?;
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
    validate_task_model_invariants(conn, task)?;
    let current = task.clone();
    update_task_row(conn, &current)?;
    insert_task_history_event_as(
        conn,
        org_run_id,
        task_id,
        TASK_EVENT_UPDATED,
        Some(&previous),
        &current,
        &audit,
    )?;
    crate::coordination::agent_org_runs::bump_work_revision_in_tx(conn, org_run_id)?;
    let outcome = mutation_outcome(previous, current, &tasks);
    let effect = effects(conn, &outcome, &tasks)?;
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

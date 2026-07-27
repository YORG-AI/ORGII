//! Task creation: single inserts (with optional scheduling guard and
//! transactional side effects) and atomic multi-task graph creation. Every
//! path validates the whole candidate graph before the first INSERT.

use std::collections::HashSet;

use database::db::{get_connection, with_sessions_writer};
use rusqlite::params;

use crate::coordination::agent_org_payload_limits::{
    validate_task_dependency_ids, validate_task_identifier,
};

use super::super::helpers::{
    encode_json_array, encode_metadata, insert_task_history_event, list_tasks_with_conn,
    now_rfc3339,
};
use super::super::{
    task_dependency_closure, CreateTaskParams, Task, TaskCreateSchedulingPolicy, TaskStatus,
    TASK_EVENT_CREATED, TASK_GRAPH_OPEN_WORK_CONFLICT_ERROR,
};
use super::dependencies::{canonicalize_dependencies, persist_dependency_projection};
use super::validation::{
    ensure_run_allows_task_mutation, ensure_task_run_capacity, reject_writable_blocks,
    validate_task_persistence_invariants, validate_task_text_fields,
};
use super::AgentOrgTaskStore;

impl AgentOrgTaskStore {
    /// Insert a task. Fails if `(org_run_id, id)` already exists.
    pub fn create(params: CreateTaskParams) -> Result<Task, String> {
        Self::create_without_scheduling_guard_with_transactional_effects(
            params,
            |_tx, _task, _tasks| Ok(()),
        )
        .map(|(task, ())| task)
    }

    /// Insert a task together with deterministic derived effects (for example
    /// TaskAssigned outbox rows) in the same SQLite transaction. The returned
    /// effect value is safe to use only for post-commit best-effort work such
    /// as waking a session; returning `Err` from `effects` rolls back the task,
    /// its history row, dependency projection, revision, and all effects.
    pub fn create_with_transactional_effects<T>(
        params: CreateTaskParams,
        scheduling_policy: TaskCreateSchedulingPolicy,
        effects: impl FnOnce(&rusqlite::Connection, &Task, &[Task]) -> Result<T, String>,
    ) -> Result<(Task, T), String> {
        Self::create_with_optional_scheduling_guard_transactional_effects(
            params,
            Some(scheduling_policy),
            effects,
        )
    }

    /// Internal persistence paths build fixtures or restore already-decided
    /// lifecycle state and therefore do not represent a fresh scheduling
    /// decision. The public `task_create` path must use
    /// [`Self::create_with_transactional_effects`] so its confirmation gate is
    /// rechecked at commit time.
    fn create_without_scheduling_guard_with_transactional_effects<T>(
        params: CreateTaskParams,
        effects: impl FnOnce(&rusqlite::Connection, &Task, &[Task]) -> Result<T, String>,
    ) -> Result<(Task, T), String> {
        Self::create_with_optional_scheduling_guard_transactional_effects(params, None, effects)
    }

    fn create_with_optional_scheduling_guard_transactional_effects<T>(
        params: CreateTaskParams,
        scheduling_policy: Option<TaskCreateSchedulingPolicy>,
        effects: impl FnOnce(&rusqlite::Connection, &Task, &[Task]) -> Result<T, String>,
    ) -> Result<(Task, T), String> {
        validate_task_identifier("task id", &params.id)?;
        validate_task_dependency_ids("blocked_by", &params.blocked_by)?;
        if params.org_run_id.trim().is_empty() {
            return Err("org_run_id must be non-empty".into());
        }
        validate_task_text_fields(
            &params.subject,
            &params.description,
            params.active_form.as_deref(),
        )?;
        if params.status == TaskStatus::InProgress && params.owner.is_none() {
            return Err("in_progress task must have an owner".into());
        }
        reject_writable_blocks(&params.blocks)?;

        let metadata_json = encode_metadata(params.metadata.as_ref())?;
        let now = now_rfc3339();

        let (task, effect) = with_sessions_writer(|| -> Result<(Task, T), String> {
            let mut conn = get_connection().map_err(|err| err.to_string())?;
            let tx = conn
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .map_err(|err| err.to_string())?;
            ensure_run_allows_task_mutation(&tx, &params.org_run_id)?;
            validate_task_persistence_invariants(
                &tx,
                &params.org_run_id,
                params.owner.as_deref(),
                params.status,
                params.metadata.as_ref(),
            )?;
            let mut candidate_tasks = list_tasks_with_conn(&tx, &params.org_run_id)?;
            let existing_task_count = candidate_tasks.len();
            ensure_task_run_capacity(existing_task_count, 1)?;
            candidate_tasks.push(Task {
                id: params.id.clone(),
                org_run_id: params.org_run_id.clone(),
                subject: params.subject.clone(),
                description: params.description.clone(),
                active_form: params.active_form.clone(),
                owner: params.owner.clone(),
                status: params.status,
                blocks: Vec::new(),
                blocked_by: params.blocked_by.clone(),
                metadata: params.metadata.clone(),
                created_at: now.clone(),
                updated_at: now.clone(),
            });
            canonicalize_dependencies(&mut candidate_tasks, &params.org_run_id)?;
            let task = candidate_tasks
                .last()
                .cloned()
                .expect("candidate graph contains the task being created");
            if !task.status.is_resolved()
                && scheduling_policy
                    .is_some_and(|policy| !policy.allow_parallel_with_unlisted_open_tasks)
            {
                let covered_dependency_ids =
                    task_dependency_closure(&task.blocked_by, &candidate_tasks);
                let omitted_open_task_ids = candidate_tasks[..existing_task_count]
                    .iter()
                    .filter(|existing| !existing.status.is_resolved())
                    .filter(|existing| !covered_dependency_ids.contains(&existing.id))
                    .map(|existing| existing.id.clone())
                    .collect::<Vec<_>>();
                if !omitted_open_task_ids.is_empty() {
                    return Err(format!(
                        "{TASK_GRAPH_OPEN_WORK_CONFLICT_ERROR}:{}",
                        omitted_open_task_ids.join(",")
                    ));
                }
            }
            let blocks_json = encode_json_array(&task.blocks)?;
            let blocked_by_json = encode_json_array(&task.blocked_by)?;

            tx.execute(
                "INSERT INTO agent_org_tasks (
                    id, org_run_id, subject, description, active_form, owner,
                    status, blocks_json, blocked_by_json, metadata_json,
                    created_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)",
                params![
                    &task.id,
                    &task.org_run_id,
                    &task.subject,
                    &task.description,
                    task.active_form.as_deref(),
                    task.owner.as_deref(),
                    task.status.as_wire(),
                    &blocks_json,
                    &blocked_by_json,
                    metadata_json.as_deref(),
                    &now,
                ],
            )
            .map_err(|err| err.to_string())?;

            insert_task_history_event(
                &tx,
                &task.org_run_id,
                &task.id,
                TASK_EVENT_CREATED,
                None,
                &task,
                task.owner.as_deref(),
            )?;
            persist_dependency_projection(&tx, &candidate_tasks)?;
            crate::coordination::agent_org_runs::bump_work_revision_in_tx(&tx, &task.org_run_id)?;
            let effect = effects(&tx, &task, &candidate_tasks)?;
            tx.commit().map_err(|err| err.to_string())?;

            Ok((task, effect))
        })?;
        crate::coordination::agent_org_run_events::notify_agent_org_run_changed(&task.org_run_id);
        Ok((task, effect))
    }

    /// Atomically insert a complete task graph. Every task and history row is
    /// validated before the first INSERT, so a missing dependency, duplicate
    /// id, invalid owner, or cycle leaves the board unchanged.
    pub fn create_batch(
        params_list: Vec<CreateTaskParams>,
        allow_parallel_with_existing_open_tasks: bool,
    ) -> Result<Vec<Task>, String> {
        Self::create_batch_with_transactional_effects(
            params_list,
            allow_parallel_with_existing_open_tasks,
            |_tx, _created, _tasks| Ok(()),
        )
        .map(|(tasks, ())| tasks)
    }

    /// Batch equivalent of [`Self::create_with_transactional_effects`]. All
    /// graph rows and every derived outbox row commit together or not at all.
    pub fn create_batch_with_transactional_effects<T>(
        params_list: Vec<CreateTaskParams>,
        allow_parallel_with_existing_open_tasks: bool,
        effects: impl FnOnce(&rusqlite::Connection, &[Task], &[Task]) -> Result<T, String>,
    ) -> Result<(Vec<Task>, T), String> {
        if params_list.is_empty() {
            return Err("task graph must contain at least one task".to_string());
        }
        ensure_task_run_capacity(0, params_list.len())?;
        let org_run_id = params_list[0].org_run_id.clone();
        if org_run_id.trim().is_empty() {
            return Err("org_run_id must be non-empty".to_string());
        }
        for params in &params_list {
            if params.org_run_id != org_run_id {
                return Err("every task in a graph must belong to the same org run".to_string());
            }
            validate_task_identifier("task id", &params.id)?;
            validate_task_dependency_ids("blocked_by", &params.blocked_by)?;
            validate_task_text_fields(
                &params.subject,
                &params.description,
                params.active_form.as_deref(),
            )?;
            if params.status == TaskStatus::InProgress && params.owner.is_none() {
                return Err("in_progress task must have an owner".to_string());
            }
            reject_writable_blocks(&params.blocks)?;
        }

        let (tasks, effect) = with_sessions_writer(|| -> Result<(Vec<Task>, T), String> {
            let mut conn = get_connection().map_err(|err| err.to_string())?;
            let tx = conn
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .map_err(|err| err.to_string())?;
            ensure_run_allows_task_mutation(&tx, &org_run_id)?;

            let existing_tasks = list_tasks_with_conn(&tx, &org_run_id)?;
            ensure_task_run_capacity(existing_tasks.len(), params_list.len())?;
            if !allow_parallel_with_existing_open_tasks {
                let existing_ids = existing_tasks
                    .iter()
                    .map(|task| task.id.clone())
                    .collect::<HashSet<_>>();
                let referenced_existing_ids = params_list
                    .iter()
                    .flat_map(|params| params.blocked_by.iter())
                    .filter(|task_id| existing_ids.contains(task_id.as_str()))
                    .cloned()
                    .collect::<Vec<_>>();
                let covered_existing_ids =
                    task_dependency_closure(&referenced_existing_ids, &existing_tasks);
                let omitted_open_task_ids = existing_tasks
                    .iter()
                    .filter(|task| !task.status.is_resolved())
                    .filter(|task| !covered_existing_ids.contains(&task.id))
                    .map(|task| task.id.clone())
                    .collect::<Vec<_>>();
                if !omitted_open_task_ids.is_empty() {
                    return Err(format!(
                        "{TASK_GRAPH_OPEN_WORK_CONFLICT_ERROR}:{}",
                        omitted_open_task_ids.join(",")
                    ));
                }
            }
            let mut known_ids = existing_tasks
                .iter()
                .map(|task| task.id.clone())
                .collect::<HashSet<_>>();
            for params in &params_list {
                if !known_ids.insert(params.id.clone()) {
                    return Err(format!(
                        "task graph contains an id that already exists or is duplicated: {}",
                        params.id
                    ));
                }
            }
            for params in &params_list {
                for dependency_id in &params.blocked_by {
                    if !known_ids.contains(dependency_id) {
                        return Err(format!(
                            "task graph references task id that does not exist: {dependency_id}"
                        ));
                    }
                }
                validate_task_persistence_invariants(
                    &tx,
                    &org_run_id,
                    params.owner.as_deref(),
                    params.status,
                    params.metadata.as_ref(),
                )?;
            }

            let now = now_rfc3339();
            let new_tasks = params_list
                .iter()
                .map(|params| Task {
                    id: params.id.clone(),
                    org_run_id: params.org_run_id.clone(),
                    subject: params.subject.clone(),
                    description: params.description.clone(),
                    active_form: params.active_form.clone(),
                    owner: params.owner.clone(),
                    status: params.status,
                    blocks: params.blocks.clone(),
                    blocked_by: params.blocked_by.clone(),
                    metadata: params.metadata.clone(),
                    created_at: now.clone(),
                    updated_at: now.clone(),
                })
                .collect::<Vec<_>>();
            let existing_task_count = existing_tasks.len();
            let mut candidate_graph = existing_tasks;
            candidate_graph.extend(new_tasks);
            canonicalize_dependencies(&mut candidate_graph, &org_run_id)?;
            let new_tasks = candidate_graph.split_off(existing_task_count);

            for task in &new_tasks {
                let blocks_json = encode_json_array(&task.blocks)?;
                let blocked_by_json = encode_json_array(&task.blocked_by)?;
                let metadata_json = encode_metadata(task.metadata.as_ref())?;
                tx.execute(
                    "INSERT INTO agent_org_tasks (
                        id, org_run_id, subject, description, active_form, owner,
                        status, blocks_json, blocked_by_json, metadata_json,
                        created_at, updated_at
                    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)",
                    params![
                        &task.id,
                        &task.org_run_id,
                        &task.subject,
                        &task.description,
                        task.active_form.as_deref(),
                        task.owner.as_deref(),
                        task.status.as_wire(),
                        &blocks_json,
                        &blocked_by_json,
                        metadata_json.as_deref(),
                        &now,
                    ],
                )
                .map_err(|err| err.to_string())?;
                insert_task_history_event(
                    &tx,
                    &org_run_id,
                    &task.id,
                    TASK_EVENT_CREATED,
                    None,
                    task,
                    task.owner.as_deref(),
                )?;
            }
            persist_dependency_projection(&tx, &candidate_graph)?;
            crate::coordination::agent_org_runs::bump_work_revision_in_tx(&tx, &org_run_id)?;
            let effect = effects(&tx, &new_tasks, &candidate_graph)?;
            tx.commit().map_err(|err| err.to_string())?;
            Ok((new_tasks, effect))
        })?;
        crate::coordination::agent_org_run_events::notify_agent_org_run_changed(&org_run_id);
        Ok((tasks, effect))
    }
}

//! Task mutation: the plan-completion CAS used by Agent Org plan approval, the
//! public partial-update surface (including the optimistic
//! `if_unchanged` variants), and the shared `update_inner` that recanonicalizes
//! dependencies and reports a `TaskMutationOutcome`.

use database::db::{get_connection, with_sessions_writer};
use rusqlite::{params, OptionalExtension};

use super::super::helpers::{
    encode_json_array, encode_metadata, insert_task_history_event, list_tasks_with_conn,
    now_rfc3339, row_to_task, SELECT_COLUMNS,
};
use super::super::{
    task_execution_mode, Task, TaskExecutionMode, TaskGraphIndex, TaskMutationOutcome, TaskOutput,
    TaskStatus, UpdateTaskPatch, TASK_EVENT_UPDATED, TASK_METADATA_OUTPUT,
};
use super::dependencies::{canonicalize_dependencies, persist_dependency_projection};
use super::validation::{
    ensure_run_allows_task_mutation, validate_task_persistence_invariants,
    validate_task_text_fields,
};
use super::AgentOrgTaskStore;

fn task_persisted_state_equal(left: &Task, right: &Task) -> bool {
    left.subject == right.subject
        && left.description == right.description
        && left.active_form == right.active_form
        && left.owner == right.owner
        && left.status == right.status
        && left.blocked_by == right.blocked_by
        && left.metadata == right.metadata
}

impl AgentOrgTaskStore {
    /// Complete a member-authored planning task inside a caller-owned
    /// transaction. Agent Org plan approval uses this together with its
    /// approval-row CAS so neither side can commit without the other.
    pub(crate) fn complete_planning_task_in_tx(
        tx: &rusqlite::Transaction<'_>,
        org_run_id: &str,
        task_id: &str,
        source_member_id: &str,
        output: TaskOutput,
    ) -> Result<TaskMutationOutcome, String> {
        ensure_run_allows_task_mutation(tx, org_run_id)?;
        let sql = format!(
            "SELECT {SELECT_COLUMNS} FROM agent_org_tasks
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
        let mut metadata = match current.metadata.take() {
            Some(serde_json::Value::Object(object)) => object,
            Some(_) => return Err("task metadata must be a JSON object".to_string()),
            None => serde_json::Map::new(),
        };
        metadata.insert(TASK_METADATA_OUTPUT.to_string(), serde_json::json!(output));
        current.metadata = Some(serde_json::Value::Object(metadata));
        current.status = TaskStatus::Completed;
        current.updated_at = now_rfc3339();
        validate_task_persistence_invariants(
            tx,
            org_run_id,
            current.owner.as_deref(),
            current.status,
            current.metadata.as_ref(),
        )?;
        let metadata_json = encode_metadata(current.metadata.as_ref())?;
        let changed = tx
            .execute(
                "UPDATE agent_org_tasks
                 SET status = ?1, metadata_json = ?2, updated_at = ?3
                 WHERE org_run_id = ?4 AND id = ?5 AND status = ?6 AND owner = ?7",
                params![
                    current.status.as_wire(),
                    metadata_json.as_deref(),
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
        insert_task_history_event(
            tx,
            org_run_id,
            task_id,
            TASK_EVENT_UPDATED,
            Some(&previous),
            &current,
            Some(source_member_id),
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

    /// Apply a partial update. The full updated row is returned. `Err` on
    /// missing row so callers can surface a clear "task_not_found" without
    /// a separate get round-trip.
    pub fn update(org_run_id: &str, task_id: &str, patch: UpdateTaskPatch) -> Result<Task, String> {
        Self::update_with_outcome(org_run_id, task_id, patch).map(|outcome| outcome.current)
    }

    pub fn update_with_outcome(
        org_run_id: &str,
        task_id: &str,
        patch: UpdateTaskPatch,
    ) -> Result<TaskMutationOutcome, String> {
        Self::update_with_outcome_and_transactional_effects(
            org_run_id,
            task_id,
            patch,
            |_tx, _outcome, _tasks| Ok(()),
        )
        .map(|(outcome, ())| outcome)
    }

    pub fn update_with_outcome_and_transactional_effects<T>(
        org_run_id: &str,
        task_id: &str,
        patch: UpdateTaskPatch,
        effects: impl FnOnce(&rusqlite::Connection, &TaskMutationOutcome, &[Task]) -> Result<T, String>,
    ) -> Result<(TaskMutationOutcome, T), String> {
        let (outcome, effect) =
            with_sessions_writer(|| Self::update_inner(org_run_id, task_id, patch, None, effects))?;
        crate::coordination::agent_org_run_events::notify_agent_org_run_changed(org_run_id);
        Ok((outcome, effect))
    }

    /// Apply a tool-authorized patch only if the row is still the exact
    /// version that was inspected before authorization. This closes the
    /// check-then-write race where another turn could reassign a task after a
    /// member was authorized but before its update transaction began.
    pub fn update_with_outcome_if_unchanged(
        org_run_id: &str,
        task_id: &str,
        expected_updated_at: &str,
        patch: UpdateTaskPatch,
    ) -> Result<TaskMutationOutcome, String> {
        Self::update_with_outcome_if_unchanged_and_transactional_effects(
            org_run_id,
            task_id,
            expected_updated_at,
            patch,
            |_tx, _outcome, _tasks| Ok(()),
        )
        .map(|(outcome, ())| outcome)
    }

    pub fn update_with_outcome_if_unchanged_and_transactional_effects<T>(
        org_run_id: &str,
        task_id: &str,
        expected_updated_at: &str,
        patch: UpdateTaskPatch,
        effects: impl FnOnce(&rusqlite::Connection, &TaskMutationOutcome, &[Task]) -> Result<T, String>,
    ) -> Result<(TaskMutationOutcome, T), String> {
        let (outcome, effect) = with_sessions_writer(|| {
            Self::update_inner(
                org_run_id,
                task_id,
                patch,
                Some(expected_updated_at),
                effects,
            )
        })?;
        crate::coordination::agent_org_run_events::notify_agent_org_run_changed(org_run_id);
        Ok((outcome, effect))
    }

    fn update_inner<T>(
        org_run_id: &str,
        task_id: &str,
        patch: UpdateTaskPatch,
        expected_updated_at: Option<&str>,
        effects: impl FnOnce(&rusqlite::Connection, &TaskMutationOutcome, &[Task]) -> Result<T, String>,
    ) -> Result<(TaskMutationOutcome, T), String> {
        let mut conn = get_connection().map_err(|err| err.to_string())?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|err| err.to_string())?;
        ensure_run_allows_task_mutation(&tx, org_run_id)?;

        if patch.blocks.is_some() {
            return Err(
                "task `blocks` is a derived field; write canonical `blocked_by` dependencies instead"
                    .to_string(),
            );
        }
        let existing_tasks = list_tasks_with_conn(&tx, org_run_id)?;
        let existing = existing_tasks
            .iter()
            .find(|task| task.id == task_id)
            .cloned();
        let Some(mut task) = existing else {
            return Err(format!("task_not_found: {task_id} in run {org_run_id}"));
        };
        let previous_task = task.clone();
        if expected_updated_at.is_some_and(|expected| expected != previous_task.updated_at.as_str())
        {
            return Err(format!(
                "{}: task {} changed after authorization; reload it and retry",
                super::TASK_MUTATION_CONFLICT_ERROR,
                task_id
            ));
        }
        if previous_task.status == TaskStatus::Completed
            && patch
                .status
                .is_some_and(|status| status != TaskStatus::Completed)
        {
            return Err(format!(
                "{}: task {} cannot transition from completed back to open work; create a follow-up task",
                super::TASK_COMPLETED_IMMUTABLE_ERROR,
                task_id
            ));
        }
        let previous_graph = TaskGraphIndex::new(&existing_tasks);
        let previous_ready =
            previous_task.owner.is_some() && previous_graph.is_ready(&previous_task);

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
        if let Some(status) = patch.status {
            task.status = status;
        }
        if task.status == TaskStatus::InProgress && task.owner.is_none() {
            return Err("in_progress task must have an owner".into());
        }
        if let Some(blocked_by) = patch.blocked_by {
            task.blocked_by = blocked_by;
        }
        if let Some(metadata) = patch.metadata {
            task.metadata = metadata;
        }
        validate_task_text_fields(
            &task.subject,
            &task.description,
            task.active_form.as_deref(),
        )?;
        validate_task_persistence_invariants(
            &tx,
            org_run_id,
            task.owner.as_deref(),
            task.status,
            task.metadata.as_ref(),
        )?;
        if task_persisted_state_equal(&previous_task, &task) {
            let outcome = TaskMutationOutcome {
                previous: previous_task.clone(),
                current: previous_task,
                owner_changed: false,
                status_changed: false,
                became_completed: false,
                became_ready: false,
            };
            let effect = effects(&tx, &outcome, &existing_tasks)?;
            tx.commit().map_err(|err| err.to_string())?;
            return Ok((outcome, effect));
        }
        task.updated_at = now_rfc3339();

        let mut candidate_tasks = existing_tasks;
        let candidate = candidate_tasks
            .iter_mut()
            .find(|candidate| candidate.id == task_id)
            .expect("existing task remains present during update");
        *candidate = task;
        canonicalize_dependencies(&mut candidate_tasks, org_run_id)?;
        let task = candidate_tasks
            .iter()
            .find(|candidate| candidate.id == task_id)
            .cloned()
            .expect("updated task remains present in candidate graph");
        let blocks_json = encode_json_array(&task.blocks)?;
        let blocked_by_json = encode_json_array(&task.blocked_by)?;
        let metadata_json = encode_metadata(task.metadata.as_ref())?;

        tx.execute(
            "UPDATE agent_org_tasks SET
                subject = ?1,
                description = ?2,
                active_form = ?3,
                owner = ?4,
                status = ?5,
                blocks_json = ?6,
                blocked_by_json = ?7,
                metadata_json = ?8,
                updated_at = ?9
             WHERE org_run_id = ?10 AND id = ?11",
            params![
                &task.subject,
                &task.description,
                task.active_form.as_deref(),
                task.owner.as_deref(),
                task.status.as_wire(),
                &blocks_json,
                &blocked_by_json,
                metadata_json.as_deref(),
                &task.updated_at,
                org_run_id,
                task_id,
            ],
        )
        .map_err(|err| err.to_string())?;
        insert_task_history_event(
            &tx,
            org_run_id,
            task_id,
            TASK_EVENT_UPDATED,
            Some(&previous_task),
            &task,
            task.owner.as_deref(),
        )?;
        persist_dependency_projection(&tx, &candidate_tasks)?;
        crate::coordination::agent_org_runs::bump_work_revision_in_tx(&tx, org_run_id)?;

        let current_graph = TaskGraphIndex::new(&candidate_tasks);
        let current_ready = task.owner.is_some() && current_graph.is_ready(&task);
        let outcome = TaskMutationOutcome {
            owner_changed: task.owner != previous_task.owner,
            status_changed: task.status != previous_task.status,
            became_completed: task.status == TaskStatus::Completed
                && previous_task.status != TaskStatus::Completed,
            became_ready: current_ready && !previous_ready,
            previous: previous_task,
            current: task,
        };
        let effect = effects(&tx, &outcome, &candidate_tasks)?;
        tx.commit().map_err(|err| err.to_string())?;
        Ok((outcome, effect))
    }
}

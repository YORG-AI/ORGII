//! Test-only compatibility mutation fixtures retained while older
//! owning-boundary tests are migrated to the typed actor API.

#[cfg(test)]
use database::db::{get_connection, with_sessions_writer};

#[cfg(test)]
use rusqlite::params;

#[cfg(test)]
use super::super::helpers::{
    encode_json_array, encode_metadata, encode_optional_json, insert_task_history_event,
    list_tasks_with_conn, now_rfc3339,
};
#[cfg(test)]
use super::super::{
    Task, TaskExecutionMode, TaskGraphIndex, TaskMutationOutcome, TaskStatus, UpdateTaskPatch,
    TASK_EVENT_UPDATED, TASK_METADATA_EXECUTION_MODE, TASK_METADATA_OUTPUT,
};
#[cfg(test)]
use super::dependencies::{
    canonicalize_dependencies, persist_canonical_blocked_by_for_test_fixture,
};
#[cfg(test)]
use super::validation::{
    ensure_run_allows_task_mutation, validate_task_persistence_invariants,
    validate_task_text_fields,
};
#[cfg(test)]
use super::AgentOrgTaskStore;
#[cfg(test)]
use crate::coordination::agent_org_payload_limits::validate_task_dependency_ids;

#[cfg(test)]
fn task_persisted_state_equal(left: &Task, right: &Task) -> bool {
    left.subject == right.subject
        && left.description == right.description
        && left.active_form == right.active_form
        && left.owner == right.owner
        && left.status == right.status
        && left.execution_mode == right.execution_mode
        && left.blocked_by == right.blocked_by
        && left.metadata == right.metadata
        && left.output == right.output
        && left.failure_reason == right.failure_reason
        && left.cancel_reason == right.cancel_reason
}

#[cfg(test)]
impl AgentOrgTaskStore {
    /// Apply a partial update. The full updated row is returned. `Err` on
    /// missing row so callers can surface a clear "task_not_found" without
    /// a separate get round-trip.
    #[cfg(test)]
    pub fn update(org_run_id: &str, task_id: &str, patch: UpdateTaskPatch) -> Result<Task, String> {
        Self::update_with_outcome(org_run_id, task_id, patch).map(|outcome| outcome.current)
    }

    #[cfg(test)]
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

    #[cfg(test)]
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
    #[cfg(test)]
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

    #[cfg(test)]
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

    #[cfg(test)]
    fn update_inner<T>(
        org_run_id: &str,
        task_id: &str,
        patch: UpdateTaskPatch,
        expected_updated_at: Option<&str>,
        effects: impl FnOnce(&rusqlite::Connection, &TaskMutationOutcome, &[Task]) -> Result<T, String>,
    ) -> Result<(TaskMutationOutcome, T), String> {
        if let Some(blocked_by) = patch.blocked_by.as_ref() {
            validate_task_dependency_ids("blocked_by", blocked_by)?;
        }
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
            if let Some(metadata) = task
                .metadata
                .as_mut()
                .and_then(serde_json::Value::as_object_mut)
            {
                if let Some(execution_mode) = metadata
                    .remove(TASK_METADATA_EXECUTION_MODE)
                    .and_then(|value| value.as_str().map(str::to_string))
                {
                    task.execution_mode = TaskExecutionMode::from_wire(&execution_mode)?;
                }
                if let Some(output) = metadata.remove(TASK_METADATA_OUTPUT) {
                    task.output = Some(
                        serde_json::from_value(output)
                            .map_err(|error| format!("task output has invalid shape: {error}"))?,
                    );
                }
            }
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
        let blocked_by_json = encode_json_array(&task.blocked_by)?;
        let metadata_json = encode_metadata(task.metadata.as_ref())?;
        let output_json = encode_optional_json("task output", task.output.as_ref())?;
        let failure_reason_json =
            encode_optional_json("task failure reason", task.failure_reason.as_ref())?;
        let cancel_reason_json =
            encode_optional_json("task cancel reason", task.cancel_reason.as_ref())?;

        tx.execute(
            "UPDATE agent_org_runtime_tasks SET
                subject = ?1,
                description = ?2,
                active_form = ?3,
                owner = ?4,
                status = ?5,
                execution_mode = ?6,
                blocked_by_json = ?7,
                metadata_json = ?8,
                output_json = ?9,
                failure_reason_json = ?10,
                cancel_reason_json = ?11,
                updated_at = ?12
             WHERE org_run_id = ?13 AND id = ?14",
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
        persist_canonical_blocked_by_for_test_fixture(&tx, &candidate_tasks)?;
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

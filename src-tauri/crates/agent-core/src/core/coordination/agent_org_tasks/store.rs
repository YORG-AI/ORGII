use std::collections::HashSet;

use rusqlite::{params, OptionalExtension};

use database::db::{get_connection, with_sessions_writer};

use super::graph::{
    unresolved_blockers, validate_dependency_graph, validate_dependency_graph_after_upsert,
};
use super::helpers::{
    encode_json_array, encode_metadata, insert_task_history_event, list_tasks_with_conn,
    now_rfc3339, row_to_task, row_to_task_history_event, SELECT_COLUMNS,
};
use super::{
    task_dependency_closure, task_execution_mode, CreateTaskParams, Task, TaskExecutionMode,
    TaskHistoryEvent, TaskMutationOutcome, TaskOutput, TaskStatus, UpdateTaskPatch,
    TASK_EVENT_CREATED, TASK_EVENT_ESCALATED_TO_COORDINATOR, TASK_EVENT_RELEASED,
    TASK_EVENT_UPDATED, TASK_GRAPH_OPEN_WORK_CONFLICT_ERROR, TASK_METADATA_OUTPUT,
};

pub struct AgentOrgTaskStore;

fn ensure_run_allows_task_mutation(
    conn: &rusqlite::Connection,
    org_run_id: &str,
) -> Result<(), String> {
    let status: Option<String> = conn
        .query_row(
            "SELECT status FROM agent_org_runs WHERE id=?1",
            params![org_run_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| err.to_string())?;
    // Store unit tests historically use standalone task rows. Production runs
    // always have a parent row; when present it is authoritative.
    let status = match status {
        Some(status) => status,
        None => {
            // Store-level unit tests intentionally exercise task rows without
            // constructing an AgentOrgRun. Production builds keep the parent
            // run requirement strict.
            #[cfg(test)]
            return Ok(());
            #[cfg(not(test))]
            return Err(format!("agent_org_run_not_found: {org_run_id}"));
        }
    };
    if status != "running" {
        return Err(format!(
            "agent_org_run_not_mutable: run {org_run_id} is {status}",
        ));
    }
    Ok(())
}

fn collect_roster_member_ids(
    members: &[crate::definitions::orgs::OrgMember],
    out: &mut HashSet<String>,
) {
    for member in members {
        out.insert(member.id.clone());
        collect_roster_member_ids(&member.children, out);
    }
}

fn validate_task_persistence_invariants(
    conn: &rusqlite::Connection,
    org_run_id: &str,
    owner: Option<&str>,
    status: TaskStatus,
    metadata: Option<&serde_json::Value>,
) -> Result<(), String> {
    let metadata_object = match metadata {
        None => None,
        Some(serde_json::Value::Object(object)) => Some(object),
        Some(_) => return Err("task metadata must be a JSON object".to_string()),
    };

    let mut eligible_member_ids = Vec::new();
    if let Some(value) =
        metadata_object.and_then(|object| object.get(super::TASK_METADATA_ELIGIBLE_MEMBER_IDS))
    {
        let values = value.as_array().ok_or_else(|| {
            "eligible_member_ids must be an array of member_id strings".to_string()
        })?;
        let mut seen = HashSet::new();
        for value in values {
            let member_id = value
                .as_str()
                .map(str::trim)
                .filter(|member_id| !member_id.is_empty())
                .ok_or_else(|| {
                    "eligible_member_ids must contain only non-empty member_id strings".to_string()
                })?;
            if member_id == crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID {
                return Err("eligible_member_ids cannot include coordinator".to_string());
            }
            if seen.insert(member_id.to_string()) {
                eligible_member_ids.push(member_id.to_string());
            }
        }
    }
    if owner.is_none() && status == TaskStatus::Pending && eligible_member_ids.is_empty() {
        return Err("ownerless pending tasks require a non-empty eligible_member_ids list".into());
    }

    if let Some(required_role) =
        metadata_object.and_then(|object| object.get(super::TASK_METADATA_REQUIRED_ROLE))
    {
        if required_role
            .as_str()
            .map(str::trim)
            .is_none_or(str::is_empty)
        {
            return Err("required_role must be a non-empty string".to_string());
        }
    }

    let task_output = metadata_object
        .and_then(|object| object.get(super::TASK_METADATA_OUTPUT))
        .map(|value| {
            serde_json::from_value::<super::TaskOutput>(value.clone())
                .map_err(|err| format!("task output has invalid shape: {err}"))
        })
        .transpose()?;
    if let Some(output) = task_output.as_ref() {
        if status != TaskStatus::Completed {
            return Err("task output is only valid for completed tasks".to_string());
        }
        if output.summary.trim().is_empty() || output.summary.chars().count() > 1_000 {
            return Err("task output summary must be 1..=1000 chars".to_string());
        }
        if output
            .content
            .as_ref()
            .is_some_and(|content| content.chars().count() > 20_000)
        {
            return Err("task output content must be ≤ 20000 chars".to_string());
        }
        if output.produced_by_member_id.trim().is_empty() {
            return Err("task output produced_by_member_id must not be empty".to_string());
        }
        if chrono::DateTime::parse_from_rfc3339(&output.produced_at).is_err() {
            return Err("task output produced_at must be a valid RFC3339 timestamp".to_string());
        }
        if output
            .artifact_ids
            .iter()
            .any(|id| id.trim().is_empty() || id.chars().count() > 1_000)
        {
            return Err(
                "task output artifact_ids must contain only 1..=1000 char identifiers".to_string(),
            );
        }
    }

    let snapshot_json: Option<String> = conn
        .query_row(
            "SELECT org_snapshot_json FROM agent_org_runs WHERE id=?1",
            params![org_run_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| err.to_string())?
        .flatten();
    if let Some(snapshot_json) = snapshot_json {
        let snapshot: crate::definitions::orgs::OrgDefinition =
            serde_json::from_str(&snapshot_json).map_err(|err| {
                format!("invalid Agent Org launch snapshot for {org_run_id}: {err}")
            })?;
        let mut roster = HashSet::new();
        collect_roster_member_ids(&snapshot.children, &mut roster);
        for member_id in &eligible_member_ids {
            if !roster.contains(member_id) {
                return Err(format!(
                    "eligible_member_ids contains member outside run roster: {member_id}"
                ));
            }
        }
        if let Some(owner) = owner {
            if owner != crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID
                && !roster.contains(owner)
            {
                return Err(format!("owner is outside run roster: {owner}"));
            }
        }
        if let Some(output) = task_output.as_ref() {
            let producer = output.produced_by_member_id.as_str();
            if producer != crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID
                && !roster.contains(producer)
            {
                return Err(format!(
                    "task output producer is outside run roster: {producer}"
                ));
            }
        }
    }
    Ok(())
}

impl AgentOrgTaskStore {
    pub(crate) fn list_with_connection(
        conn: &rusqlite::Connection,
        org_run_id: &str,
    ) -> Result<Vec<Task>, String> {
        list_tasks_with_conn(conn, org_run_id)
    }

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
        Ok(TaskMutationOutcome {
            previous,
            current,
            owner_changed: false,
            status_changed: true,
            became_completed: true,
            became_ready: false,
        })
    }

    /// Insert a task. Fails if `(org_run_id, id)` already exists.
    pub fn create(params: CreateTaskParams) -> Result<Task, String> {
        if params.id.trim().is_empty() {
            return Err("task id must be non-empty".into());
        }
        if params.org_run_id.trim().is_empty() {
            return Err("org_run_id must be non-empty".into());
        }
        if params.subject.trim().is_empty() {
            return Err("task subject must be non-empty".into());
        }
        if params.status == TaskStatus::InProgress && params.owner.is_none() {
            return Err("in_progress task must have an owner".into());
        }

        let metadata_json = encode_metadata(params.metadata.as_ref())?;
        let now = now_rfc3339();

        with_sessions_writer(|| -> Result<Task, String> {
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
            let existing_tasks = list_tasks_with_conn(&tx, &params.org_run_id)?;
            validate_dependency_graph_after_upsert(
                &existing_tasks,
                &params.org_run_id,
                &params.id,
                &params.blocks,
                &params.blocked_by,
            )?;
            let blocks_json = encode_json_array(&params.blocks)?;
            let blocked_by_json = encode_json_array(&params.blocked_by)?;

            tx.execute(
                "INSERT INTO agent_org_tasks (
                    id, org_run_id, subject, description, active_form, owner,
                    status, blocks_json, blocked_by_json, metadata_json,
                    created_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)",
                params![
                    &params.id,
                    &params.org_run_id,
                    &params.subject,
                    &params.description,
                    params.active_form.as_deref(),
                    params.owner.as_deref(),
                    params.status.as_wire(),
                    &blocks_json,
                    &blocked_by_json,
                    metadata_json.as_deref(),
                    &now,
                ],
            )
            .map_err(|err| err.to_string())?;

            let task = Task {
                id: params.id,
                org_run_id: params.org_run_id,
                subject: params.subject,
                description: params.description,
                active_form: params.active_form,
                owner: params.owner,
                status: params.status,
                blocks: params.blocks,
                blocked_by: params.blocked_by,
                metadata: params.metadata,
                created_at: now.clone(),
                updated_at: now,
            };
            insert_task_history_event(
                &tx,
                &task.org_run_id,
                &task.id,
                TASK_EVENT_CREATED,
                None,
                &task,
                task.owner.as_deref(),
            )?;
            tx.commit().map_err(|err| err.to_string())?;

            Ok(task)
        })
    }

    /// Atomically insert a complete task graph. Every task and history row is
    /// validated before the first INSERT, so a missing dependency, duplicate
    /// id, invalid owner, or cycle leaves the board unchanged.
    pub fn create_batch(
        params_list: Vec<CreateTaskParams>,
        allow_parallel_with_existing_open_tasks: bool,
    ) -> Result<Vec<Task>, String> {
        if params_list.is_empty() {
            return Err("task graph must contain at least one task".to_string());
        }
        let org_run_id = params_list[0].org_run_id.clone();
        if org_run_id.trim().is_empty() {
            return Err("org_run_id must be non-empty".to_string());
        }
        for params in &params_list {
            if params.org_run_id != org_run_id {
                return Err("every task in a graph must belong to the same org run".to_string());
            }
            if params.id.trim().is_empty() {
                return Err("task id must be non-empty".to_string());
            }
            if params.subject.trim().is_empty() {
                return Err("task subject must be non-empty".to_string());
            }
            if params.status == TaskStatus::InProgress && params.owner.is_none() {
                return Err("in_progress task must have an owner".to_string());
            }
        }

        with_sessions_writer(|| -> Result<Vec<Task>, String> {
            let mut conn = get_connection().map_err(|err| err.to_string())?;
            let tx = conn
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .map_err(|err| err.to_string())?;
            ensure_run_allows_task_mutation(&tx, &org_run_id)?;

            let existing_tasks = list_tasks_with_conn(&tx, &org_run_id)?;
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
                for dependency_id in params.blocks.iter().chain(params.blocked_by.iter()) {
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
            let mut candidate_graph = existing_tasks;
            candidate_graph.extend(new_tasks.iter().cloned());
            validate_dependency_graph(&candidate_graph, &org_run_id)?;

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
            tx.commit().map_err(|err| err.to_string())?;
            Ok(new_tasks)
        })
    }

    pub fn get(org_run_id: &str, task_id: &str) -> Result<Option<Task>, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        let sql = format!(
            "SELECT {SELECT_COLUMNS} FROM agent_org_tasks WHERE org_run_id = ?1 AND id = ?2"
        );
        let mut stmt = conn.prepare(&sql).map_err(|err| err.to_string())?;
        let task = stmt
            .query_row(params![org_run_id, task_id], row_to_task)
            .optional()
            .map_err(|err| err.to_string())?;
        Ok(task)
    }

    pub fn list(org_run_id: &str) -> Result<Vec<Task>, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        list_tasks_with_conn(&conn, org_run_id)
    }

    pub fn list_history(org_run_id: &str) -> Result<Vec<TaskHistoryEvent>, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, org_run_id, task_id, event_type, previous_owner, next_owner,
                    previous_status, next_status, actor_member_id, created_at
                 FROM agent_org_task_events
                 WHERE org_run_id = ?1
                 ORDER BY created_at ASC, id ASC",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(params![org_run_id], row_to_task_history_event)
            .map_err(|err| err.to_string())?;
        let mut events = Vec::new();
        for row in rows {
            events.push(row.map_err(|err| err.to_string())?);
        }
        Ok(events)
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
        with_sessions_writer(|| Self::update_inner(org_run_id, task_id, patch, None))
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
        with_sessions_writer(|| {
            Self::update_inner(org_run_id, task_id, patch, Some(expected_updated_at))
        })
    }

    fn update_inner(
        org_run_id: &str,
        task_id: &str,
        patch: UpdateTaskPatch,
        expected_updated_at: Option<&str>,
    ) -> Result<TaskMutationOutcome, String> {
        let mut conn = get_connection().map_err(|err| err.to_string())?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|err| err.to_string())?;
        ensure_run_allows_task_mutation(&tx, org_run_id)?;

        let existing: Option<Task> = {
            let sql = format!(
                "SELECT {SELECT_COLUMNS} FROM agent_org_tasks
                 WHERE org_run_id = ?1 AND id = ?2"
            );
            let mut stmt = tx.prepare(&sql).map_err(|err| err.to_string())?;
            stmt.query_row(params![org_run_id, task_id], row_to_task)
                .optional()
                .map_err(|err| err.to_string())?
        };
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
        let previous_ready = previous_task.owner.is_some()
            && previous_task.status == TaskStatus::Pending
            && unresolved_blockers(
                &list_tasks_with_conn(&tx, org_run_id)?,
                &previous_task.blocked_by,
            )
            .is_empty();

        if let Some(subject) = patch.subject {
            if subject.trim().is_empty() {
                return Err("task subject must be non-empty".into());
            }
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
        if let Some(blocks) = patch.blocks {
            task.blocks = blocks;
        }
        if let Some(blocked_by) = patch.blocked_by {
            task.blocked_by = blocked_by;
        }
        if let Some(metadata) = patch.metadata {
            task.metadata = metadata;
        }
        validate_task_persistence_invariants(
            &tx,
            org_run_id,
            task.owner.as_deref(),
            task.status,
            task.metadata.as_ref(),
        )?;
        task.updated_at = now_rfc3339();

        let existing_tasks = list_tasks_with_conn(&tx, org_run_id)?;
        validate_dependency_graph_after_upsert(
            &existing_tasks,
            org_run_id,
            &task.id,
            &task.blocks,
            &task.blocked_by,
        )?;
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

        let current_ready = task.owner.is_some()
            && task.status == TaskStatus::Pending
            && unresolved_blockers(&list_tasks_with_conn(&tx, org_run_id)?, &task.blocked_by)
                .is_empty();
        let outcome = TaskMutationOutcome {
            owner_changed: task.owner != previous_task.owner,
            status_changed: task.status != previous_task.status,
            became_completed: task.status == TaskStatus::Completed
                && previous_task.status != TaskStatus::Completed,
            became_ready: current_ready && !previous_ready,
            previous: previous_task,
            current: task,
        };
        tx.commit().map_err(|err| err.to_string())?;
        Ok(outcome)
    }

    pub fn delete(org_run_id: &str, task_id: &str) -> Result<bool, String> {
        with_sessions_writer(|| Self::delete_inner(org_run_id, task_id, None))
    }

    /// Delete only the row version that was inspected before tool-level
    /// authorization. See `update_with_outcome_if_unchanged`.
    pub fn delete_if_unchanged(
        org_run_id: &str,
        task_id: &str,
        expected_updated_at: &str,
    ) -> Result<bool, String> {
        with_sessions_writer(|| Self::delete_inner(org_run_id, task_id, Some(expected_updated_at)))
    }

    fn delete_inner(
        org_run_id: &str,
        task_id: &str,
        expected_updated_at: Option<&str>,
    ) -> Result<bool, String> {
        let mut conn = get_connection().map_err(|err| err.to_string())?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|err| err.to_string())?;
        ensure_run_allows_task_mutation(&tx, org_run_id)?;
        let current_updated_at = tx
            .query_row(
                "SELECT updated_at FROM agent_org_tasks WHERE org_run_id=?1 AND id=?2",
                params![org_run_id, task_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|err| err.to_string())?;
        let Some(current_updated_at) = current_updated_at else {
            tx.commit().map_err(|err| err.to_string())?;
            return Ok(false);
        };
        if expected_updated_at.is_some_and(|expected| expected != current_updated_at) {
            return Err(format!(
                "{}: task {} changed after authorization; reload it and retry",
                super::TASK_MUTATION_CONFLICT_ERROR,
                task_id
            ));
        }
        let n = tx
            .execute(
                "DELETE FROM agent_org_tasks WHERE org_run_id = ?1 AND id = ?2",
                params![org_run_id, task_id],
            )
            .map_err(|err| err.to_string())?;
        tx.commit().map_err(|err| err.to_string())?;
        Ok(n > 0)
    }

    /// Requeue every open task owned by a member that accepted shutdown.
    /// Tasks with another eligible peer return to the pool. Tasks without a
    /// legal peer move to the coordinator so an intentionally stopped member
    /// cannot be resurrected by terminal-session recovery.
    ///
    /// Returns the list of tasks that were unassigned (full updated
    /// rows). Empty list if the member owns nothing or only completed
    /// tasks.
    pub fn dispose_open_tasks_for_shutdown(
        org_run_id: &str,
        owner_member_id: &str,
    ) -> Result<Vec<Task>, String> {
        with_sessions_writer(|| {
            Self::dispose_open_tasks_for_shutdown_inner(org_run_id, owner_member_id)
        })
    }

    fn dispose_open_tasks_for_shutdown_inner(
        org_run_id: &str,
        owner_member_id: &str,
    ) -> Result<Vec<Task>, String> {
        let mut conn = get_connection().map_err(|err| err.to_string())?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|err| err.to_string())?;
        ensure_run_allows_task_mutation(&tx, org_run_id)?;

        let owned: Vec<Task> = {
            let sql = format!(
                "SELECT {SELECT_COLUMNS} FROM agent_org_tasks
                 WHERE org_run_id = ?1 AND owner = ?2 AND status != ?3
                 ORDER BY created_at ASC, id ASC"
            );
            let mut stmt = tx.prepare(&sql).map_err(|err| err.to_string())?;
            let rows = stmt
                .query_map(
                    params![org_run_id, owner_member_id, TaskStatus::Completed.as_wire()],
                    row_to_task,
                )
                .map_err(|err| err.to_string())?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row.map_err(|err| err.to_string())?);
            }
            out
        };

        if owned.is_empty() {
            tx.commit().map_err(|err| err.to_string())?;
            return Ok(Vec::new());
        }

        let now = now_rfc3339();
        let mut updated_rows = Vec::with_capacity(owned.len());
        for task in owned {
            let release_to_pool = super::eligible_member_ids(&task)
                .iter()
                .any(|member_id| member_id != owner_member_id);
            tx.execute(
                "UPDATE agent_org_tasks
                 SET owner = CASE WHEN ?1 THEN NULL ELSE ?2 END,
                     status = ?3,
                     updated_at = ?4
                 WHERE org_run_id = ?5 AND id = ?6 AND owner = ?7",
                params![
                    release_to_pool,
                    crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID,
                    TaskStatus::Pending.as_wire(),
                    &now,
                    org_run_id,
                    &task.id,
                    owner_member_id,
                ],
            )
            .map_err(|err| err.to_string())?;
            let mut updated_task = task.clone();
            if release_to_pool {
                updated_task.owner = None;
            } else {
                updated_task.owner =
                    Some(crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID.to_string());
            }
            updated_task.status = TaskStatus::Pending;
            updated_task.updated_at = now.clone();
            validate_task_persistence_invariants(
                &tx,
                org_run_id,
                updated_task.owner.as_deref(),
                updated_task.status,
                updated_task.metadata.as_ref(),
            )?;
            insert_task_history_event(
                &tx,
                org_run_id,
                &updated_task.id,
                if release_to_pool {
                    TASK_EVENT_RELEASED
                } else {
                    TASK_EVENT_ESCALATED_TO_COORDINATOR
                },
                Some(&task),
                &updated_task,
                Some(owner_member_id),
            )?;
            updated_rows.push(updated_task);
        }

        tx.commit().map_err(|err| err.to_string())?;
        Ok(updated_rows)
    }

    /// Requeue every `in_progress` task owned by `owner_member_id` after
    /// the owner's turn failed.
    ///
    /// On explicit member failure (issue #272 E4), release every
    /// `in_progress` task to the
    /// coordinator's unassigned queue (`owner = NULL`, `status = pending`,
    /// metadata preserved). Ownerless is a durable "needs assignment" state;
    /// workers never self-claim it.
    pub fn requeue_in_progress_for_owner(
        org_run_id: &str,
        owner_member_id: &str,
    ) -> Result<Vec<Task>, String> {
        with_sessions_writer(|| {
            Self::requeue_in_progress_for_owner_inner(org_run_id, owner_member_id)
        })
    }

    fn requeue_in_progress_for_owner_inner(
        org_run_id: &str,
        owner_member_id: &str,
    ) -> Result<Vec<Task>, String> {
        let mut conn = get_connection().map_err(|err| err.to_string())?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|err| err.to_string())?;
        ensure_run_allows_task_mutation(&tx, org_run_id)?;

        let owned: Vec<Task> = {
            let sql = format!(
                "SELECT {SELECT_COLUMNS} FROM agent_org_tasks
                 WHERE org_run_id = ?1 AND owner = ?2 AND status = ?3
                 ORDER BY created_at ASC, id ASC"
            );
            let mut stmt = tx.prepare(&sql).map_err(|err| err.to_string())?;
            let rows = stmt
                .query_map(
                    params![
                        org_run_id,
                        owner_member_id,
                        TaskStatus::InProgress.as_wire()
                    ],
                    row_to_task,
                )
                .map_err(|err| err.to_string())?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row.map_err(|err| err.to_string())?);
            }
            out
        };

        if owned.is_empty() {
            tx.commit().map_err(|err| err.to_string())?;
            return Ok(Vec::new());
        }

        let now = now_rfc3339();
        let mut updated_rows = Vec::with_capacity(owned.len());
        for task in owned {
            tx.execute(
                "UPDATE agent_org_tasks
                 SET owner = NULL, status = ?1, updated_at = ?2
                 WHERE org_run_id = ?3 AND id = ?4 AND owner = ?5 AND status = ?6",
                params![
                    TaskStatus::Pending.as_wire(),
                    &now,
                    org_run_id,
                    &task.id,
                    owner_member_id,
                    TaskStatus::InProgress.as_wire(),
                ],
            )
            .map_err(|err| err.to_string())?;
            let mut updated_task = task.clone();
            updated_task.owner = None;
            updated_task.status = TaskStatus::Pending;
            updated_task.updated_at = now.clone();
            insert_task_history_event(
                &tx,
                org_run_id,
                &updated_task.id,
                TASK_EVENT_RELEASED,
                Some(&task),
                &updated_task,
                Some(owner_member_id),
            )?;
            updated_rows.push(updated_task);
        }

        tx.commit().map_err(|err| err.to_string())?;
        Ok(updated_rows)
    }
}

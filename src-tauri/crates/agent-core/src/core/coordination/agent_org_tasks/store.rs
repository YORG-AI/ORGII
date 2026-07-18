use std::collections::HashSet;

use rusqlite::{params, OptionalExtension};
use tracing::warn;

use database::db::{get_connection, with_sessions_writer};

use crate::coordination::agent_org_payload_limits::{
    validate_optional_text, validate_required_text, validate_task_dependency_ids,
    validate_task_eligible_member_ids, validate_task_identifier, validate_text_len,
    TASK_ACTIVE_FORM_MAX_BYTES, TASK_ACTIVE_FORM_MAX_CHARS, TASK_DESCRIPTION_MAX_BYTES,
    TASK_DESCRIPTION_MAX_CHARS, TASK_OUTPUT_CONTENT_MAX_BYTES, TASK_OUTPUT_CONTENT_MAX_CHARS,
    TASK_OUTPUT_SUMMARY_MAX_BYTES, TASK_OUTPUT_SUMMARY_MAX_CHARS, TASK_RUN_MAX_TASKS,
    TASK_SUBJECT_MAX_BYTES, TASK_SUBJECT_MAX_CHARS, TASK_SUMMARY_ARTIFACT_PREVIEW_MAX_COUNT,
    TASK_SUMMARY_DEPENDENCY_PREVIEW_MAX_COUNT, TASK_SUMMARY_DESCRIPTION_MAX_CHARS,
    TASK_SUMMARY_ELIGIBILITY_PREVIEW_MAX_COUNT, TASK_SUMMARY_PAGE_MAX_BYTES,
};

use super::graph::validate_dependency_graph;
#[cfg(test)]
#[cfg(test)]
use super::helpers::row_to_task_history_event;
use super::helpers::{
    encode_json_array, encode_metadata, insert_task_history_event, list_tasks_with_conn,
    now_rfc3339, row_to_task, SELECT_COLUMNS,
};
#[cfg(test)]
use super::TaskHistoryEvent;
use super::{
    task_dependency_closure, task_execution_mode, CreateTaskParams, Task,
    TaskCreateSchedulingPolicy, TaskExecutionMode, TaskGraphIndex, TaskMutationOutcome, TaskOutput,
    TaskOutputSummary, TaskStatus, TaskSummary, TaskSummaryPage, UpdateTaskPatch,
    TASK_DELETE_HAS_DEPENDENTS_ERROR, TASK_DELETE_IS_DELIVERY_REPLACEMENT_ERROR,
    TASK_EVENT_CREATED, TASK_EVENT_DELETED, TASK_EVENT_ESCALATED_TO_COORDINATOR,
    TASK_EVENT_RELEASED, TASK_EVENT_UPDATED, TASK_GRAPH_OPEN_WORK_CONFLICT_ERROR,
    TASK_METADATA_ELIGIBLE_MEMBER_IDS, TASK_METADATA_OUTPUT, TASK_RUN_TASK_LIMIT_ERROR,
};

pub struct AgentOrgTaskStore;

fn decode_summary_array(raw: String, column: usize) -> rusqlite::Result<Vec<String>> {
    serde_json::from_str(&raw).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(column, rusqlite::types::Type::Text, error.into())
    })
}

fn task_summary_scalar_predicate_sql(alias: &str) -> String {
    use crate::coordination::agent_org_payload_limits as limits;

    format!(
        "{alias}.status IN ('pending','in_progress','completed')
         AND trim({alias}.id)<>''
         AND {alias}.id=trim({alias}.id)
         AND length({alias}.id)<={}
         AND length(CAST({alias}.id AS BLOB))<={}
         AND length({alias}.created_at)<={}
         AND length(CAST({alias}.created_at AS BLOB))<={}
         AND length({alias}.updated_at)<={}
         AND length(CAST({alias}.updated_at AS BLOB))<={}",
        limits::TASK_IDENTIFIER_MAX_CHARS,
        limits::TASK_IDENTIFIER_MAX_BYTES,
        limits::RFC3339_TIMESTAMP_MAX_CHARS,
        limits::RFC3339_TIMESTAMP_MAX_BYTES,
        limits::RFC3339_TIMESTAMP_MAX_CHARS,
        limits::RFC3339_TIMESTAMP_MAX_BYTES,
    )
}

fn canonicalize_dependencies(tasks: &mut [Task], org_run_id: &str) -> Result<(), String> {
    // `list_tasks_with_conn` has already folded historical reverse-only
    // `blocks` edges into `blocked_by`. From this point forward blocked_by is
    // authoritative and blocks is a derived read projection.
    for task in tasks.iter_mut() {
        task.blocks.clear();
    }
    let graph = TaskGraphIndex::new(tasks);
    graph.apply_projection(tasks);
    for task in tasks.iter() {
        validate_task_dependency_ids("blocked_by", &task.blocked_by)?;
        validate_task_dependency_ids("derived blocks", &task.blocks)?;
    }
    validate_dependency_graph(tasks, org_run_id)
}

fn persist_dependency_projection(
    conn: &rusqlite::Connection,
    tasks: &[Task],
) -> Result<(), String> {
    let mut stmt = conn
        .prepare(
            "UPDATE agent_org_tasks
             SET blocks_json=?1, blocked_by_json=?2
             WHERE org_run_id=?3 AND id=?4
               AND (blocks_json<>?1 OR blocked_by_json<>?2)",
        )
        .map_err(|err| err.to_string())?;
    for task in tasks {
        let blocks_json = encode_json_array(&task.blocks)?;
        let blocked_by_json = encode_json_array(&task.blocked_by)?;
        stmt.execute(params![
            &blocks_json,
            &blocked_by_json,
            &task.org_run_id,
            &task.id,
        ])
        .map_err(|err| err.to_string())?;
    }
    Ok(())
}

/// One-time migration for the historical dual-write dependency fields.
/// Legacy `blocks`-only edges are folded into canonical `blocked_by`, then
/// both stored columns are rewritten as a consistent forward/reverse pair.
pub(super) fn normalize_legacy_dependency_rows(
    conn: &rusqlite::Connection,
) -> rusqlite::Result<()> {
    const MIGRATION_NAME: &str = "canonical_blocked_by_v1";
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_org_task_run_schema_migrations (
            name TEXT NOT NULL,
            org_run_id TEXT NOT NULL,
            applied_at TEXT NOT NULL,
            PRIMARY KEY (name, org_run_id)
        );",
    )?;

    // Discover candidates in bounded keyset pages. A large historical DB
    // must not collect every run id in memory merely to initialize schema.
    let mut after_run_id: Option<String> = None;
    loop {
        let run_ids = {
            let mut stmt = conn.prepare(
                "SELECT task.org_run_id
                 FROM agent_org_tasks task
                 WHERE NOT EXISTS (
                     SELECT 1 FROM agent_org_task_run_schema_migrations migration
                     WHERE migration.name=?1
                       AND migration.org_run_id=task.org_run_id
                 )
                   AND (?2 IS NULL OR task.org_run_id>?2)
                 GROUP BY task.org_run_id
                 ORDER BY task.org_run_id
                 LIMIT 256",
            )?;
            let rows = stmt.query_map(params![MIGRATION_NAME, after_run_id.as_deref()], |row| {
                row.get::<_, String>(0)
            })?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        if run_ids.is_empty() {
            break;
        }
        after_run_id = run_ids.last().cloned();

        for run_id in run_ids {
            conn.execute_batch("BEGIN IMMEDIATE")?;
            let normalized = (|| -> Result<(), String> {
                // Schema initialization can race across app surfaces. Recheck the
                // marker under the run's writer transaction before doing work.
                let already_applied: bool = conn
                    .query_row(
                        "SELECT EXISTS(
                         SELECT 1 FROM agent_org_task_run_schema_migrations
                         WHERE name=?1 AND org_run_id=?2
                     )",
                        params![MIGRATION_NAME, &run_id],
                        |row| row.get(0),
                    )
                    .map_err(|err| err.to_string())?;
                if already_applied {
                    return Ok(());
                }

                if !run_is_safe_for_dependency_normalization(conn, &run_id)? {
                    return Err(
                    "task board exceeds current resource/integrity limits; repair is required before dependency normalization"
                        .to_string(),
                );
                }

                let mut tasks = list_tasks_with_conn(conn, &run_id)?;
                canonicalize_dependencies(&mut tasks, &run_id)?;
                persist_dependency_projection(conn, &tasks)?;
                conn.execute(
                    "INSERT INTO agent_org_task_run_schema_migrations(
                     name, org_run_id, applied_at
                 ) VALUES (?1, ?2, ?3)",
                    params![MIGRATION_NAME, &run_id, now_rfc3339()],
                )
                .map_err(|err| err.to_string())?;
                Ok(())
            })();

            match normalized {
                Ok(()) => conn.execute_batch("COMMIT")?,
                Err(error) => {
                    let _ = conn.execute_batch("ROLLBACK");
                    // Historical data is allowed to be imperfect. Leave this
                    // run unmarked so a later startup can retry after the row is
                    // repaired, while healthy runs retain their success marker.
                    warn!(
                        org_run_id = %run_id,
                        error = %error,
                        "deferring corrupt Agent Org task board dependency normalization"
                    );
                }
            }
        }
    }
    Ok(())
}

/// Preflight historical rows without deserializing their JSON. Oversized
/// values are replaced by invalid one-byte sentinels inside SQLite before the
/// shared predicate examines shape, so startup never parses a giant legacy
/// payload just to decide that it is unsafe.
fn run_is_safe_for_dependency_normalization(
    conn: &rusqlite::Connection,
    run_id: &str,
) -> Result<bool, String> {
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM agent_org_tasks WHERE org_run_id=?1",
            params![run_id],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())?;
    if count > TASK_RUN_MAX_TASKS as i64 {
        return Ok(false);
    }
    let predicate = super::corrupt_task_row_predicate_sql();
    let dependency_json_max =
        crate::coordination::agent_org_payload_limits::TASK_DEPENDENCY_JSON_MAX_BYTES;
    let metadata_max = crate::coordination::agent_org_payload_limits::TASK_METADATA_MAX_BYTES;
    let sql = format!(
        "SELECT COALESCE(SUM(CASE WHEN {predicate} THEN 1 ELSE 0 END),0)
         FROM (
             SELECT id, subject, description, active_form, owner, status,
                    created_at, updated_at,
                    CASE WHEN length(CAST(blocks_json AS BLOB))<={dependency_json_max}
                         THEN blocks_json ELSE '!' END AS blocks_json,
                    CASE WHEN length(CAST(blocked_by_json AS BLOB))<={dependency_json_max}
                         THEN blocked_by_json ELSE '!' END AS blocked_by_json,
                    CASE WHEN metadata_json IS NULL
                              OR length(CAST(metadata_json AS BLOB))<={metadata_max}
                         THEN metadata_json ELSE '!' END AS metadata_json
             FROM agent_org_tasks WHERE org_run_id=?1
         ) AS bounded_tasks"
    );
    let corrupt: i64 = conn
        .query_row(&sql, params![run_id], |row| row.get(0))
        .map_err(|err| err.to_string())?;
    Ok(corrupt == 0)
}

fn ensure_task_rows_safe_for_operational_projection(
    conn: &rusqlite::Connection,
    run_id: &str,
) -> Result<(), String> {
    if run_is_safe_for_dependency_normalization(conn, run_id)? {
        Ok(())
    } else {
        Err(
            "Agent Org task board contains oversized or corrupt rows; operational projection refused"
                .to_string(),
        )
    }
}

fn reject_writable_blocks(blocks: &[String]) -> Result<(), String> {
    if blocks.is_empty() {
        Ok(())
    } else {
        Err(
            "task `blocks` is a derived field; write canonical `blocked_by` dependencies instead"
                .to_string(),
        )
    }
}

fn ensure_task_run_capacity(existing_count: usize, incoming_count: usize) -> Result<(), String> {
    let projected_count = existing_count.checked_add(incoming_count).ok_or_else(|| {
        format!(
            "{TASK_RUN_TASK_LIMIT_ERROR}: task count overflow while checking the Agent Org run capacity"
        )
    })?;
    if projected_count <= TASK_RUN_MAX_TASKS {
        return Ok(());
    }
    Err(format!(
        "{TASK_RUN_TASK_LIMIT_ERROR}: run retains {existing_count} tasks and this mutation would add {incoming_count}; maximum total is {TASK_RUN_MAX_TASKS}"
    ))
}

fn task_persisted_state_equal(left: &Task, right: &Task) -> bool {
    left.subject == right.subject
        && left.description == right.description
        && left.active_form == right.active_form
        && left.owner == right.owner
        && left.status == right.status
        && left.blocked_by == right.blocked_by
        && left.metadata == right.metadata
}

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
    let status = match status {
        Some(status) => status,
        None => return Err(format!("agent_org_run_not_found: {org_run_id}")),
    };
    if status != "running" {
        return Err(format!(
            "agent_org_run_not_mutable: run {org_run_id} is {status}",
        ));
    }
    Ok(())
}

fn validate_task_text_fields(
    subject: &str,
    description: &str,
    active_form: Option<&str>,
) -> Result<(), String> {
    validate_required_text(
        "task subject",
        subject,
        TASK_SUBJECT_MAX_CHARS,
        TASK_SUBJECT_MAX_BYTES,
    )?;
    validate_text_len(
        "task description",
        description,
        TASK_DESCRIPTION_MAX_CHARS,
        TASK_DESCRIPTION_MAX_BYTES,
    )?;
    validate_optional_text(
        "task active_form",
        active_form,
        TASK_ACTIVE_FORM_MAX_CHARS,
        TASK_ACTIVE_FORM_MAX_BYTES,
    )
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
    if let Some(owner) = owner {
        validate_task_identifier("task owner_member_id", owner)?;
    }
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
        let raw_member_ids = values
            .iter()
            .map(|value| {
                value.as_str().map(str::to_string).ok_or_else(|| {
                    "eligible_member_ids must contain only non-empty member_id strings".to_string()
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        validate_task_eligible_member_ids("eligible_member_ids", &raw_member_ids)?;
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
        let Some(required_role) = required_role.as_str() else {
            return Err("required_role must be a non-empty string".to_string());
        };
        validate_required_text(
            "required_role",
            required_role,
            crate::coordination::agent_org_payload_limits::TASK_REQUIRED_ROLE_MAX_CHARS,
            crate::coordination::agent_org_payload_limits::TASK_REQUIRED_ROLE_MAX_BYTES,
        )?;
    }

    if let Some(execution_mode) =
        metadata_object.and_then(|object| object.get(super::TASK_METADATA_EXECUTION_MODE))
    {
        let execution_mode = execution_mode
            .as_str()
            .ok_or_else(|| "execution_mode must be build or plan".to_string())?;
        super::TaskExecutionMode::from_wire(execution_mode)?;
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
        validate_required_text(
            "task output summary",
            &output.summary,
            TASK_OUTPUT_SUMMARY_MAX_CHARS,
            TASK_OUTPUT_SUMMARY_MAX_BYTES,
        )?;
        validate_optional_text(
            "task output content",
            output.content.as_deref(),
            TASK_OUTPUT_CONTENT_MAX_CHARS,
            TASK_OUTPUT_CONTENT_MAX_BYTES,
        )?;
        validate_task_identifier(
            "task output produced_by_member_id",
            &output.produced_by_member_id,
        )?;
        if chrono::DateTime::parse_from_rfc3339(&output.produced_at).is_err() {
            return Err("task output produced_at must be a valid RFC3339 timestamp".to_string());
        }
        crate::coordination::agent_org_payload_limits::validate_task_artifact_ids(
            "task output artifact_ids",
            &output.artifact_ids,
        )?;
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

    pub fn get(org_run_id: &str, task_id: &str) -> Result<Option<Task>, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        let sql = format!(
            "SELECT {SELECT_COLUMNS} FROM agent_org_tasks
             WHERE org_run_id=?1 AND id=?2"
        );
        conn.query_row(&sql, params![org_run_id, task_id], row_to_task)
            .optional()
            .map_err(|err| err.to_string())
    }

    pub fn list(org_run_id: &str) -> Result<Vec<Task>, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        list_tasks_with_conn(&conn, org_run_id)
    }

    /// Load the narrow task fields needed by recovery and per-turn prompt
    /// snapshots. Full descriptions and TaskOutput metadata intentionally stay
    /// behind `get`/`task_get`; a periodic watchdog or model prompt must not
    /// deserialize up to 64 KiB of result metadata for every task.
    pub fn list_operational(org_run_id: &str) -> Result<Vec<Task>, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        Self::list_operational_with_connection(&conn, org_run_id)
    }

    pub(crate) fn list_operational_with_connection(
        conn: &rusqlite::Connection,
        org_run_id: &str,
    ) -> Result<Vec<Task>, String> {
        ensure_task_rows_safe_for_operational_projection(conn, org_run_id)?;
        Self::list_operational_after_validated_with_connection(conn, org_run_id)
    }

    /// Internal projection for a caller that has already run the shared
    /// finality/corruption assessment in the same SQLite read snapshot.
    /// Keeping this separate avoids evaluating the expensive JSON integrity
    /// predicate twice per watchdog tick while the public wrapper remains
    /// fail-closed for every other caller.
    pub(crate) fn list_operational_after_validated_with_connection(
        conn: &rusqlite::Connection,
        org_run_id: &str,
    ) -> Result<Vec<Task>, String> {
        let mut stmt = conn
            .prepare(
                "SELECT task.id,
                        task.org_run_id,
                        substr(task.subject, 1, 200),
                        task.owner,
                        task.status,
                        task.blocks_json,
                        task.blocked_by_json,
                        CASE WHEN json_valid(task.metadata_json)
                                  AND json_type(task.metadata_json, '$.eligible_member_ids')='array'
                             THEN json_extract(task.metadata_json, '$.eligible_member_ids')
                             ELSE '[]' END,
                        task.created_at,
                        task.updated_at
                 FROM (
                     SELECT id, org_run_id, subject, description, active_form,
                            owner, status, created_at, updated_at,
                            CASE WHEN length(CAST(blocks_json AS BLOB))<=?2
                                 THEN blocks_json ELSE '!' END AS blocks_json,
                            CASE WHEN length(CAST(blocked_by_json AS BLOB))<=?2
                                 THEN blocked_by_json ELSE '!' END AS blocked_by_json,
                            CASE WHEN metadata_json IS NULL
                                      OR length(CAST(metadata_json AS BLOB))<=?3
                                 THEN metadata_json ELSE '!' END AS metadata_json
                     FROM agent_org_tasks
                 ) task
                 WHERE task.org_run_id=?1
                 ORDER BY task.created_at ASC, task.id ASC",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(
                params![
                    org_run_id,
                    crate::coordination::agent_org_payload_limits::TASK_DEPENDENCY_JSON_MAX_BYTES
                        as i64,
                    crate::coordination::agent_org_payload_limits::TASK_METADATA_MAX_BYTES as i64,
                ],
                |row| {
                    let status_raw: String = row.get(4)?;
                    let eligible = decode_summary_array(row.get(7)?, 7)?;
                    let metadata = (!eligible.is_empty()).then(
                        || serde_json::json!({ (TASK_METADATA_ELIGIBLE_MEMBER_IDS): eligible }),
                    );
                    Ok(Task {
                        id: row.get(0)?,
                        org_run_id: row.get(1)?,
                        subject: row.get(2)?,
                        description: String::new(),
                        active_form: None,
                        owner: row.get(3)?,
                        status: TaskStatus::from_wire(&status_raw).map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(
                                4,
                                rusqlite::types::Type::Text,
                                error.into(),
                            )
                        })?,
                        blocks: decode_summary_array(row.get(5)?, 5)?,
                        blocked_by: decode_summary_array(row.get(6)?, 6)?,
                        metadata,
                        created_at: row.get(8)?,
                        updated_at: row.get(9)?,
                    })
                },
            )
            .map_err(|err| err.to_string())?;
        let mut tasks = rows
            .map(|row| row.map_err(|err| err.to_string()))
            .collect::<Result<Vec<_>, _>>()?;
        TaskGraphIndex::new(&tasks).apply_projection(&mut tasks);
        Ok(tasks)
    }

    pub fn list_summary_page(
        org_run_id: &str,
        status: Option<TaskStatus>,
        owner: Option<&str>,
        after_task_id: Option<&str>,
        limit: usize,
    ) -> Result<TaskSummaryPage, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        Self::list_summary_page_with_connection(
            &conn,
            org_run_id,
            status,
            owner,
            after_task_id,
            limit,
        )
    }

    /// Read one compact task page directly from SQLite. The cursor is first
    /// resolved to its `(created_at, id)` tuple, then the page uses that stable
    /// pair as its boundary so equal timestamps cannot reorder or skip rows.
    pub fn list_summary_page_with_connection(
        conn: &rusqlite::Connection,
        org_run_id: &str,
        status: Option<TaskStatus>,
        owner: Option<&str>,
        after_task_id: Option<&str>,
        limit: usize,
    ) -> Result<TaskSummaryPage, String> {
        let bounded_limit = limit.clamp(1, 200);
        let cursor = after_task_id
            .map(|task_id| {
                conn.query_row(
                    "SELECT created_at, id FROM agent_org_tasks
                     WHERE org_run_id=?1 AND id=?2
                       AND length(id)<=?3 AND length(CAST(id AS BLOB))<=?4
                       AND length(created_at)<=?5
                       AND length(CAST(created_at AS BLOB))<=?6",
                    params![
                        org_run_id,
                        task_id,
                        crate::coordination::agent_org_payload_limits::TASK_IDENTIFIER_MAX_CHARS
                            as i64,
                        crate::coordination::agent_org_payload_limits::TASK_IDENTIFIER_MAX_BYTES
                            as i64,
                        crate::coordination::agent_org_payload_limits::RFC3339_TIMESTAMP_MAX_CHARS
                            as i64,
                        crate::coordination::agent_org_payload_limits::RFC3339_TIMESTAMP_MAX_BYTES
                            as i64,
                    ],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()
                .map_err(|err| err.to_string())?
                .ok_or_else(|| {
                    format!(
                        "task_list after_task_id '{task_id}' does not exist or is corrupt in this run"
                    )
                })
            })
            .transpose()?;
        let (cursor_created_at, cursor_id) = cursor
            .as_ref()
            .map(|(created_at, id)| (Some(created_at.as_str()), Some(id.as_str())))
            .unwrap_or((None, None));
        let status_wire = status.map(|status| status.as_wire());

        let summary_scalar_predicate = task_summary_scalar_predicate_sql("task");
        let filtered_total_sql = format!(
            "SELECT COUNT(*) FROM agent_org_tasks task
             WHERE task.org_run_id=?1
               AND {summary_scalar_predicate}
               AND (?2 IS NULL OR task.status=?2)
               AND (?3 IS NULL OR task.owner=?3)"
        );
        let filtered_total: i64 = conn
            .query_row(
                &filtered_total_sql,
                params![org_run_id, status_wire, owner],
                |row| row.get(0),
            )
            .map_err(|err| err.to_string())?;

        let summary_sql = "SELECT
                     task.id,
                     substr(task.subject, 1, 200),
                     substr(task.description, 1, ?6),
                     CASE WHEN length(task.description) > ?6 THEN 1 ELSE 0 END,
                     CASE WHEN task.active_form IS NULL THEN NULL
                          ELSE substr(task.active_form, 1, 1000) END,
                     task.owner,
                     task.status,
                     CASE WHEN json_valid(task.blocks_json) THEN
                         CASE WHEN json_type(task.blocks_json)='array' THEN
                             (SELECT json_group_array(value) FROM (
                                  SELECT value
                                  FROM json_each(task.blocks_json)
                                  WHERE type='text' LIMIT ?8
                              ))
                         ELSE '[]' END
                     ELSE '[]' END,
                     CASE WHEN json_valid(task.blocked_by_json) THEN
                         CASE WHEN json_type(task.blocked_by_json)='array' THEN
                             (SELECT json_group_array(value) FROM (
                                  SELECT value
                                  FROM json_each(task.blocked_by_json)
                                  WHERE type='text' LIMIT ?8
                              ))
                         ELSE '[]' END
                     ELSE '[]' END,
                     CASE WHEN json_valid(task.metadata_json) THEN
                         CASE WHEN json_type(task.metadata_json, '$.eligible_member_ids')='array' THEN
                             (SELECT json_group_array(value) FROM (
                                  SELECT value
                                  FROM json_each(task.metadata_json, '$.eligible_member_ids')
                                  WHERE type='text' LIMIT ?9
                              ))
                         ELSE '[]' END
                     ELSE '[]' END,
                     CASE WHEN json_valid(task.metadata_json) THEN
                         CASE WHEN json_type(task.metadata_json, '$.required_role')='text'
                              THEN substr(json_extract(task.metadata_json, '$.required_role'), 1, 200)
                              ELSE NULL END
                     ELSE NULL END,
                     CASE WHEN json_valid(task.metadata_json) THEN
                         CASE WHEN json_type(task.metadata_json, '$.execution_mode')='text'
                              THEN substr(json_extract(task.metadata_json, '$.execution_mode'), 1, 20)
                              ELSE 'build' END
                     ELSE 'build' END,
                     CASE WHEN json_valid(task.metadata_json) THEN
                         CASE WHEN json_type(task.metadata_json, '$.output.summary')='text'
                              THEN substr(json_extract(task.metadata_json, '$.output.summary'), 1, 1000)
                              ELSE NULL END
                     ELSE NULL END,
                     CASE WHEN json_valid(task.metadata_json) THEN
                         CASE WHEN json_type(task.metadata_json, '$.output.artifactIds')='array' THEN
                             (SELECT json_group_array(value) FROM (
                                  SELECT value
                                  FROM json_each(task.metadata_json, '$.output.artifactIds')
                                  WHERE type='text' LIMIT ?10
                              ))
                         ELSE '[]' END
                     ELSE '[]' END,
                     CASE WHEN json_valid(task.metadata_json) THEN
                         CASE WHEN json_type(task.metadata_json, '$.output.producedByMemberId')='text'
                              THEN substr(json_extract(task.metadata_json, '$.output.producedByMemberId'), 1, 1000)
                              ELSE NULL END
                     ELSE NULL END,
                     CASE WHEN json_valid(task.metadata_json) THEN
                         CASE WHEN json_type(task.metadata_json, '$.output.producedAt')='text'
                              THEN substr(json_extract(task.metadata_json, '$.output.producedAt'), 1, 100)
                              ELSE NULL END
                     ELSE NULL END,
                     CASE WHEN json_valid(task.metadata_json) THEN
                         CASE WHEN json_type(task.metadata_json, '$.output.content')='text' THEN 1 ELSE 0 END
                     ELSE 0 END,
                     task.created_at,
                     task.updated_at,
                     CASE WHEN json_valid(task.blocks_json)
                               AND json_type(task.blocks_json)='array'
                          THEN (SELECT COUNT(*) FROM json_each(task.blocks_json) WHERE type='text')
                          ELSE 0 END,
                     CASE WHEN json_valid(task.blocked_by_json)
                               AND json_type(task.blocked_by_json)='array'
                          THEN (SELECT COUNT(*) FROM json_each(task.blocked_by_json) WHERE type='text')
                          ELSE 0 END,
                     CASE WHEN json_valid(task.metadata_json)
                               AND json_type(task.metadata_json, '$.eligible_member_ids')='array'
                          THEN (SELECT COUNT(*) FROM json_each(task.metadata_json, '$.eligible_member_ids') WHERE type='text')
                          ELSE 0 END,
                     CASE WHEN json_valid(task.metadata_json)
                               AND json_type(task.metadata_json, '$.output.artifactIds')='array'
                          THEN (SELECT COUNT(*) FROM json_each(task.metadata_json, '$.output.artifactIds') WHERE type='text')
                          ELSE 0 END
                 FROM (
                     SELECT id, org_run_id, subject, description, active_form,
                            CASE WHEN owner IS NULL THEN NULL
                                 WHEN trim(owner)<>''
                                      AND length(owner)<={id_chars}
                                      AND length(CAST(owner AS BLOB))<={id_bytes}
                                 THEN owner ELSE NULL END AS owner,
                            status, created_at, updated_at,
                            CASE WHEN length(CAST(blocks_json AS BLOB))<=?11
                                 THEN blocks_json ELSE '!' END AS blocks_json,
                            CASE WHEN length(CAST(blocked_by_json AS BLOB))<=?11
                                 THEN blocked_by_json ELSE '!' END AS blocked_by_json,
                            CASE WHEN metadata_json IS NULL
                                      OR length(CAST(metadata_json AS BLOB))<=?12
                                 THEN metadata_json ELSE '!' END AS metadata_json
                     FROM agent_org_tasks
                 ) task
                 WHERE task.org_run_id=?1
                   AND {summary_scalar_predicate}
                   AND (?2 IS NULL OR task.status=?2)
                   AND (?3 IS NULL OR task.owner=?3)
                   AND (
                       ?4 IS NULL
                       OR task.created_at > ?4
                       OR (task.created_at = ?4 AND task.id > ?5)
                   )
                 ORDER BY task.created_at ASC, task.id ASC
                 LIMIT ?7"
            .replace("{id_chars}", &crate::coordination::agent_org_payload_limits::TASK_IDENTIFIER_MAX_CHARS.to_string())
            .replace("{id_bytes}", &crate::coordination::agent_org_payload_limits::TASK_IDENTIFIER_MAX_BYTES.to_string())
            .replace("{timestamp_chars}", &crate::coordination::agent_org_payload_limits::RFC3339_TIMESTAMP_MAX_CHARS.to_string())
            .replace("{timestamp_bytes}", &crate::coordination::agent_org_payload_limits::RFC3339_TIMESTAMP_MAX_BYTES.to_string())
            .replace("{summary_scalar_predicate}", &summary_scalar_predicate);
        let mut stmt = conn.prepare(&summary_sql).map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(
                params![
                    org_run_id,
                    status_wire,
                    owner,
                    cursor_created_at,
                    cursor_id,
                    TASK_SUMMARY_DESCRIPTION_MAX_CHARS as i64,
                    (bounded_limit + 1) as i64,
                    TASK_SUMMARY_DEPENDENCY_PREVIEW_MAX_COUNT as i64,
                    TASK_SUMMARY_ELIGIBILITY_PREVIEW_MAX_COUNT as i64,
                    TASK_SUMMARY_ARTIFACT_PREVIEW_MAX_COUNT as i64,
                    crate::coordination::agent_org_payload_limits::TASK_DEPENDENCY_JSON_MAX_BYTES
                        as i64,
                    crate::coordination::agent_org_payload_limits::TASK_METADATA_MAX_BYTES as i64,
                ],
                |row| {
                    let status_raw: String = row.get(6)?;
                    let execution_mode_raw: String = row.get(11)?;
                    let output_summary: Option<String> = row.get(12)?;
                    let artifact_ids = decode_summary_array(row.get(13)?, 13)?;
                    let artifact_count = row.get::<_, i64>(22)?.max(0) as usize;
                    let output = output_summary
                        .map(|summary| {
                            Ok::<TaskOutputSummary, rusqlite::Error>(TaskOutputSummary {
                                summary,
                                artifact_ids,
                                artifact_ids_truncated: artifact_count
                                    > TASK_SUMMARY_ARTIFACT_PREVIEW_MAX_COUNT,
                                produced_by_member_id: row.get(14)?,
                                produced_at: row.get(15)?,
                                has_content: row.get::<_, i64>(16)? != 0,
                            })
                        })
                        .transpose()?;
                    let blocks = decode_summary_array(row.get(7)?, 7)?;
                    let blocked_by = decode_summary_array(row.get(8)?, 8)?;
                    let eligible_member_ids = decode_summary_array(row.get(9)?, 9)?;
                    Ok(TaskSummary {
                        id: row.get(0)?,
                        subject: row.get(1)?,
                        description: row.get(2)?,
                        description_truncated: row.get::<_, i64>(3)? != 0,
                        active_form: row.get(4)?,
                        owner: row.get(5)?,
                        status: TaskStatus::from_wire(&status_raw).map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(
                                6,
                                rusqlite::types::Type::Text,
                                error.into(),
                            )
                        })?,
                        blocks,
                        blocks_truncated: row.get::<_, i64>(19)?.max(0) as usize
                            > TASK_SUMMARY_DEPENDENCY_PREVIEW_MAX_COUNT,
                        blocked_by,
                        blocked_by_truncated: row.get::<_, i64>(20)?.max(0) as usize
                            > TASK_SUMMARY_DEPENDENCY_PREVIEW_MAX_COUNT,
                        eligible_member_ids,
                        eligible_member_ids_truncated: row.get::<_, i64>(21)?.max(0) as usize
                            > TASK_SUMMARY_ELIGIBILITY_PREVIEW_MAX_COUNT,
                        required_role: row.get(10)?,
                        execution_mode: TaskExecutionMode::from_wire(&execution_mode_raw)
                            .unwrap_or(TaskExecutionMode::Build),
                        output,
                        created_at: row.get(17)?,
                        updated_at: row.get(18)?,
                    })
                },
            )
            .map_err(|err| err.to_string())?;
        let mut tasks = Vec::new();
        let mut serialized_bytes = 2usize; // surrounding JSON array
        let mut has_more = false;
        for row in rows {
            let task = row.map_err(|err| err.to_string())?;
            if tasks.len() == bounded_limit {
                has_more = true;
                break;
            }
            let task_bytes = serde_json::to_vec(&task)
                .map_err(|err| format!("serialize TaskSummary for payload budget failed: {err}"))?
                .len();
            let separator = usize::from(!tasks.is_empty());
            if serialized_bytes
                .saturating_add(separator)
                .saturating_add(task_bytes)
                > TASK_SUMMARY_PAGE_MAX_BYTES
            {
                has_more = true;
                break;
            }
            serialized_bytes = serialized_bytes
                .saturating_add(separator)
                .saturating_add(task_bytes);
            tasks.push(task);
        }
        let next_cursor = has_more
            .then(|| tasks.last().map(|task| task.id.clone()))
            .flatten();
        Ok(TaskSummaryPage {
            tasks,
            filtered_total: filtered_total.max(0) as usize,
            has_more,
            next_cursor,
        })
    }

    /// Return a bounded preview of unresolved task ids from an existing read
    /// snapshot. The boolean reports whether more ids exist beyond `limit`.
    /// Callers that only render run-level guidance must not load full task
    /// rows (and their potentially large descriptions/output metadata) merely
    /// to name a few blockers.
    pub(crate) fn open_task_ids_preview_with_connection(
        conn: &rusqlite::Connection,
        org_run_id: &str,
        limit: usize,
    ) -> Result<(Vec<String>, bool), String> {
        let bounded_limit = limit.clamp(1, 500);
        let mut stmt = conn
            .prepare(
                "SELECT id FROM agent_org_tasks
                 WHERE org_run_id=?1 AND status<>'completed'
                   AND trim(id)<>''
                   AND length(id)<=?3
                   AND length(CAST(id AS BLOB))<=?4
                 ORDER BY created_at ASC, id ASC
                 LIMIT ?2",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(
                params![
                    org_run_id,
                    (bounded_limit + 1) as i64,
                    crate::coordination::agent_org_payload_limits::TASK_IDENTIFIER_MAX_CHARS as i64,
                    crate::coordination::agent_org_payload_limits::TASK_IDENTIFIER_MAX_BYTES as i64,
                ],
                |row| row.get::<_, String>(0),
            )
            .map_err(|err| err.to_string())?;
        let mut ids = Vec::new();
        let mut bytes = 2usize; // surrounding JSON array
        let mut truncated = false;
        for row in rows {
            let id = row.map_err(|err| err.to_string())?;
            let encoded_id_bytes = serde_json::to_vec(&id)
                .map_err(|err| format!("serialize open task id preview failed: {err}"))?
                .len();
            let separator = usize::from(!ids.is_empty());
            if ids.len() == bounded_limit
                || bytes
                    .saturating_add(encoded_id_bytes)
                    .saturating_add(separator)
                    > crate::coordination::agent_org_payload_limits::TASK_OPEN_ID_PREVIEW_MAX_BYTES
            {
                truncated = true;
                break;
            }
            bytes = bytes
                .saturating_add(encoded_id_bytes)
                .saturating_add(separator);
            ids.push(id);
        }
        Ok((ids, truncated))
    }

    #[cfg(test)]
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

    pub fn delete(org_run_id: &str, task_id: &str) -> Result<bool, String> {
        let deleted = with_sessions_writer(|| Self::delete_inner(org_run_id, task_id, None))?;
        if deleted {
            crate::coordination::agent_org_run_events::notify_agent_org_run_changed(org_run_id);
        }
        Ok(deleted)
    }

    /// Delete only the row version that was inspected before tool-level
    /// authorization. See `update_with_outcome_if_unchanged`.
    pub fn delete_if_unchanged(
        org_run_id: &str,
        task_id: &str,
        expected_updated_at: &str,
    ) -> Result<bool, String> {
        let deleted = with_sessions_writer(|| {
            Self::delete_inner(org_run_id, task_id, Some(expected_updated_at))
        })?;
        if deleted {
            crate::coordination::agent_org_run_events::notify_agent_org_run_changed(org_run_id);
        }
        Ok(deleted)
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
        let existing_tasks = list_tasks_with_conn(&tx, org_run_id)?;
        let Some(current_task) = existing_tasks
            .iter()
            .find(|task| task.id == task_id)
            .cloned()
        else {
            tx.commit().map_err(|err| err.to_string())?;
            return Ok(false);
        };
        if expected_updated_at.is_some_and(|expected| expected != current_task.updated_at.as_str())
        {
            return Err(format!(
                "{}: task {} changed after authorization; reload it and retry",
                super::TASK_MUTATION_CONFLICT_ERROR,
                task_id
            ));
        }
        let graph = TaskGraphIndex::new(&existing_tasks);
        let dependent_task_ids = graph.blocks(task_id).to_vec();
        if !dependent_task_ids.is_empty() {
            return Err(format!(
                "{TASK_DELETE_HAS_DEPENDENTS_ERROR}: task {task_id} is still referenced by blocked_by on [{}]; update or delete those dependent tasks first",
                dependent_task_ids.join(",")
            ));
        }
        // Fail closed if the delivery-resolution schema is missing or
        // unreadable. Treating a schema failure as "not referenced" could
        // permanently delete the only durable replacement for an Inbox row.
        let is_delivery_replacement: bool = tx
            .query_row(
                "SELECT EXISTS(
                     SELECT 1
                     FROM agent_inbox_delivery_resolutions
                     WHERE org_run_id=?1 AND replacement_task_id=?2
                 )",
                params![org_run_id, task_id],
                |row| row.get(0),
            )
            .map_err(|err| err.to_string())?;
        if is_delivery_replacement {
            return Err(format!(
                "{TASK_DELETE_IS_DELIVERY_REPLACEMENT_ERROR}: task {task_id} is durable replacement evidence for a resolved Inbox delivery and cannot be deleted"
            ));
        }
        let n = tx
            .execute(
                "DELETE FROM agent_org_tasks WHERE org_run_id = ?1 AND id = ?2",
                params![org_run_id, task_id],
            )
            .map_err(|err| err.to_string())?;
        if n > 0 {
            let mut deleted_snapshot = current_task.clone();
            deleted_snapshot.updated_at = now_rfc3339();
            insert_task_history_event(
                &tx,
                org_run_id,
                task_id,
                TASK_EVENT_DELETED,
                Some(&current_task),
                &deleted_snapshot,
                None,
            )?;
            crate::coordination::agent_org_runs::bump_work_revision_in_tx(&tx, org_run_id)?;
        }
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
        let tasks = with_sessions_writer(|| {
            Self::dispose_open_tasks_for_shutdown_inner(org_run_id, owner_member_id)
        })?;
        if !tasks.is_empty() {
            crate::coordination::agent_org_run_events::notify_agent_org_run_changed(org_run_id);
        }
        Ok(tasks)
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

        crate::coordination::agent_org_runs::bump_work_revision_in_tx(&tx, org_run_id)?;

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
        let tasks = with_sessions_writer(|| {
            Self::requeue_in_progress_for_owner_inner(org_run_id, owner_member_id)
        })?;
        if !tasks.is_empty() {
            crate::coordination::agent_org_run_events::notify_agent_org_run_changed(org_run_id);
        }
        Ok(tasks)
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

        crate::coordination::agent_org_runs::bump_work_revision_in_tx(&tx, org_run_id)?;

        tx.commit().map_err(|err| err.to_string())?;
        Ok(updated_rows)
    }
}

#[cfg(test)]
mod migration_tests {
    use super::*;

    #[test]
    fn dependency_migration_skips_corrupt_run_and_normalizes_valid_run() {
        let conn = rusqlite::Connection::open_in_memory().expect("open in-memory database");
        super::super::init_schema(&conn).expect("create task schema");

        let now = now_rfc3339();
        for (id, blocks_json, blocked_by_json) in
            [("task-a", r#"["task-b"]"#, "[]"), ("task-b", "[]", "[]")]
        {
            conn.execute(
                "INSERT INTO agent_org_tasks (
                     id, org_run_id, subject, description, status,
                     blocks_json, blocked_by_json, created_at, updated_at
                 ) VALUES (?1, 'valid-run', ?1, '', 'pending', ?2, ?3, ?4, ?4)",
                params![id, blocks_json, blocked_by_json, &now],
            )
            .expect("seed valid legacy task");
        }
        conn.execute(
            "INSERT INTO agent_org_tasks (
                 id, org_run_id, subject, description, status,
                 blocks_json, blocked_by_json, created_at, updated_at
             ) VALUES (
                 'corrupt-task', 'corrupt-run', 'corrupt', '', 'pending',
                 'not-json', '[]', ?1, ?1
             )",
            params![&now],
        )
        .expect("seed corrupt historical task");

        super::super::init_schema(&conn)
            .expect("schema init must survive one corrupt historical run");

        let (a_blocks, b_blocked_by): (String, String) = conn
            .query_row(
                "SELECT a.blocks_json, b.blocked_by_json
                 FROM agent_org_tasks a
                 JOIN agent_org_tasks b
                   ON b.org_run_id=a.org_run_id AND b.id='task-b'
                 WHERE a.org_run_id='valid-run' AND a.id='task-a'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read normalized valid board");
        assert_eq!(a_blocks, r#"["task-b"]"#);
        assert_eq!(b_blocked_by, r#"["task-a"]"#);

        let corrupt_blocks: String = conn
            .query_row(
                "SELECT blocks_json FROM agent_org_tasks
                 WHERE org_run_id='corrupt-run' AND id='corrupt-task'",
                [],
                |row| row.get(0),
            )
            .expect("corrupt row remains available for runtime repair");
        assert_eq!(corrupt_blocks, "not-json");

        let valid_marked: bool = conn
            .query_row(
                "SELECT EXISTS(
                     SELECT 1 FROM agent_org_task_run_schema_migrations
                     WHERE name='canonical_blocked_by_v1' AND org_run_id='valid-run'
                 )",
                [],
                |row| row.get(0),
            )
            .expect("read valid marker");
        let corrupt_marked: bool = conn
            .query_row(
                "SELECT EXISTS(
                     SELECT 1 FROM agent_org_task_run_schema_migrations
                     WHERE name='canonical_blocked_by_v1' AND org_run_id='corrupt-run'
                 )",
                [],
                |row| row.get(0),
            )
            .expect("read corrupt marker");
        assert!(valid_marked, "healthy run receives its own success marker");
        assert!(
            !corrupt_marked,
            "corrupt run remains unmarked so a later startup can retry"
        );

        conn.execute(
            "UPDATE agent_org_tasks SET blocks_json='[]'
             WHERE org_run_id='corrupt-run' AND id='corrupt-task'",
            [],
        )
        .expect("repair corrupt historical row");
        super::super::init_schema(&conn).expect("retry repaired run");
        let corrupt_marked_after_retry: bool = conn
            .query_row(
                "SELECT EXISTS(
                     SELECT 1 FROM agent_org_task_run_schema_migrations
                     WHERE name='canonical_blocked_by_v1' AND org_run_id='corrupt-run'
                 )",
                [],
                |row| row.get(0),
            )
            .expect("read retry marker");
        assert!(
            corrupt_marked_after_retry,
            "a repaired run is retried and marked independently"
        );
    }
}

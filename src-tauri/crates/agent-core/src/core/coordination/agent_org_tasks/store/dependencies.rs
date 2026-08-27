//! Dependency-graph canonicalization. `blocked_by` is the only persisted edge;
//! `blocks` is derived in memory for readers.

use rusqlite::params;

use super::super::graph::validate_dependency_graph;
#[cfg(test)]
use super::super::helpers::encode_json_array;
use super::super::{Task, TaskGraphIndex};
use crate::coordination::agent_org_payload_limits::{
    validate_task_dependency_ids, TASK_RUN_MAX_OPEN_TASKS,
};

pub(super) fn canonicalize_dependencies(
    tasks: &mut [Task],
    org_run_id: &str,
) -> Result<(), String> {
    // `blocked_by` is the sole persisted edge. `blocks` is rebuilt only as an
    // in-memory read projection before validating the candidate graph.
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

#[cfg(test)]
pub(super) fn persist_canonical_blocked_by_for_test_fixture(
    conn: &rusqlite::Connection,
    tasks: &[Task],
) -> Result<(), String> {
    let mut stmt = conn
        .prepare(
            "UPDATE agent_org_runtime_tasks
             SET blocked_by_json=?1
             WHERE org_run_id=?2 AND id=?3 AND blocked_by_json<>?1",
        )
        .map_err(|err| err.to_string())?;
    for task in tasks {
        let blocked_by_json = encode_json_array(&task.blocked_by)?;
        stmt.execute(params![&blocked_by_json, &task.org_run_id, &task.id,])
            .map_err(|err| err.to_string())?;
    }
    Ok(())
}

/// Preflight canonical rows without deserializing their JSON.
pub(super) fn run_is_safe_for_operational_projection(
    conn: &rusqlite::Connection,
    run_id: &str,
) -> Result<bool, String> {
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM agent_org_runtime_tasks
             WHERE org_run_id=?1 AND status IN ('pending','in_progress')",
            params![run_id],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())?;
    if count > TASK_RUN_MAX_OPEN_TASKS as i64 {
        return Ok(false);
    }
    let predicate = super::super::corrupt_task_row_predicate_sql();
    let dependency_json_max =
        crate::coordination::agent_org_payload_limits::TASK_DEPENDENCY_JSON_MAX_BYTES;
    let metadata_max = crate::coordination::agent_org_payload_limits::TASK_METADATA_MAX_BYTES;
    let sql = format!(
        "WITH operational_ids(id) AS (
             SELECT id
             FROM agent_org_runtime_tasks
             WHERE org_run_id=?1 AND status IN ('pending','in_progress')
             UNION
             SELECT CAST(edge.value AS TEXT)
             FROM agent_org_runtime_tasks open_task,
                  json_each(
                      CASE WHEN json_valid(open_task.blocked_by_json)
                           THEN open_task.blocked_by_json ELSE '[]' END
                  ) edge
             WHERE open_task.org_run_id=?1
               AND open_task.status IN ('pending','in_progress')
               AND edge.type='text'
         )
         SELECT COALESCE(SUM(CASE WHEN {predicate} THEN 1 ELSE 0 END),0)
         FROM (
             SELECT id, subject, description, active_form, owner, status,
                    execution_mode, output_json, failure_reason_json, cancel_reason_json,
                    created_by_participant_id, source_turn_intent_id,
                    originating_message_id, replaces_task_id, created_at, updated_at,
                    external_effect_unknown,
                    CASE WHEN length(CAST(blocked_by_json AS BLOB))<={dependency_json_max}
                         THEN blocked_by_json ELSE '!' END AS blocked_by_json,
                    CASE WHEN metadata_json IS NULL
                              OR length(CAST(metadata_json AS BLOB))<={metadata_max}
                         THEN metadata_json ELSE '!' END AS metadata_json
             FROM agent_org_runtime_tasks
             WHERE org_run_id=?1 AND id IN (SELECT id FROM operational_ids)
         ) AS bounded_tasks"
    );
    let corrupt: i64 = conn
        .query_row(&sql, params![run_id], |row| row.get(0))
        .map_err(|err| err.to_string())?;
    Ok(corrupt == 0)
}

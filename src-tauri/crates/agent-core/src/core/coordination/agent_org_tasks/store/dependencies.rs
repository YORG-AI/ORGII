//! Dependency-graph canonicalization and its persisted `blocks`/`blocked_by`
//! projection. `blocked_by` is authoritative; `blocks` is a derived read
//! projection recomputed here and written back only when it drifts.

use rusqlite::params;

use super::super::graph::validate_dependency_graph;
use super::super::helpers::encode_json_array;
use super::super::{Task, TaskGraphIndex};

pub(super) fn canonicalize_dependencies(
    tasks: &mut [Task],
    org_run_id: &str,
) -> Result<(), String> {
    // `list_tasks_with_conn` has already folded historical reverse-only
    // `blocks` edges into `blocked_by`. From this point forward blocked_by is
    // authoritative and blocks is a derived read projection.
    for task in tasks.iter_mut() {
        task.blocks.clear();
    }
    let graph = TaskGraphIndex::new(tasks);
    graph.apply_projection(tasks);
    validate_dependency_graph(tasks, org_run_id)
}

pub(super) fn persist_dependency_projection(
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

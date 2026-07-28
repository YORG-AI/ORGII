//! Dependency-graph canonicalization and its persisted `blocks`/`blocked_by`
//! projection. `blocked_by` is authoritative; `blocks` is a derived read
//! projection recomputed here and written back only when it drifts.

use rusqlite::params;
use tracing::warn;

use super::super::graph::validate_dependency_graph;
use super::super::helpers::{encode_json_array, list_tasks_with_conn, now_rfc3339};
use super::super::{Task, TaskGraphIndex};
use crate::coordination::agent_org_payload_limits::{
    validate_task_dependency_ids, TASK_RUN_MAX_TASKS,
};

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
    for task in tasks.iter() {
        validate_task_dependency_ids("blocked_by", &task.blocked_by)?;
        validate_task_dependency_ids("derived blocks", &task.blocks)?;
    }
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

/// Preflight historical rows without deserializing their JSON.
pub(super) fn run_is_safe_for_dependency_normalization(
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
    let predicate = super::super::corrupt_task_row_predicate_sql();
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

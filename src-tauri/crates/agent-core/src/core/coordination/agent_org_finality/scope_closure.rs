//! Episode-scoped user removal receipts and explicit dependent resolutions.

use rusqlite::{params, OptionalExtension};

use super::*;
use crate::coordination::agent_org_tasks::{Task, TaskActorAudit};

fn decode_scope_receipt(row: &rusqlite::Row<'_>) -> rusqlite::Result<ScopeRemovalReceipt> {
    Ok(ScopeRemovalReceipt {
        id: row.get(0)?,
        org_run_id: row.get(1)?,
        work_episode_id: row.get(2)?,
        target_task_id: row.get(3)?,
        root_user_event_id: row.get(4)?,
        request_id: row.get(5)?,
        actor_session_id: row.get(6)?,
        status: row.get(7)?,
        created_at: row.get(8)?,
    })
}

pub(crate) fn scope_removal_by_request_in_tx(
    conn: &Connection,
    org_run_id: &str,
    request_id: &str,
) -> Result<Option<(ScopeRemovalReceipt, String)>, String> {
    conn.query_row(
        "SELECT receipt_id,org_run_id,work_episode_id,target_task_id,
                root_user_event_id,request_id,actor_session_id,status,created_at,
                request_digest
         FROM agent_org_scope_removal_receipts
         WHERE org_run_id=?1 AND request_id=?2",
        params![org_run_id, request_id],
        |row| Ok((decode_scope_receipt(row)?, row.get(9)?)),
    )
    .optional()
    .map_err(|error| error.to_string())
}

pub(crate) fn create_scope_removal_in_tx(
    conn: &Connection,
    org_run_id: &str,
    task_id: &str,
    request_id: &str,
    request_digest: &str,
    actor_session_id: &str,
) -> Result<ScopeRemovalReceipt, String> {
    let episode_id: String = conn
        .query_row(
            "SELECT association.work_episode_id
             FROM agent_org_runtime_work_episode_tasks association
             JOIN agent_org_runtime_work_episodes episode
               ON episode.id=association.work_episode_id
              AND episode.org_run_id=association.org_run_id
              AND episode.status='active'
             JOIN agent_org_runtime_tasks task
               ON task.org_run_id=association.org_run_id
              AND task.id=association.task_id
              AND task.status IN ('pending','in_progress')
             JOIN agent_org_runtime_runs run
               ON run.id=association.org_run_id
              AND run.status='running'
              AND run.root_session_id=?3
             WHERE association.org_run_id=?1 AND association.task_id=?2",
            params![org_run_id, task_id, actor_session_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("scope_removal_target_invalid:{error}"))?;
    let receipt_id = format!("scope-removal-{}", uuid::Uuid::new_v4());
    let root_user_event_id = format!("run-view-scope-removal:{request_id}");
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO agent_org_scope_removal_receipts (
            receipt_id,org_run_id,work_episode_id,target_task_id,root_user_event_id,
            request_id,request_digest,actor_session_id,actor_kind,status,created_at
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'run_view_user','recorded',?9)",
        params![
            &receipt_id,
            org_run_id,
            &episode_id,
            task_id,
            &root_user_event_id,
            request_id,
            request_digest,
            actor_session_id,
            &now,
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(ScopeRemovalReceipt {
        id: receipt_id,
        org_run_id: org_run_id.to_string(),
        work_episode_id: episode_id,
        target_task_id: task_id.to_string(),
        root_user_event_id,
        request_id: request_id.to_string(),
        actor_session_id: actor_session_id.to_string(),
        status: "recorded".to_string(),
        created_at: now,
    })
}

pub(crate) fn valid_scope_removal_for_task(
    conn: &Connection,
    org_run_id: &str,
    task_id: &str,
    receipt_id: &str,
) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(
             SELECT 1
             FROM agent_org_scope_removal_receipts root
             JOIN agent_org_runtime_work_episode_tasks target_episode
               ON target_episode.org_run_id=root.org_run_id
              AND target_episode.work_episode_id=root.work_episode_id
              AND target_episode.task_id=?2
             WHERE root.receipt_id=?3 AND root.org_run_id=?1
               AND root.status='recorded'
               AND (
                   root.target_task_id=?2
                   OR EXISTS (
                       SELECT 1 FROM agent_org_scope_resolution_receipts resolution
                       WHERE resolution.root_receipt_id=root.receipt_id
                         AND resolution.org_run_id=root.org_run_id
                         AND resolution.work_episode_id=root.work_episode_id
                         AND resolution.task_id=?2
                         AND resolution.resolution_kind IN (
                             'dependency_cancelled','dependency_replaced'
                         )
                   )
               )
         )",
        params![org_run_id, task_id, receipt_id],
        |row| row.get(0),
    )
    .map_err(|error| error.to_string())
}

pub(crate) fn validate_scope_removal_reason_in_tx(
    conn: &Connection,
    org_run_id: &str,
    task_id: &str,
    receipt_id: &str,
    run_view_request_id: Option<&str>,
) -> Result<(), String> {
    let valid: bool = conn
        .query_row(
            "WITH RECURSIVE dependency_ancestors(task_id) AS (
                 SELECT ?2
                 UNION
                 SELECT CAST(edge.value AS TEXT)
                 FROM dependency_ancestors ancestor
                 JOIN agent_org_runtime_tasks task
                   ON task.org_run_id=?1 AND task.id=ancestor.task_id
                 JOIN json_each(
                     CASE WHEN json_valid(task.blocked_by_json)
                          THEN task.blocked_by_json ELSE '[]' END
                 ) edge
                 WHERE edge.type='text'
             )
             SELECT EXISTS(
                 SELECT 1
                 FROM agent_org_scope_removal_receipts root
                 JOIN agent_org_runtime_runs run ON run.id=root.org_run_id
                 JOIN agent_org_runtime_work_episode_tasks task_episode
                   ON task_episode.org_run_id=root.org_run_id
                  AND task_episode.work_episode_id=root.work_episode_id
                  AND task_episode.task_id=?2
                 WHERE root.receipt_id=?3 AND root.org_run_id=?1
                   AND root.status='recorded'
                   AND root.actor_session_id=run.root_session_id
                   AND (
                       (?4 IS NOT NULL
                        AND root.target_task_id=?2
                        AND root.request_id=?4)
                       OR
                       (?4 IS NULL
                        AND root.target_task_id<>?2
                        AND root.target_task_id IN (
                            SELECT task_id FROM dependency_ancestors
                        ))
                   )
             )",
            params![org_run_id, task_id, receipt_id, run_view_request_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if valid {
        Ok(())
    } else {
        Err("scope_removal_receipt_not_authoritative_for_task".to_string())
    }
}

pub(crate) fn record_scope_resolution_in_tx(
    conn: &Connection,
    org_run_id: &str,
    task_id: &str,
    root_receipt_id: &str,
    resolution_kind: &str,
    replacement_task_id: Option<&str>,
    source_turn_intent_id: Option<&str>,
) -> Result<(), String> {
    let root: Option<String> = conn
        .query_row(
            "SELECT root.work_episode_id
             FROM agent_org_scope_removal_receipts root
             JOIN agent_org_runtime_work_episode_tasks task_episode
               ON task_episode.org_run_id=root.org_run_id
              AND task_episode.work_episode_id=root.work_episode_id
              AND task_episode.task_id=?3
             WHERE root.receipt_id=?2 AND root.org_run_id=?1
               AND root.status='recorded'",
            params![org_run_id, root_receipt_id, task_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let episode_id = root.ok_or_else(|| "scope_resolution_root_or_episode_mismatch".to_string())?;
    conn.execute(
        "INSERT INTO agent_org_scope_resolution_receipts (
            resolution_id,root_receipt_id,org_run_id,work_episode_id,task_id,
            resolution_kind,replacement_task_id,source_turn_intent_id,created_at
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
         ON CONFLICT(root_receipt_id,task_id,resolution_kind) DO UPDATE SET
            replacement_task_id=excluded.replacement_task_id,
            source_turn_intent_id=COALESCE(
                agent_org_scope_resolution_receipts.source_turn_intent_id,
                excluded.source_turn_intent_id
            )",
        params![
            format!("scope-resolution-{}", uuid::Uuid::new_v4()),
            root_receipt_id,
            org_run_id,
            episode_id,
            task_id,
            resolution_kind,
            replacement_task_id,
            source_turn_intent_id,
            chrono::Utc::now().to_rfc3339(),
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) fn record_scope_detachments_in_tx(
    conn: &Connection,
    previous: &Task,
    current: &Task,
    audit: &TaskActorAudit,
) -> Result<usize, String> {
    let removed_dependencies = previous
        .blocked_by
        .iter()
        .filter(|dependency_id| !current.blocked_by.contains(dependency_id))
        .collect::<Vec<_>>();
    let mut recorded = 0usize;
    for dependency_id in removed_dependencies {
        let root_receipt_id: Option<String> = conn
            .query_row(
                "SELECT json_extract(cancel_reason_json,'$.sourceEventId')
                 FROM agent_org_runtime_tasks
                 WHERE org_run_id=?1 AND id=?2 AND status='cancelled'
                   AND json_valid(cancel_reason_json)
                   AND json_extract(cancel_reason_json,'$.code') IN (
                       'user_scope_removed','dependency_scope_removed'
                   )",
                params![&current.org_run_id, dependency_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .flatten();
        if let Some(root_receipt_id) = root_receipt_id {
            record_scope_resolution_in_tx(
                conn,
                &current.org_run_id,
                &current.id,
                &root_receipt_id,
                "dependency_detached",
                None,
                audit.turn_intent_id.as_deref(),
            )?;
            recorded = recorded.saturating_add(1);
        }
    }
    Ok(recorded)
}

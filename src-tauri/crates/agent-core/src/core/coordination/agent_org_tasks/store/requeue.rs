//! Owner-scoped requeue paths: dispose every open task of a member that
//! accepted shutdown (released to the pool or escalated to the coordinator),
//! and requeue a failed member's `in_progress` tasks back to the unassigned
//! pool.

use database::db::{get_connection, with_sessions_writer};
use rusqlite::params;

use super::super::helpers::{insert_task_history_event, now_rfc3339, row_to_task, SELECT_COLUMNS};
use super::super::{Task, TaskStatus, TASK_EVENT_ESCALATED_TO_COORDINATOR, TASK_EVENT_RELEASED};
use super::validation::{ensure_run_allows_task_mutation, validate_task_persistence_invariants};
use super::AgentOrgTaskStore;

impl AgentOrgTaskStore {
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
        super::super::super::init_schema(&conn).expect("create task schema");

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

        super::super::super::init_schema(&conn)
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
        super::super::super::init_schema(&conn).expect("retry repaired run");
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

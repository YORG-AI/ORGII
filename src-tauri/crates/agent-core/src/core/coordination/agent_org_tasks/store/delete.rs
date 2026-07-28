//! Task deletion. Deletion is refused while any task still lists the target in
//! `blocked_by`, and (optionally) only applies to the exact inspected row
//! version to close the check-then-write race.

use database::db::{get_connection, with_sessions_writer};
use rusqlite::params;

use super::super::helpers::{insert_task_history_event, list_tasks_with_conn, now_rfc3339};
use super::super::{
    TaskGraphIndex, TASK_DELETE_HAS_DEPENDENTS_ERROR, TASK_DELETE_IS_DELIVERY_REPLACEMENT_ERROR,
    TASK_EVENT_DELETED,
};
use super::validation::ensure_run_allows_task_mutation;
use super::AgentOrgTaskStore;

impl AgentOrgTaskStore {
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
}

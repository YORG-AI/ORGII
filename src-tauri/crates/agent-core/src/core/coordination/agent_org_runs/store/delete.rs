use rusqlite::{params, Connection};

use crate::coordination::agent_org_plan_approvals::AgentOrgPlanRevisionStore;
use database::db::{get_connection, with_sessions_writer};

use super::AgentOrgRunStore;

pub(crate) struct AgentOrgRunDeleteOutcome {
    plan_artifacts: Vec<(String, String)>,
    deleted: bool,
}

impl AgentOrgRunDeleteOutcome {
    pub(crate) fn deleted(&self) -> bool {
        self.deleted
    }
}

fn delete_user_directed_work_for_run_with_connection(
    conn: &Connection,
    run_id: &str,
) -> Result<(), String> {
    conn.execute(
        "DELETE FROM agent_org_runtime_user_directed_coordinator_bindings
         WHERE org_run_id=?1",
        params![run_id],
    )
    .map_err(|err| {
        format!("failed to delete user-directed Coordinator bindings for {run_id}: {err}")
    })?;

    let mut remaining = conn
        .query_row(
            "SELECT COUNT(*)
             FROM agent_org_runtime_user_directed_deliveries
             WHERE org_run_id=?1",
            params![run_id],
            |row| row.get::<_, usize>(0),
        )
        .map_err(|err| format!("failed to count user-directed deliveries for {run_id}: {err}"))?;
    while remaining > 0 {
        let deleted = conn
            .execute(
                "DELETE FROM agent_org_runtime_user_directed_deliveries
                 WHERE delivery_id IN (
                     SELECT parent.delivery_id
                     FROM agent_org_runtime_user_directed_deliveries parent
                     WHERE parent.org_run_id=?1
                       AND NOT EXISTS (
                           SELECT 1
                           FROM agent_org_runtime_user_directed_deliveries child
                           WHERE child.parent_delivery_id=parent.delivery_id
                       )
                 )",
                params![run_id],
            )
            .map_err(|err| {
                format!("failed to delete user-directed delivery leaves for {run_id}: {err}")
            })?;
        if deleted == 0 || deleted > remaining {
            return Err(format!(
                "user_directed_delete_causal_cycle: Run {run_id} has {remaining} delivery row(s) but no removable causal leaf"
            ));
        }
        remaining -= deleted;
    }

    conn.execute(
        "DELETE FROM agent_org_runtime_user_directed_roots WHERE org_run_id=?1",
        params![run_id],
    )
    .map_err(|err| format!("failed to delete user-directed roots for {run_id}: {err}"))?;
    Ok(())
}

impl AgentOrgRunStore {
    pub fn delete_by_id(run_id: &str) -> Result<(), String> {
        let outcome = with_sessions_writer(|| -> Result<AgentOrgRunDeleteOutcome, String> {
            let mut conn = get_connection().map_err(|err| err.to_string())?;
            let tx = conn
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .map_err(|err| err.to_string())?;
            let outcome = Self::delete_by_id_with_connection(&tx, run_id)?;
            tx.commit().map_err(|err| err.to_string())?;
            Ok(outcome)
        })?;

        Self::finish_delete(run_id, outcome);
        Ok(())
    }

    pub(crate) fn delete_by_id_with_connection(
        conn: &Connection,
        run_id: &str,
    ) -> Result<AgentOrgRunDeleteOutcome, String> {
        let plan_artifacts = {
            let mut stmt = conn
                .prepare(
                    "SELECT DISTINCT revision.source_session_id, revision.plan_path
                     FROM agent_org_runtime_plan_revisions revision
                     WHERE revision.org_run_id=?1
                       AND NOT EXISTS (
                         SELECT 1 FROM agent_org_runtime_plan_revisions other
                         WHERE other.plan_path=revision.plan_path
                           AND other.org_run_id<>?1
                       )",
                )
                .map_err(|err| err.to_string())?;
            let rows = stmt
                .query_map(params![run_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|err| err.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|err| err.to_string())?
        };

        // User-directed deliveries deliberately use RESTRICT for their
        // parent-Inbox and parent-delivery authority. Tear the causal graph
        // down from its leaves before deleting Turn intents or Inbox rows;
        // otherwise those cascades can try to remove a parent while a linked
        // child still proves that it was derived from it.
        delete_user_directed_work_for_run_with_connection(conn, run_id)?;

        // Intent ownership is explicit. The hierarchy delete caller rejects
        // nested run roots before reaching this helper; standalone run cleanup
        // still deletes only rows owned by the requested run.
        conn.execute(
            "DELETE FROM session_turn_intents WHERE org_run_id=?1",
            params![run_id],
        )
        .map_err(|err| err.to_string())?;
        conn.execute(
            "DELETE FROM agent_org_runtime_inbox_materializations
             WHERE inbox_id IN (
                 SELECT id FROM agent_org_runtime_inbox WHERE org_run_id=?1
             )",
            params![run_id],
        )
        .map_err(|err| {
            format!("failed to delete agent_org_runtime_inbox_materializations rows for {run_id}: {err}")
        })?;
        conn.execute(
            "DELETE FROM agent_org_runtime_plan_decisions
             WHERE plan_revision_id IN (
                 SELECT plan_revision_id FROM agent_org_runtime_plan_revisions
                 WHERE org_run_id=?1
             )",
            params![run_id],
        )
        .map_err(|err| {
            format!("failed to delete agent_org_runtime_plan_decisions rows for {run_id}: {err}")
        })?;
        for table in [
            "agent_org_runtime_plan_revisions",
            "agent_org_runtime_recovery_attempts",
            // Handoffs retain exact old/replacement Task identities. Delete
            // the run-owned receipts before their Task rows so permanent Team
            // deletion preserves foreign-key enforcement instead of relying
            // on disabled or deferred constraints.
            "agent_org_runtime_task_execution_handoffs",
            "agent_org_runtime_task_annotations",
            "agent_org_runtime_task_events",
            "agent_org_runtime_tasks",
            "agent_org_runtime_inbox_delivery_resolutions",
            "agent_org_runtime_inbox",
            "agent_org_runtime_member_interventions",
            "agent_org_runtime_run_progress",
        ] {
            conn.execute(
                &format!("DELETE FROM {table} WHERE org_run_id=?1"),
                params![run_id],
            )
            .map_err(|err| format!("failed to delete {table} rows for {run_id}: {err}"))?;
        }
        let deleted = conn
            .execute(
                "DELETE FROM agent_org_runtime_runs WHERE id=?1",
                params![run_id],
            )
            .map_err(|err| err.to_string())?
            > 0;
        Ok(AgentOrgRunDeleteOutcome {
            plan_artifacts,
            deleted,
        })
    }

    pub(crate) fn finish_delete(run_id: &str, outcome: AgentOrgRunDeleteOutcome) {
        // SQLite is the source of truth. Files are derived artifacts, so they
        // are cleaned only after the transaction commits and failures are
        // logged without resurrecting already-deleted durable state.
        for (source_session_id, plan_path) in outcome.plan_artifacts {
            if let Err(err) = AgentOrgPlanRevisionStore::remove_managed_plan_artifact(
                &source_session_id,
                &plan_path,
            ) {
                tracing::warn!(
                    run_id,
                    source_session_id,
                    plan_path,
                    error = %err,
                    "failed to remove managed Agent Org plan artifact after run deletion"
                );
            }
        }
        if outcome.deleted {
            crate::coordination::agent_org_run_events::notify_agent_org_run_changed(run_id);
        }
    }
}

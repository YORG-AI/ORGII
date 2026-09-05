//! Exact Task-bound Inbox, materialization, trigger, and lease settlement.

use rusqlite::{params, OptionalExtension};

use super::*;
use crate::coordination::agent_org_tasks::{Task, TaskActorAudit, TaskStatus};

/// Settle only Inbox rows durably bound to one Task. The source rows remain
/// immutable history; the append-only resolution makes them non-blocking and
/// the materialization deletion prevents a later drain from replaying them.
pub(crate) fn settle_task_bound_deliveries_in_tx(
    conn: &Connection,
    previous: &Task,
    current: &Task,
    audit: &TaskActorAudit,
    replacement_task_id: Option<&str>,
) -> Result<usize, String> {
    let terminal = current.status.is_terminal();
    let owner_changed = previous.owner != current.owner;
    if !terminal && !owner_changed {
        return Ok(0);
    }
    let reason = if current.status == TaskStatus::Completed {
        "task_completed"
    } else if current.status == TaskStatus::Failed {
        "task_failed"
    } else if replacement_task_id.is_some() {
        "task_replaced"
    } else if current.status == TaskStatus::Cancelled {
        "task_cancelled"
    } else {
        "owner_changed"
    };
    let resolution_kind = if replacement_task_id.is_some() {
        "superseded"
    } else {
        "cancelled"
    };
    let now = chrono::Utc::now().to_rfc3339();
    let mut statement = conn
        .prepare(
            "SELECT DISTINCT inbox.id
             FROM agent_org_runtime_inbox inbox
             LEFT JOIN agent_org_runtime_inbox_task_bindings binding
               ON binding.inbox_id=inbox.id
             LEFT JOIN agent_org_runtime_formal_trigger_receipts trigger
               ON trigger.inbox_id=inbox.id
             WHERE inbox.org_run_id=?1
               AND inbox.delivery_class='formal_work'
               AND inbox.read_at IS NULL
               AND NOT EXISTS (
                   SELECT 1 FROM agent_org_runtime_inbox_delivery_resolutions existing
                   WHERE existing.inbox_id=inbox.id
               )
               AND (
                   binding.task_id=?2
                   OR trigger.task_id=?2
                   OR (
                       inbox.payload_kind='task_assigned'
                       AND json_valid(inbox.payload_json)
                       AND json_extract(inbox.payload_json,'$.task_id')=?2
                   )
                   OR (
                       inbox.payload_kind='plan_approval_response'
                       AND json_valid(inbox.payload_json)
                       AND EXISTS (
                           SELECT 1
                           FROM agent_org_runtime_plan_decisions decision
                           JOIN agent_org_runtime_plan_revisions revision
                             ON revision.plan_revision_id=decision.plan_revision_id
                           WHERE revision.org_run_id=?1
                             AND revision.source_task_id=?2
                             AND decision.request_id=json_extract(
                                 inbox.payload_json,'$.request_id'
                             )
                       )
                   )
               )
             ORDER BY inbox.id",
        )
        .map_err(|error| error.to_string())?;
    let inbox_ids = statement
        .query_map(params![&previous.org_run_id, &previous.id], |row| {
            row.get::<_, i64>(0)
        })
        .map_err(|error| error.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())?;
    drop(statement);

    let mut inserted = 0usize;
    for inbox_id in &inbox_ids {
        inserted = inserted.saturating_add(
            conn.execute(
                "INSERT OR IGNORE INTO agent_org_runtime_inbox_delivery_resolutions (
                    inbox_id,org_run_id,resolution_kind,resolved_by_member_id,reason,
                    replacement_inbox_id,replacement_task_id,created_at
                 ) VALUES (?1,?2,?3,?4,?5,NULL,?6,?7)",
                params![
                    inbox_id,
                    &previous.org_run_id,
                    resolution_kind,
                    &audit.participant_id,
                    reason,
                    replacement_task_id,
                    &now,
                ],
            )
            .map_err(|error| error.to_string())?,
        );
    }
    if !inbox_ids.is_empty() {
        for inbox_id in &inbox_ids {
            conn.execute(
                "DELETE FROM agent_org_runtime_inbox_materializations WHERE inbox_id=?1",
                [inbox_id],
            )
            .map_err(|error| error.to_string())?;
            conn.execute(
                "UPDATE agent_org_runtime_formal_trigger_attempts
                 SET status='resolved',terminal_at=COALESCE(terminal_at,?2),updated_at=?2
                 WHERE receipt_id IN (
                     SELECT receipt_id FROM agent_org_runtime_formal_trigger_receipts
                     WHERE inbox_id=?1
                 ) AND status IN ('queued','running')",
                params![inbox_id, &now],
            )
            .map_err(|error| error.to_string())?;
            conn.execute(
                "UPDATE agent_org_runtime_formal_trigger_receipts
                 SET status='resolved',doorbell_status='suppressed',
                     resolved_at=COALESCE(resolved_at,?2),updated_at=?2
                 WHERE inbox_id=?1 AND status IN ('pending','materialized')",
                params![inbox_id, &now],
            )
            .map_err(|error| error.to_string())?;
        }
    }

    if terminal || owner_changed {
        super::execution_authority::release_task_leases_in_tx(
            conn,
            &previous.org_run_id,
            &previous.id,
            if current.status == TaskStatus::Cancelled {
                "frozen"
            } else {
                "released"
            },
            reason,
        )?;
    }
    if let Some(scope_reason) = current.cancel_reason.as_ref().filter(|reason| {
        matches!(
            reason.code.as_str(),
            "user_scope_removed" | "dependency_scope_removed"
        )
    }) {
        if let Some(root_receipt_id) = scope_reason.source_event_id.as_deref() {
            let root_task_id: Option<String> = conn
                .query_row(
                    "SELECT target_task_id FROM agent_org_scope_removal_receipts
                     WHERE receipt_id=?1 AND org_run_id=?2 AND status='recorded'",
                    params![root_receipt_id, &current.org_run_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| error.to_string())?;
            if root_task_id
                .as_deref()
                .is_some_and(|root| root != current.id)
            {
                record_scope_resolution_in_tx(
                    conn,
                    &current.org_run_id,
                    &current.id,
                    root_receipt_id,
                    if replacement_task_id.is_some() {
                        "dependency_replaced"
                    } else {
                        "dependency_cancelled"
                    },
                    replacement_task_id,
                    audit.turn_intent_id.as_deref(),
                )?;
            }
        }
    }
    Ok(inserted)
}

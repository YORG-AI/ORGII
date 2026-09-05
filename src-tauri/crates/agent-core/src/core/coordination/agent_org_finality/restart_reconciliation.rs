//! Idempotent startup repair for historical finality and delivery state.

use rusqlite::params;

use super::*;

fn settle_historical_inbox_in_tx(
    conn: &Connection,
    inbox_id: i64,
    org_run_id: &str,
    reason: &str,
    now: &str,
) -> Result<usize, String> {
    let mut changed = conn
        .execute(
            "INSERT OR IGNORE INTO agent_org_runtime_inbox_delivery_resolutions (
                inbox_id,org_run_id,resolution_kind,resolved_by_member_id,reason,
                replacement_inbox_id,replacement_task_id,created_at
             ) VALUES (?1,?2,'cancelled','system:startup_repair',?3,NULL,NULL,?4)",
            params![inbox_id, org_run_id, reason, now],
        )
        .map_err(|error| error.to_string())?;
    changed = changed.saturating_add(
        conn.execute(
            "DELETE FROM agent_org_runtime_inbox_materializations WHERE inbox_id=?1",
            [inbox_id],
        )
        .map_err(|error| error.to_string())?,
    );
    changed = changed.saturating_add(
        conn.execute(
            "UPDATE agent_org_runtime_formal_trigger_attempts
             SET status='resolved',terminal_at=COALESCE(terminal_at,?2),updated_at=?2
             WHERE receipt_id IN (
                 SELECT receipt_id FROM agent_org_runtime_formal_trigger_receipts
                 WHERE inbox_id=?1
             ) AND status IN ('queued','running')",
            params![inbox_id, now],
        )
        .map_err(|error| error.to_string())?,
    );
    changed = changed.saturating_add(
        conn.execute(
            "UPDATE agent_org_runtime_formal_trigger_receipts
             SET status='resolved',doorbell_status='suppressed',
                 resolved_at=COALESCE(resolved_at,?2),updated_at=?2
             WHERE inbox_id=?1 AND status IN ('pending','materialized')",
            params![inbox_id, now],
        )
        .map_err(|error| error.to_string())?,
    );
    Ok(changed)
}

/// One-shot startup repair for state written before the finality companion
/// schema existed, plus leases/rechecks left by the process that disappeared.
/// Every delivery repair is still selected by an exact durable Task binding.
pub(crate) fn reconcile_after_restart(conn: &Connection) -> Result<usize, String> {
    let now = chrono::Utc::now().to_rfc3339();
    let mut changed = conn
        .execute(
            "UPDATE agent_org_task_execution_leases
             SET state='frozen',terminal_reason_code='app_restart',terminal_at=?1
             WHERE state='active'",
            [&now],
        )
        .map_err(|error| error.to_string())?;

    let duplicate_source_deliveries = {
        let mut statement = conn
            .prepare(
                "SELECT DISTINCT inbox.id,context.org_run_id
                 FROM agent_org_runtime_turn_contexts context
                 JOIN session_turn_intents intent
                   ON intent.session_id=context.session_id
                  AND intent.turn_intent_id=context.turn_intent_id
                 JOIN agent_org_runtime_inbox_materializations materialization
                   ON materialization.session_id=context.session_id
                  AND materialization.transcript_intent_id=context.turn_intent_id
                 JOIN agent_org_runtime_inbox inbox
                   ON inbox.id=materialization.inbox_id
                  AND inbox.org_run_id=context.org_run_id
                 JOIN agent_org_task_execution_reconciliations reconciliation
                   ON reconciliation.context_id=context.context_id
                  AND reconciliation.reason_code='duplicate_execution_rejected'
                 WHERE context.turn_kind='task_execution'
                   AND intent.status IN (
                       'completed','failed','cancelled','stale','coalesced','rejected'
                   )
                   AND NOT EXISTS (
                       SELECT 1 FROM agent_org_runtime_inbox_delivery_resolutions resolution
                       WHERE resolution.inbox_id=inbox.id
                   )
                 UNION
                 SELECT DISTINCT inbox.id,context.org_run_id
                 FROM agent_org_runtime_turn_contexts context
                 JOIN session_turn_intents intent
                   ON intent.session_id=context.session_id
                  AND intent.turn_intent_id=context.turn_intent_id
                 JOIN agent_org_runtime_formal_trigger_attempts attempt
                   ON attempt.session_id=context.session_id
                  AND attempt.turn_intent_id=context.turn_intent_id
                 JOIN agent_org_runtime_formal_trigger_receipts trigger
                   ON trigger.receipt_id=attempt.receipt_id
                 JOIN agent_org_runtime_inbox inbox
                   ON inbox.id=trigger.inbox_id
                  AND inbox.org_run_id=context.org_run_id
                 JOIN agent_org_task_execution_reconciliations reconciliation
                   ON reconciliation.context_id=context.context_id
                  AND reconciliation.reason_code='duplicate_execution_rejected'
                 WHERE context.turn_kind='task_execution'
                   AND intent.status IN (
                       'completed','failed','cancelled','stale','coalesced','rejected'
                   )
                   AND NOT EXISTS (
                       SELECT 1 FROM agent_org_runtime_inbox_delivery_resolutions resolution
                       WHERE resolution.inbox_id=inbox.id
                   )",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| error.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| error.to_string())?;
        rows
    };
    for (inbox_id, org_run_id) in duplicate_source_deliveries {
        changed = changed.saturating_add(settle_historical_inbox_in_tx(
            conn,
            inbox_id,
            &org_run_id,
            "duplicate_execution_rejected",
            &now,
        )?);
    }

    let terminal_deliveries = {
        let mut statement = conn
            .prepare(
                "SELECT DISTINCT inbox.id,inbox.org_run_id
                 FROM agent_org_runtime_inbox inbox
                 JOIN agent_org_runtime_tasks task ON task.org_run_id=inbox.org_run_id
                 LEFT JOIN agent_org_runtime_inbox_task_bindings binding
                   ON binding.inbox_id=inbox.id AND binding.task_id=task.id
                 LEFT JOIN agent_org_runtime_formal_trigger_receipts trigger
                   ON trigger.inbox_id=inbox.id AND trigger.task_id=task.id
                 WHERE task.status IN ('completed','failed','cancelled')
                   AND inbox.delivery_class='formal_work'
                   AND inbox.read_at IS NULL
                   AND NOT EXISTS (
                       SELECT 1 FROM agent_org_runtime_inbox_delivery_resolutions resolution
                       WHERE resolution.inbox_id=inbox.id
                   )
                   AND (
                       binding.task_id IS NOT NULL
                       OR trigger.task_id IS NOT NULL
                       OR (
                           inbox.payload_kind='task_assigned'
                           AND json_valid(inbox.payload_json)
                           AND json_extract(inbox.payload_json,'$.task_id')=task.id
                       )
                       OR (
                           inbox.payload_kind='plan_approval_response'
                           AND json_valid(inbox.payload_json)
                           AND EXISTS (
                               SELECT 1
                               FROM agent_org_runtime_plan_decisions decision
                               JOIN agent_org_runtime_plan_revisions revision
                                 ON revision.plan_revision_id=decision.plan_revision_id
                               WHERE revision.org_run_id=inbox.org_run_id
                                 AND revision.source_task_id=task.id
                                 AND decision.request_id=json_extract(
                                     inbox.payload_json,'$.request_id'
                                 )
                           )
                       )
                   )",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| error.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| error.to_string())?;
        rows
    };
    for (inbox_id, org_run_id) in terminal_deliveries {
        changed = changed.saturating_add(settle_historical_inbox_in_tx(
            conn,
            inbox_id,
            &org_run_id,
            "historical_task_terminal",
            &now,
        )?);
    }

    let interrupted_rechecks = {
        let mut statement = conn
            .prepare(
                "SELECT recheck.source_session_id,recheck.source_turn_intent_id,
                        intent.status
                 FROM agent_org_coordinator_completion_rechecks recheck
                 JOIN session_turn_intents intent
                   ON intent.session_id=recheck.source_session_id
                  AND intent.turn_intent_id=recheck.source_turn_intent_id
                 WHERE recheck.status='pending'
                   AND intent.status NOT IN ('optimistic','queued','running')",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|error| error.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| error.to_string())?;
        rows
    };
    for (session_id, turn_intent_id, status) in interrupted_rechecks {
        changed = changed.saturating_add(
            super::coordinator_recheck::materialize_coordinator_recheck_in_tx(
                conn,
                &session_id,
                &turn_intent_id,
                status == "completed",
            )?
            .len(),
        );
    }
    Ok(changed)
}

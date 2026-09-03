//! Bounded startup reconciliation for durable user-directed work.

use rusqlite::params;

use database::db::{get_connection, with_sessions_writer};

use super::RecoverableUserDirectedDispatch;

/// On process restart, a delivery that had already crossed the durable
/// `started` boundary is never replayed. Its file/provider/external effects
/// may have happened even if no terminal receipt was written, so surface an
/// explicit unknown outcome and leave recovery to the user.
#[cfg(test)]
pub(crate) fn mark_started_unknown_after_restart() -> Result<usize, String> {
    let mut changed = 0usize;
    let mut after_key: Option<String> = None;
    loop {
        let page = mark_started_unknown_after_restart_after(after_key.as_deref(), 100)?;
        if page.is_empty() {
            break;
        }
        changed = changed.saturating_add(page.len());
        after_key = page.last().cloned();
        if page.len() < 100 {
            break;
        }
    }
    Ok(changed)
}

/// Classify one bounded keyset page of pre-restart started work. The startup
/// owner yields between pages; no transaction scans or rewrites the full UDW
/// history, and only rows that still hold the exact `started` state change.
pub(crate) fn mark_started_unknown_after_restart_after(
    after_key: Option<&str>,
    limit: usize,
) -> Result<Vec<String>, String> {
    with_sessions_writer(|| {
        let mut conn = get_connection().map_err(|error| error.to_string())?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;
        let now = chrono::Utc::now().to_rfc3339();
        let reason = "app_restarted_after_user_directed_work_started";
        let interrupted = {
            let mut statement = tx
                .prepare(
                    "WITH interrupted AS (
                         SELECT 'm:' || printf('%020d',delivery_id) AS recovery_key,
                                'member' AS recovery_kind,delivery_id AS row_id,
                                org_run_id,session_id,turn_intent_id
                         FROM agent_org_runtime_user_directed_deliveries
                         WHERE status='started'
                         UNION ALL
                         SELECT 'c:' || printf('%020d',binding_id) AS recovery_key,
                                'coordinator' AS recovery_kind,binding_id AS row_id,
                                org_run_id,session_id,turn_intent_id
                         FROM agent_org_runtime_user_directed_coordinator_bindings
                         WHERE status='started'
                     )
                     SELECT recovery_key,recovery_kind,row_id,org_run_id,
                            session_id,turn_intent_id
                     FROM interrupted
                     WHERE recovery_key>COALESCE(?1,'')
                     ORDER BY recovery_key
                     LIMIT ?2",
                )
                .map_err(|error| error.to_string())?;
            let rows = statement
                .query_map(params![after_key, limit.clamp(1, 100) as i64], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                    ))
                })
                .map_err(|error| error.to_string())?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|error| error.to_string())?
        };
        let mut changed_keys = Vec::with_capacity(interrupted.len());
        let mut run_ids = std::collections::HashSet::new();
        for (recovery_key, recovery_kind, row_id, org_run_id, session_id, turn_intent_id) in
            interrupted
        {
            let changed = if recovery_kind == "member" {
                tx.execute(
                    "UPDATE agent_org_runtime_member_intervention_turns
                     SET status='abandoned',terminal_at=?3,failure_reason=?4
                     WHERE session_id=?1 AND turn_intent_id=?2 AND status='running'",
                    params![&session_id, &turn_intent_id, &now, reason],
                )
                .map_err(|error| error.to_string())?;
                tx.execute(
                    "UPDATE agent_org_runtime_user_directed_deliveries
                     SET status='unknown',terminal_at=?2,failure_reason=?3
                     WHERE delivery_id=?1 AND status='started'",
                    params![row_id, &now, reason],
                )
                .map_err(|error| error.to_string())?
            } else {
                tx.execute(
                    "UPDATE agent_org_runtime_user_directed_coordinator_bindings
                     SET status='unknown',terminal_at=?2,failure_reason=?3
                     WHERE binding_id=?1 AND status='started'",
                    params![row_id, &now, reason],
                )
                .map_err(|error| error.to_string())?
            };
            if changed == 1 {
                tx.execute(
                    "UPDATE session_turn_intents
                     SET status='failed',updated_at=?3
                     WHERE session_id=?1 AND turn_intent_id=?2 AND status='running'",
                    params![&session_id, &turn_intent_id, &now],
                )
                .map_err(|error| error.to_string())?;
                changed_keys.push(recovery_key);
                run_ids.insert(org_run_id);
            }
        }
        tx.commit().map_err(|error| error.to_string())?;
        for run_id in run_ids {
            crate::coordination::agent_org_run_events::notify_agent_org_run_changed(&run_id);
        }
        Ok(changed_keys)
    })
}

/// Read one bounded keyset page of never-started linked/group UDW. Direct
/// Member work keeps its event-backed recovery path because it must restore
/// the intervention chain as well as the neutral delivery receipt.
pub(crate) fn recoverable_pending_after(
    after_key: Option<&str>,
    limit: usize,
) -> Result<Vec<RecoverableUserDirectedDispatch>, String> {
    let conn = get_connection().map_err(|error| error.to_string())?;
    let mut statement = conn
        .prepare(
            "WITH recoverable AS (
                 SELECT 'm:' || printf('%020d',delivery.delivery_id) AS recovery_key,
                        delivery.org_run_id,delivery.dispatch_member_id,
                        delivery.session_id,delivery.turn_intent_id,
                        delivery.dispatch_content,delivery.display_content,delivery.images_json
                 FROM agent_org_runtime_user_directed_deliveries delivery
                 JOIN agent_org_runtime_turn_contexts context
                   ON context.session_id=delivery.session_id
                  AND context.turn_intent_id=delivery.turn_intent_id
                 JOIN session_turn_intents intent
                   ON intent.session_id=delivery.session_id
                  AND intent.turn_intent_id=delivery.turn_intent_id
                 JOIN agent_org_runtime_runs run ON run.id=delivery.org_run_id
                 JOIN agent_org_runtime_inbox inbox ON inbox.id=delivery.source_inbox_id
                 WHERE delivery.status='pending'
                   AND delivery.source_kind IN ('group_mention','member_inbox')
                   AND context.turn_kind='user_directed_work'
                   AND intent.status='queued'
                   AND run.status IN ('running','idle','paused')
                   AND inbox.delivery_class='user_directed'
                 UNION ALL
                 SELECT 'c:' || printf('%020d',binding.binding_id) AS recovery_key,
                        binding.org_run_id,'coordinator',binding.session_id,
                        binding.turn_intent_id,binding.dispatch_content,
                        binding.display_content,'[]'
                 FROM agent_org_runtime_user_directed_coordinator_bindings binding
                 JOIN agent_org_runtime_turn_contexts context
                   ON context.session_id=binding.session_id
                  AND context.turn_intent_id=binding.turn_intent_id
                 JOIN session_turn_intents intent
                   ON intent.session_id=binding.session_id
                  AND intent.turn_intent_id=binding.turn_intent_id
                 JOIN agent_org_runtime_runs run ON run.id=binding.org_run_id
                 JOIN agent_org_runtime_inbox inbox ON inbox.id=binding.source_inbox_id
                 WHERE binding.status='pending'
                   AND context.turn_kind='coordinator'
                   AND context.source_kind='member_inbox'
                   AND intent.status='queued'
                   AND run.status IN ('running','idle','paused')
                   AND inbox.delivery_class='user_directed'
             )
             SELECT recovery_key,org_run_id,dispatch_member_id,session_id,
                    turn_intent_id,dispatch_content,display_content,images_json
             FROM recoverable
             WHERE recovery_key>COALESCE(?1,'')
             ORDER BY recovery_key
             LIMIT ?2",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![after_key, limit.clamp(1, 100) as i64], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut recovered = Vec::new();
    for row in rows {
        let (
            recovery_key,
            org_run_id,
            recipient_member_id,
            recipient_session_id,
            turn_intent_id,
            content,
            display_text,
            images_json,
        ) = row.map_err(|error| error.to_string())?;
        let images: Vec<String> =
            serde_json::from_str(&images_json).map_err(|error| error.to_string())?;
        recovered.push(RecoverableUserDirectedDispatch {
            recovery_key,
            org_run_id,
            recipient_member_id,
            recipient_session_id,
            turn_intent_id,
            content,
            display_text,
            images: (!images.is_empty()).then_some(images),
        });
    }
    Ok(recovered)
}

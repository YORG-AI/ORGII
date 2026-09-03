use rusqlite::{params, Connection, OptionalExtension};

const MAX_RECEIPTS_PER_TURN: usize = 32;
const MAX_MATERIALIZED_BYTES_PER_TURN: usize = 128 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FormalTriggerBatch {
    pub receipt_ids: Vec<String>,
    pub inbox_ids: Vec<i64>,
    pub materialized_input_id: String,
    pub has_more: bool,
}

pub(crate) fn claim_for_coordinator_turn(
    org_run_id: &str,
    session_id: &str,
    turn_intent_id: &str,
) -> Result<Option<FormalTriggerBatch>, String> {
    database::db::with_sessions_writer(|| {
        let mut conn = database::db::get_connection().map_err(|error| error.to_string())?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;
        let context =
            crate::coordination::agent_org_turn_contexts::revalidate_context_with_connection(
                &tx,
                session_id,
                turn_intent_id,
            )?;
        if context.org_run_id != org_run_id
            || context.turn_kind
                != crate::coordination::agent_org_turn_contexts::AgentOrgTurnKind::Coordinator
        {
            return Err(
                "FormalTriggerReceipt claim requires exact Coordinator Turn authority".to_string(),
            );
        }

        // A restarted or response-loss Turn must replay the exact receipt set
        // it already materialized. Later facts stay pending for a follow-up
        // Turn; adding them here would change the stable provider input.
        let active_rows = {
            let mut stmt = tx
                .prepare(
                    "SELECT receipt.receipt_id,receipt.inbox_id,
                            attempt.materialized_input_id
                     FROM agent_org_runtime_formal_trigger_attempts attempt
                     JOIN agent_org_runtime_formal_trigger_receipts receipt
                       ON receipt.receipt_id=attempt.receipt_id
                     JOIN agent_org_runtime_inbox inbox ON inbox.id=receipt.inbox_id
                     WHERE attempt.session_id=?1 AND attempt.turn_intent_id=?2
                       AND attempt.status IN ('queued','running')
                       AND receipt.org_run_id=?3 AND receipt.status='materialized'
                       AND inbox.read_at IS NULL
                     ORDER BY receipt.created_at,receipt.inbox_id,receipt.receipt_id",
                )
                .map_err(|error| error.to_string())?;
            let rows = stmt
                .query_map(params![session_id, turn_intent_id, org_run_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .map_err(|error| error.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?;
            rows
        };
        if let Some(first) = active_rows.first() {
            if active_rows
                .iter()
                .any(|row| row.2.as_str() != first.2.as_str())
            {
                return Err("FormalTriggerReceipt active batch identity conflict".to_string());
            }
            let now = chrono::Utc::now().to_rfc3339();
            tx.execute(
                "UPDATE agent_org_runtime_formal_trigger_attempts
                 SET status='running',started_at=COALESCE(started_at,?3),updated_at=?3
                 WHERE session_id=?1 AND turn_intent_id=?2 AND status='queued'",
                params![session_id, turn_intent_id, &now],
            )
            .map_err(|error| error.to_string())?;
            let has_more: bool = tx
                .query_row(
                    "SELECT EXISTS(
                         SELECT 1 FROM agent_org_runtime_formal_trigger_receipts receipt
                         WHERE receipt.org_run_id=?1 AND receipt.status='pending'
                           AND receipt.doorbell_status IN ('missing','delivered')
                     )",
                    [org_run_id],
                    |row| row.get(0),
                )
                .map_err(|error| error.to_string())?;
            let batch = FormalTriggerBatch {
                receipt_ids: active_rows.iter().map(|row| row.0.clone()).collect(),
                inbox_ids: active_rows.iter().map(|row| row.1).collect(),
                materialized_input_id: first.2.clone(),
                has_more,
            };
            tx.commit().map_err(|error| error.to_string())?;
            return Ok(Some(batch));
        }

        let mut stmt = tx
            .prepare(
                "SELECT receipt.receipt_id,receipt.inbox_id,
                        length(CAST(inbox.payload_json AS BLOB)),
                        attempt.attempt,attempt.session_id,attempt.turn_intent_id,
                        attempt.materialized_input_id
                 FROM agent_org_runtime_formal_trigger_receipts receipt
                 JOIN agent_org_runtime_inbox inbox ON inbox.id=receipt.inbox_id
                 LEFT JOIN agent_org_runtime_formal_trigger_attempts attempt
                   ON attempt.receipt_id=receipt.receipt_id
                  AND attempt.status IN ('queued','running')
                 WHERE receipt.org_run_id=?1 AND receipt.status IN ('pending','materialized')
                   AND receipt.doorbell_status IN ('missing','delivered')
                   AND inbox.read_at IS NULL
                   AND NOT EXISTS (
                       SELECT 1 FROM agent_org_runtime_inbox_delivery_resolutions resolution
                       WHERE resolution.inbox_id=inbox.id
                   )
                   AND attempt.receipt_id IS NULL
                 ORDER BY receipt.created_at,receipt.inbox_id,receipt.receipt_id
                 LIMIT ?2",
            )
            .map_err(|error| error.to_string())?;
        let rows = stmt
            .query_map(
                params![org_run_id, (MAX_RECEIPTS_PER_TURN + 1) as i64],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, Option<i64>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, Option<String>>(6)?,
                    ))
                },
            )
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        drop(stmt);

        let mut selected = Vec::new();
        let mut bytes = 0usize;
        let mut has_more = false;
        for row in rows {
            if selected.len() == MAX_RECEIPTS_PER_TURN {
                has_more = true;
                break;
            }
            let row_bytes = usize::try_from(row.2).unwrap_or(usize::MAX);
            if !selected.is_empty()
                && bytes.saturating_add(row_bytes) > MAX_MATERIALIZED_BYTES_PER_TURN
            {
                has_more = true;
                break;
            }
            bytes = bytes.saturating_add(row_bytes);
            selected.push(row);
        }
        if selected.is_empty() {
            tx.commit().map_err(|error| error.to_string())?;
            return Ok(None);
        }

        let receipt_ids = selected.iter().map(|row| row.0.clone()).collect::<Vec<_>>();
        let inbox_ids = selected.iter().map(|row| row.1).collect::<Vec<_>>();
        let materialized_input_id = stable_input_id(org_run_id, &receipt_ids);
        let now = chrono::Utc::now().to_rfc3339();
        for (receipt_id, _, _, active_attempt, active_session, active_turn, active_input) in
            &selected
        {
            if let Some(attempt) = active_attempt {
                if active_session.as_deref() != Some(session_id)
                    || active_turn.as_deref() != Some(turn_intent_id)
                    || active_input.as_deref() != Some(materialized_input_id.as_str())
                {
                    return Err(format!(
                        "FormalTriggerReceipt {receipt_id} has a conflicting active attempt {attempt}"
                    ));
                }
                continue;
            }
            let attempt: i64 = tx
                .query_row(
                    "SELECT current_attempt + 1
                     FROM agent_org_runtime_formal_trigger_receipts WHERE receipt_id=?1",
                    [receipt_id],
                    |row| row.get(0),
                )
                .map_err(|error| error.to_string())?;
            tx.execute(
                "INSERT INTO agent_org_runtime_formal_trigger_attempts (
                     receipt_id,attempt,session_id,turn_intent_id,status,
                     materialized_input_id,materialized_event_id,typed_error,
                     queued_at,started_at,terminal_at,updated_at
                 ) VALUES (?1,?2,?3,?4,'running',?5,NULL,NULL,?6,?6,NULL,?6)",
                params![
                    receipt_id,
                    attempt,
                    session_id,
                    turn_intent_id,
                    &materialized_input_id,
                    &now
                ],
            )
            .map_err(|error| error.to_string())?;
            tx.execute(
                "UPDATE agent_org_runtime_formal_trigger_receipts
                 SET current_attempt=?2,status='materialized',
                     materialized_input_id=?3,updated_at=?4
                 WHERE receipt_id=?1 AND status='pending'",
                params![receipt_id, attempt, &materialized_input_id, &now],
            )
            .map_err(|error| error.to_string())?;
        }
        tx.commit().map_err(|error| error.to_string())?;
        tracing::debug!(
            org_run_id,
            session_id,
            turn_intent_id,
            receipt_count = receipt_ids.len(),
            inbox_count = inbox_ids.len(),
            materialized_bytes = bytes,
            has_more,
            "[agent_org_metric] formal_trigger_materialized"
        );
        Ok(Some(FormalTriggerBatch {
            receipt_ids,
            inbox_ids,
            materialized_input_id,
            has_more,
        }))
    })
}

pub(crate) fn resolve_inbox_receipts_in_tx(
    tx: &Connection,
    inbox_ids: &[i64],
    session_id: &str,
    turn_intent_id: &str,
    materialized_event_id: Option<&str>,
) -> Result<usize, String> {
    if inbox_ids.is_empty() {
        return Ok(0);
    }
    let now = chrono::Utc::now().to_rfc3339();
    let mut resolved = 0usize;
    for inbox_id in inbox_ids {
        let active: Option<(String, i64)> = tx
            .query_row(
                "SELECT receipt.receipt_id,attempt.attempt
                 FROM agent_org_runtime_formal_trigger_receipts receipt
                 JOIN agent_org_runtime_formal_trigger_attempts attempt
                   ON attempt.receipt_id=receipt.receipt_id
                  AND attempt.attempt=receipt.current_attempt
                 WHERE receipt.inbox_id=?1
                   AND attempt.session_id=?2 AND attempt.turn_intent_id=?3
                   AND attempt.status IN ('queued','running')",
                params![inbox_id, session_id, turn_intent_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let Some((receipt_id, attempt)) = active else {
            continue;
        };
        tx.execute(
            "UPDATE agent_org_runtime_formal_trigger_attempts
             SET status='resolved',materialized_event_id=?4,terminal_at=?5,updated_at=?5
             WHERE receipt_id=?1 AND attempt=?2
               AND session_id=?3 AND turn_intent_id=?6
               AND status IN ('queued','running')",
            params![
                &receipt_id,
                attempt,
                session_id,
                materialized_event_id,
                &now,
                turn_intent_id
            ],
        )
        .map_err(|error| error.to_string())?;
        let changed = tx
            .execute(
                "UPDATE agent_org_runtime_formal_trigger_receipts
                 SET status='resolved',materialized_event_id=?2,resolved_at=?3,updated_at=?3
                 WHERE receipt_id=?1 AND current_attempt=?4
                   AND status='materialized'",
                params![&receipt_id, materialized_event_id, &now, attempt],
            )
            .map_err(|error| error.to_string())?;
        resolved = resolved.saturating_add(changed);
    }
    Ok(resolved)
}

/// End a known-failed Coordinator attempt without consuming its facts.
///
/// Provider errors, Stop, and transcript/EventStore failures are different
/// from an unknown crash: the current Turn is known not to have observed the
/// batch successfully. Its attempt becomes terminal while each exact receipt
/// returns to Pending with a missing doorbell for event-owned recovery.
pub(crate) fn fail_attempt_for_turn(
    session_id: &str,
    turn_intent_id: &str,
    typed_error: &str,
) -> Result<usize, String> {
    let typed_error = typed_error.trim();
    if typed_error.is_empty() {
        return Err("FormalTriggerReceipt failure requires typed_error".to_string());
    }
    database::db::with_sessions_writer(|| {
        let conn = database::db::get_connection().map_err(|error| error.to_string())?;
        let tx = database::db::begin_immediate(&conn).map_err(|error| error.to_string())?;
        let now = chrono::Utc::now().to_rfc3339();
        let changed = tx
            .execute(
                "UPDATE agent_org_runtime_formal_trigger_attempts
                 SET status='failed',typed_error=?3,terminal_at=?4,updated_at=?4
                 WHERE session_id=?1 AND turn_intent_id=?2
                   AND status IN ('queued','running')",
                params![session_id, turn_intent_id, typed_error, &now],
            )
            .map_err(|error| error.to_string())?;
        if changed > 0 {
            tx.execute(
                "UPDATE agent_org_runtime_formal_trigger_receipts
                 SET status='pending',doorbell_status='missing',
                     doorbell_delivered_at=NULL,materialized_event_id=NULL,
                     resolved_at=NULL,updated_at=?3
                 WHERE receipt_id IN (
                     SELECT receipt_id
                     FROM agent_org_runtime_formal_trigger_attempts
                     WHERE session_id=?1 AND turn_intent_id=?2
                       AND status='failed' AND terminal_at=?3
                 ) AND status='materialized'",
                params![session_id, turn_intent_id, &now],
            )
            .map_err(|error| error.to_string())?;
        }
        tx.commit().map_err(|error| error.to_string())?;
        Ok(changed)
    })
}

fn stable_input_id(org_run_id: &str, receipt_ids: &[String]) -> String {
    let mut sorted = receipt_ids.to_vec();
    sorted.sort();
    let mut material = org_run_id.to_string();
    for receipt_id in sorted {
        material.push('\0');
        material.push_str(&receipt_id);
    }
    format!(
        "formal-trigger-input-{}",
        blake3::hash(material.as_bytes()).to_hex()
    )
}

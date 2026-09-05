//! Exact Coordinator revision advancement and one-shot terminal rechecks.

use rusqlite::{params, OptionalExtension};

use super::*;
use crate::coordination::agent_org_tasks::TaskActorAudit;

/// Bump the Task-board revision and advance only the exact Coordinator Turn
/// that authored this transaction. A pending recheck receipt is coalesced by
/// source Turn and materialized only after that Turn becomes terminal.
pub(crate) fn record_task_mutation_in_tx(
    conn: &Connection,
    org_run_id: &str,
    audit: &TaskActorAudit,
) -> Result<i64, String> {
    let revision = crate::coordination::agent_org_runs::bump_work_revision_in_tx(conn, org_run_id)?;
    if audit.participant_id != crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID {
        return Ok(revision);
    }
    let Some(turn_intent_id) = audit.turn_intent_id.as_deref() else {
        return Ok(revision);
    };
    let source_session_id: Option<String> = conn
        .query_row(
            "SELECT context.session_id
             FROM agent_org_runtime_turn_contexts context
             JOIN agent_org_runtime_runs run
               ON run.id=context.org_run_id
              AND run.root_session_id=context.session_id
             WHERE context.org_run_id=?1
               AND context.turn_intent_id=?2
               AND context.participant_id='coordinator'
               AND context.turn_kind='coordinator'
               AND context.source_kind IN ('root_turn','group_root')
               AND context.activation_generation=?3",
            params![org_run_id, turn_intent_id, audit.activation_generation],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some(source_session_id) = source_session_id else {
        return Ok(revision);
    };
    let updated = conn
        .execute(
            "UPDATE agent_org_runtime_turn_contexts
             SET coordinator_work_revision=?4
             WHERE org_run_id=?1 AND session_id=?2 AND turn_intent_id=?3
               AND turn_kind='coordinator'
               AND source_kind IN ('root_turn','group_root')",
            params![org_run_id, &source_session_id, turn_intent_id, revision],
        )
        .map_err(|error| error.to_string())?;
    if updated != 1 {
        return Err("coordinator_task_mutation_context_conflict".to_string());
    }
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO agent_org_coordinator_completion_rechecks (
            org_run_id,source_session_id,source_turn_intent_id,
            activation_generation,work_revision,status,created_at,updated_at
         ) VALUES (?1,?2,?3,?4,?5,'pending',?6,?6)
         ON CONFLICT(org_run_id,source_session_id,source_turn_intent_id) DO UPDATE SET
            work_revision=excluded.work_revision,
            activation_generation=excluded.activation_generation,
            status=CASE
                WHEN agent_org_coordinator_completion_rechecks.status='resolved'
                THEN 'pending'
                ELSE agent_org_coordinator_completion_rechecks.status
            END,
            updated_at=excluded.updated_at",
        params![
            org_run_id,
            &source_session_id,
            turn_intent_id,
            audit.activation_generation,
            revision,
            now,
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(revision)
}

pub(crate) fn final_coordinator_revision_for_turn(
    session_id: &str,
    turn_intent_id: &str,
) -> Result<Option<(String, i64)>, String> {
    let conn = database::db::get_connection().map_err(|error| error.to_string())?;
    conn.query_row(
        "SELECT org_run_id,coordinator_work_revision
         FROM agent_org_runtime_turn_contexts
         WHERE session_id=?1 AND turn_intent_id=?2
           AND turn_kind='coordinator'
           AND source_kind IN ('root_turn','group_root')
           AND coordinator_work_revision IS NOT NULL",
        params![session_id, turn_intent_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
    .map_err(|error| error.to_string())
}

/// Terminalize the generic Turn and its Agent Org lease atomically. If this
/// was a Coordinator graph-writer Turn, materialize its single coalesced
/// completion recheck only after the terminal state is durable.
pub(crate) fn finalize_turn(
    session_id: &str,
    turn_intent_id: &str,
    success: bool,
    reason_code: &str,
) -> Result<Vec<String>, String> {
    database::db::with_sessions_writer(|| {
        let conn = database::db::get_connection().map_err(|error| error.to_string())?;
        let tx = database::db::begin_immediate(&conn).map_err(|error| error.to_string())?;
        let status = if success {
            crate::foundation::session_bridge::TurnIntentBridgeStatus::Completed
        } else {
            crate::foundation::session_bridge::TurnIntentBridgeStatus::Failed
        };
        crate::foundation::session_bridge::update_turn_intent_status_with_connection(
            &tx,
            session_id,
            turn_intent_id,
            status,
        )?;
        release_turn_lease_in_tx(&tx, session_id, turn_intent_id, "released", reason_code)?;
        let receipt_ids =
            materialize_coordinator_recheck_in_tx(&tx, session_id, turn_intent_id, success)?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok(receipt_ids)
    })
}

pub(super) fn materialize_coordinator_recheck_in_tx(
    conn: &Connection,
    session_id: &str,
    turn_intent_id: &str,
    source_succeeded: bool,
) -> Result<Vec<String>, String> {
    let pending: Option<(String, i64, i64)> = conn
        .query_row(
            "SELECT recheck.org_run_id,recheck.activation_generation,recheck.work_revision
             FROM agent_org_coordinator_completion_rechecks recheck
             JOIN agent_org_runtime_runs run ON run.id=recheck.org_run_id
             JOIN agent_org_runtime_work_episodes episode
               ON episode.org_run_id=recheck.org_run_id AND episode.status='active'
             WHERE recheck.source_session_id=?1
               AND recheck.source_turn_intent_id=?2
               AND recheck.status='pending'
               AND run.status='running'
               AND run.activation_generation=recheck.activation_generation",
            params![session_id, turn_intent_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some((org_run_id, _generation, revision)) = pending else {
        return Ok(Vec::new());
    };
    let coordinator_agent_id: String = conn
        .query_row(
            "SELECT coordinator_agent_id
             FROM agent_org_runtime_runs WHERE id=?1",
            [&org_run_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let outcome = if source_succeeded {
        "completed"
    } else {
        "failed"
    };
    let message = crate::coordination::agent_inbox::AgentMessage::Plain {
        summary: "Recheck Team completion".to_string(),
        text: format!(
            "The previous Coordinator Turn {outcome} after committing Task-board revision {revision}. Re-read the durable Task board and complete, review, or continue the active work episode."
        ),
    };
    let record =
        crate::coordination::agent_inbox::AgentInboxStore::insert_in_tx_without_formal_trigger(
            conn,
            crate::coordination::agent_inbox::InsertInboxParams {
                recipient_agent_id: coordinator_agent_id,
                recipient_member_id: Some(
                    crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID.to_string(),
                ),
                sender_agent_id: crate::coordination::agent_inbox::SYSTEM_SENDER_ID.to_string(),
                sender_member_id: None,
                org_run_id: Some(org_run_id.clone()),
                message,
            },
        )?;
    let receipt = crate::coordination::agent_org_formal_triggers::record_inbox_trigger_in_tx(
        conn,
        &org_run_id,
        record.id,
        crate::coordination::agent_org_formal_triggers::InboxFormalTriggerSource {
            source_kind: "coordinator_completion_recheck",
            task_id: None,
            owner_member_id: None,
            source_turn_intent_id: Some(turn_intent_id),
            task_output_digest: None,
            plan_revision_id: None,
            suppress_self_wake: false,
        },
    )?;
    let now = chrono::Utc::now().to_rfc3339();
    let updated = conn
        .execute(
            "UPDATE agent_org_coordinator_completion_rechecks
             SET status='materialized',inbox_id=?4,updated_at=?5
             WHERE org_run_id=?1 AND source_session_id=?2
               AND source_turn_intent_id=?3 AND status='pending'",
            params![&org_run_id, session_id, turn_intent_id, record.id, now],
        )
        .map_err(|error| error.to_string())?;
    if updated != 1 {
        return Err("coordinator_completion_recheck_materialization_conflict".to_string());
    }
    Ok(vec![receipt.receipt_id])
}

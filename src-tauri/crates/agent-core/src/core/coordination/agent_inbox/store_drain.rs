//! Drain / acknowledgement path for [`AgentInboxStore`]: unread probes,
//! bounded delivery batches, high-water-mark accounting, and the
//! materialization-ownership-aware read receipts.

use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension};

use database::db::{get_connection, with_sessions_writer};

use crate::coordination::agent_org_payload_limits as limits;

#[cfg(test)]
use super::record::AgentInboxRecord;
use super::record::{row_to_record, AgentInboxBatch};
use super::{AgentInboxStore, MAX_INBOX_DRAIN_PAYLOAD_BYTES, MAX_INBOX_DRAIN_ROWS};

fn ensure_inbox_claim_allowed(conn: &Connection, org_run_id: &str) -> Result<(), String> {
    let status: Option<String> = conn
        .query_row(
            "SELECT status FROM agent_org_runtime_runs WHERE id=?1",
            [org_run_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if status.as_deref()
        == Some(crate::coordination::agent_org_runs::AgentOrgRunStatus::Archived.as_str())
    {
        return Err(crate::coordination::agent_org_runs::mutation_blocked_error(
            org_run_id, "archived",
        ));
    }
    Ok(())
}

impl AgentInboxStore {
    /// Load the single formal Inbox input bound to one persisted
    /// `TaskExecution` context.
    ///
    /// A generic member drain is intentionally too broad for a task-bound Turn: it could
    /// acknowledge another Task's assignment or a user-directed message in
    /// the same provider Turn. Pending Tasks consume their oldest matching
    /// `TaskAssigned`; an in-progress Plan Task consumes its oldest matching
    /// changes-requested approval response; an in-progress Task may consume a
    /// Coordinator plain message only when its durable binding points at this
    /// exact Task. The Task row and binding remain authoritative, while the
    /// returned source row stays unread until the normal deferred guard
    /// commits after a successful Turn.
    pub fn list_unread_task_input_for_member(
        recipient_member_id: &str,
        org_run_id: &str,
        task_id: &str,
    ) -> Result<AgentInboxBatch, String> {
        Self::list_unread_task_input_for_turn(recipient_member_id, org_run_id, task_id, "", "")
    }

    pub fn list_unread_task_input_for_turn(
        recipient_member_id: &str,
        org_run_id: &str,
        task_id: &str,
        session_id: &str,
        turn_intent_id: &str,
    ) -> Result<AgentInboxBatch, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        ensure_inbox_claim_allowed(&conn, org_run_id)?;
        let mut stmt = conn
            .prepare(
                "SELECT inbox.id,
                        inbox.recipient_agent_id,
                        inbox.recipient_member_id,
                        inbox.sender_agent_id,
                        inbox.sender_member_id,
                        inbox.org_run_id,
                        inbox.payload_kind,
                        inbox.payload_json,
                        inbox.request_id,
                        inbox.created_at,
                        inbox.read_at
                 FROM agent_org_runtime_inbox inbox
                 JOIN agent_org_runtime_tasks task
                   ON task.org_run_id=inbox.org_run_id
                  AND task.id=?3
                  AND task.owner=?1
                 WHERE inbox.recipient_member_id=?1
                   AND inbox.org_run_id=?2
                   AND inbox.read_at IS NULL
                   AND NOT EXISTS (
                       SELECT 1 FROM agent_org_runtime_inbox_delivery_resolutions resolution
                       WHERE resolution.inbox_id=inbox.id
                   )
                   AND (
                       (task.status='pending'
                        AND inbox.payload_kind='task_assigned'
                        AND json_valid(inbox.payload_json)
                        AND json_type(inbox.payload_json,'$.task_id')='text'
                        AND json_extract(inbox.payload_json,'$.task_id')=?3)
                       OR
                       (task.status='in_progress'
                        AND inbox.payload_kind='task_assigned'
                        AND json_valid(inbox.payload_json)
                        AND json_type(inbox.payload_json,'$.task_id')='text'
                        AND json_extract(inbox.payload_json,'$.task_id')=?3)
                       OR
                       (task.status='in_progress'
                        AND task.execution_mode='plan'
                        AND inbox.payload_kind='plan_approval_response'
                        AND json_valid(inbox.payload_json)
                        AND json_type(inbox.payload_json,'$.request_id')='text'
                        AND EXISTS (
                            SELECT 1
                            FROM agent_org_runtime_plan_revisions revision
                            JOIN agent_org_runtime_plan_decisions decision
                              ON decision.plan_revision_id=revision.plan_revision_id
                            WHERE revision.org_run_id=?2
                              AND revision.source_task_id=?3
                              AND revision.source_member_id=?1
                              AND decision.status='changes_requested'
                              AND decision.request_id=json_extract(
                                  inbox.payload_json,'$.request_id'
                              )
                        ))
                   )
                 ORDER BY inbox.id ASC
                 LIMIT 2",
            )
            .map_err(|err| err.to_string())?;
        let mut rows = stmt
            .query_map(
                params![recipient_member_id, org_run_id, task_id],
                row_to_record,
            )
            .map_err(|err| err.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())?;
        let task_is_pending = task_status_is_pending(&conn, org_run_id, task_id)?;
        if !task_is_pending {
            if let Some((inbox_id, _bound_task_id)) =
                super::oldest_unread_task_message_binding_with_connection(
                    &conn,
                    org_run_id,
                    recipient_member_id,
                    Some(task_id),
                )?
            {
                let reply = conn
                    .query_row(
                        "SELECT id,
                                recipient_agent_id,
                                recipient_member_id,
                                sender_agent_id,
                                sender_member_id,
                                org_run_id,
                                payload_kind,
                                payload_json,
                                request_id,
                                created_at,
                                read_at
                         FROM agent_org_runtime_inbox
                         WHERE id=?1 AND org_run_id=?2",
                        params![inbox_id, org_run_id],
                        row_to_record,
                    )
                    .map_err(|err| err.to_string())?;
                if rows.iter().all(|row| row.id != reply.id) {
                    rows.push(reply);
                    rows.sort_by_key(|row| row.id);
                }
            }
        }
        let mut filtered_rows = Vec::with_capacity(rows.len());
        for row in rows {
            if row.payload_kind != "task_assigned"
                || task_is_pending
                || resume_continuation_owns_assignment(&conn, session_id, turn_intent_id, row.id)?
            {
                filtered_rows.push(row);
            }
        }
        let rows = filtered_rows;
        let has_more = rows.len() > 1;
        Ok(AgentInboxBatch {
            rows: rows.into_iter().take(1).collect(),
            has_more,
        })
    }

    /// `EXISTS`-style unread probe. Periodic scanners (watchdog) only
    /// need the boolean; loading and decoding full rows for it is
    /// wasted work.
    pub fn has_unread_for_member(
        recipient_member_id: &str,
        org_run_id: &str,
    ) -> Result<bool, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        conn.query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM agent_org_runtime_inbox
                 WHERE recipient_member_id = ?1
                   AND org_run_id = ?2
                   AND read_at IS NULL
                   AND NOT EXISTS (
                       SELECT 1 FROM agent_org_runtime_inbox_delivery_resolutions resolution
                       WHERE resolution.inbox_id=agent_org_runtime_inbox.id
                   )
             )",
            params![recipient_member_id, org_run_id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|err| err.to_string())
    }

    #[cfg(test)]
    pub fn list_unread_for_member(
        recipient_member_id: &str,
        org_run_id: &str,
    ) -> Result<Vec<AgentInboxRecord>, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id,
                        recipient_agent_id,
                        recipient_member_id,
                        sender_agent_id,
                        sender_member_id,
                        org_run_id,
                        payload_kind,
                        payload_json,
                        request_id,
                        created_at,
                        read_at
                 FROM agent_org_runtime_inbox
                 WHERE recipient_member_id = ?1
                   AND org_run_id = ?2
                   AND read_at IS NULL
                   AND NOT EXISTS (
                       SELECT 1 FROM agent_org_runtime_inbox_delivery_resolutions resolution
                       WHERE resolution.inbox_id=agent_org_runtime_inbox.id
                   )
                 ORDER BY id ASC",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(params![recipient_member_id, org_run_id], row_to_record)
            .map_err(|err| err.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|err| err.to_string())?);
        }
        Ok(out)
    }

    /// Highest unread row id at an acknowledgement boundary. A scalar
    /// high-water mark keeps return-to-work memory and SQL work bounded even
    /// when a member has a very large historical backlog.
    pub fn unread_ack_boundary_for_member(
        recipient_member_id: &str,
        org_run_id: &str,
    ) -> Result<Option<i64>, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        conn.query_row(
            "SELECT MAX(id) FROM agent_org_runtime_inbox
             WHERE recipient_member_id=?1
               AND org_run_id=?2
               AND read_at IS NULL
               AND NOT EXISTS (
                   SELECT 1 FROM agent_org_runtime_inbox_delivery_resolutions resolution
                   WHERE resolution.inbox_id=agent_org_runtime_inbox.id
               )",
            params![recipient_member_id, org_run_id],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())
    }

    /// Count rows that were unread at or before a captured high-water mark and
    /// remain unread now. New messages arriving after the return-to-work
    /// request do not extend that request's acknowledgement wait.
    pub fn unread_count_through_boundary(
        recipient_member_id: &str,
        org_run_id: &str,
        boundary_id: i64,
    ) -> Result<usize, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM agent_org_runtime_inbox
                 WHERE recipient_member_id=?1
                   AND org_run_id=?2
                   AND id<=?3
                   AND read_at IS NULL
                   AND NOT EXISTS (
                       SELECT 1 FROM agent_org_runtime_inbox_delivery_resolutions resolution
                       WHERE resolution.inbox_id=agent_org_runtime_inbox.id
                   )",
                params![recipient_member_id, org_run_id, boundary_id],
                |row| row.get(0),
            )
            .map_err(|err| err.to_string())?;
        usize::try_from(count).map_err(|_| format!("invalid unread inbox row count: {count}"))
    }

    /// Oldest-first bounded delivery batch for the production inbox drain.
    /// The row cap bounds control-envelope work; the serialized-payload cap
    /// bounds provider prompt growth. Full unread history remains available
    /// to explicit diagnostics through `list_unread_for_member`.
    pub fn list_unread_batch_for_member(
        recipient_member_id: &str,
        org_run_id: &str,
    ) -> Result<AgentInboxBatch, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        ensure_inbox_claim_allowed(&conn, org_run_id)?;
        let mut stmt = conn
            .prepare(
                "SELECT id,
                        recipient_agent_id,
                        recipient_member_id,
                        sender_agent_id,
                        sender_member_id,
                        org_run_id,
                        CASE WHEN length(CAST(payload_json AS BLOB))<=?4
                             THEN payload_kind ELSE 'oversized_payload' END,
                        CASE WHEN length(CAST(payload_json AS BLOB))<=?4
                             THEN payload_json
                             ELSE json_object(
                                 'kind', 'plain',
                                 'summary', 'Oversized historical inbox payload',
                                 'text', printf(
                                     'Inbox row %d contained %d bytes, above the supported delivery limit. The original row remains durable; this bounded diagnostic replaces its body. Raw prefix: %s',
                                     id,
                                     length(CAST(payload_json AS BLOB)),
                                     substr(payload_json,1,4096)
                                 )
                             ) END,
                        request_id,
                        created_at,
                        read_at
                 FROM agent_org_runtime_inbox
                 WHERE recipient_member_id = ?1
                   AND org_run_id = ?2
                   AND read_at IS NULL
                   AND NOT EXISTS (
                       SELECT 1 FROM agent_org_runtime_inbox_delivery_resolutions resolution
                       WHERE resolution.inbox_id=agent_org_runtime_inbox.id
                   )
                 ORDER BY id ASC
                 LIMIT ?3",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(
                params![
                    recipient_member_id,
                    org_run_id,
                    (MAX_INBOX_DRAIN_ROWS + 1) as i64,
                    limits::AGENT_INBOX_PAYLOAD_MAX_BYTES as i64,
                ],
                row_to_record,
            )
            .map_err(|err| err.to_string())?;
        let mut batch = Vec::new();
        let mut payload_bytes = 0usize;
        let mut has_more = false;
        for row in rows {
            let row = row.map_err(|err| err.to_string())?;
            if batch.len() == MAX_INBOX_DRAIN_ROWS {
                has_more = true;
                break;
            }
            let next_bytes = payload_bytes.saturating_add(row.payload_json.len());
            if next_bytes > MAX_INBOX_DRAIN_PAYLOAD_BYTES {
                has_more = true;
                break;
            }
            payload_bytes = next_bytes;
            batch.push(row);
        }
        Ok(AgentInboxBatch {
            rows: batch,
            has_more,
        })
    }

    /// Claim and load only the formal Inbox facts bound to this exact
    /// Coordinator Turn. Unrelated unread rows, user-directed messages, and
    /// routine narration remain untouched and cannot be acknowledged by this
    /// provider response.
    pub fn list_formal_coordinator_input_for_turn(
        recipient_member_id: &str,
        org_run_id: &str,
        session_id: &str,
        turn_intent_id: &str,
    ) -> Result<AgentInboxBatch, String> {
        if recipient_member_id != crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID {
            return Err("formal Coordinator input requires coordinator recipient".to_string());
        }
        let Some(claim) =
            crate::coordination::agent_org_formal_triggers::claim_for_coordinator_turn(
                org_run_id,
                session_id,
                turn_intent_id,
            )?
        else {
            return Ok(AgentInboxBatch {
                rows: Vec::new(),
                has_more: false,
            });
        };
        let conn = get_connection().map_err(|error| error.to_string())?;
        ensure_inbox_claim_allowed(&conn, org_run_id)?;
        let mut stmt = conn
            .prepare(
                "SELECT id,
                        recipient_agent_id,
                        recipient_member_id,
                        sender_agent_id,
                        sender_member_id,
                        org_run_id,
                        CASE WHEN length(CAST(payload_json AS BLOB))<=?2
                             THEN payload_kind ELSE 'oversized_payload' END,
                        CASE WHEN length(CAST(payload_json AS BLOB))<=?2
                             THEN payload_json
                             ELSE json_object(
                                 'kind','plain',
                                 'summary','Oversized formal inbox payload',
                                 'text',printf(
                                     'Formal Inbox row %d contained %d bytes, above the supported delivery limit. The original row remains durable. Raw prefix: %s',
                                     id,length(CAST(payload_json AS BLOB)),substr(payload_json,1,4096)
                                 )
                             ) END,
                        request_id,created_at,read_at
                 FROM agent_org_runtime_inbox
                 WHERE id=?1 AND recipient_member_id='coordinator'
                   AND org_run_id=?3 AND read_at IS NULL
                   AND NOT EXISTS (
                       SELECT 1 FROM agent_org_runtime_inbox_delivery_resolutions resolution
                       WHERE resolution.inbox_id=agent_org_runtime_inbox.id
                   )",
            )
            .map_err(|error| error.to_string())?;
        let mut rows = Vec::with_capacity(claim.inbox_ids.len());
        for inbox_id in claim.inbox_ids {
            let row = stmt
                .query_row(
                    params![
                        inbox_id,
                        limits::AGENT_INBOX_PAYLOAD_MAX_BYTES as i64,
                        org_run_id
                    ],
                    row_to_record,
                )
                .optional()
                .map_err(|error| error.to_string())?
                .ok_or_else(|| {
                    format!(
                        "FormalTriggerReceipt claimed missing/unactionable Inbox row {inbox_id}"
                    )
                })?;
            rows.push(row);
        }
        Ok(AgentInboxBatch {
            rows,
            has_more: claim.has_more,
        })
    }

    /// Mark a batch of inbox rows as read in a single immediate
    /// transaction. Idempotent: rows that are already read return
    /// `0` updates and do not error. Returns the total number of rows
    /// whose `read_at` was actually advanced.
    ///
    /// Used by the turn-processor drain hook after rendering the
    /// attachment, so the next turn's drain returns an empty list.
    pub fn mark_many_read(ids: &[i64]) -> Result<usize, String> {
        Self::mark_many_read_internal(ids, None, None, None)
    }

    /// Production acknowledgement for transcript-backed delivery. Only the
    /// Session that owns every row's durable materialization receipt may mark
    /// it read. A stale Guard from an older/replaced Session therefore cannot
    /// acknowledge a row after ownership moved elsewhere.
    pub fn mark_many_read_for_session(ids: &[i64], session_id: &str) -> Result<usize, String> {
        Self::mark_many_read_internal(ids, Some(session_id), None, None)
    }

    /// Formal Turn acknowledgement guarded by the exact current lifecycle
    /// generation inside the same IMMEDIATE write transaction.
    pub fn mark_many_read_for_turn(
        ids: &[i64],
        session_id: &str,
        turn_intent_id: &str,
        materialized_event_id: Option<&str>,
    ) -> Result<usize, String> {
        Self::mark_many_read_internal(
            ids,
            Some(session_id),
            Some(turn_intent_id),
            materialized_event_id,
        )
    }

    fn mark_many_read_internal(
        ids: &[i64],
        materialization_session_id: Option<&str>,
        formal_turn_intent_id: Option<&str>,
        materialized_event_id: Option<&str>,
    ) -> Result<usize, String> {
        if ids.is_empty() {
            return Ok(0);
        }
        let (updated, changed_run_ids) = with_sessions_writer(
            || -> Result<(usize, HashSet<String>), String> {
                let mut conn = get_connection().map_err(|err| err.to_string())?;
                let tx = conn
                    .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                    .map_err(|err| err.to_string())?;
                // A late acknowledgement is still a write. Archive leaves
                // Inbox history readable but permanently closes claim/ack
                // paths, even when the pre-Archive materialization owner is
                // otherwise still valid.
                {
                    let mut status_stmt = tx
                        .prepare(
                            "SELECT inbox.org_run_id,run.status
                             FROM agent_org_runtime_inbox inbox
                             LEFT JOIN agent_org_runtime_runs run ON run.id=inbox.org_run_id
                             WHERE inbox.id=?1",
                        )
                        .map_err(|err| err.to_string())?;
                    for id in ids {
                        let source: Option<(Option<String>, Option<String>)> = status_stmt
                            .query_row([id], |row| Ok((row.get(0)?, row.get(1)?)))
                            .optional()
                            .map_err(|err| err.to_string())?;
                        if let Some((Some(run_id), status)) = source {
                            if status.as_deref()
                                == Some(
                                    crate::coordination::agent_org_runs::AgentOrgRunStatus::Archived
                                        .as_str(),
                                )
                            {
                                return Err(
                                    crate::coordination::agent_org_runs::mutation_blocked_error(
                                        &run_id, "archived",
                                    ),
                                );
                            }
                        }
                    }
                }
                if let (Some(session_id), Some(turn_intent_id)) =
                    (materialization_session_id, formal_turn_intent_id)
                {
                    crate::coordination::agent_org_turn_contexts::validate_formal_turn_generation_with_connection(
                        &tx,
                        session_id,
                        turn_intent_id,
                    )?;
                    let is_resume_continuation =
                        turn_is_resume_continuation(&tx, session_id, turn_intent_id)?;
                    for id in ids {
                        let assignment_status: Option<String> = tx
                            .query_row(
                                "SELECT task.status
                                 FROM agent_org_runtime_inbox inbox
                                 JOIN agent_org_runtime_tasks task
                                   ON task.org_run_id=inbox.org_run_id
                                  AND task.id=json_extract(inbox.payload_json,'$.task_id')
                                 WHERE inbox.id=?1 AND inbox.payload_kind='task_assigned'",
                                [id],
                                |row| row.get(0),
                            )
                            .optional()
                            .map_err(|err| err.to_string())?;
                        if is_resume_continuation && assignment_status.is_some() {
                            let owns_assignment = resume_continuation_owns_assignment(
                                &tx,
                                session_id,
                                turn_intent_id,
                                *id,
                            )?;
                            if assignment_status.as_deref() != Some("completed") || !owns_assignment
                            {
                                return Err(format!(
                                    "Agent Org Inbox row {id} remains unread because its exact Resume continuation did not complete the Task successfully"
                                ));
                            }
                        }
                    }
                }
                let now = chrono::Utc::now().to_rfc3339();
                let mut updated = 0usize;
                let mut changed_run_ids = HashSet::new();
                {
                    if let Some(session_id) = materialization_session_id {
                        // Ownership is all-or-nothing. A stale Guard must not
                        // acknowledge only the subset it still happens to own.
                        let mut preflight = tx
                            .prepare(
                                "SELECT read_at,
                                    EXISTS(
                                        SELECT 1
                                        FROM agent_org_runtime_inbox_materializations receipt
                                        WHERE receipt.inbox_id=agent_org_runtime_inbox.id
                                          AND receipt.session_id=?2
                                    ),
                                    EXISTS(
                                        SELECT 1
                                        FROM agent_org_runtime_inbox_delivery_resolutions resolution
                                        WHERE resolution.inbox_id=agent_org_runtime_inbox.id
                                    )
                             FROM agent_org_runtime_inbox WHERE id=?1",
                            )
                            .map_err(|err| err.to_string())?;
                        for id in ids {
                            let state: Option<(Option<String>, bool, bool)> = preflight
                                .query_row(params![id, session_id], |row| {
                                    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                                })
                                .optional()
                                .map_err(|err| err.to_string())?;
                            if matches!(state, Some((None, false, false))) {
                                return Err(format!(
                                "Agent Org Inbox row {id} has no materialization receipt owned by session {session_id}; refusing partial acknowledgement"
                            ));
                            }
                        }
                        let mut stmt = tx
                            .prepare(
                                "UPDATE agent_org_runtime_inbox
                             SET read_at=?1
                             WHERE id=?2 AND read_at IS NULL
                               AND NOT EXISTS (
                                   SELECT 1 FROM agent_org_runtime_inbox_delivery_resolutions resolution
                                   WHERE resolution.inbox_id=agent_org_runtime_inbox.id
                               )
                               AND EXISTS (
                                   SELECT 1 FROM agent_org_runtime_inbox_materializations receipt
                                   WHERE receipt.inbox_id=agent_org_runtime_inbox.id
                                     AND receipt.session_id=?3
                               )",
                            )
                            .map_err(|err| err.to_string())?;
                        for id in ids {
                            let org_run_id = tx
                            .query_row(
                                "SELECT org_run_id FROM agent_org_runtime_inbox WHERE id=?1 AND read_at IS NULL",
                                params![id],
                                |row| row.get::<_, Option<String>>(0),
                            )
                            .optional()
                            .map_err(|err| err.to_string())?
                            .flatten();
                            let changed = stmt
                                .execute(params![&now, id, session_id])
                                .map_err(|err| err.to_string())?;
                            updated += changed;
                            if changed > 0 {
                                if let Some(org_run_id) = org_run_id {
                                    changed_run_ids.insert(org_run_id);
                                }
                            }
                        }
                    } else {
                        let mut stmt = tx
                            .prepare(
                                "UPDATE agent_org_runtime_inbox
                             SET read_at=?1
                             WHERE id=?2 AND read_at IS NULL
                               AND NOT EXISTS (
                                   SELECT 1 FROM agent_org_runtime_inbox_delivery_resolutions resolution
                                   WHERE resolution.inbox_id=agent_org_runtime_inbox.id
                               )",
                            )
                            .map_err(|err| err.to_string())?;
                        for id in ids {
                            let org_run_id = tx
                            .query_row(
                                "SELECT org_run_id FROM agent_org_runtime_inbox WHERE id=?1 AND read_at IS NULL",
                                params![id],
                                |row| row.get::<_, Option<String>>(0),
                            )
                            .optional()
                            .map_err(|err| err.to_string())?
                            .flatten();
                            let changed = stmt
                                .execute(params![&now, id])
                                .map_err(|err| err.to_string())?;
                            updated += changed;
                            if changed > 0 {
                                if let Some(org_run_id) = org_run_id {
                                    changed_run_ids.insert(org_run_id);
                                }
                            }
                        }
                    }
                }
                {
                    if let Some(session_id) = materialization_session_id {
                        let mut stmt = tx
                            .prepare(
                                "DELETE FROM agent_org_runtime_inbox_materializations
                             WHERE inbox_id=?1 AND session_id=?2",
                            )
                            .map_err(|err| err.to_string())?;
                        for id in ids {
                            stmt.execute(params![id, session_id])
                                .map_err(|err| err.to_string())?;
                        }
                    } else {
                        let mut stmt = tx
                            .prepare("DELETE FROM agent_org_runtime_inbox_materializations WHERE inbox_id=?1")
                            .map_err(|err| err.to_string())?;
                        for id in ids {
                            stmt.execute(params![id]).map_err(|err| err.to_string())?;
                        }
                    }
                }
                if let (Some(session_id), Some(turn_intent_id)) =
                    (materialization_session_id, formal_turn_intent_id)
                {
                    crate::coordination::agent_org_formal_triggers::resolve_inbox_receipts_in_tx(
                        &tx,
                        ids,
                        session_id,
                        turn_intent_id,
                        materialized_event_id,
                    )?;
                }
                tx.commit().map_err(|err| err.to_string())?;
                Ok((updated, changed_run_ids))
            },
        )?;
        for org_run_id in changed_run_ids {
            crate::coordination::agent_org_run_events::notify_agent_org_run_changed(&org_run_id);
        }
        Ok(updated)
    }
}

fn task_status_is_pending(
    conn: &rusqlite::Connection,
    org_run_id: &str,
    task_id: &str,
) -> Result<bool, String> {
    conn.query_row(
        "SELECT status='pending' FROM agent_org_runtime_tasks
         WHERE org_run_id=?1 AND id=?2",
        params![org_run_id, task_id],
        |row| row.get(0),
    )
    .map_err(|error| error.to_string())
}

/// Exact authority for the one exceptional TaskAssigned transition: the Task
/// was already moved to in_progress by the pre-Pause Turn, so only the
/// durable continuation created from that same handoff may consume it.
fn resume_continuation_owns_assignment(
    conn: &rusqlite::Connection,
    session_id: &str,
    turn_intent_id: &str,
    inbox_id: i64,
) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(
             SELECT 1
             FROM agent_org_runtime_pause_handoffs handoff
             JOIN agent_org_runtime_pause_episodes episode
               ON episode.episode_id=handoff.episode_id
             JOIN agent_org_runtime_runs run ON run.id=handoff.org_run_id
             JOIN agent_org_runtime_turn_contexts continuation
               ON continuation.session_id=handoff.session_id
              AND continuation.turn_intent_id=handoff.continuation_turn_intent_id
             JOIN agent_org_runtime_turn_contexts original
               ON original.session_id=handoff.session_id
              AND original.turn_intent_id=handoff.original_turn_intent_id
             JOIN session_turn_intents intent
               ON intent.session_id=handoff.session_id
              AND intent.turn_intent_id=handoff.continuation_turn_intent_id
             JOIN agent_org_runtime_tasks task
               ON task.org_run_id=handoff.org_run_id
              AND task.id=handoff.task_id
             JOIN agent_org_runtime_inbox inbox
               ON inbox.id=?3
              AND inbox.org_run_id=handoff.org_run_id
              AND inbox.recipient_member_id=handoff.participant_id
             JOIN agent_org_runtime_inbox_materializations materialization
               ON materialization.inbox_id=inbox.id
              AND materialization.session_id=handoff.session_id
             WHERE handoff.session_id=?1
               AND handoff.continuation_turn_intent_id=?2
               AND handoff.continuation_status='dispatched'
               AND handoff.drain_status IN ('released','runtime_absent')
               AND episode.status='consumed'
               AND run.status='running'
               AND intent.status IN ('queued','running')
               AND continuation.turn_kind='task_execution'
               AND continuation.source_kind='task'
               AND continuation.task_id=handoff.task_id
               AND continuation.owner_member_id=handoff.participant_id
               AND continuation.activation_generation=run.activation_generation
               AND original.activation_generation=handoff.original_activation_generation
               AND original.task_id=handoff.task_id
               AND original.owner_member_id=handoff.participant_id
               AND task.status IN ('in_progress','completed')
               AND task.owner=handoff.participant_id
               AND inbox.read_at IS NULL
               AND inbox.payload_kind='task_assigned'
               AND json_valid(inbox.payload_json)
               AND json_type(inbox.payload_json,'$.task_id')='text'
               AND json_extract(inbox.payload_json,'$.task_id')=handoff.task_id
               AND NOT EXISTS (
                   SELECT 1
                   FROM agent_org_runtime_inbox_delivery_resolutions resolution
                   WHERE resolution.inbox_id=inbox.id
               )
         )",
        params![session_id, turn_intent_id, inbox_id],
        |row| row.get(0),
    )
    .map_err(|error| error.to_string())
}

fn turn_is_resume_continuation(
    conn: &rusqlite::Connection,
    session_id: &str,
    turn_intent_id: &str,
) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM agent_org_runtime_pause_handoffs
             WHERE session_id=?1
               AND continuation_turn_intent_id=?2
               AND continuation_status='dispatched'
         )",
        params![session_id, turn_intent_id],
        |row| row.get(0),
    )
    .map_err(|error| error.to_string())
}

// Other read-side store methods (`mark_read` for a single id,
// `find_by_request_id`) will land alongside the next consumer that
// actually needs them. They are intentionally not added here because
// there is no production caller — see `architecture-audit` skill,
// anti-pattern #29 ("Grep-alive = alive — reference counting is not
// a dead code audit").

//! Drain / acknowledgement path for [`AgentInboxStore`]: unread probes,
//! bounded delivery batches, high-water-mark accounting, and the
//! materialization-ownership-aware read receipts.

use std::collections::HashSet;

use rusqlite::{params, OptionalExtension};

use database::db::{get_connection, with_sessions_writer};

use crate::coordination::agent_org_payload_limits as limits;

#[cfg(test)]
use super::record::AgentInboxRecord;
use super::record::{row_to_record, AgentInboxBatch};
use super::{AgentInboxStore, MAX_INBOX_DRAIN_PAYLOAD_BYTES, MAX_INBOX_DRAIN_ROWS};

impl AgentInboxStore {
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
                 SELECT 1 FROM agent_inbox
                 WHERE recipient_member_id = ?1
                   AND org_run_id = ?2
                   AND read_at IS NULL
                   AND NOT EXISTS (
                       SELECT 1 FROM agent_inbox_delivery_resolutions resolution
                       WHERE resolution.inbox_id=agent_inbox.id
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
                 FROM agent_inbox
                 WHERE recipient_member_id = ?1
                   AND org_run_id = ?2
                   AND read_at IS NULL
                   AND NOT EXISTS (
                       SELECT 1 FROM agent_inbox_delivery_resolutions resolution
                       WHERE resolution.inbox_id=agent_inbox.id
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
            "SELECT MAX(id) FROM agent_inbox
             WHERE recipient_member_id=?1
               AND org_run_id=?2
               AND read_at IS NULL
               AND NOT EXISTS (
                   SELECT 1 FROM agent_inbox_delivery_resolutions resolution
                   WHERE resolution.inbox_id=agent_inbox.id
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
                "SELECT COUNT(*) FROM agent_inbox
                 WHERE recipient_member_id=?1
                   AND org_run_id=?2
                   AND id<=?3
                   AND read_at IS NULL
                   AND NOT EXISTS (
                       SELECT 1 FROM agent_inbox_delivery_resolutions resolution
                       WHERE resolution.inbox_id=agent_inbox.id
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
                 FROM agent_inbox
                 WHERE recipient_member_id = ?1
                   AND org_run_id = ?2
                   AND read_at IS NULL
                   AND NOT EXISTS (
                       SELECT 1 FROM agent_inbox_delivery_resolutions resolution
                       WHERE resolution.inbox_id=agent_inbox.id
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

    /// Mark a batch of inbox rows as read in a single immediate
    /// transaction. Idempotent: rows that are already read return
    /// `0` updates and do not error. Returns the total number of rows
    /// whose `read_at` was actually advanced.
    ///
    /// Used by the turn-processor drain hook after rendering the
    /// attachment, so the next turn's drain returns an empty list.
    pub fn mark_many_read(ids: &[i64]) -> Result<usize, String> {
        Self::mark_many_read_internal(ids, None)
    }

    /// Production acknowledgement for transcript-backed delivery. Only the
    /// Session that owns every row's durable materialization receipt may mark
    /// it read. A stale Guard from an older/replaced Session therefore cannot
    /// acknowledge a row after ownership moved elsewhere.
    pub fn mark_many_read_for_session(ids: &[i64], session_id: &str) -> Result<usize, String> {
        Self::mark_many_read_internal(ids, Some(session_id))
    }

    fn mark_many_read_internal(
        ids: &[i64],
        materialization_session_id: Option<&str>,
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
                                        FROM agent_inbox_materializations receipt
                                        WHERE receipt.inbox_id=agent_inbox.id
                                          AND receipt.session_id=?2
                                    ),
                                    EXISTS(
                                        SELECT 1
                                        FROM agent_inbox_delivery_resolutions resolution
                                        WHERE resolution.inbox_id=agent_inbox.id
                                    )
                             FROM agent_inbox WHERE id=?1",
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
                                "UPDATE agent_inbox
                             SET read_at=?1
                             WHERE id=?2 AND read_at IS NULL
                               AND NOT EXISTS (
                                   SELECT 1 FROM agent_inbox_delivery_resolutions resolution
                                   WHERE resolution.inbox_id=agent_inbox.id
                               )
                               AND EXISTS (
                                   SELECT 1 FROM agent_inbox_materializations receipt
                                   WHERE receipt.inbox_id=agent_inbox.id
                                     AND receipt.session_id=?3
                               )",
                            )
                            .map_err(|err| err.to_string())?;
                        for id in ids {
                            let org_run_id = tx
                            .query_row(
                                "SELECT org_run_id FROM agent_inbox WHERE id=?1 AND read_at IS NULL",
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
                                "UPDATE agent_inbox
                             SET read_at=?1
                             WHERE id=?2 AND read_at IS NULL
                               AND NOT EXISTS (
                                   SELECT 1 FROM agent_inbox_delivery_resolutions resolution
                                   WHERE resolution.inbox_id=agent_inbox.id
                               )",
                            )
                            .map_err(|err| err.to_string())?;
                        for id in ids {
                            let org_run_id = tx
                            .query_row(
                                "SELECT org_run_id FROM agent_inbox WHERE id=?1 AND read_at IS NULL",
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
                                "DELETE FROM agent_inbox_materializations
                             WHERE inbox_id=?1 AND session_id=?2",
                            )
                            .map_err(|err| err.to_string())?;
                        for id in ids {
                            stmt.execute(params![id, session_id])
                                .map_err(|err| err.to_string())?;
                        }
                    } else {
                        let mut stmt = tx
                            .prepare("DELETE FROM agent_inbox_materializations WHERE inbox_id=?1")
                            .map_err(|err| err.to_string())?;
                        for id in ids {
                            stmt.execute(params![id]).map_err(|err| err.to_string())?;
                        }
                    }
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

// Other read-side store methods (`mark_read` for a single id,
// `find_by_request_id`) will land alongside the next consumer that
// actually needs them. They are intentionally not added here because
// there is no production caller — see `architecture-audit` skill,
// anti-pattern #29 ("Grep-alive = alive — reference counting is not
// a dead code audit").

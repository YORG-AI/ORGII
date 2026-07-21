//! Read/projection path for [`AgentInboxStore`]: bounded history pages,
//! Run View previews, recipient counters, unread fingerprints, and the
//! current-owner task-assignment snapshot.

use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashSet;

use crate::coordination::agent_org_payload_limits as limits;
use database::db::get_connection;

use super::message::AgentMessage;
use super::record::{
    row_to_preview_record, row_to_record, AgentInboxPage, AgentInboxPreviewRecord,
    AgentInboxUnreadRecipientCounts,
};
#[cfg(test)]
use super::record::{AgentInboxRecipientCounts, AgentInboxRecord};
use super::{
    AgentInboxStore, MAX_INBOX_HISTORY_PAGE_BYTES, MAX_INBOX_HISTORY_PAGE_ROWS,
    MAX_RUN_INBOX_PREVIEW_CHARS, MAX_RUN_INBOX_SNAPSHOT_ROWS,
};

pub(super) const UNREAD_COUNTS_BY_RECIPIENT_SQL: &str = "SELECT recipient_agent_id,
            recipient_member_id,
            COUNT(*) AS unread_count,
            MAX(id) AS max_unread_id
     FROM agent_inbox INDEXED BY idx_agent_inbox_run_unread_recipient
     WHERE org_run_id = ?1
       AND read_at IS NULL
     GROUP BY recipient_member_id, recipient_agent_id
     ORDER BY recipient_member_id ASC, recipient_agent_id ASC";

pub(super) fn task_assignment_lookup_sql() -> String {
    let payload_max = limits::AGENT_INBOX_PAYLOAD_MAX_BYTES;
    format!(
        "SELECT payload_json
         FROM agent_inbox INDEXED BY idx_agent_inbox_run_task_assignment_v4
         WHERE org_run_id=?1
           AND recipient_member_id=?2
           AND payload_kind='task_assigned'
           AND CASE WHEN length(CAST(payload_json AS BLOB))<={payload_max}
                    THEN json_valid(payload_json) ELSE 0 END
           AND json_type(
                CASE WHEN length(CAST(payload_json AS BLOB))<={payload_max}
                               AND json_valid(payload_json)
                     THEN payload_json ELSE '{{}}' END,
                '$.task_id'
              )='text'
           AND json_extract(
                CASE WHEN length(CAST(payload_json AS BLOB))<={payload_max}
                               AND json_valid(payload_json)
                     THEN payload_json ELSE '{{}}' END,
                '$.task_id'
              )=?3
         ORDER BY id DESC
         LIMIT 1"
    )
}

impl AgentInboxStore {
    /// Test-only convenience wrapper for assertions that intentionally seed a
    /// tiny number of rows. Production and debug paths use bounded pages.
    #[cfg(test)]
    pub fn list_by_run(org_run_id: &str) -> Result<Vec<AgentInboxRecord>, String> {
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
                 WHERE org_run_id = ?1
                 ORDER BY id ASC",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(params![org_run_id], row_to_record)
            .map_err(|err| err.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|err| err.to_string())?);
        }
        Ok(out)
    }

    /// Cursor-paged full Inbox history for explicit debug/E2E inspection.
    /// Every scalar and payload is bounded in SQL before crossing into Rust;
    /// the page also has an aggregate serialized-byte ceiling.
    pub fn list_page_by_run(
        org_run_id: &str,
        after_id: Option<i64>,
        limit: usize,
    ) -> Result<AgentInboxPage, String> {
        let bounded_limit = limit.clamp(1, MAX_INBOX_HISTORY_PAGE_ROWS);
        let conn = get_connection().map_err(|err| err.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id,
                        recipient_agent_id,
                        recipient_member_id,
                        sender_agent_id,
                        sender_member_id,
                        ?1,
                        payload_kind,
                        payload_json,
                        request_id,
                        created_at,
                        read_at
                 FROM agent_inbox
                 WHERE org_run_id=?1 AND id>?2
                 ORDER BY id ASC
                 LIMIT ?3",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(
                params![
                    org_run_id,
                    after_id.unwrap_or(0),
                    (bounded_limit + 1) as i64,
                ],
                row_to_record,
            )
            .map_err(|err| err.to_string())?;
        let mut page_rows = Vec::new();
        let mut serialized_bytes = 2usize;
        let mut has_more = false;
        for row in rows {
            let row = row.map_err(|err| err.to_string())?;
            if page_rows.len() == bounded_limit {
                has_more = true;
                break;
            }
            let row_bytes = serde_json::to_vec(&row)
                .map_err(|err| format!("serialize Inbox history row failed: {err}"))?
                .len();
            let separator = usize::from(!page_rows.is_empty());
            if serialized_bytes
                .saturating_add(separator)
                .saturating_add(row_bytes)
                > MAX_INBOX_HISTORY_PAGE_BYTES
            {
                has_more = true;
                break;
            }
            serialized_bytes = serialized_bytes
                .saturating_add(separator)
                .saturating_add(row_bytes);
            page_rows.push(row);
        }
        let next_cursor = has_more
            .then(|| page_rows.last().map(|row| row.id))
            .flatten();
        Ok(AgentInboxPage {
            rows: page_rows,
            has_more,
            next_cursor,
        })
    }

    pub fn count_by_run(org_run_id: &str) -> Result<usize, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM agent_inbox WHERE org_run_id=?1",
                params![org_run_id],
                |row| row.get(0),
            )
            .map_err(|err| err.to_string())?;
        usize::try_from(count).map_err(|_| format!("invalid Inbox row count: {count}"))
    }

    /// Return a bounded tail of one run's inbox history in chronological
    /// order. The inner descending query lets SQLite stop at `limit`; the
    /// outer query restores the order expected by transcript projections.
    #[cfg(test)]
    pub fn list_recent_by_run(
        org_run_id: &str,
        limit: usize,
    ) -> Result<Vec<AgentInboxRecord>, String> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let bounded_limit = limit.min(MAX_RUN_INBOX_SNAPSHOT_ROWS) as i64;
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
                 FROM (
                     SELECT id,
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
                     WHERE org_run_id = ?1
                     ORDER BY id DESC
                     LIMIT ?2
                 )
                 ORDER BY id ASC",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(params![org_run_id, bounded_limit], row_to_record)
            .map_err(|err| err.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|err| err.to_string())?);
        }
        Ok(out)
    }

    /// Return a bounded, payload-free activity tail for Run View.
    ///
    /// SQLite extracts at most a small human-facing preview for message kinds
    /// that have one. The full serialized payload never crosses the DB/API
    /// boundary here; explicit inbox history/detail paths keep using
    /// [`Self::list_by_run`] or the member drain query.
    pub fn list_recent_previews_by_run(
        org_run_id: &str,
        limit: usize,
    ) -> Result<Vec<AgentInboxPreviewRecord>, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        Self::list_recent_previews_by_run_with_connection(&conn, org_run_id, limit)
    }

    /// Same bounded Run View projection, but on a caller-owned read snapshot.
    pub(crate) fn list_recent_previews_by_run_with_connection(
        conn: &Connection,
        org_run_id: &str,
        limit: usize,
    ) -> Result<Vec<AgentInboxPreviewRecord>, String> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let bounded_limit = limit.min(MAX_RUN_INBOX_SNAPSHOT_ROWS) as i64;
        let preview_chars = MAX_RUN_INBOX_PREVIEW_CHARS as i64;
        let mut stmt = conn
            .prepare(
                "SELECT id,
                        recipient_agent_id,
                        recipient_member_id,
                        sender_agent_id,
                        sender_member_id,
                        org_run_id,
                        payload_kind,
                        request_id,
                        created_at,
                        read_at,
                        display_preview
                 FROM (
                     SELECT id,
                            recipient_agent_id,
                            recipient_member_id,
                            sender_agent_id,
                            sender_member_id,
                            org_run_id,
                            payload_kind,
                            request_id,
                            created_at,
                            read_at,
                            CASE WHEN length(CAST(payload_json AS BLOB))<=?4 THEN
                              CASE WHEN json_valid(payload_json) THEN CASE payload_kind
                                WHEN 'plain' THEN substr(
                                    COALESCE(
                                        json_extract(payload_json, '$.text'),
                                        json_extract(payload_json, '$.summary')
                                    ),
                                    1,
                                    ?3
                                )
                                WHEN 'task_assigned' THEN substr(
                                    json_extract(payload_json, '$.subject'),
                                    1,
                                    ?3
                                )
                                WHEN 'task_completed' THEN substr(
                                    COALESCE(
                                        json_extract(payload_json, '$.output_summary'),
                                        json_extract(payload_json, '$.subject')
                                    ),
                                    1,
                                    ?3
                                )
                                WHEN 'member_idle' THEN substr(
                                    json_extract(payload_json, '$.summary'),
                                    1,
                                    ?3
                                )
                                WHEN 'member_terminated' THEN substr(
                                    json_extract(payload_json, '$.member_name'),
                                    1,
                                    ?3
                                )
                                WHEN 'plan_approval_request' THEN substr(
                                    json_extract(payload_json, '$.plan_title'),
                                    1,
                                    ?3
                                )
                                ELSE NULL
                              END ELSE NULL END
                            ELSE NULL END AS display_preview
                     FROM agent_inbox
                     WHERE org_run_id = ?1
                     ORDER BY id DESC
                     LIMIT ?2
                 )
                 ORDER BY id ASC",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(
                params![
                    org_run_id,
                    bounded_limit,
                    preview_chars,
                    limits::AGENT_INBOX_PAYLOAD_MAX_BYTES as i64,
                ],
                row_to_preview_record,
            )
            .map_err(|err| err.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|err| err.to_string())?);
        }
        Ok(out)
    }

    /// Return compact activity/unread counters without loading payload JSON.
    #[cfg(test)]
    pub fn run_counts_by_recipient(
        org_run_id: &str,
    ) -> Result<Vec<AgentInboxRecipientCounts>, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        Self::run_counts_by_recipient_with_connection(&conn, org_run_id)
    }

    /// Same compact counters, but on a caller-owned read snapshot.
    #[cfg(test)]
    pub(crate) fn run_counts_by_recipient_with_connection(
        conn: &Connection,
        org_run_id: &str,
    ) -> Result<Vec<AgentInboxRecipientCounts>, String> {
        let mut stmt = conn
            .prepare(
                "SELECT recipient_agent_id,
                        recipient_member_id,
                        COUNT(*) AS activity_count,
                        SUM(CASE WHEN read_at IS NULL THEN 1 ELSE 0 END) AS unread_count
                 FROM agent_inbox
                 WHERE org_run_id = ?1
                 GROUP BY recipient_member_id, recipient_agent_id
                 ORDER BY recipient_member_id ASC, recipient_agent_id ASC",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(params![org_run_id], |row| {
                Ok(AgentInboxRecipientCounts {
                    recipient_agent_id: row.get(0)?,
                    recipient_member_id: row.get(1)?,
                    activity_count: row.get::<_, i64>(2)?.max(0) as usize,
                    unread_count: row.get::<_, i64>(3)?.max(0) as usize,
                })
            })
            .map_err(|err| err.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|err| err.to_string())?);
        }
        Ok(out)
    }

    /// Return only unread recipient totals using the partial unread index.
    ///
    /// Unlike [`Self::run_counts_by_recipient_with_connection`], this query
    /// never walks historical read rows and is therefore safe for the
    /// watchdog and frequently-polled Run View.
    pub(crate) fn unread_counts_by_recipient_with_connection(
        conn: &Connection,
        org_run_id: &str,
    ) -> Result<Vec<AgentInboxUnreadRecipientCounts>, String> {
        let mut stmt = conn
            .prepare(UNREAD_COUNTS_BY_RECIPIENT_SQL)
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(params![org_run_id], |row| {
                Ok(AgentInboxUnreadRecipientCounts {
                    recipient_agent_id: row.get(0)?,
                    recipient_member_id: row.get(1)?,
                    unread_count: row.get::<_, i64>(2)?.max(0) as usize,
                    max_unread_id: row.get(3)?,
                })
            })
            .map_err(|err| err.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|err| err.to_string())?);
        }
        Ok(out)
    }

    /// Return only current open task ids whose *current owner* has a valid,
    /// durable `TaskAssigned` envelope. The expression index turns this into
    /// bounded lookups from the current task board instead of re-running
    /// `json_extract` over the run's entire historical Inbox on every
    /// watchdog tick. Rust still performs the authoritative typed decode so
    /// a hand-edited or partially-written JSON object cannot suppress a
    /// legitimate redelivery.
    pub(crate) fn task_assignment_ids_for_open_tasks_with_connection(
        conn: &Connection,
        org_run_id: &str,
    ) -> Result<HashSet<String>, String> {
        const TASK_PAGE_SIZE: i64 = 200;
        let mut task_stmt = conn
            .prepare(
                "SELECT id, owner
                 FROM agent_org_tasks
                 WHERE org_run_id=?1
                   AND status IN ('pending','in_progress')
                   AND owner IS NOT NULL
                   AND id>?2
                 ORDER BY id ASC
                 LIMIT ?3",
            )
            .map_err(|err| err.to_string())?;

        // Page the current board in bounded reads. SQLite does not bind an
        // outer task.id into the third expression-index column, so one reused
        // exact probe per current task is faster than scanning historical
        // Inbox JSON and does not impose a run-level task capacity policy.
        let lookup_sql = task_assignment_lookup_sql();
        let mut assignment_stmt = conn.prepare(&lookup_sql).map_err(|err| err.to_string())?;
        let mut task_ids = HashSet::new();
        let mut after_task_id = String::new();
        loop {
            let open_tasks = task_stmt
                .query_map(params![org_run_id, &after_task_id, TASK_PAGE_SIZE], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|err| err.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|err| err.to_string())?;
            if open_tasks.is_empty() {
                break;
            }
            after_task_id = open_tasks
                .last()
                .map(|(task_id, _)| task_id.clone())
                .unwrap_or_default();
            for (task_id, owner) in open_tasks {
                let payload_json = assignment_stmt
                    .query_row(params![org_run_id, &owner, &task_id], |row| {
                        row.get::<_, String>(0)
                    })
                    .optional()
                    .map_err(|err| err.to_string())?;
                let Some(payload_json) = payload_json else {
                    continue;
                };
                let Ok(message) = serde_json::from_str::<AgentMessage>(&payload_json) else {
                    continue;
                };
                if message.validate().is_err() {
                    continue;
                }
                if matches!(message, AgentMessage::TaskAssigned { task_id: ref id, .. } if id == &task_id)
                {
                    task_ids.insert(task_id);
                }
            }
        }
        Ok(task_ids)
    }

    /// Compact identity of the current unread set without loading payloads.
    /// Useful for coalescing/backoff decisions; `None` means no unread rows.
    pub fn unread_fingerprint_for_member(
        recipient_member_id: &str,
        org_run_id: &str,
    ) -> Result<Option<String>, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        Self::unread_fingerprint_for_member_with_connection(&conn, recipient_member_id, org_run_id)
    }

    /// Same payload-free unread identity, but on a caller-owned snapshot.
    /// Recovery uses this while classifying recipient availability so budget
    /// state and Inbox state come from the same SQLite generation.
    pub(crate) fn unread_fingerprint_for_member_with_connection(
        conn: &Connection,
        recipient_member_id: &str,
        org_run_id: &str,
    ) -> Result<Option<String>, String> {
        let (max_id, count): (Option<i64>, i64) = conn
            .query_row(
                "SELECT MAX(id), COUNT(*)
                 FROM agent_inbox
                 WHERE recipient_member_id=?1
                   AND org_run_id=?2
                   AND read_at IS NULL",
                params![recipient_member_id, org_run_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|err| err.to_string())?;
        Ok(max_id.map(|max_id| format!("{max_id}:{count}")))
    }
}

//! Read/projection path for [`AgentInboxStore`]: bounded history pages,
//! Run View previews, recipient counters, unread fingerprints, and the
//! current-owner task-assignment snapshot.

use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashSet;

use crate::coordination::agent_org_payload_limits as limits;
use database::db::{get_connection, with_sessions_writer};

use super::message::AgentMessage;
#[cfg(test)]
use super::record::AgentInboxRecipientCounts;
use super::record::{
    row_to_preview_record, row_to_record, AgentInboxDeliveryResolution,
    AgentInboxDeliveryResolutionKind, AgentInboxPage, AgentInboxPreviewRecord, AgentInboxRecord,
    AgentInboxUnreadRecipientCounts, ResolveInboxDeliveryError, ResolveInboxDeliveryParams,
};
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
       AND NOT EXISTS (
            SELECT 1 FROM agent_inbox_delivery_resolutions resolution
            WHERE resolution.inbox_id=agent_inbox.id
       )
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

fn inbox_recipient_is_permanently_unavailable(
    conn: &Connection,
    org_run_id: &str,
    recipient_member_id: Option<&str>,
) -> Result<bool, String> {
    use crate::coordination::agent_org_runs::{AgentOrgRunStore, COORDINATOR_MEMBER_ID};
    use crate::session::SessionStatus;

    let Some(member_id) = recipient_member_id.filter(|value| !value.trim().is_empty()) else {
        return Ok(true);
    };
    let roster = AgentOrgRunStore::snapshot_member_ids_with_connection(conn, org_run_id)?;
    if member_id != COORDINATOR_MEMBER_ID
        && roster
            .as_ref()
            .is_some_and(|members| !members.contains(member_id))
    {
        return Ok(true);
    }
    if member_id == COORDINATOR_MEMBER_ID {
        return Ok(
            AgentOrgRunStore::find_coordinator_session_by_member_id_with_connection(
                conn,
                org_run_id,
                COORDINATOR_MEMBER_ID,
            )?
            .is_none_or(|runtime| runtime.status == SessionStatus::Archived),
        );
    }
    Ok(
        AgentOrgRunStore::list_descendant_worker_sessions_with_connection(conn, org_run_id)?
            .into_iter()
            .find(|runtime| runtime.member_id.as_deref() == Some(member_id))
            .is_none_or(|runtime| {
                runtime.cli_agent_type.is_some() || runtime.status == SessionStatus::Archived
            }),
    )
}

fn load_delivery_resolution(
    conn: &Connection,
    org_run_id: &str,
    inbox_id: i64,
) -> Result<Option<AgentInboxDeliveryResolution>, String> {
    type DeliveryResolutionRow = (
        i64,
        String,
        String,
        String,
        String,
        Option<i64>,
        Option<String>,
        String,
    );
    let raw: Option<DeliveryResolutionRow> = conn
        .query_row(
            "SELECT inbox_id, org_run_id, resolution_kind,
                    resolved_by_member_id, reason,
                    replacement_inbox_id, replacement_task_id, created_at
             FROM agent_inbox_delivery_resolutions
             WHERE inbox_id=?1 AND org_run_id=?2
             LIMIT 1",
            params![inbox_id, org_run_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                ))
            },
        )
        .optional()
        .map_err(|err| err.to_string())?;
    raw.map(
        |(
            inbox_id,
            org_run_id,
            resolution_kind,
            resolved_by_member_id,
            reason,
            replacement_inbox_id,
            replacement_task_id,
            created_at,
        )| {
            Ok(AgentInboxDeliveryResolution {
                inbox_id,
                org_run_id,
                resolution_kind: AgentInboxDeliveryResolutionKind::parse(&resolution_kind)?,
                resolved_by_member_id,
                reason,
                replacement_inbox_id,
                replacement_task_id,
                created_at,
            })
        },
    )
    .transpose()
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
                        CASE WHEN length(CAST(recipient_agent_id AS BLOB))<=?4
                             THEN recipient_agent_id
                             ELSE printf('[oversized recipient agent row %d]', id) END,
                        CASE WHEN recipient_member_id IS NULL THEN NULL
                             WHEN length(CAST(recipient_member_id AS BLOB))<=?4
                             THEN recipient_member_id
                             ELSE printf('[oversized recipient member row %d]', id) END,
                        CASE WHEN length(CAST(sender_agent_id AS BLOB))<=?4
                             THEN sender_agent_id
                             ELSE printf('[oversized sender agent row %d]', id) END,
                        CASE WHEN sender_member_id IS NULL THEN NULL
                             WHEN length(CAST(sender_member_id AS BLOB))<=?4
                             THEN sender_member_id
                             ELSE printf('[oversized sender member row %d]', id) END,
                        ?1,
                        CASE WHEN length(CAST(payload_json AS BLOB))<=?5
                             THEN substr(payload_kind,1,128) ELSE 'oversized_payload' END,
                        CASE WHEN length(CAST(payload_json AS BLOB))<=?5
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
                        CASE WHEN request_id IS NULL THEN NULL ELSE substr(request_id,1,1000) END,
                        substr(created_at,1,64),
                        CASE WHEN read_at IS NULL THEN NULL ELSE substr(read_at,1,64) END
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
                    limits::MESSAGE_IDENTIFIER_MAX_BYTES as i64,
                    limits::AGENT_INBOX_PAYLOAD_MAX_BYTES as i64,
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

    /// Read one durable Inbox row for an explicit repair/diagnostic action.
    /// The stored row is never mutated and oversized historical payloads are
    /// replaced in the response by the same bounded diagnostic used by the
    /// cursor history API.
    pub fn get_by_id_for_run(
        org_run_id: &str,
        inbox_id: i64,
    ) -> Result<Option<AgentInboxRecord>, String> {
        if inbox_id <= 0 {
            return Err("inbox_id must be a positive integer".to_string());
        }
        let conn = get_connection().map_err(|err| err.to_string())?;
        conn.query_row(
            "SELECT id,
                    CASE WHEN length(CAST(recipient_agent_id AS BLOB))<=?3
                         THEN recipient_agent_id
                         ELSE printf('[oversized recipient agent row %d]', id) END,
                    CASE WHEN recipient_member_id IS NULL THEN NULL
                         WHEN length(CAST(recipient_member_id AS BLOB))<=?3
                         THEN recipient_member_id
                         ELSE printf('[oversized recipient member row %d]', id) END,
                    CASE WHEN length(CAST(sender_agent_id AS BLOB))<=?3
                         THEN sender_agent_id
                         ELSE printf('[oversized sender agent row %d]', id) END,
                    CASE WHEN sender_member_id IS NULL THEN NULL
                         WHEN length(CAST(sender_member_id AS BLOB))<=?3
                         THEN sender_member_id
                         ELSE printf('[oversized sender member row %d]', id) END,
                    ?1,
                    CASE WHEN length(CAST(payload_json AS BLOB))<=?4
                         THEN substr(payload_kind,1,128) ELSE 'oversized_payload' END,
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
                    CASE WHEN request_id IS NULL THEN NULL ELSE substr(request_id,1,1000) END,
                    substr(created_at,1,64),
                    CASE WHEN read_at IS NULL THEN NULL ELSE substr(read_at,1,64) END
             FROM agent_inbox
             WHERE org_run_id=?1 AND id=?2
             LIMIT 1",
            params![
                org_run_id,
                inbox_id,
                limits::MESSAGE_IDENTIFIER_MAX_BYTES as i64,
                limits::AGENT_INBOX_PAYLOAD_MAX_BYTES as i64,
            ],
            row_to_record,
        )
        .optional()
        .map_err(|err| err.to_string())
    }

    pub fn delivery_resolution_for_inbox(
        org_run_id: &str,
        inbox_id: i64,
    ) -> Result<Option<AgentInboxDeliveryResolution>, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        load_delivery_resolution(&conn, org_run_id, inbox_id)
    }

    /// Resolve an otherwise-undeliverable source row without falsifying its
    /// read receipt. Only the canonical coordinator may call this store path;
    /// the LLM tool also enforces that authority before entering the blocking
    /// transaction.
    pub fn resolve_delivery(
        params: ResolveInboxDeliveryParams,
    ) -> Result<AgentInboxDeliveryResolution, ResolveInboxDeliveryError> {
        use crate::coordination::agent_org_runs::{
            AgentOrgRunStatus, AgentOrgRunStore, COORDINATOR_MEMBER_ID,
        };

        let constraint = ResolveInboxDeliveryError::Constraint;
        let storage = ResolveInboxDeliveryError::Storage;

        if params.inbox_id <= 0 {
            return Err(constraint(
                "inbox_id must be a positive integer".to_string(),
            ));
        }
        limits::validate_message_identifier("org_run_id", &params.org_run_id)
            .map_err(constraint)?;
        limits::validate_message_identifier("resolved_by_member_id", &params.resolved_by_member_id)
            .map_err(constraint)?;
        if params.resolved_by_member_id != COORDINATOR_MEMBER_ID {
            return Err(constraint(
                "Inbox delivery resolution is coordinator-only".to_string(),
            ));
        }
        limits::validate_required_text(
            "reason",
            &params.reason,
            limits::PLAN_FEEDBACK_MAX_CHARS,
            limits::PLAN_FEEDBACK_MAX_BYTES,
        )
        .map_err(constraint)?;
        if let Some(task_id) = params.replacement_task_id.as_deref() {
            limits::validate_task_identifier("replacement_task_id", task_id).map_err(constraint)?;
        }
        if params.replacement_inbox_id.is_some_and(|id| id <= 0) {
            return Err(constraint(
                "replacement_inbox_id must be a positive integer".to_string(),
            ));
        }
        match params.resolution_kind {
            AgentInboxDeliveryResolutionKind::Cancelled => {
                if params.replacement_inbox_id.is_some() || params.replacement_task_id.is_some() {
                    return Err(constraint(
                        "cancelled delivery resolution cannot name a replacement".to_string(),
                    ));
                }
            }
            AgentInboxDeliveryResolutionKind::Superseded => {
                if params.replacement_inbox_id.is_some() == params.replacement_task_id.is_some() {
                    return Err(constraint(
                        "superseded delivery resolution requires exactly one of replacement_inbox_id or replacement_task_id"
                            .to_string(),
                    ));
                }
                if params.replacement_inbox_id == Some(params.inbox_id) {
                    return Err(constraint(
                        "an Inbox row cannot supersede itself".to_string(),
                    ));
                }
            }
        }

        with_sessions_writer(
            || -> Result<AgentInboxDeliveryResolution, ResolveInboxDeliveryError> {
                let mut conn = get_connection().map_err(|err| storage(err.to_string()))?;
                let tx = conn
                    .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                    .map_err(|err| storage(err.to_string()))?;
                let run_status =
                    AgentOrgRunStore::get_run_status_with_connection(&tx, &params.org_run_id)
                        .map_err(storage)?;
                if run_status != Some(AgentOrgRunStatus::Running) {
                    return Err(constraint(format!(
                        "Agent Org run {} is not Running; Inbox delivery repair was not applied",
                        params.org_run_id
                    )));
                }

                let source: Option<(Option<String>, Option<String>)> = tx
                    .query_row(
                        "SELECT recipient_member_id, read_at
                     FROM agent_inbox
                     WHERE id=?1 AND org_run_id=?2
                     LIMIT 1",
                        params![params.inbox_id, &params.org_run_id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()
                    .map_err(|err| storage(err.to_string()))?;
                let Some((source_recipient_member_id, read_at)) = source else {
                    return Err(constraint(format!(
                        "Inbox row {} does not belong to Agent Org run {}",
                        params.inbox_id, params.org_run_id
                    )));
                };
                if read_at.is_some() {
                    return Err(constraint(format!(
                    "Inbox row {} was already delivered and cannot be resolved as undeliverable",
                    params.inbox_id
                )));
                }

                if let Some(existing) =
                    load_delivery_resolution(&tx, &params.org_run_id, params.inbox_id)
                        .map_err(storage)?
                {
                    let is_same = existing.resolution_kind == params.resolution_kind
                        && existing.resolved_by_member_id == params.resolved_by_member_id
                        && existing.reason == params.reason
                        && existing.replacement_inbox_id == params.replacement_inbox_id
                        && existing.replacement_task_id == params.replacement_task_id;
                    if is_same {
                        tx.commit().map_err(|err| storage(err.to_string()))?;
                        return Ok(existing);
                    }
                    return Err(constraint(format!(
                        "Inbox row {} already has a different delivery resolution",
                        params.inbox_id
                    )));
                }

                // A model-visible repair tool must not be able to discard healthy
                // work merely because the coordinator changed its mind. Only
                // identities that are provably outside a deliverable production
                // path may be resolved here. Recoverable states (Idle, terminal
                // retry candidates, Pending, Paused, Running/waiting) must instead
                // be resumed/retried or explicitly archived by the user first.
                let permanently_unavailable = inbox_recipient_is_permanently_unavailable(
                    &tx,
                    &params.org_run_id,
                    source_recipient_member_id.as_deref(),
                )
                .map_err(storage)?;
                if !permanently_unavailable {
                    return Err(constraint(format!(
                    "Inbox row {} still has a recoverable canonical recipient. Resume/retry that recipient instead of discarding or superseding healthy delivery; archive it explicitly first only if the user has decided it is permanently unavailable.",
                    params.inbox_id
                )));
                }

                if let Some(replacement_inbox_id) = params.replacement_inbox_id {
                    let replacement: Option<(Option<String>, Option<String>, bool)> = tx
                        .query_row(
                            "SELECT inbox.recipient_member_id,
                                inbox.read_at,
                                EXISTS(
                                    SELECT 1
                                    FROM agent_inbox_delivery_resolutions resolution
                                    WHERE resolution.inbox_id=inbox.id
                                )
                         FROM agent_inbox inbox
                         WHERE inbox.id=?1 AND inbox.org_run_id=?2
                         LIMIT 1",
                            params![replacement_inbox_id, &params.org_run_id],
                            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                        )
                        .optional()
                        .map_err(|err| storage(err.to_string()))?;
                    let Some((Some(replacement_member_id), replacement_read_at, is_resolved)) =
                        replacement
                    else {
                        return Err(constraint(format!(
                        "replacement Inbox row {replacement_inbox_id} must exist in the same run and name a canonical recipient_member_id"
                    )));
                    };
                    if is_resolved {
                        return Err(constraint(format!(
                        "replacement Inbox row {replacement_inbox_id} already has a delivery resolution and cannot be used as a live replacement"
                    )));
                    }
                    let replacement_is_unavailable = inbox_recipient_is_permanently_unavailable(
                        &tx,
                        &params.org_run_id,
                        Some(&replacement_member_id),
                    )
                    .map_err(storage)?;
                    if replacement_read_at.is_none() && replacement_is_unavailable {
                        return Err(constraint(format!(
                        "replacement Inbox row {replacement_inbox_id} has not been delivered and its recipient {replacement_member_id:?} is permanently unavailable"
                    )));
                    }
                }
                if let Some(replacement_task_id) = params.replacement_task_id.as_deref() {
                    let replacement_exists: bool = tx
                        .query_row(
                            "SELECT EXISTS(
                             SELECT 1 FROM agent_org_tasks
                             WHERE id=?1 AND org_run_id=?2
                         )",
                            params![replacement_task_id, &params.org_run_id],
                            |row| row.get(0),
                        )
                        .map_err(|err| storage(err.to_string()))?;
                    if !replacement_exists {
                        return Err(constraint(format!(
                        "replacement task {replacement_task_id:?} does not exist in Agent Org run {}",
                        params.org_run_id
                    )));
                    }
                }

                let created_at = chrono::Utc::now().to_rfc3339();
                tx.execute(
                    "INSERT INTO agent_inbox_delivery_resolutions (
                    inbox_id, org_run_id, resolution_kind,
                    resolved_by_member_id, reason,
                    replacement_inbox_id, replacement_task_id, created_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![
                        params.inbox_id,
                        &params.org_run_id,
                        params.resolution_kind.as_str(),
                        &params.resolved_by_member_id,
                        &params.reason,
                        params.replacement_inbox_id,
                        params.replacement_task_id.as_deref(),
                        &created_at,
                    ],
                )
                .map_err(|err| storage(err.to_string()))?;
                // A Session that materialized the old row before this repair must
                // not later acknowledge it as delivered. The guarded mark-read
                // path also rechecks the resolution table.
                tx.execute(
                    "DELETE FROM agent_inbox_materializations WHERE inbox_id=?1",
                    params![params.inbox_id],
                )
                .map_err(|err| storage(err.to_string()))?;
                tx.commit().map_err(|err| storage(err.to_string()))?;
                Ok(AgentInboxDeliveryResolution {
                    inbox_id: params.inbox_id,
                    org_run_id: params.org_run_id,
                    resolution_kind: params.resolution_kind,
                    resolved_by_member_id: params.resolved_by_member_id,
                    reason: params.reason,
                    replacement_inbox_id: params.replacement_inbox_id,
                    replacement_task_id: params.replacement_task_id,
                    created_at,
                })
            },
        )
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
                        CASE WHEN length(CAST(payload_json AS BLOB))<=?2
                             THEN payload_kind ELSE 'oversized_payload' END,
                        CASE WHEN length(CAST(payload_json AS BLOB))<=?2
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
                        display_preview,
                        delivery_resolution
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
                            ELSE NULL END AS display_preview,
                            (
                                SELECT resolution.resolution_kind
                                FROM agent_inbox_delivery_resolutions resolution
                                WHERE resolution.inbox_id=agent_inbox.id
                                LIMIT 1
                            ) AS delivery_resolution
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
                        SUM(CASE WHEN read_at IS NULL
                                      AND NOT EXISTS (
                                          SELECT 1
                                          FROM agent_inbox_delivery_resolutions resolution
                                          WHERE resolution.inbox_id=agent_inbox.id
                                      )
                                 THEN 1 ELSE 0 END) AS unread_count
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

    /// Load only the durable task ids that have ever received a TaskAssigned
    /// envelope in this run. Recovery uses this instead of decoding the full
    /// inbox history in Rust.
    #[cfg(test)]
    pub(super) fn task_assignment_ids_by_run(org_run_id: &str) -> Result<HashSet<String>, String> {
        let conn = get_connection().map_err(|err| err.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT json_extract(payload_json, '$.task_id')
                 FROM agent_inbox
                 WHERE org_run_id=?1
                   AND payload_kind='task_assigned'
                   AND json_valid(payload_json)
                   AND json_type(payload_json, '$.task_id')='text'",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(params![org_run_id], |row| row.get::<_, String>(0))
            .map_err(|err| err.to_string())?;
        let mut task_ids = HashSet::new();
        for row in rows {
            let task_id = row.map_err(|err| err.to_string())?;
            if !task_id.trim().is_empty() {
                task_ids.insert(task_id);
            }
        }
        Ok(task_ids)
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
        let mut task_stmt = conn
            .prepare(
                "SELECT id, owner
                 FROM agent_org_tasks
                 WHERE org_run_id=?1
                   AND status IN ('pending','in_progress')
                   AND owner IS NOT NULL
                 ORDER BY id ASC
                 LIMIT ?2",
            )
            .map_err(|err| err.to_string())?;
        let open_tasks = task_stmt
            .query_map(
                params![
                    org_run_id,
                    (crate::coordination::agent_org_payload_limits::TASK_RUN_MAX_TASKS + 1) as i64,
                ],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .map_err(|err| err.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())?;
        if open_tasks.len() > crate::coordination::agent_org_payload_limits::TASK_RUN_MAX_TASKS {
            return Err(
                "Agent Org task board exceeds the supported assignment snapshot limit".to_string(),
            );
        }

        // At most 200 exact probes are preferable to one nominally joined
        // query here. SQLite does not bind an outer task.id into the third
        // expression-index column and otherwise scans historical Inbox rows
        // plus a temp sort. One reused prepared statement with ?3 uses all
        // `(run, member, task_id)` keys and traverses rowid newest-first.
        let lookup_sql = task_assignment_lookup_sql();
        let mut assignment_stmt = conn.prepare(&lookup_sql).map_err(|err| err.to_string())?;
        let mut task_ids = HashSet::new();
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
                   AND read_at IS NULL
                   AND NOT EXISTS (
                       SELECT 1 FROM agent_inbox_delivery_resolutions resolution
                       WHERE resolution.inbox_id=agent_inbox.id
                   )",
                params![recipient_member_id, org_run_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|err| err.to_string())?;
        Ok(max_id.map(|max_id| format!("{max_id}:{count}")))
    }
}

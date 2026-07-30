//! Write path for [`AgentInboxStore`]: message persistence, run-gated and
//! causation-idempotent inserts, and the shared transactional insert core.

use rusqlite::{params, Connection};

use crate::coordination::agent_org_payload_limits as limits;
use database::db::{get_connection, with_sessions_writer};

use super::record::row_to_record;
use super::{AgentInboxRecord, AgentInboxStore, InsertInboxParams};

impl AgentInboxStore {
    /// Persist a message and return the inserted record. The caller is
    /// responsible for resolving display-name / broadcast targets to one or
    /// more concrete `AgentId`s before calling this — the store does not
    /// fan out by itself. The router owns that resolution.
    pub fn insert(params: InsertInboxParams) -> Result<AgentInboxRecord, String> {
        let changed_org_run_id = params.org_run_id.clone();
        let record = with_sessions_writer(|| -> Result<AgentInboxRecord, String> {
            let conn = get_connection().map_err(|err| err.to_string())?;
            Self::insert_in_tx(&conn, params)
        })?;
        if let Some(org_run_id) = changed_org_run_id {
            crate::coordination::agent_org_run_events::notify_agent_org_run_changed(&org_run_id);
        }
        Ok(record)
    }

    /// Atomically persist a recovery/outbox message only while its Agent Org
    /// run is still Running. This shares the sessions writer lock and an
    /// IMMEDIATE transaction with run finality, so a queued watchdog action
    /// cannot insert a new unread row after pause or terminal transition.
    pub(crate) fn insert_if_run_running(
        params: InsertInboxParams,
    ) -> Result<Option<AgentInboxRecord>, String> {
        let run_id = params
            .org_run_id
            .as_deref()
            .ok_or_else(|| "insert_if_run_running requires org_run_id".to_string())?
            .to_string();
        with_sessions_writer(|| -> Result<Option<AgentInboxRecord>, String> {
            let mut conn = get_connection().map_err(|err| err.to_string())?;
            let tx = conn
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .map_err(|err| err.to_string())?;
            let running: bool = tx
                .query_row(
                    "SELECT EXISTS(
                         SELECT 1 FROM agent_org_runs WHERE id=?1 AND status='running'
                     )",
                    params![&run_id],
                    |row| row.get(0),
                )
                .map_err(|err| err.to_string())?;
            if !running {
                tx.commit().map_err(|err| err.to_string())?;
                return Ok(None);
            }
            let record = Self::insert_in_tx(&tx, params)?;
            tx.commit().map_err(|err| err.to_string())?;
            Ok(Some(record))
        })
    }

    /// Persist a system-derived message at most once for a source inbox row.
    ///
    /// Inbox drain deliberately leaves source rows unread until the turn has
    /// been durably committed. A crash in that window replays the source row.
    /// `causation_inbox_id` makes the derived notification idempotent across
    /// that replay without making ordinary messages globally deduplicated.
    pub fn insert_once_for_causation(
        params: InsertInboxParams,
        causation_inbox_id: i64,
    ) -> Result<(AgentInboxRecord, bool), String> {
        if causation_inbox_id <= 0 {
            return Err("causation_inbox_id must be a positive inbox row id".into());
        }
        with_sessions_writer(|| -> Result<(AgentInboxRecord, bool), String> {
            let conn = get_connection().map_err(|err| err.to_string())?;
            Self::insert_in_tx_with_causation(&conn, params, Some(causation_inbox_id))
        })
    }

    /// Insert an inbox row using an existing writer transaction.
    ///
    /// This keeps state transitions such as "plan changes requested" and
    /// their durable feedback delivery atomic: a caller cannot commit the
    /// state change while losing the message that explains it.
    pub(crate) fn insert_in_tx(
        conn: &Connection,
        params: InsertInboxParams,
    ) -> Result<AgentInboxRecord, String> {
        Self::insert_in_tx_with_causation(conn, params, None).map(|(record, _inserted)| record)
    }

    fn insert_in_tx_with_causation(
        conn: &Connection,
        params: InsertInboxParams,
        causation_inbox_id: Option<i64>,
    ) -> Result<(AgentInboxRecord, bool), String> {
        limits::validate_required_text(
            "recipient_agent_id",
            &params.recipient_agent_id,
            limits::MESSAGE_IDENTIFIER_MAX_CHARS,
            limits::MESSAGE_IDENTIFIER_MAX_BYTES,
        )?;
        limits::validate_required_text(
            "sender_agent_id",
            &params.sender_agent_id,
            limits::MESSAGE_IDENTIFIER_MAX_CHARS,
            limits::MESSAGE_IDENTIFIER_MAX_BYTES,
        )?;
        for (field, value) in [
            ("recipient_member_id", params.recipient_member_id.as_deref()),
            ("sender_member_id", params.sender_member_id.as_deref()),
            ("org_run_id", params.org_run_id.as_deref()),
        ] {
            if let Some(value) = value {
                limits::validate_required_text(
                    field,
                    value,
                    limits::MESSAGE_IDENTIFIER_MAX_CHARS,
                    limits::MESSAGE_IDENTIFIER_MAX_BYTES,
                )?;
            }
        }
        if params.org_run_id.is_some() && params.recipient_member_id.is_none() {
            return Err(
                "Agent Org Inbox rows require recipient_member_id; legacy agent-only rows are read-only"
                    .to_string(),
            );
        }
        params.message.validate()?;

        let kind = params.message.kind_tag().to_string();
        let request_id = params.message.request_id().map(|r| r.0.clone());
        let payload_json = serde_json::to_string(&params.message)
            .map_err(|err| format!("serialize AgentMessage failed: {err}"))?;
        if payload_json.len() > limits::AGENT_INBOX_PAYLOAD_MAX_BYTES {
            return Err(format!(
                "Agent Inbox payload must be <= {} serialized bytes (got {} bytes)",
                limits::AGENT_INBOX_PAYLOAD_MAX_BYTES,
                payload_json.len()
            ));
        }
        let now = chrono::Utc::now().to_rfc3339();

        let insert_sql = if causation_inbox_id.is_some() {
            "INSERT OR IGNORE INTO agent_inbox (
                    recipient_agent_id,
                    recipient_member_id,
                    sender_agent_id,
                    sender_member_id,
                    org_run_id,
                    payload_kind,
                    payload_json,
                    request_id,
                    created_at,
                    read_at,
                    causation_inbox_id
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10)"
        } else {
            "INSERT INTO agent_inbox (
                    recipient_agent_id,
                    recipient_member_id,
                    sender_agent_id,
                    sender_member_id,
                    org_run_id,
                    payload_kind,
                    payload_json,
                    request_id,
                    created_at,
                    read_at,
                    causation_inbox_id
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10)"
        };
        let inserted = conn
            .execute(
                insert_sql,
                params![
                    &params.recipient_agent_id,
                    params.recipient_member_id.as_deref(),
                    &params.sender_agent_id,
                    params.sender_member_id.as_deref(),
                    params.org_run_id.as_deref(),
                    &kind,
                    &payload_json,
                    request_id.as_deref(),
                    &now,
                    causation_inbox_id,
                ],
            )
            .map_err(|err| err.to_string())?;

        if inserted == 0 {
            let source_id = causation_inbox_id.ok_or_else(|| {
                "ordinary Agent Inbox insert unexpectedly affected zero rows".to_string()
            })?;
            let existing = conn
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
                     FROM agent_inbox
                     WHERE causation_inbox_id = ?1
                       AND payload_kind = ?2
                       AND recipient_agent_id = ?3
                       AND COALESCE(recipient_member_id, '') = COALESCE(?4, '')
                     LIMIT 1",
                    params![
                        source_id,
                        &kind,
                        &params.recipient_agent_id,
                        params.recipient_member_id.as_deref(),
                    ],
                    row_to_record,
                )
                .map_err(|err| {
                    format!(
                        "caused Agent Inbox insert was coalesced but existing row lookup failed: {err}"
                    )
                })?;
            return Ok((existing, false));
        }

        let id = conn.last_insert_rowid();
        Ok((
            AgentInboxRecord {
                id,
                recipient_agent_id: params.recipient_agent_id,
                recipient_member_id: params.recipient_member_id,
                sender_agent_id: params.sender_agent_id,
                sender_member_id: params.sender_member_id,
                org_run_id: params.org_run_id,
                payload_kind: kind,
                payload_json,
                request_id,
                created_at: now,
                read_at: None,
            },
            true,
        ))
    }
}

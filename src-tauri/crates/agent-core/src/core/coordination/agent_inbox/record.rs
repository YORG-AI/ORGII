//! Persisted inbox-row DTOs, insertion parameters, and the `rusqlite`
//! row mappers shared by the store submodules.

use rusqlite::Result as SqliteResult;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::AgentMessage;

/// Persisted inbox row.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInboxRecord {
    pub id: i64,
    pub recipient_agent_id: String,
    pub recipient_member_id: Option<String>,
    pub sender_agent_id: String,
    pub sender_member_id: Option<String>,
    pub org_run_id: Option<String>,
    pub payload_kind: String,
    pub payload_json: String,
    pub request_id: Option<String>,
    pub created_at: String,
    pub read_at: Option<String>,
}

/// Aggregate inbox activity for one concrete recipient identity in a run.
///
/// `recipient_member_id` is canonical for materialized Agent Org members.
/// Historical coordinator rows may only carry `recipient_agent_id`, so both
/// identities stay available to the projection layer instead of being merged
/// through a potentially-colliding `COALESCE` key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInboxRecipientCounts {
    pub recipient_agent_id: String,
    pub recipient_member_id: Option<String>,
    pub activity_count: usize,
    pub unread_count: usize,
}

/// Payload-free unread totals used by recovery and high-frequency read views.
///
/// This deliberately has no historical activity count: periodic paths should
/// scan only the partial unread index, while durable history stays behind the
/// paginated Inbox APIs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentInboxUnreadRecipientCounts {
    pub recipient_agent_id: String,
    pub recipient_member_id: Option<String>,
    pub unread_count: usize,
    /// Highest unread row id for this exact recipient identity. Together
    /// with `unread_count` this is the payload-free identity used by recovery
    /// budgets; keeping it in the grouped snapshot avoids one query per
    /// member during every watchdog tick.
    pub max_unread_id: i64,
}

/// Lightweight row used by Run View / monitoring projections.
///
/// Deliberately excludes `payload_json`: a plan request can legally carry a
/// 256 KiB document, and a status panel must never retain hundreds of those
/// documents just to render a short activity label.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInboxPreviewRecord {
    pub id: i64,
    pub recipient_agent_id: String,
    pub recipient_member_id: Option<String>,
    pub sender_agent_id: String,
    pub sender_member_id: Option<String>,
    pub org_run_id: Option<String>,
    pub payload_kind: String,
    pub request_id: Option<String>,
    pub created_at: String,
    pub read_at: Option<String>,
    pub display_preview: Option<String>,
    pub delivery_resolution: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AgentInboxBatch {
    pub rows: Vec<AgentInboxRecord>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInboxPage {
    pub rows: Vec<AgentInboxRecord>,
    pub has_more: bool,
    pub next_cursor: Option<i64>,
}

/// Explicit disposition for an Inbox row that can no longer be delivered to
/// its original canonical recipient. The source row remains immutable and
/// unread for audit/history; operational readers treat a row with one of
/// these append-only records as no longer pending delivery.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentInboxDeliveryResolutionKind {
    Cancelled,
    Superseded,
}

impl AgentInboxDeliveryResolutionKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Cancelled => "cancelled",
            Self::Superseded => "superseded",
        }
    }

    pub(super) fn parse(value: &str) -> Result<Self, String> {
        match value {
            "cancelled" => Ok(Self::Cancelled),
            "superseded" => Ok(Self::Superseded),
            other => Err(format!(
                "unknown Agent Inbox delivery resolution kind: {other:?}"
            )),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInboxDeliveryResolution {
    pub inbox_id: i64,
    pub org_run_id: String,
    pub resolution_kind: AgentInboxDeliveryResolutionKind,
    pub resolved_by_member_id: String,
    pub reason: String,
    pub replacement_inbox_id: Option<i64>,
    pub replacement_task_id: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone)]
pub struct ResolveInboxDeliveryParams {
    pub inbox_id: i64,
    pub org_run_id: String,
    pub resolved_by_member_id: String,
    pub resolution_kind: AgentInboxDeliveryResolutionKind,
    pub reason: String,
    pub replacement_inbox_id: Option<i64>,
    pub replacement_task_id: Option<String>,
}

/// Typed boundary between expected coordinator corrections and infrastructure
/// failures. The LLM tool renders `Constraint` as recoverable guidance while
/// keeping SQLite/schema/locking failures as real execution failures.
#[derive(Debug, Error)]
pub enum ResolveInboxDeliveryError {
    #[error("{0}")]
    Constraint(String),
    #[error("{0}")]
    Storage(String),
}

impl AgentInboxRecord {
    /// Re-hydrate the typed `AgentMessage` from the persisted JSON
    /// payload. Returns a stable error string on schema drift; callers
    /// surface this through whichever transport applies (debug endpoint,
    /// LLM tool-error, drain-loop log).
    pub fn decode_payload(&self) -> Result<AgentMessage, String> {
        serde_json::from_str(&self.payload_json)
            .map_err(|err| format!("decode AgentMessage payload (id={}) failed: {err}", self.id))
    }
}

/// Insertion parameters for the inbox.
#[derive(Debug, Clone)]
pub struct InsertInboxParams {
    pub recipient_agent_id: String,
    pub recipient_member_id: Option<String>,
    pub sender_agent_id: String,
    pub sender_member_id: Option<String>,
    pub org_run_id: Option<String>,
    pub message: AgentMessage,
}

pub(super) fn row_to_record(row: &rusqlite::Row<'_>) -> SqliteResult<AgentInboxRecord> {
    Ok(AgentInboxRecord {
        id: row.get(0)?,
        recipient_agent_id: row.get(1)?,
        recipient_member_id: row.get(2)?,
        sender_agent_id: row.get(3)?,
        sender_member_id: row.get(4)?,
        org_run_id: row.get(5)?,
        payload_kind: row.get(6)?,
        payload_json: row.get(7)?,
        request_id: row.get(8)?,
        created_at: row.get(9)?,
        read_at: row.get(10)?,
    })
}

pub(super) fn row_to_preview_record(
    row: &rusqlite::Row<'_>,
) -> SqliteResult<AgentInboxPreviewRecord> {
    Ok(AgentInboxPreviewRecord {
        id: row.get(0)?,
        recipient_agent_id: row.get(1)?,
        recipient_member_id: row.get(2)?,
        sender_agent_id: row.get(3)?,
        sender_member_id: row.get(4)?,
        org_run_id: row.get(5)?,
        payload_kind: row.get(6)?,
        request_id: row.get(7)?,
        created_at: row.get(8)?,
        read_at: row.get(9)?,
        display_preview: row.get(10)?,
        delivery_resolution: row.get(11)?,
    })
}

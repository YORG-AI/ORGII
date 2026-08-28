use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FormalTriggerReceiptStatus {
    Pending,
    Materialized,
    Resolved,
}

impl FormalTriggerReceiptStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Materialized => "materialized",
            Self::Resolved => "resolved",
        }
    }

    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "pending" => Ok(Self::Pending),
            "materialized" => Ok(Self::Materialized),
            "resolved" => Ok(Self::Resolved),
            other => Err(format!("unknown FormalTriggerReceipt status: {other}")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FormalTriggerDoorbellStatus {
    Missing,
    Delivered,
    Suppressed,
}

impl FormalTriggerDoorbellStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Missing => "missing",
            Self::Delivered => "delivered",
            Self::Suppressed => "suppressed",
        }
    }

    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "missing" => Ok(Self::Missing),
            "delivered" => Ok(Self::Delivered),
            "suppressed" => Ok(Self::Suppressed),
            other => Err(format!(
                "unknown FormalTriggerReceipt doorbell status: {other}"
            )),
        }
    }
}

#[derive(Debug, Clone)]
pub struct FormalTriggerSource<'a> {
    pub trigger_kind: &'a str,
    pub trigger_id: &'a str,
    pub trigger_revision: i64,
    pub source_kind: &'a str,
    pub inbox_id: Option<i64>,
    pub task_id: Option<&'a str>,
    pub owner_member_id: Option<&'a str>,
    pub source_turn_intent_id: Option<&'a str>,
    pub task_output_digest: Option<&'a str>,
    pub plan_revision_id: Option<&'a str>,
    pub doorbell_status: FormalTriggerDoorbellStatus,
    pub initially_resolved: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormalTriggerReceipt {
    pub receipt_id: String,
    pub org_run_id: String,
    pub trigger_kind: String,
    pub trigger_id: String,
    pub trigger_revision: i64,
    pub source_kind: String,
    pub inbox_id: Option<i64>,
    pub task_id: Option<String>,
    pub owner_member_id: Option<String>,
    pub source_turn_intent_id: Option<String>,
    pub task_output_digest: Option<String>,
    pub plan_revision_id: Option<String>,
    #[serde(skip)]
    pub status: FormalTriggerReceiptStatus,
    #[serde(skip)]
    pub doorbell_status: FormalTriggerDoorbellStatus,
    pub current_attempt: i64,
    pub materialized_input_id: Option<String>,
    pub materialized_event_id: Option<String>,
    pub resolved_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormalTriggerActivity {
    pub pending_count: usize,
    pub materialized_count: usize,
    pub pending_receipt_ids: Vec<String>,
    pub coordinator_observing: bool,
}

fn validate_source(source: &FormalTriggerSource<'_>) -> Result<(), String> {
    if source.trigger_kind.trim().is_empty()
        || source.trigger_id.trim().is_empty()
        || source.source_kind.trim().is_empty()
    {
        return Err("FormalTriggerReceipt kind, id, and source must not be empty".to_string());
    }
    if source.trigger_revision < 1 {
        return Err("FormalTriggerReceipt revision must be >= 1".to_string());
    }
    for (field, value) in [
        ("task_id", source.task_id),
        ("owner_member_id", source.owner_member_id),
        ("source_turn_intent_id", source.source_turn_intent_id),
        ("plan_revision_id", source.plan_revision_id),
    ] {
        if value.is_some_and(|value| value.trim().is_empty()) {
            return Err(format!(
                "FormalTriggerReceipt {field} must not be empty when present"
            ));
        }
    }
    if source.task_output_digest.is_some_and(|digest| {
        digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit())
    }) {
        return Err("FormalTriggerReceipt task_output_digest must be a SHA-256 digest".to_string());
    }
    Ok(())
}

pub(crate) fn record_trigger_in_tx(
    tx: &Connection,
    org_run_id: &str,
    source: FormalTriggerSource<'_>,
) -> Result<FormalTriggerReceipt, String> {
    validate_source(&source)?;
    let run_is_running: bool = tx
        .query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM agent_org_runtime_runs
                 WHERE id=?1 AND status='running'
             )",
            [org_run_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if !run_is_running {
        return Err(format!(
            "FormalTriggerReceipt requires a running Agent Org run: {org_run_id}"
        ));
    }

    let receipt_id = stable_receipt_id(
        org_run_id,
        source.trigger_kind,
        source.trigger_id,
        source.trigger_revision,
    );
    let now = chrono::Utc::now().to_rfc3339();
    let status = if source.initially_resolved {
        FormalTriggerReceiptStatus::Resolved
    } else {
        FormalTriggerReceiptStatus::Pending
    };
    let resolved_at = source.initially_resolved.then_some(now.as_str());
    tx.execute(
        "INSERT INTO agent_org_runtime_formal_trigger_receipts (
             receipt_id,org_run_id,trigger_kind,trigger_id,trigger_revision,
             source_kind,target_member_id,inbox_id,task_id,owner_member_id,
             source_turn_intent_id,task_output_digest,plan_revision_id,status,
             doorbell_status,doorbell_delivered_at,current_attempt,
             materialized_input_id,materialized_event_id,resolved_at,
             created_at,updated_at
         ) VALUES (
             ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,
             CASE WHEN ?15='delivered' THEN ?16 ELSE NULL END,
             0,NULL,NULL,?17,?16,?16
         )
         ON CONFLICT(org_run_id,trigger_kind,trigger_id,trigger_revision) DO NOTHING",
        params![
            &receipt_id,
            org_run_id,
            source.trigger_kind,
            source.trigger_id,
            source.trigger_revision,
            source.source_kind,
            COORDINATOR_MEMBER_ID,
            source.inbox_id,
            source.task_id,
            source.owner_member_id,
            source.source_turn_intent_id,
            source.task_output_digest,
            source.plan_revision_id,
            status.as_str(),
            source.doorbell_status.as_str(),
            &now,
            resolved_at,
        ],
    )
    .map_err(|error| error.to_string())?;

    let existing = get_by_identity_with_connection(
        tx,
        org_run_id,
        source.trigger_kind,
        source.trigger_id,
        source.trigger_revision,
    )?
    .ok_or_else(|| "FormalTriggerReceipt missing after insert".to_string())?;
    if existing.source_kind != source.source_kind
        || existing.inbox_id != source.inbox_id
        || existing.task_id.as_deref() != source.task_id
        || existing.owner_member_id.as_deref() != source.owner_member_id
        || existing.source_turn_intent_id.as_deref() != source.source_turn_intent_id
        || existing.task_output_digest.as_deref() != source.task_output_digest
        || existing.plan_revision_id.as_deref() != source.plan_revision_id
    {
        return Err(format!(
            "FormalTriggerReceipt identity replay conflict for {receipt_id}"
        ));
    }
    tracing::debug!(
        org_run_id,
        receipt_id,
        trigger_kind = source.trigger_kind,
        trigger_id = source.trigger_id,
        trigger_revision = source.trigger_revision,
        status = existing.status.as_str(),
        doorbell_status = existing.doorbell_status.as_str(),
        "[agent_org_metric] formal_trigger_recorded"
    );
    Ok(existing)
}

pub(crate) struct InboxFormalTriggerSource<'a> {
    pub source_kind: &'a str,
    pub task_id: Option<&'a str>,
    pub owner_member_id: Option<&'a str>,
    pub source_turn_intent_id: Option<&'a str>,
    pub task_output_digest: Option<&'a str>,
    pub plan_revision_id: Option<&'a str>,
    pub suppress_self_wake: bool,
}

pub(crate) fn record_inbox_trigger_in_tx(
    tx: &Connection,
    org_run_id: &str,
    inbox_id: i64,
    source: InboxFormalTriggerSource<'_>,
) -> Result<FormalTriggerReceipt, String> {
    record_trigger_in_tx(
        tx,
        org_run_id,
        FormalTriggerSource {
            trigger_kind: "inbox",
            trigger_id: &inbox_id.to_string(),
            trigger_revision: 1,
            source_kind: source.source_kind,
            inbox_id: Some(inbox_id),
            task_id: source.task_id,
            owner_member_id: source.owner_member_id,
            source_turn_intent_id: source.source_turn_intent_id,
            task_output_digest: source.task_output_digest,
            plan_revision_id: source.plan_revision_id,
            doorbell_status: if source.suppress_self_wake {
                FormalTriggerDoorbellStatus::Suppressed
            } else {
                FormalTriggerDoorbellStatus::Missing
            },
            initially_resolved: source.suppress_self_wake,
        },
    )
}

pub(crate) fn mark_doorbell_delivered_with_connection(
    tx: &Connection,
    receipt_id: &str,
) -> Result<bool, String> {
    let now = chrono::Utc::now().to_rfc3339();
    let updated = tx
        .execute(
            "UPDATE agent_org_runtime_formal_trigger_receipts
             SET doorbell_status='delivered',doorbell_delivered_at=?2,updated_at=?2
             WHERE receipt_id=?1 AND status='pending' AND doorbell_status='missing'",
            params![receipt_id, &now],
        )
        .map_err(|error| error.to_string())?;
    Ok(updated == 1)
}

pub fn mark_doorbells_delivered(receipt_ids: &[String]) -> Result<usize, String> {
    if receipt_ids.is_empty() {
        return Ok(0);
    }
    database::db::with_sessions_writer(|| {
        let conn = database::db::get_connection().map_err(|error| error.to_string())?;
        let mut updated = 0usize;
        for receipt_id in receipt_ids {
            if mark_doorbell_delivered_with_connection(&conn, receipt_id)? {
                updated = updated.saturating_add(1);
            }
        }
        Ok(updated)
    })
}

pub fn missing_doorbell_ids_for_run(org_run_id: &str, limit: usize) -> Result<Vec<String>, String> {
    let conn = database::db::get_connection().map_err(|error| error.to_string())?;
    let limit = limit.clamp(1, 100) as i64;
    let mut stmt = conn
        .prepare(
            "SELECT receipt.receipt_id
             FROM agent_org_runtime_formal_trigger_receipts receipt
             JOIN agent_org_runtime_runs run ON run.id=receipt.org_run_id
             WHERE receipt.org_run_id=?1 AND run.status='running'
               AND receipt.status='pending' AND receipt.doorbell_status='missing'
               AND NOT EXISTS (
                   SELECT 1 FROM agent_org_runtime_formal_trigger_attempts attempt
                   WHERE attempt.receipt_id=receipt.receipt_id
                     AND attempt.status IN ('queued','running')
               )
             ORDER BY receipt.created_at,receipt.receipt_id
             LIMIT ?2",
        )
        .map_err(|error| error.to_string())?;
    let receipt_ids = stmt
        .query_map(params![org_run_id, limit], |row| row.get(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<String>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(receipt_ids)
}

pub(crate) fn list_missing_doorbells_with_connection(
    conn: &Connection,
    limit: usize,
) -> Result<Vec<FormalTriggerReceipt>, String> {
    let limit = limit.clamp(1, 100) as i64;
    let mut stmt = conn
        .prepare(
            "SELECT receipt_id,org_run_id,trigger_kind,trigger_id,trigger_revision,
                    source_kind,inbox_id,task_id,owner_member_id,source_turn_intent_id,
                    task_output_digest,plan_revision_id,status,doorbell_status,
                    current_attempt,materialized_input_id,materialized_event_id,resolved_at,
                    created_at,updated_at
             FROM agent_org_runtime_formal_trigger_receipts receipt
             WHERE receipt.status='pending' AND receipt.doorbell_status='missing'
               AND EXISTS (
                   SELECT 1 FROM agent_org_runtime_runs run
                   WHERE run.id=receipt.org_run_id AND run.status='running'
               )
               AND NOT EXISTS (
                   SELECT 1 FROM agent_org_runtime_formal_trigger_attempts attempt
                   WHERE attempt.receipt_id=receipt.receipt_id
                     AND attempt.status IN ('queued','running')
               )
             ORDER BY receipt.created_at,receipt.receipt_id
             LIMIT ?1",
        )
        .map_err(|error| error.to_string())?;
    let receipts = stmt
        .query_map([limit], row_to_receipt)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(receipts)
}

pub fn activity_with_connection(
    conn: &Connection,
    org_run_id: &str,
    limit: usize,
) -> Result<FormalTriggerActivity, String> {
    let (pending, materialized): (i64, i64) = conn
        .query_row(
            "SELECT
                 SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END),
                 SUM(CASE WHEN status='materialized' THEN 1 ELSE 0 END)
             FROM agent_org_runtime_formal_trigger_receipts
             WHERE org_run_id=?1",
            [org_run_id],
            |row| {
                Ok((
                    row.get::<_, Option<i64>>(0)?.unwrap_or(0),
                    row.get::<_, Option<i64>>(1)?.unwrap_or(0),
                ))
            },
        )
        .map_err(|error| error.to_string())?;
    let limit = limit.clamp(1, 100) as i64;
    let mut stmt = conn
        .prepare(
            "SELECT receipt_id
             FROM agent_org_runtime_formal_trigger_receipts
             WHERE org_run_id=?1 AND status='pending'
             ORDER BY created_at,receipt_id LIMIT ?2",
        )
        .map_err(|error| error.to_string())?;
    let pending_receipt_ids = stmt
        .query_map(params![org_run_id, limit], |row| row.get(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<String>, _>>()
        .map_err(|error| error.to_string())?;
    let coordinator_observing = conn
        .query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM agent_org_runtime_formal_trigger_attempts attempt
                 JOIN agent_org_runtime_formal_trigger_receipts receipt
                   ON receipt.receipt_id=attempt.receipt_id
                 WHERE receipt.org_run_id=?1
                   AND attempt.status IN ('queued','running')
             )",
            [org_run_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    Ok(FormalTriggerActivity {
        pending_count: usize::try_from(pending).unwrap_or(usize::MAX),
        materialized_count: usize::try_from(materialized).unwrap_or(usize::MAX),
        pending_receipt_ids,
        coordinator_observing,
    })
}

fn stable_receipt_id(run_id: &str, kind: &str, id: &str, revision: i64) -> String {
    let material = format!("{run_id}\0{kind}\0{id}\0{revision}");
    format!(
        "formal-trigger-{}",
        blake3::hash(material.as_bytes()).to_hex()
    )
}

fn get_by_identity_with_connection(
    conn: &Connection,
    run_id: &str,
    kind: &str,
    id: &str,
    revision: i64,
) -> Result<Option<FormalTriggerReceipt>, String> {
    conn.query_row(
        "SELECT receipt_id,org_run_id,trigger_kind,trigger_id,trigger_revision,
                source_kind,inbox_id,task_id,owner_member_id,source_turn_intent_id,
                task_output_digest,plan_revision_id,status,doorbell_status,
                current_attempt,materialized_input_id,materialized_event_id,resolved_at,
                created_at,updated_at
         FROM agent_org_runtime_formal_trigger_receipts
         WHERE org_run_id=?1 AND trigger_kind=?2 AND trigger_id=?3 AND trigger_revision=?4",
        params![run_id, kind, id, revision],
        row_to_receipt,
    )
    .optional()
    .map_err(|error| error.to_string())
}

fn row_to_receipt(row: &rusqlite::Row<'_>) -> rusqlite::Result<FormalTriggerReceipt> {
    let status: String = row.get(12)?;
    let doorbell: String = row.get(13)?;
    Ok(FormalTriggerReceipt {
        receipt_id: row.get(0)?,
        org_run_id: row.get(1)?,
        trigger_kind: row.get(2)?,
        trigger_id: row.get(3)?,
        trigger_revision: row.get(4)?,
        source_kind: row.get(5)?,
        inbox_id: row.get(6)?,
        task_id: row.get(7)?,
        owner_member_id: row.get(8)?,
        source_turn_intent_id: row.get(9)?,
        task_output_digest: row.get(10)?,
        plan_revision_id: row.get(11)?,
        status: FormalTriggerReceiptStatus::parse(&status).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                12,
                rusqlite::types::Type::Text,
                std::io::Error::new(std::io::ErrorKind::InvalidData, error).into(),
            )
        })?,
        doorbell_status: FormalTriggerDoorbellStatus::parse(&doorbell).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                13,
                rusqlite::types::Type::Text,
                std::io::Error::new(std::io::ErrorKind::InvalidData, error).into(),
            )
        })?,
        current_attempt: row.get(14)?,
        materialized_input_id: row.get(15)?,
        materialized_event_id: row.get(16)?,
        resolved_at: row.get(17)?,
        created_at: row.get(18)?,
        updated_at: row.get(19)?,
    })
}

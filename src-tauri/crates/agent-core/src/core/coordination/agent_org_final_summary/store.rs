use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use sha2::Digest;

use crate::coordination::agent_org_run_completion::RunCompletionCertificate;
use crate::coordination::agent_org_tasks::AgentOrgTaskStore;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FinalSummaryStatus {
    Pending,
    Running,
    Persisting,
    Persisted,
    Failed,
}

impl FinalSummaryStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Persisting => "persisting",
            Self::Persisted => "persisted",
            Self::Failed => "failed",
        }
    }

    pub const fn is_finalizing(self) -> bool {
        matches!(self, Self::Pending | Self::Running | Self::Persisting)
    }

    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "pending" => Ok(Self::Pending),
            "running" => Ok(Self::Running),
            "persisting" => Ok(Self::Persisting),
            "persisted" => Ok(Self::Persisted),
            "failed" => Ok(Self::Failed),
            other => Err(format!("unknown FinalSummaryReceipt status: {other}")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalSummaryReceipt {
    pub receipt_id: String,
    pub org_run_id: String,
    pub activation_generation: i64,
    pub certificate_id: String,
    pub evidence_digest: String,
    pub attempt: i64,
    pub status: FinalSummaryStatus,
    pub coordinator_session_id: String,
    pub turn_intent_id: Option<String>,
    pub started_at: Option<String>,
    pub terminal_at: Option<String>,
    pub event_id: Option<String>,
    pub typed_error: Option<String>,
    pub can_retry: bool,
    pub created_at: String,
    pub updated_at: String,
}

pub(crate) fn create_initial_for_certificate_in_tx(
    tx: &Connection,
    certificate: &RunCompletionCertificate,
) -> Result<FinalSummaryReceipt, String> {
    if let Some(existing) = load_attempt_with_connection(tx, &certificate.id, 1)? {
        let expected = evidence_digest_with_connection(tx, certificate)?;
        if existing.evidence_digest != expected {
            return Err("final_summary_initial_evidence_conflict".to_string());
        }
        return Ok(existing);
    }
    let evidence_digest = evidence_digest_with_connection(tx, certificate)?;
    let receipt_id = stable_receipt_id(&certificate.id, 1);
    let now = chrono::Utc::now().to_rfc3339();
    tx.execute(
        "INSERT INTO agent_org_runtime_final_summary_receipts (
             receipt_id,org_run_id,activation_generation,certificate_id,
             evidence_digest,attempt,status,coordinator_session_id,
             turn_intent_id,retry_request_id,started_at,terminal_at,event_id,
             typed_error,created_at,updated_at
         ) VALUES (?1,?2,?3,?4,?5,1,'pending',?6,NULL,NULL,NULL,NULL,NULL,NULL,?7,?7)",
        params![
            &receipt_id,
            &certificate.org_run_id,
            certificate.activation_generation,
            &certificate.id,
            &evidence_digest,
            &certificate.coordinator_session_id,
            &now,
        ],
    )
    .map_err(|error| error.to_string())?;
    crate::coordination::agent_org_formal_triggers::record_trigger_in_tx(
        tx,
        &certificate.org_run_id,
        crate::coordination::agent_org_formal_triggers::FormalTriggerSource {
            trigger_kind: "final_summary",
            trigger_id: &receipt_id,
            trigger_revision: 1,
            source_kind: "final_summary",
            inbox_id: None,
            task_id: None,
            owner_member_id: Some("coordinator"),
            source_turn_intent_id: Some(&certificate.coordinator_turn_intent_id),
            task_output_digest: Some(&evidence_digest),
            plan_revision_id: None,
            doorbell_status:
                crate::coordination::agent_org_formal_triggers::FormalTriggerDoorbellStatus::Missing,
            initially_resolved: false,
        },
    )?;
    tracing::debug!(
        org_run_id = certificate.org_run_id,
        certificate_id = certificate.id,
        receipt_id,
        evidence_digest,
        attempt = 1,
        "[agent_org_metric] final_summary_attempt_created"
    );
    load_attempt_with_connection(tx, &certificate.id, 1)?
        .ok_or_else(|| "FinalSummaryReceipt missing after insert".to_string())
}

pub(crate) fn claim_pending_for_coordinator_turn_in_tx(
    tx: &Connection,
    org_run_id: &str,
    coordinator_session_id: &str,
    turn_intent_id: &str,
) -> Result<Option<FinalSummaryReceipt>, String> {
    let pending: Option<(String, String)> = tx
        .query_row(
            "SELECT receipt_id,coordinator_session_id
             FROM agent_org_runtime_final_summary_receipts
             WHERE org_run_id=?1 AND status='pending'
             ORDER BY attempt DESC LIMIT 1",
            [org_run_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some((receipt_id, expected_session_id)) = pending else {
        return Ok(None);
    };
    if expected_session_id != coordinator_session_id {
        return Err("final_summary_root_session_mismatch".to_string());
    }
    let now = chrono::Utc::now().to_rfc3339();
    let updated = tx
        .execute(
            "UPDATE agent_org_runtime_final_summary_receipts
             SET status='running',turn_intent_id=?2,started_at=?3,updated_at=?3
             WHERE receipt_id=?1 AND status='pending'",
            params![&receipt_id, turn_intent_id, &now],
        )
        .map_err(|error| error.to_string())?;
    if updated != 1 {
        return Err("final_summary_claim_conflict".to_string());
    }
    let resolved_trigger = tx
        .execute(
            "UPDATE agent_org_runtime_formal_trigger_receipts
         SET status='resolved',doorbell_status='suppressed',resolved_at=?2,updated_at=?2
         WHERE org_run_id=?1 AND trigger_kind='final_summary'
           AND trigger_id=?3 AND status='pending'",
            params![org_run_id, &now, &receipt_id],
        )
        .map_err(|error| error.to_string())?;
    if resolved_trigger != 1 {
        return Err("final_summary_formal_trigger_claim_conflict".to_string());
    }
    load_by_receipt_with_connection(tx, &receipt_id)
}

pub(crate) fn is_summary_turn_with_connection(
    conn: &Connection,
    session_id: &str,
    turn_intent_id: &str,
) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM agent_org_runtime_final_summary_receipts
             WHERE coordinator_session_id=?1 AND turn_intent_id=?2
               AND status IN ('running','persisting')
         )",
        params![session_id, turn_intent_id],
        |row| row.get(0),
    )
    .map_err(|error| error.to_string())
}

pub(crate) fn has_summary_receipt_for_turn_with_connection(
    conn: &Connection,
    session_id: &str,
    turn_intent_id: &str,
) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM agent_org_runtime_final_summary_receipts
             WHERE coordinator_session_id=?1 AND turn_intent_id=?2
         )",
        params![session_id, turn_intent_id],
        |row| row.get(0),
    )
    .map_err(|error| error.to_string())
}

pub(crate) fn is_summary_turn(session_id: &str, turn_intent_id: &str) -> Result<bool, String> {
    let conn = database::db::get_connection().map_err(|error| error.to_string())?;
    is_summary_turn_with_connection(&conn, session_id, turn_intent_id)
}

pub(crate) fn status_for_turn(
    session_id: &str,
    turn_intent_id: &str,
) -> Result<Option<FinalSummaryStatus>, String> {
    let conn = database::db::get_connection().map_err(|error| error.to_string())?;
    let raw: Option<String> = conn
        .query_row(
            "SELECT status FROM agent_org_runtime_final_summary_receipts
             WHERE coordinator_session_id=?1 AND turn_intent_id=?2",
            params![session_id, turn_intent_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    raw.map(|status| FinalSummaryStatus::parse(&status))
        .transpose()
}

pub(crate) fn certificate_for_turn(
    session_id: &str,
    turn_intent_id: &str,
) -> Result<Option<RunCompletionCertificate>, String> {
    let conn = database::db::get_connection().map_err(|error| error.to_string())?;
    let certificate_id: Option<String> = conn
        .query_row(
            "SELECT certificate_id
             FROM agent_org_runtime_final_summary_receipts
             WHERE coordinator_session_id=?1 AND turn_intent_id=?2",
            params![session_id, turn_intent_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    match certificate_id {
        Some(certificate_id) => {
            crate::coordination::agent_org_run_completion::load_with_connection(
                &conn,
                &certificate_id,
            )
        }
        None => Ok(None),
    }
}

pub(crate) fn stable_event_id_for_turn(
    session_id: &str,
    turn_intent_id: &str,
) -> Result<Option<String>, String> {
    let conn = database::db::get_connection().map_err(|error| error.to_string())?;
    let receipt_id: Option<String> = conn
        .query_row(
            "SELECT receipt_id
             FROM agent_org_runtime_final_summary_receipts
             WHERE coordinator_session_id=?1 AND turn_intent_id=?2
               AND status IN ('running','persisting')",
            params![session_id, turn_intent_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    Ok(receipt_id.map(|receipt_id| stable_event_id(&receipt_id)))
}

pub(crate) fn mark_persisting_for_turn(
    session_id: &str,
    turn_intent_id: &str,
) -> Result<bool, String> {
    update_turn_status(
        session_id,
        turn_intent_id,
        "running",
        "persisting",
        None,
        None,
    )
}

pub(crate) fn mark_persisted_for_turn(
    session_id: &str,
    turn_intent_id: &str,
    event_id: &str,
) -> Result<bool, String> {
    if event_id.trim().is_empty() {
        return Err("final_summary_event_id_invalid".to_string());
    }
    update_turn_status(
        session_id,
        turn_intent_id,
        "persisting",
        "persisted",
        Some(event_id),
        None,
    )
}

pub(crate) fn mark_failed_for_turn(
    session_id: &str,
    turn_intent_id: &str,
    typed_error: &str,
) -> Result<bool, String> {
    let typed_error = typed_error.trim();
    if typed_error.is_empty() {
        return Err("final_summary_typed_error_required".to_string());
    }
    database::db::with_sessions_writer(|| {
        let conn = database::db::get_connection().map_err(|error| error.to_string())?;
        let now = chrono::Utc::now().to_rfc3339();
        let changed = conn
            .execute(
                "UPDATE agent_org_runtime_final_summary_receipts
                 SET status='failed',typed_error=?3,terminal_at=?4,updated_at=?4
                 WHERE coordinator_session_id=?1 AND turn_intent_id=?2
                   AND status IN ('running','persisting')",
                params![session_id, turn_intent_id, typed_error, &now],
            )
            .map_err(|error| error.to_string())?;
        Ok(changed == 1)
    })
}

fn update_turn_status(
    session_id: &str,
    turn_intent_id: &str,
    expected: &str,
    next: &str,
    event_id: Option<&str>,
    typed_error: Option<&str>,
) -> Result<bool, String> {
    database::db::with_sessions_writer(|| {
        let conn = database::db::get_connection().map_err(|error| error.to_string())?;
        let now = chrono::Utc::now().to_rfc3339();
        let terminal = matches!(next, "persisted" | "failed");
        let changed = conn
            .execute(
                "UPDATE agent_org_runtime_final_summary_receipts
                 SET status=?4,event_id=?5,typed_error=?6,
                     terminal_at=CASE WHEN ?7 THEN ?8 ELSE terminal_at END,
                     updated_at=?8
                 WHERE coordinator_session_id=?1 AND turn_intent_id=?2 AND status=?3",
                params![
                    session_id,
                    turn_intent_id,
                    expected,
                    next,
                    event_id,
                    typed_error,
                    terminal,
                    &now,
                ],
            )
            .map_err(|error| error.to_string())?;
        Ok(changed == 1)
    })
}

pub(crate) fn active_for_run_with_connection(
    conn: &Connection,
    org_run_id: &str,
    generation: i64,
) -> Result<Option<FinalSummaryReceipt>, String> {
    conn.query_row(
        &format!(
            "SELECT {RECEIPT_COLUMNS}
             FROM agent_org_runtime_final_summary_receipts
             WHERE org_run_id=?1 AND activation_generation=?2
             ORDER BY attempt DESC LIMIT 1"
        ),
        params![org_run_id, generation],
        row_to_receipt,
    )
    .optional()
    .map_err(|error| error.to_string())
}

pub(crate) fn retry_failed(
    org_run_id: &str,
    certificate_id: &str,
    failed_attempt: i64,
    request_id: &str,
) -> Result<FinalSummaryReceipt, String> {
    let request_id = request_id.trim();
    if request_id.is_empty() {
        return Err("final_summary_retry_request_id_required".to_string());
    }
    database::db::with_sessions_writer(|| {
        let conn = database::db::get_connection().map_err(|error| error.to_string())?;
        let tx = database::db::begin_immediate(&conn).map_err(|error| error.to_string())?;
        if let Some(existing) = tx
            .query_row(
                &format!(
                    "SELECT {RECEIPT_COLUMNS}
                     FROM agent_org_runtime_final_summary_receipts
                     WHERE certificate_id=?1 AND retry_request_id=?2"
                ),
                params![certificate_id, request_id],
                row_to_receipt,
            )
            .optional()
            .map_err(|error| error.to_string())?
        {
            let expected_attempt = failed_attempt
                .checked_add(1)
                .ok_or_else(|| "final_summary_retry_attempt_overflow".to_string())?;
            if existing.org_run_id != org_run_id || existing.attempt != expected_attempt {
                return Err("final_summary_retry_request_replay_conflict".to_string());
            }
            tx.commit().map_err(|error| error.to_string())?;
            return Ok(existing);
        }
        let failed = load_attempt_with_connection(&tx, certificate_id, failed_attempt)?
            .ok_or_else(|| "final_summary_failed_attempt_not_found".to_string())?;
        if failed.status != FinalSummaryStatus::Failed {
            return Err("final_summary_retry_requires_failed_attempt".to_string());
        }
        let current_attempt: i64 = tx
            .query_row(
                "SELECT MAX(attempt) FROM agent_org_runtime_final_summary_receipts
                 WHERE certificate_id=?1",
                [certificate_id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if current_attempt != failed_attempt {
            return Err("final_summary_retry_attempt_is_stale".to_string());
        }
        let certificate = crate::coordination::agent_org_run_completion::load_with_connection(
            &tx,
            certificate_id,
        )?
        .ok_or_else(|| "final_summary_certificate_not_found".to_string())?;
        if certificate.org_run_id != org_run_id {
            return Err("final_summary_certificate_run_mismatch".to_string());
        }
        let digest = evidence_digest_with_connection(&tx, &certificate)?;
        if digest != failed.evidence_digest {
            return Err("final_summary_retry_evidence_conflict".to_string());
        }
        let attempt = failed_attempt
            .checked_add(1)
            .ok_or_else(|| "final_summary_retry_attempt_overflow".to_string())?;
        let receipt_id = stable_receipt_id(certificate_id, attempt);
        let now = chrono::Utc::now().to_rfc3339();
        let reactivated = tx
            .execute(
                "UPDATE agent_org_runtime_runs
                 SET status='running',idled_at=NULL,updated_at=?3
                 WHERE id=?1 AND status='idle' AND activation_generation=?2",
                params![
                    &certificate.org_run_id,
                    certificate.activation_generation,
                    &now
                ],
            )
            .map_err(|error| error.to_string())?;
        if reactivated != 1 {
            return Err("final_summary_retry_requires_idle_current_generation".to_string());
        }
        tx.execute(
            "INSERT INTO agent_org_runtime_final_summary_receipts (
                 receipt_id,org_run_id,activation_generation,certificate_id,
                 evidence_digest,attempt,status,coordinator_session_id,
                 turn_intent_id,retry_request_id,started_at,terminal_at,event_id,
                 typed_error,created_at,updated_at
             ) VALUES (?1,?2,?3,?4,?5,?6,'pending',?7,NULL,?8,NULL,NULL,NULL,NULL,?9,?9)",
            params![
                &receipt_id,
                &certificate.org_run_id,
                certificate.activation_generation,
                certificate_id,
                &digest,
                attempt,
                &certificate.coordinator_session_id,
                request_id,
                &now,
            ],
        )
        .map_err(|error| error.to_string())?;
        crate::coordination::agent_org_formal_triggers::record_trigger_in_tx(
            &tx,
            &certificate.org_run_id,
            crate::coordination::agent_org_formal_triggers::FormalTriggerSource {
                trigger_kind: "final_summary",
                trigger_id: &receipt_id,
                trigger_revision: attempt,
                source_kind: "final_summary_retry",
                inbox_id: None,
                task_id: None,
                owner_member_id: Some("coordinator"),
                source_turn_intent_id: None,
                task_output_digest: Some(&digest),
                plan_revision_id: None,
                doorbell_status: crate::coordination::agent_org_formal_triggers::FormalTriggerDoorbellStatus::Missing,
                initially_resolved: false,
            },
        )?;
        let receipt = load_by_receipt_with_connection(&tx, &receipt_id)?
            .ok_or_else(|| "FinalSummaryReceipt retry missing after insert".to_string())?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok(receipt)
    })
}

pub(crate) fn reconcile_after_restart(conn: &Connection) -> Result<usize, String> {
    let now = chrono::Utc::now().to_rfc3339();
    let rows = {
        let mut stmt = conn
            .prepare(
                "SELECT receipt_id,coordinator_session_id
                 FROM agent_org_runtime_final_summary_receipts
                 WHERE status IN ('running','persisting') AND event_id IS NULL
                 ORDER BY created_at,receipt_id",
            )
            .map_err(|error| error.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        rows
    };
    let mut reconciled = 0usize;
    for (receipt_id, session_id) in rows {
        let event_id = stable_event_id(&receipt_id);
        let persisted: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM events WHERE id=?1 AND session_id=?2)",
                params![&event_id, &session_id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        let changed = if persisted {
            conn.execute(
                "UPDATE agent_org_runtime_final_summary_receipts
                 SET status='persisted',event_id=?2,terminal_at=?3,updated_at=?3
                 WHERE receipt_id=?1 AND status IN ('running','persisting')
                   AND event_id IS NULL",
                params![&receipt_id, &event_id, &now],
            )
        } else {
            conn.execute(
                "UPDATE agent_org_runtime_final_summary_receipts
                 SET status='failed',typed_error='started_but_output_unknown_after_restart',
                     terminal_at=?2,updated_at=?2
                 WHERE receipt_id=?1 AND status IN ('running','persisting')
                   AND event_id IS NULL",
                params![&receipt_id, &now],
            )
        }
        .map_err(|error| error.to_string())?;
        reconciled = reconciled.saturating_add(changed);
    }
    Ok(reconciled)
}

fn evidence_digest_with_connection(
    conn: &Connection,
    certificate: &RunCompletionCertificate,
) -> Result<String, String> {
    let tasks = AgentOrgTaskStore::list_with_connection(conn, &certificate.org_run_id)?;
    let mut outputs = certificate
        .task_output_refs
        .iter()
        .map(|reference| {
            let task = tasks
                .iter()
                .find(|task| task.id == reference.task_id)
                .ok_or_else(|| format!("final_summary_task_missing:{}", reference.task_id))?;
            let output = task
                .output
                .as_ref()
                .ok_or_else(|| format!("final_summary_output_missing:{}", reference.task_id))?;
            let encoded = serde_json::to_value(output).map_err(|error| error.to_string())?;
            Ok((
                reference.task_id.clone(),
                reference.output_digest.clone(),
                encoded,
            ))
        })
        .collect::<Result<Vec<_>, String>>()?;
    outputs.sort_by(|left, right| left.0.cmp(&right.0));
    let value = serde_json::json!({
        "certificateId": certificate.id,
        "generation": certificate.activation_generation,
        "requestDigest": certificate.request_digest,
        "outcome": certificate.outcome,
        "evidenceTaskIds": certificate.evidence_task_ids,
        "closureTaskIds": certificate.closure_task_ids,
        "taskOutputs": outputs,
        "resolutionLinks": certificate.resolution_links,
        "validatorVersion": certificate.validator_version,
    });
    let encoded = serde_json::to_vec(&value).map_err(|error| error.to_string())?;
    Ok(format!("{:x}", sha2::Sha256::digest(encoded)))
}

fn stable_receipt_id(certificate_id: &str, attempt: i64) -> String {
    let material = format!("{certificate_id}\0{attempt}");
    format!(
        "final-summary-{}",
        blake3::hash(material.as_bytes()).to_hex()
    )
}

fn stable_event_id(receipt_id: &str) -> String {
    format!("agent-org-{receipt_id}")
}

fn load_attempt_with_connection(
    conn: &Connection,
    certificate_id: &str,
    attempt: i64,
) -> Result<Option<FinalSummaryReceipt>, String> {
    conn.query_row(
        &format!(
            "SELECT {RECEIPT_COLUMNS}
             FROM agent_org_runtime_final_summary_receipts
             WHERE certificate_id=?1 AND attempt=?2"
        ),
        params![certificate_id, attempt],
        row_to_receipt,
    )
    .optional()
    .map_err(|error| error.to_string())
}

fn load_by_receipt_with_connection(
    conn: &Connection,
    receipt_id: &str,
) -> Result<Option<FinalSummaryReceipt>, String> {
    conn.query_row(
        &format!(
            "SELECT {RECEIPT_COLUMNS}
             FROM agent_org_runtime_final_summary_receipts WHERE receipt_id=?1"
        ),
        [receipt_id],
        row_to_receipt,
    )
    .optional()
    .map_err(|error| error.to_string())
}

const RECEIPT_COLUMNS: &str = "receipt_id,org_run_id,activation_generation,certificate_id,
    evidence_digest,attempt,status,coordinator_session_id,turn_intent_id,started_at,
    terminal_at,event_id,typed_error,created_at,updated_at";

fn row_to_receipt(row: &rusqlite::Row<'_>) -> rusqlite::Result<FinalSummaryReceipt> {
    let raw_status: String = row.get(6)?;
    let status = FinalSummaryStatus::parse(&raw_status).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            6,
            rusqlite::types::Type::Text,
            std::io::Error::new(std::io::ErrorKind::InvalidData, error).into(),
        )
    })?;
    Ok(FinalSummaryReceipt {
        receipt_id: row.get(0)?,
        org_run_id: row.get(1)?,
        activation_generation: row.get(2)?,
        certificate_id: row.get(3)?,
        evidence_digest: row.get(4)?,
        attempt: row.get(5)?,
        status,
        coordinator_session_id: row.get(7)?,
        turn_intent_id: row.get(8)?,
        started_at: row.get(9)?,
        terminal_at: row.get(10)?,
        event_id: row.get(11)?,
        typed_error: row.get(12)?,
        can_retry: status == FinalSummaryStatus::Failed,
        created_at: row.get(13)?,
        updated_at: row.get(14)?,
    })
}

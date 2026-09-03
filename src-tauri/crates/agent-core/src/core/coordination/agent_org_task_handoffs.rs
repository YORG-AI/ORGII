//! Durable cancellation/reassignment handoff receipts.
//!
//! A replacement for an `in_progress` Task is a blocked outbox until the exact
//! old Turn, runtime lease and owned processes are proven released. This table
//! is the single restart-safe owner of that decision; timers and UI state do
//! not authorize dispatch.

use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::agent_org_tasks::{Task, TaskStatus};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskExecutionHandoffState {
    Requested,
    Yielding,
    Released,
    Timeout,
    Unknown,
    Failed,
}

impl TaskExecutionHandoffState {
    pub const fn as_wire(self) -> &'static str {
        match self {
            Self::Requested => "requested",
            Self::Yielding => "yielding",
            Self::Released => "released",
            Self::Timeout => "timeout",
            Self::Unknown => "unknown",
            Self::Failed => "failed",
        }
    }

    fn parse(value: &str) -> Result<Self, String> {
        Ok(match value {
            "requested" => Self::Requested,
            "yielding" => Self::Yielding,
            "released" => Self::Released,
            "timeout" => Self::Timeout,
            "unknown" => Self::Unknown,
            "failed" => Self::Failed,
            other => return Err(format!("unknown TaskExecution handoff state: {other}")),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskExecutionHandoffResolution {
    ContinueReplacement,
    KeepStopped,
    AbandonEpisode,
}

impl TaskExecutionHandoffResolution {
    pub const fn as_wire(self) -> &'static str {
        match self {
            Self::ContinueReplacement => "continue_replacement",
            Self::KeepStopped => "keep_stopped",
            Self::AbandonEpisode => "abandon_episode",
        }
    }

    fn parse(value: &str) -> Result<Self, String> {
        Ok(match value {
            "continue_replacement" => Self::ContinueReplacement,
            "keep_stopped" => Self::KeepStopped,
            "abandon_episode" => Self::AbandonEpisode,
            other => return Err(format!("unknown TaskExecution handoff resolution: {other}")),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskExecutionHandoffReceipt {
    pub id: String,
    pub org_run_id: String,
    pub activation_generation: i64,
    pub request_id: String,
    pub request_digest: String,
    pub old_task_id: String,
    pub old_owner_member_id: String,
    pub old_session_id: Option<String>,
    pub old_turn_intent_id: Option<String>,
    pub runtime_lease_id: Option<String>,
    pub dialog_turn_generation: Option<String>,
    pub replacement_task_id: Option<String>,
    pub state: TaskExecutionHandoffState,
    pub slo_missed: bool,
    pub external_effect_unknown: bool,
    pub local_effect_count: usize,
    pub resolution_request_id: Option<String>,
    pub resolution_session_id: Option<String>,
    pub requested_resolution: Option<TaskExecutionHandoffResolution>,
    pub resolution_attempt: i64,
    pub resolution_requested_at: Option<String>,
    pub resolution: Option<TaskExecutionHandoffResolution>,
    pub requested_at: String,
    pub released_at: Option<String>,
    pub resolved_at: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HandoffRuntimeEvidence {
    pub old_session_id: String,
    pub old_turn_intent_id: String,
    pub runtime_lease_id: String,
    pub dialog_turn_generation: String,
}

#[derive(Debug, Clone)]
pub struct CreateTaskExecutionHandoff<'a> {
    pub request_id: &'a str,
    pub request_digest: &'a str,
    pub old_task: &'a Task,
    pub replacement_task: Option<&'a Task>,
    pub runtime_evidence: Option<&'a HandoffRuntimeEvidence>,
    pub external_effect_unknown: bool,
}

#[derive(Debug, Clone)]
pub struct HandoffResolutionAcceptance {
    pub receipt: TaskExecutionHandoffReceipt,
    /// True only for a newly accepted decision or an explicit retry after a
    /// failed application attempt. Duplicate IPC delivery never owns another
    /// background worker.
    pub should_apply: bool,
}

pub(crate) fn create_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_org_runtime_task_execution_handoffs (
            id TEXT PRIMARY KEY,
            org_run_id TEXT NOT NULL,
            activation_generation INTEGER NOT NULL CHECK(activation_generation >= 1),
            request_id TEXT NOT NULL CHECK(trim(request_id) <> ''),
            request_digest TEXT NOT NULL CHECK(length(request_digest)=64),
            old_task_id TEXT NOT NULL,
            old_owner_member_id TEXT NOT NULL CHECK(trim(old_owner_member_id) <> ''),
            old_session_id TEXT,
            old_turn_intent_id TEXT,
            runtime_lease_id TEXT,
            dialog_turn_generation TEXT,
            replacement_task_id TEXT,
            state TEXT NOT NULL CHECK(state IN ('requested','yielding','released','timeout','unknown','failed')),
            slo_missed INTEGER NOT NULL DEFAULT 0 CHECK(slo_missed IN (0,1)),
            external_effect_unknown INTEGER NOT NULL DEFAULT 0 CHECK(external_effect_unknown IN (0,1)),
            local_effect_count INTEGER NOT NULL DEFAULT 0 CHECK(local_effect_count >= 0),
            resolution_request_id TEXT,
            resolution_session_id TEXT,
            requested_resolution TEXT CHECK(requested_resolution IN ('continue_replacement','keep_stopped','abandon_episode')),
            resolution_attempt INTEGER NOT NULL DEFAULT 0 CHECK(resolution_attempt >= 0),
            resolution_requested_at TEXT,
            resolution TEXT CHECK(resolution IN ('continue_replacement','keep_stopped','abandon_episode')),
            requested_at TEXT NOT NULL,
            released_at TEXT,
            resolved_at TEXT,
            updated_at TEXT NOT NULL,
            UNIQUE(org_run_id, activation_generation, request_id),
            UNIQUE(org_run_id, activation_generation, resolution_request_id),
            UNIQUE(org_run_id, activation_generation, old_task_id, old_turn_intent_id),
            FOREIGN KEY (org_run_id, old_task_id)
                REFERENCES agent_org_runtime_tasks(org_run_id, id),
            FOREIGN KEY (org_run_id, replacement_task_id)
                REFERENCES agent_org_runtime_tasks(org_run_id, id),
            CHECK((old_session_id IS NULL) = (old_turn_intent_id IS NULL)),
            CHECK((runtime_lease_id IS NULL) = (dialog_turn_generation IS NULL)),
            CHECK(runtime_lease_id IS NULL OR old_session_id IS NOT NULL),
            CHECK(state <> 'released' OR released_at IS NOT NULL),
            CHECK(
                (requested_resolution IS NULL AND resolution_request_id IS NULL
                    AND resolution_session_id IS NULL AND resolution_attempt=0
                    AND resolution_requested_at IS NULL)
                OR
                (requested_resolution IS NOT NULL AND resolution_request_id IS NOT NULL
                    AND resolution_session_id IS NOT NULL AND resolution_attempt>=1
                    AND resolution_requested_at IS NOT NULL)
            ),
            CHECK(resolution IS NULL OR (
                resolved_at IS NOT NULL AND resolution=requested_resolution
            ))
        );
        CREATE INDEX IF NOT EXISTS idx_agent_org_runtime_task_execution_handoffs_run
            ON agent_org_runtime_task_execution_handoffs(org_run_id, activation_generation, state, requested_at, id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_org_runtime_task_execution_handoffs_replacement
            ON agent_org_runtime_task_execution_handoffs(org_run_id, replacement_task_id)
            WHERE replacement_task_id IS NOT NULL;",
    )
}

pub fn canonical_request_digest(value: &serde_json::Value) -> Result<String, String> {
    let encoded = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    Ok(format!("{:x}", Sha256::digest(encoded)))
}

/// Load the exact currently-running TaskExecution companion Turn. Multiple
/// matches are corruption and never get reduced to "latest wins".
pub fn running_target(
    conn: &Connection,
    org_run_id: &str,
    task_id: &str,
) -> Result<Option<(String, String, String, i64)>, String> {
    let mut statement = conn
        .prepare(
            "SELECT context.session_id,context.turn_intent_id,
                    context.owner_member_id,context.activation_generation
             FROM agent_org_runtime_turn_contexts context
             JOIN session_turn_intents base
               ON base.session_id=context.session_id
              AND base.turn_intent_id=context.turn_intent_id
             WHERE context.org_run_id=?1
               AND context.task_id=?2
               AND context.turn_kind='task_execution'
               AND context.owner_member_id IS NOT NULL
               AND context.activation_generation IS NOT NULL
               AND base.org_run_id=?1
               AND base.status='running'
             ORDER BY context.context_id DESC
             LIMIT 2",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![org_run_id, task_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .map_err(|error| error.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())?;
    match rows.as_slice() {
        [] => Ok(None),
        [row] => Ok(Some(row.clone())),
        _ => Err(format!(
            "task_execution_handoff_multiple_running_turns:{org_run_id}:{task_id}"
        )),
    }
}

/// Proves the historical no-receipt case is safe to release. The Task must
/// already be terminal, carry no sticky external-effect uncertainty, and have
/// no persisted running TaskExecution Turn. This is intentionally stricter
/// than merely observing zero in-process writers.
pub fn terminal_task_is_quiesced_with_connection(
    conn: &Connection,
    org_run_id: &str,
    task_id: &str,
) -> Result<bool, String> {
    let task_state = conn
        .query_row(
            "SELECT status,external_effect_unknown
             FROM agent_org_runtime_tasks
             WHERE org_run_id=?1 AND id=?2",
            params![org_run_id, task_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? != 0)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some((status, external_effect_unknown)) = task_state else {
        return Err(format!("task_not_found:{task_id}"));
    };
    let status = TaskStatus::from_wire(&status)?;
    if !status.is_terminal() || external_effect_unknown {
        return Ok(false);
    }
    Ok(running_target(conn, org_run_id, task_id)?.is_none())
}

pub fn create_in_tx(
    conn: &Connection,
    request: CreateTaskExecutionHandoff<'_>,
) -> Result<TaskExecutionHandoffReceipt, String> {
    if request.request_id.trim().is_empty()
        || request.request_id != request.request_id.trim()
        || request.request_digest.len() != 64
        || !request
            .request_digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        return Err("task_execution_handoff_request_identity_invalid".to_string());
    }
    if request.old_task.status != TaskStatus::InProgress {
        return Err("task_execution_handoff_requires_in_progress_task".to_string());
    }
    let old_owner_member_id = request
        .old_task
        .owner
        .as_deref()
        .ok_or_else(|| "task_execution_handoff_requires_old_owner".to_string())?;
    let generation: i64 = conn
        .query_row(
            "SELECT activation_generation FROM agent_org_runtime_runs
             WHERE id=?1 AND status='running'",
            [&request.old_task.org_run_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if generation < 1 {
        return Err("task_execution_handoff_invalid_generation".to_string());
    }
    let running = running_target(conn, &request.old_task.org_run_id, &request.old_task.id)?;
    let (old_session_id, old_turn_intent_id) = match running.as_ref() {
        Some((session_id, turn_intent_id, owner, turn_generation)) => {
            if owner != old_owner_member_id || *turn_generation != generation {
                return Err("task_execution_handoff_turn_identity_mismatch".to_string());
            }
            (Some(session_id.clone()), Some(turn_intent_id.clone()))
        }
        None => (None, None),
    };
    if let Some(evidence) = request.runtime_evidence {
        if old_session_id.as_deref() != Some(evidence.old_session_id.as_str())
            || old_turn_intent_id.as_deref() != Some(evidence.old_turn_intent_id.as_str())
        {
            return Err("task_execution_handoff_runtime_evidence_stale".to_string());
        }
    }

    let existing = load_by_request_with_connection(
        conn,
        &request.old_task.org_run_id,
        generation,
        request.request_id,
    )?;
    if let Some(existing) = existing {
        if existing.request_digest == request.request_digest {
            return Ok(existing);
        }
        return Err("task_execution_handoff_request_digest_conflict".to_string());
    }

    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let state = if !request.external_effect_unknown
        && running.is_some()
        && request.runtime_evidence.is_some()
    {
        TaskExecutionHandoffState::Requested
    } else {
        TaskExecutionHandoffState::Unknown
    };
    conn.execute(
        "INSERT INTO agent_org_runtime_task_execution_handoffs (
            id,org_run_id,activation_generation,request_id,request_digest,
            old_task_id,old_owner_member_id,old_session_id,old_turn_intent_id,
            runtime_lease_id,dialog_turn_generation,replacement_task_id,state,
            slo_missed,external_effect_unknown,local_effect_count,
            resolution_request_id,resolution_session_id,requested_resolution,
            resolution_attempt,resolution_requested_at,resolution,
            requested_at,released_at,resolved_at,updated_at
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,0,?14,0,
                   NULL,NULL,NULL,0,NULL,NULL,?15,NULL,NULL,?15)",
        params![
            &id,
            &request.old_task.org_run_id,
            generation,
            request.request_id,
            request.request_digest,
            &request.old_task.id,
            old_owner_member_id,
            old_session_id.as_deref(),
            old_turn_intent_id.as_deref(),
            request
                .runtime_evidence
                .map(|item| item.runtime_lease_id.as_str()),
            request
                .runtime_evidence
                .map(|item| item.dialog_turn_generation.as_str()),
            request.replacement_task.map(|task| task.id.as_str()),
            state.as_wire(),
            i64::from(request.external_effect_unknown),
            &now,
        ],
    )
    .map_err(|error| error.to_string())?;
    load_with_connection(conn, &id)?.ok_or_else(|| "handoff receipt disappeared".to_string())
}

pub fn load(receipt_id: &str) -> Result<Option<TaskExecutionHandoffReceipt>, String> {
    let conn = database::db::get_connection().map_err(|error| error.to_string())?;
    load_with_connection(&conn, receipt_id)
}

pub fn load_current_by_request(
    org_run_id: &str,
    request_id: &str,
) -> Result<Option<TaskExecutionHandoffReceipt>, String> {
    let conn = database::db::get_connection().map_err(|error| error.to_string())?;
    let handoff_columns = HANDOFF_COLUMNS
        .split(',')
        .map(|column| format!("handoff.{}", column.trim()))
        .collect::<Vec<_>>()
        .join(",");
    conn.query_row(
        &format!(
            "SELECT {handoff_columns}
             FROM agent_org_runtime_task_execution_handoffs handoff
             JOIN agent_org_runtime_runs run ON run.id=handoff.org_run_id
             WHERE handoff.org_run_id=?1 AND handoff.request_id=?2
               AND handoff.activation_generation=run.activation_generation"
        ),
        params![org_run_id, request_id],
        decode_receipt,
    )
    .optional()
    .map_err(|error| error.to_string())
}

pub fn load_current_for_task_with_connection(
    conn: &Connection,
    org_run_id: &str,
    generation: i64,
    task_id: &str,
) -> Result<Option<TaskExecutionHandoffReceipt>, String> {
    conn.query_row(
        &format!(
            "SELECT {HANDOFF_COLUMNS}
             FROM agent_org_runtime_task_execution_handoffs
             WHERE org_run_id=?1 AND activation_generation=?2 AND old_task_id=?3
             ORDER BY requested_at DESC,id DESC LIMIT 1"
        ),
        params![org_run_id, generation, task_id],
        decode_receipt,
    )
    .optional()
    .map_err(|error| error.to_string())
}

pub fn list_current_with_connection(
    conn: &Connection,
    org_run_id: &str,
    generation: i64,
) -> Result<Vec<TaskExecutionHandoffReceipt>, String> {
    let mut statement = conn
        .prepare(&format!(
            "SELECT {HANDOFF_COLUMNS}
             FROM agent_org_runtime_task_execution_handoffs
             WHERE org_run_id=?1 AND activation_generation=?2
             ORDER BY requested_at ASC,id ASC"
        ))
        .map_err(|error| error.to_string())?;
    let receipts = statement
        .query_map(params![org_run_id, generation], decode_receipt)
        .map_err(|error| error.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())?;
    Ok(receipts)
}

/// Return replacements whose durable handoff has not authorized dispatch.
///
/// The receipt, rather than an in-memory outbox, owns this gate across
/// restart. `released` is the only unresolved state that permits automatic
/// dispatch; Timeout/Unknown/Failed require an explicit user resolution.
pub(crate) fn blocked_replacement_task_ids_with_connection(
    conn: &Connection,
    org_run_id: &str,
) -> Result<HashSet<String>, String> {
    let mut statement = conn
        .prepare(
            "SELECT handoff.replacement_task_id
             FROM agent_org_runtime_task_execution_handoffs handoff
             JOIN agent_org_runtime_runs run ON run.id=handoff.org_run_id
             WHERE handoff.org_run_id=?1
               AND handoff.activation_generation=run.activation_generation
               AND handoff.replacement_task_id IS NOT NULL
               AND handoff.resolution IS NULL
               AND handoff.state<>'released'",
        )
        .map_err(|error| error.to_string())?;
    let task_ids = statement
        .query_map([org_run_id], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .collect::<rusqlite::Result<HashSet<_>>>()
        .map_err(|error| error.to_string())?;
    Ok(task_ids)
}

pub(crate) fn replacement_dispatch_is_blocked_with_connection(
    conn: &Connection,
    org_run_id: &str,
    task_id: &str,
) -> Result<bool, String> {
    Ok(blocked_replacement_task_ids_with_connection(conn, org_run_id)?.contains(task_id))
}

/// Reconcile a Requested or Yielding receipt without replaying either side of
/// the handoff. A persisted terminal old Turn plus zero exact owned jobs and
/// zero active effect permits is sufficient proof of release. Every other
/// case fails closed to `unknown` for an explicit user decision; this restart
/// hook never dispatches the replacement.
pub(crate) fn reconcile_after_restart(conn: &Connection) -> Result<usize, String> {
    let mut statement = conn
        .prepare(&format!(
            "SELECT {HANDOFF_COLUMNS}
             FROM agent_org_runtime_task_execution_handoffs
             WHERE resolution IS NULL AND state IN ('requested','yielding')
             ORDER BY requested_at ASC,id ASC"
        ))
        .map_err(|error| error.to_string())?;
    let receipts = statement
        .query_map([], decode_receipt)
        .map_err(|error| error.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())?;
    drop(statement);
    if receipts.is_empty() {
        return Ok(0);
    }
    let now = chrono::Utc::now().to_rfc3339();
    let tx = conn
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    let mut changed = 0;
    for receipt in receipts {
        let persisted_terminal = match (
            receipt.old_session_id.as_deref(),
            receipt.old_turn_intent_id.as_deref(),
        ) {
            (Some(session_id), Some(turn_intent_id)) => tx
                .query_row(
                    "SELECT status FROM session_turn_intents
                     WHERE session_id=?1 AND turn_intent_id=?2 AND org_run_id=?3",
                    params![session_id, turn_intent_id, &receipt.org_run_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|error| error.to_string())?
                .is_some_and(|status| {
                    matches!(
                        status.as_str(),
                        "completed" | "failed" | "cancelled" | "abandoned"
                    )
                }),
            _ => false,
        };
        let owned_jobs_terminal = match (
            receipt.old_session_id.as_ref(),
            receipt.old_turn_intent_id.as_ref(),
            receipt.runtime_lease_id.as_ref(),
            receipt.dialog_turn_generation.as_ref(),
        ) {
            (Some(session_id), Some(turn_intent_id), Some(runtime_lease_id), Some(generation)) => {
                let owner = crate::tools::call_context::TurnProcessOwner {
                    session_id: session_id.clone(),
                    turn_intent_id: turn_intent_id.clone(),
                    runtime_lease_id: runtime_lease_id.clone(),
                    dialog_turn_generation: generation.clone(),
                };
                crate::tools::impls::coding::exec::registry::owned_jobs_are_terminal(&owner)
            }
            _ => false,
        };
        let local_effect_count = super::agent_org_task_execution_fence::active_effect_count(
            &receipt.org_run_id,
            &receipt.old_task_id,
        );
        let released = persisted_terminal && owned_jobs_terminal && local_effect_count == 0;
        changed += tx
            .execute(
                "UPDATE agent_org_runtime_task_execution_handoffs
                 SET state=?2,local_effect_count=?3,
                     released_at=CASE WHEN ?2='released' THEN COALESCE(released_at,?4)
                                      ELSE released_at END,
                     updated_at=?4
                 WHERE id=?1 AND resolution IS NULL
                   AND state IN ('requested','yielding')",
                params![
                    receipt.id,
                    if released { "released" } else { "unknown" },
                    local_effect_count as i64,
                    &now,
                ],
            )
            .map_err(|error| error.to_string())?;
    }
    tx.commit().map_err(|error| error.to_string())?;
    Ok(changed)
}

pub fn load_with_connection(
    conn: &Connection,
    receipt_id: &str,
) -> Result<Option<TaskExecutionHandoffReceipt>, String> {
    conn.query_row(
        &format!(
            "SELECT {HANDOFF_COLUMNS}
             FROM agent_org_runtime_task_execution_handoffs WHERE id=?1"
        ),
        [receipt_id],
        decode_receipt,
    )
    .optional()
    .map_err(|error| error.to_string())
}

pub(crate) fn load_by_request_with_connection(
    conn: &Connection,
    org_run_id: &str,
    generation: i64,
    request_id: &str,
) -> Result<Option<TaskExecutionHandoffReceipt>, String> {
    conn.query_row(
        &format!(
            "SELECT {HANDOFF_COLUMNS}
             FROM agent_org_runtime_task_execution_handoffs
             WHERE org_run_id=?1 AND activation_generation=?2 AND request_id=?3"
        ),
        params![org_run_id, generation, request_id],
        decode_receipt,
    )
    .optional()
    .map_err(|error| error.to_string())
}

pub fn mark_yielding(receipt_id: &str) -> Result<TaskExecutionHandoffReceipt, String> {
    let receipt = transition(receipt_id, "requested", "yielding", false, 0)?;
    observe_handoff("yielding", &receipt);
    Ok(receipt)
}

pub fn mark_released(
    receipt_id: &str,
    local_effect_count: usize,
) -> Result<TaskExecutionHandoffReceipt, String> {
    let receipt = transition(
        receipt_id,
        "yielding",
        "released",
        false,
        local_effect_count,
    )?;
    observe_handoff("released", &receipt);
    Ok(receipt)
}

pub(crate) fn mark_released_in_tx(
    conn: &Connection,
    receipt_id: &str,
    local_effect_count: usize,
) -> Result<TaskExecutionHandoffReceipt, String> {
    let now = chrono::Utc::now().to_rfc3339();
    let changed = conn
        .execute(
            "UPDATE agent_org_runtime_task_execution_handoffs
             SET state='released',local_effect_count=?2,released_at=?3,updated_at=?3
             WHERE id=?1 AND state='yielding'",
            params![receipt_id, local_effect_count as i64, &now],
        )
        .map_err(|error| error.to_string())?;
    if changed == 0 {
        let current = load_with_connection(conn, receipt_id)?
            .ok_or_else(|| format!("task_execution_handoff_not_found:{receipt_id}"))?;
        if current.state != TaskExecutionHandoffState::Released {
            return Err(format!(
                "task_execution_handoff_transition_conflict:{}:released",
                current.state.as_wire()
            ));
        }
        return Ok(current);
    }
    load_with_connection(conn, receipt_id)?
        .ok_or_else(|| format!("task_execution_handoff_not_found:{receipt_id}"))
}

pub fn mark_slo_missed(receipt_id: &str) -> Result<TaskExecutionHandoffReceipt, String> {
    let receipt = database::db::with_sessions_writer(|| {
        let conn = database::db::get_connection().map_err(|error| error.to_string())?;
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE agent_org_runtime_task_execution_handoffs
             SET slo_missed=1,updated_at=?2
             WHERE id=?1 AND state='yielding'",
            params![receipt_id, &now],
        )
        .map_err(|error| error.to_string())?;
        load_with_connection(&conn, receipt_id)?
            .ok_or_else(|| format!("task_execution_handoff_not_found:{receipt_id}"))
    })?;
    observe_handoff("slo_missed", &receipt);
    Ok(receipt)
}

pub fn mark_timeout(
    receipt_id: &str,
    local_effect_count: usize,
) -> Result<TaskExecutionHandoffReceipt, String> {
    let receipt = transition(receipt_id, "yielding", "timeout", true, local_effect_count)?;
    observe_handoff("timeout", &receipt);
    Ok(receipt)
}

pub fn mark_unknown(
    receipt_id: &str,
    local_effect_count: usize,
) -> Result<TaskExecutionHandoffReceipt, String> {
    let receipt = database::db::with_sessions_writer(|| {
        let conn = database::db::get_connection().map_err(|error| error.to_string())?;
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE agent_org_runtime_task_execution_handoffs
             SET state='unknown',local_effect_count=?2,updated_at=?3
             WHERE id=?1 AND state IN ('requested','yielding','timeout')",
            params![receipt_id, local_effect_count as i64, &now],
        )
        .map_err(|error| error.to_string())?;
        load_with_connection(&conn, receipt_id)?
            .ok_or_else(|| format!("task_execution_handoff_not_found:{receipt_id}"))
    })?;
    observe_handoff("unknown", &receipt);
    Ok(receipt)
}

pub fn mark_drive_failed(
    receipt_id: &str,
    local_effect_count: usize,
) -> Result<TaskExecutionHandoffReceipt, String> {
    let receipt = database::db::with_sessions_writer(|| {
        let conn = database::db::get_connection().map_err(|error| error.to_string())?;
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE agent_org_runtime_task_execution_handoffs
             SET state='failed',slo_missed=1,local_effect_count=?2,updated_at=?3
             WHERE id=?1 AND resolution IS NULL AND requested_resolution IS NULL
               AND state IN ('requested','yielding')",
            params![receipt_id, local_effect_count as i64, &now],
        )
        .map_err(|error| error.to_string())?;
        load_with_connection(&conn, receipt_id)?
            .ok_or_else(|| format!("task_execution_handoff_not_found:{receipt_id}"))
    })?;
    observe_handoff("failed", &receipt);
    Ok(receipt)
}

pub fn request_resolution(
    receipt_id: &str,
    session_id: &str,
    request_id: &str,
    resolution: TaskExecutionHandoffResolution,
) -> Result<HandoffResolutionAcceptance, String> {
    if session_id.trim().is_empty()
        || request_id.trim().is_empty()
        || session_id != session_id.trim()
        || request_id != request_id.trim()
    {
        return Err("task_execution_handoff_resolution_request_identity_invalid".to_string());
    }
    database::db::with_sessions_writer(|| {
        let conn = database::db::get_connection().map_err(|error| error.to_string())?;
        let tx = conn
            .unchecked_transaction()
            .map_err(|error| error.to_string())?;
        let acceptance = request_resolution_with_connection(
            &tx, receipt_id, session_id, request_id, resolution,
        )?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok(acceptance)
    })
}

pub(crate) fn request_resolution_with_connection(
    conn: &Connection,
    receipt_id: &str,
    session_id: &str,
    request_id: &str,
    resolution: TaskExecutionHandoffResolution,
) -> Result<HandoffResolutionAcceptance, String> {
    let current = load_with_connection(conn, receipt_id)?
        .ok_or_else(|| format!("task_execution_handoff_not_found:{receipt_id}"))?;
    if let Some(existing) = current.resolution {
        if existing == resolution {
            return Ok(HandoffResolutionAcceptance {
                receipt: current,
                should_apply: false,
            });
        }
        return Err("task_execution_handoff_resolution_conflict".to_string());
    }
    if let Some(existing) = current.requested_resolution {
        let failed_application_retry = current.state == TaskExecutionHandoffState::Failed
            && current.resolution_request_id.as_deref() != Some(request_id);
        if existing != resolution && !failed_application_retry {
            return Err("task_execution_handoff_resolution_conflict".to_string());
        }
        if existing == resolution && !failed_application_retry {
            return Ok(HandoffResolutionAcceptance {
                receipt: current,
                should_apply: false,
            });
        }
    } else if !matches!(
        current.state,
        TaskExecutionHandoffState::Timeout
            | TaskExecutionHandoffState::Unknown
            | TaskExecutionHandoffState::Failed
    ) {
        return Err(format!(
            "task_execution_handoff_not_resolvable:{}",
            current.state.as_wire()
        ));
    }

    let now = chrono::Utc::now().to_rfc3339();
    let next_attempt = current
        .resolution_attempt
        .checked_add(1)
        .ok_or_else(|| "task_execution_handoff_resolution_attempt_overflow".to_string())?;
    conn.execute(
        "UPDATE agent_org_runtime_task_execution_handoffs
         SET resolution_request_id=?2,resolution_session_id=?3,
             requested_resolution=?4,resolution_attempt=?5,
             resolution_requested_at=?6,
             state=CASE WHEN state='failed' THEN 'unknown' ELSE state END,
             updated_at=?6
         WHERE id=?1 AND resolution IS NULL",
        params![
            receipt_id,
            request_id,
            session_id,
            resolution.as_wire(),
            next_attempt,
            &now,
        ],
    )
    .map_err(|error| error.to_string())?;
    let receipt = load_with_connection(conn, receipt_id)?
        .ok_or_else(|| format!("task_execution_handoff_not_found:{receipt_id}"))?;
    Ok(HandoffResolutionAcceptance {
        receipt,
        should_apply: true,
    })
}

pub fn list_pending_resolutions(limit: usize) -> Result<Vec<TaskExecutionHandoffReceipt>, String> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    let conn = database::db::get_connection().map_err(|error| error.to_string())?;
    let mut statement = conn
        .prepare(&format!(
            "SELECT {HANDOFF_COLUMNS}
             FROM agent_org_runtime_task_execution_handoffs
             WHERE requested_resolution IS NOT NULL AND resolution IS NULL
             ORDER BY resolution_requested_at ASC,id ASC LIMIT ?1"
        ))
        .map_err(|error| error.to_string())?;
    let receipts = statement
        .query_map([limit as i64], decode_receipt)
        .map_err(|error| error.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())?;
    Ok(receipts)
}

pub fn mark_resolution_failed(
    receipt_id: &str,
    resolution_attempt: i64,
    local_effect_count: usize,
) -> Result<TaskExecutionHandoffReceipt, String> {
    let receipt = database::db::with_sessions_writer(|| {
        let conn = database::db::get_connection().map_err(|error| error.to_string())?;
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE agent_org_runtime_task_execution_handoffs
             SET state='failed',slo_missed=1,local_effect_count=?3,updated_at=?4
             WHERE id=?1 AND resolution_attempt=?2
               AND requested_resolution IS NOT NULL AND resolution IS NULL",
            params![
                receipt_id,
                resolution_attempt,
                local_effect_count as i64,
                &now
            ],
        )
        .map_err(|error| error.to_string())?;
        load_with_connection(&conn, receipt_id)?
            .ok_or_else(|| format!("task_execution_handoff_not_found:{receipt_id}"))
    })?;
    if receipt.resolution_attempt == resolution_attempt
        && receipt.state == TaskExecutionHandoffState::Failed
    {
        observe_handoff("resolution_failed", &receipt);
    }
    Ok(receipt)
}

pub(crate) fn observe_handoff(event: &'static str, receipt: &TaskExecutionHandoffReceipt) {
    let elapsed_ms = chrono::DateTime::parse_from_rfc3339(&receipt.requested_at)
        .ok()
        .map(|requested_at| {
            chrono::Utc::now()
                .signed_duration_since(requested_at.with_timezone(&chrono::Utc))
                .num_milliseconds()
                .max(0)
        });
    tracing::debug!(
        event,
        receipt_id = %receipt.id,
        org_run_id = %receipt.org_run_id,
        old_task_id = %receipt.old_task_id,
        replacement_task_id = receipt.replacement_task_id.as_deref(),
        state = receipt.state.as_wire(),
        requested_resolution = receipt
            .requested_resolution
            .map(TaskExecutionHandoffResolution::as_wire),
        resolution_attempt = receipt.resolution_attempt,
        resolution = receipt.resolution.map(TaskExecutionHandoffResolution::as_wire),
        slo_missed = receipt.slo_missed,
        external_effect_unknown = receipt.external_effect_unknown,
        local_effect_count = receipt.local_effect_count,
        elapsed_ms,
        "[agent_org_metric] task_execution_handoff"
    );
}

pub(crate) fn resolve_in_tx(
    conn: &Connection,
    receipt_id: &str,
    resolution: TaskExecutionHandoffResolution,
    resolution_attempt: i64,
    release_local_execution: bool,
) -> Result<TaskExecutionHandoffReceipt, String> {
    let current = load_with_connection(conn, receipt_id)?
        .ok_or_else(|| format!("task_execution_handoff_not_found:{receipt_id}"))?;
    if let Some(existing) = current.resolution {
        if existing == resolution {
            return Ok(current);
        }
        return Err("task_execution_handoff_resolution_conflict".to_string());
    }
    if current.requested_resolution != Some(resolution)
        || current.resolution_attempt != resolution_attempt
    {
        return Err("task_execution_handoff_resolution_attempt_stale".to_string());
    }
    if !matches!(
        current.state,
        TaskExecutionHandoffState::Timeout
            | TaskExecutionHandoffState::Unknown
            | TaskExecutionHandoffState::Failed
    ) {
        return Err(format!(
            "task_execution_handoff_not_resolvable:{}",
            current.state.as_wire()
        ));
    }
    let now = chrono::Utc::now().to_rfc3339();
    let next_state = if release_local_execution {
        TaskExecutionHandoffState::Released
    } else {
        current.state
    };
    conn.execute(
        "UPDATE agent_org_runtime_task_execution_handoffs
         SET resolution=?2,resolved_at=?3,state=?4,
             released_at=CASE WHEN ?5=1 THEN COALESCE(released_at,?3) ELSE released_at END,
             local_effect_count=CASE WHEN ?5=1 THEN 0 ELSE local_effect_count END,
             updated_at=?3
         WHERE id=?1 AND resolution IS NULL AND resolution_attempt=?6",
        params![
            receipt_id,
            resolution.as_wire(),
            &now,
            next_state.as_wire(),
            i64::from(release_local_execution),
            resolution_attempt,
        ],
    )
    .map_err(|error| error.to_string())?;
    load_with_connection(conn, receipt_id)?
        .ok_or_else(|| format!("task_execution_handoff_not_found:{receipt_id}"))
}

fn transition(
    receipt_id: &str,
    from_state: &str,
    to_state: &str,
    slo_missed: bool,
    local_effect_count: usize,
) -> Result<TaskExecutionHandoffReceipt, String> {
    database::db::with_sessions_writer(|| {
        let conn = database::db::get_connection().map_err(|error| error.to_string())?;
        let now = chrono::Utc::now().to_rfc3339();
        let changed = conn
            .execute(
                "UPDATE agent_org_runtime_task_execution_handoffs
                 SET state=?3,slo_missed=MAX(slo_missed,?4),local_effect_count=?5,
                     released_at=CASE WHEN ?3='released' THEN ?6 ELSE released_at END,
                     updated_at=?6
                 WHERE id=?1 AND state=?2",
                params![
                    receipt_id,
                    from_state,
                    to_state,
                    i64::from(slo_missed),
                    local_effect_count as i64,
                    &now,
                ],
            )
            .map_err(|error| error.to_string())?;
        if changed == 0 {
            let current = load_with_connection(&conn, receipt_id)?
                .ok_or_else(|| format!("task_execution_handoff_not_found:{receipt_id}"))?;
            if current.state.as_wire() != to_state {
                return Err(format!(
                    "task_execution_handoff_transition_conflict:{}:{}",
                    current.state.as_wire(),
                    to_state
                ));
            }
            return Ok(current);
        }
        load_with_connection(&conn, receipt_id)?
            .ok_or_else(|| format!("task_execution_handoff_not_found:{receipt_id}"))
    })
}

const HANDOFF_COLUMNS: &str = "id,org_run_id,activation_generation,request_id,request_digest,
    old_task_id,old_owner_member_id,old_session_id,old_turn_intent_id,runtime_lease_id,
    dialog_turn_generation,replacement_task_id,state,slo_missed,external_effect_unknown,
    local_effect_count,resolution_request_id,resolution_session_id,requested_resolution,
    resolution_attempt,resolution_requested_at,resolution,requested_at,released_at,resolved_at,
    updated_at";

fn decode_receipt(row: &rusqlite::Row<'_>) -> rusqlite::Result<TaskExecutionHandoffReceipt> {
    let state_raw: String = row.get(12)?;
    let requested_resolution_raw: Option<String> = row.get(18)?;
    let resolution_raw: Option<String> = row.get(21)?;
    Ok(TaskExecutionHandoffReceipt {
        id: row.get(0)?,
        org_run_id: row.get(1)?,
        activation_generation: row.get(2)?,
        request_id: row.get(3)?,
        request_digest: row.get(4)?,
        old_task_id: row.get(5)?,
        old_owner_member_id: row.get(6)?,
        old_session_id: row.get(7)?,
        old_turn_intent_id: row.get(8)?,
        runtime_lease_id: row.get(9)?,
        dialog_turn_generation: row.get(10)?,
        replacement_task_id: row.get(11)?,
        state: TaskExecutionHandoffState::parse(&state_raw).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(12, rusqlite::types::Type::Text, error.into())
        })?,
        slo_missed: row.get::<_, i64>(13)? != 0,
        external_effect_unknown: row.get::<_, i64>(14)? != 0,
        local_effect_count: usize::try_from(row.get::<_, i64>(15)?).unwrap_or(usize::MAX),
        resolution_request_id: row.get(16)?,
        resolution_session_id: row.get(17)?,
        requested_resolution: requested_resolution_raw
            .map(|value| TaskExecutionHandoffResolution::parse(&value))
            .transpose()
            .map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    18,
                    rusqlite::types::Type::Text,
                    error.into(),
                )
            })?,
        resolution_attempt: row.get(19)?,
        resolution_requested_at: row.get(20)?,
        resolution: resolution_raw
            .map(|value| TaskExecutionHandoffResolution::parse(&value))
            .transpose()
            .map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    21,
                    rusqlite::types::Type::Text,
                    error.into(),
                )
            })?,
        requested_at: row.get(22)?,
        released_at: row.get(23)?,
        resolved_at: row.get(24)?,
        updated_at: row.get(25)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coordination::agent_org_tasks::{TaskExecutionMode, TaskTerminalReason};

    fn fixture(with_running_turn: bool) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE agent_org_runtime_runs(
                 id TEXT PRIMARY KEY,status TEXT,activation_generation INTEGER
             );
             CREATE TABLE agent_org_runtime_tasks(
                 org_run_id TEXT,id TEXT,status TEXT NOT NULL DEFAULT 'in_progress',
                 external_effect_unknown INTEGER NOT NULL DEFAULT 0,
                 PRIMARY KEY(org_run_id,id)
             );
             CREATE TABLE session_turn_intents(
                 session_id TEXT,turn_intent_id TEXT,org_run_id TEXT,status TEXT,
                 PRIMARY KEY(session_id,turn_intent_id)
             );
             CREATE TABLE agent_org_runtime_turn_contexts(
                 context_id INTEGER PRIMARY KEY AUTOINCREMENT,
                 session_id TEXT,turn_intent_id TEXT,org_run_id TEXT,
                 task_id TEXT,turn_kind TEXT,owner_member_id TEXT,
                 activation_generation INTEGER
             );
             INSERT INTO agent_org_runtime_runs VALUES ('run','running',1);
             INSERT INTO agent_org_runtime_tasks(org_run_id,id) VALUES ('run','old');
             INSERT INTO agent_org_runtime_tasks(org_run_id,id,status)
                 VALUES ('run','replacement','pending');",
        )
        .unwrap();
        if with_running_turn {
            conn.execute_batch(
                "INSERT INTO session_turn_intents
                     VALUES ('session','turn','run','running');
                 INSERT INTO agent_org_runtime_turn_contexts(
                     session_id,turn_intent_id,org_run_id,task_id,turn_kind,
                     owner_member_id,activation_generation
                 ) VALUES ('session','turn','run','old','task_execution','member',1);",
            )
            .unwrap();
        }
        create_schema(&conn).unwrap();
        conn
    }

    fn task(id: &str, status: TaskStatus) -> Task {
        Task {
            id: id.to_string(),
            org_run_id: "run".to_string(),
            activation_generation: 1,
            subject: id.to_string(),
            description: String::new(),
            active_form: None,
            owner: Some("member".to_string()),
            status,
            execution_mode: TaskExecutionMode::Build,
            blocks: Vec::new(),
            blocked_by: Vec::new(),
            metadata: None,
            output: None,
            failure_reason: None,
            cancel_reason: (status == TaskStatus::Cancelled).then(|| TaskTerminalReason {
                code: "user_reassigned".to_string(),
                message: "reassigned".to_string(),
                source_event_id: None,
            }),
            created_by_participant_id: "coordinator".to_string(),
            source_turn_intent_id: "coordinator-turn".to_string(),
            originating_message_id: None,
            replaces_task_id: (id == "replacement").then(|| "old".to_string()),
            created_at: "2026-08-27T00:00:00Z".to_string(),
            updated_at: "2026-08-27T00:00:00Z".to_string(),
        }
    }

    fn evidence() -> HandoffRuntimeEvidence {
        HandoffRuntimeEvidence {
            old_session_id: "session".to_string(),
            old_turn_intent_id: "turn".to_string(),
            runtime_lease_id: "lease".to_string(),
            dialog_turn_generation: "dialog-generation".to_string(),
        }
    }

    #[test]
    fn external_unknown_never_enters_the_automatic_release_path() {
        let conn = fixture(true);
        let old = task("old", TaskStatus::InProgress);
        let replacement = task("replacement", TaskStatus::Pending);
        let evidence = evidence();
        let request = CreateTaskExecutionHandoff {
            request_id: "request",
            request_digest: &"a".repeat(64),
            old_task: &old,
            replacement_task: Some(&replacement),
            runtime_evidence: Some(&evidence),
            external_effect_unknown: true,
        };
        let receipt = create_in_tx(&conn, request.clone()).unwrap();
        assert_eq!(receipt.state, TaskExecutionHandoffState::Unknown);
        assert!(receipt.external_effect_unknown);

        let replay = create_in_tx(&conn, request).unwrap();
        assert_eq!(replay.id, receipt.id);
        let conflict = create_in_tx(
            &conn,
            CreateTaskExecutionHandoff {
                request_digest: &"b".repeat(64),
                request_id: "request",
                old_task: &old,
                replacement_task: Some(&replacement),
                runtime_evidence: Some(&evidence),
                external_effect_unknown: true,
            },
        )
        .unwrap_err();
        assert_eq!(conflict, "task_execution_handoff_request_digest_conflict");
    }

    #[test]
    fn exact_runtime_evidence_is_required_for_requested_state() {
        let conn = fixture(true);
        let old = task("old", TaskStatus::InProgress);
        let replacement = task("replacement", TaskStatus::Pending);
        let evidence = evidence();
        let receipt = create_in_tx(
            &conn,
            CreateTaskExecutionHandoff {
                request_id: "request",
                request_digest: &"a".repeat(64),
                old_task: &old,
                replacement_task: Some(&replacement),
                runtime_evidence: Some(&evidence),
                external_effect_unknown: false,
            },
        )
        .unwrap();
        assert_eq!(receipt.state, TaskExecutionHandoffState::Requested);

        conn.execute(
            "UPDATE agent_org_runtime_task_execution_handoffs SET state='yielding' WHERE id=?1",
            [&receipt.id],
        )
        .unwrap();
        let released = mark_released_in_tx(&conn, &receipt.id, 0).unwrap();
        assert_eq!(released.state, TaskExecutionHandoffState::Released);
        assert!(released.released_at.is_some());
    }

    #[test]
    fn terminal_task_quiescence_requires_no_running_turn_or_external_uncertainty() {
        let conn = fixture(false);
        conn.execute(
            "UPDATE agent_org_runtime_tasks SET status='cancelled' WHERE id='old'",
            [],
        )
        .unwrap();
        assert!(terminal_task_is_quiesced_with_connection(&conn, "run", "old").unwrap());

        conn.execute(
            "UPDATE agent_org_runtime_tasks SET external_effect_unknown=1 WHERE id='old'",
            [],
        )
        .unwrap();
        assert!(!terminal_task_is_quiesced_with_connection(&conn, "run", "old").unwrap());

        let running = fixture(true);
        running
            .execute(
                "UPDATE agent_org_runtime_tasks SET status='cancelled' WHERE id='old'",
                [],
            )
            .unwrap();
        assert!(!terminal_task_is_quiesced_with_connection(&running, "run", "old").unwrap());
    }

    #[test]
    fn uncertain_resolution_is_idempotent_and_conflicts_fail_closed() {
        let conn = fixture(false);
        let old = task("old", TaskStatus::InProgress);
        let receipt = create_in_tx(
            &conn,
            CreateTaskExecutionHandoff {
                request_id: "request",
                request_digest: &"a".repeat(64),
                old_task: &old,
                replacement_task: None,
                runtime_evidence: None,
                external_effect_unknown: false,
            },
        )
        .unwrap();
        assert_eq!(receipt.state, TaskExecutionHandoffState::Unknown);
        let acceptance = request_resolution_with_connection(
            &conn,
            &receipt.id,
            "root-session",
            "resolution-request",
            TaskExecutionHandoffResolution::KeepStopped,
        )
        .unwrap();
        assert!(acceptance.should_apply);
        assert_eq!(acceptance.receipt.resolution_attempt, 1);
        let resolved = resolve_in_tx(
            &conn,
            &receipt.id,
            TaskExecutionHandoffResolution::KeepStopped,
            1,
            false,
        )
        .unwrap();
        assert_eq!(resolved.state, TaskExecutionHandoffState::Unknown);
        assert_eq!(
            resolved.resolution,
            Some(TaskExecutionHandoffResolution::KeepStopped)
        );
        assert_eq!(
            resolve_in_tx(
                &conn,
                &receipt.id,
                TaskExecutionHandoffResolution::KeepStopped,
                1,
                false,
            )
            .unwrap()
            .id,
            receipt.id
        );
        assert_eq!(
            resolve_in_tx(
                &conn,
                &receipt.id,
                TaskExecutionHandoffResolution::ContinueReplacement,
                1,
                true,
            )
            .unwrap_err(),
            "task_execution_handoff_resolution_conflict"
        );
    }

    #[test]
    fn every_user_resolution_is_durably_accepted_before_application() {
        for resolution in [
            TaskExecutionHandoffResolution::ContinueReplacement,
            TaskExecutionHandoffResolution::KeepStopped,
            TaskExecutionHandoffResolution::AbandonEpisode,
        ] {
            let conn = fixture(false);
            let old = task("old", TaskStatus::InProgress);
            let receipt = create_in_tx(
                &conn,
                CreateTaskExecutionHandoff {
                    request_id: "request",
                    request_digest: &"a".repeat(64),
                    old_task: &old,
                    replacement_task: None,
                    runtime_evidence: None,
                    external_effect_unknown: false,
                },
            )
            .unwrap();
            let accepted = request_resolution_with_connection(
                &conn,
                &receipt.id,
                "root-session",
                "resolution-request",
                resolution,
            )
            .unwrap();
            assert!(accepted.should_apply);
            assert_eq!(accepted.receipt.requested_resolution, Some(resolution));
            assert_eq!(accepted.receipt.resolution_attempt, 1);
            assert!(accepted.receipt.resolution.is_none());
            assert!(accepted.receipt.resolution_requested_at.is_some());

            let duplicate = request_resolution_with_connection(
                &conn,
                &receipt.id,
                "root-session",
                "resolution-request",
                resolution,
            )
            .unwrap();
            assert!(!duplicate.should_apply);
            assert_eq!(duplicate.receipt.resolution_attempt, 1);
        }
    }

    #[test]
    fn resolution_retry_attempt_rejects_a_late_previous_completion() {
        let conn = fixture(false);
        let old = task("old", TaskStatus::InProgress);
        let receipt = create_in_tx(
            &conn,
            CreateTaskExecutionHandoff {
                request_id: "request",
                request_digest: &"a".repeat(64),
                old_task: &old,
                replacement_task: None,
                runtime_evidence: None,
                external_effect_unknown: false,
            },
        )
        .unwrap();
        request_resolution_with_connection(
            &conn,
            &receipt.id,
            "root-session",
            "resolution-request-1",
            TaskExecutionHandoffResolution::KeepStopped,
        )
        .unwrap();
        conn.execute(
            "UPDATE agent_org_runtime_task_execution_handoffs SET state='failed' WHERE id=?1",
            [&receipt.id],
        )
        .unwrap();
        let retry = request_resolution_with_connection(
            &conn,
            &receipt.id,
            "root-session",
            "resolution-request-2",
            TaskExecutionHandoffResolution::KeepStopped,
        )
        .unwrap();
        assert!(retry.should_apply);
        assert_eq!(retry.receipt.resolution_attempt, 2);
        assert_eq!(retry.receipt.state, TaskExecutionHandoffState::Unknown);
        assert_eq!(
            resolve_in_tx(
                &conn,
                &receipt.id,
                TaskExecutionHandoffResolution::KeepStopped,
                1,
                false,
            )
            .unwrap_err(),
            "task_execution_handoff_resolution_attempt_stale"
        );
        let resolved = resolve_in_tx(
            &conn,
            &receipt.id,
            TaskExecutionHandoffResolution::KeepStopped,
            2,
            false,
        )
        .unwrap();
        assert_eq!(
            resolved.resolution,
            Some(TaskExecutionHandoffResolution::KeepStopped)
        );
    }

    #[test]
    fn failed_resolution_can_be_replaced_by_a_new_user_decision() {
        let conn = fixture(false);
        let old = task("old", TaskStatus::InProgress);
        let receipt = create_in_tx(
            &conn,
            CreateTaskExecutionHandoff {
                request_id: "request",
                request_digest: &"a".repeat(64),
                old_task: &old,
                replacement_task: None,
                runtime_evidence: None,
                external_effect_unknown: false,
            },
        )
        .unwrap();
        request_resolution_with_connection(
            &conn,
            &receipt.id,
            "root-session",
            "resolution-request-1",
            TaskExecutionHandoffResolution::ContinueReplacement,
        )
        .unwrap();
        conn.execute(
            "UPDATE agent_org_runtime_task_execution_handoffs SET state='failed' WHERE id=?1",
            [&receipt.id],
        )
        .unwrap();

        let revised = request_resolution_with_connection(
            &conn,
            &receipt.id,
            "root-session",
            "resolution-request-2",
            TaskExecutionHandoffResolution::KeepStopped,
        )
        .unwrap();
        assert!(revised.should_apply);
        assert_eq!(revised.receipt.resolution_attempt, 2);
        assert_eq!(
            revised.receipt.requested_resolution,
            Some(TaskExecutionHandoffResolution::KeepStopped)
        );
        assert_eq!(revised.receipt.state, TaskExecutionHandoffState::Unknown);
        assert_eq!(
            resolve_in_tx(
                &conn,
                &receipt.id,
                TaskExecutionHandoffResolution::ContinueReplacement,
                1,
                true,
            )
            .unwrap_err(),
            "task_execution_handoff_resolution_attempt_stale"
        );
    }

    #[test]
    fn request_identity_rejects_noncanonical_digest_before_writes() {
        let conn = fixture(false);
        let old = task("old", TaskStatus::InProgress);
        assert_eq!(
            create_in_tx(
                &conn,
                CreateTaskExecutionHandoff {
                    request_id: " request ",
                    request_digest: &"A".repeat(64),
                    old_task: &old,
                    replacement_task: None,
                    runtime_evidence: None,
                    external_effect_unknown: false,
                },
            )
            .unwrap_err(),
            "task_execution_handoff_request_identity_invalid"
        );
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM agent_org_runtime_task_execution_handoffs",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn restart_keeps_running_old_turn_as_idempotent_unknown_without_dispatch() {
        let conn = fixture(true);
        let old = task("old", TaskStatus::InProgress);
        let replacement = task("replacement", TaskStatus::Pending);
        let evidence = evidence();
        let receipt = create_in_tx(
            &conn,
            CreateTaskExecutionHandoff {
                request_id: "request",
                request_digest: &"a".repeat(64),
                old_task: &old,
                replacement_task: Some(&replacement),
                runtime_evidence: Some(&evidence),
                external_effect_unknown: false,
            },
        )
        .unwrap();
        assert_eq!(receipt.state, TaskExecutionHandoffState::Requested);
        assert_eq!(reconcile_after_restart(&conn).unwrap(), 1);
        let recovered = load_with_connection(&conn, &receipt.id).unwrap().unwrap();
        assert_eq!(recovered.state, TaskExecutionHandoffState::Unknown);
        assert!(recovered.resolution.is_none());
        assert!(
            replacement_dispatch_is_blocked_with_connection(&conn, "run", "replacement").unwrap()
        );
        assert_eq!(
            recovered.replacement_task_id.as_deref(),
            Some("replacement")
        );
        assert_eq!(reconcile_after_restart(&conn).unwrap(), 0);
    }

    #[test]
    fn restart_releases_only_a_persisted_terminal_old_turn_with_zero_local_effects() {
        let conn = fixture(true);
        let old = task("old", TaskStatus::InProgress);
        let replacement = task("replacement", TaskStatus::Pending);
        let evidence = evidence();
        let receipt = create_in_tx(
            &conn,
            CreateTaskExecutionHandoff {
                request_id: "request-terminal",
                request_digest: &"b".repeat(64),
                old_task: &old,
                replacement_task: Some(&replacement),
                runtime_evidence: Some(&evidence),
                external_effect_unknown: false,
            },
        )
        .unwrap();
        conn.execute(
            "UPDATE session_turn_intents SET status='completed'
             WHERE session_id='session' AND turn_intent_id='turn'",
            [],
        )
        .unwrap();

        assert_eq!(reconcile_after_restart(&conn).unwrap(), 1);
        let recovered = load_with_connection(&conn, &receipt.id).unwrap().unwrap();
        assert_eq!(recovered.state, TaskExecutionHandoffState::Released);
        assert_eq!(recovered.local_effect_count, 0);
        assert!(recovered.released_at.is_some());
        assert!(recovered.resolution.is_none());
        assert!(
            !replacement_dispatch_is_blocked_with_connection(&conn, "run", "replacement").unwrap()
        );
        assert_eq!(
            recovered.replacement_task_id.as_deref(),
            Some("replacement")
        );
        assert_eq!(reconcile_after_restart(&conn).unwrap(), 0);
    }
}

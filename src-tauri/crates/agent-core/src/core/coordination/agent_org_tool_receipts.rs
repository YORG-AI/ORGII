//! Exactly-once receipts for model-initiated Agent Org durable writes.
//!
//! One tool call owns one composite identity inside a Team. The receipt lookup,
//! business mutation, and deterministic result are committed in the same
//! `BEGIN IMMEDIATE` transaction. A byte-equivalent retry is therefore a
//! read-only replay; reusing the identity for different canonical parameters
//! fails closed.

use database::db::{get_connection, with_sessions_writer};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::coordination::agent_org_payload_limits::{
    validate_message_identifier, RFC3339_TIMESTAMP_MAX_BYTES, RFC3339_TIMESTAMP_MAX_CHARS,
};
use crate::tools::traits::{CallContext, ToolError};

pub(super) const TABLE_NAME: &str = "agent_org_runtime_tool_call_receipts";

const TOOL_NAME_MAX_BYTES: usize = 128;
const OPERATION_MAX_BYTES: usize = 128;
const RESULT_MAX_BYTES: usize = 512 * 1024;
const ERROR_MAX_BYTES: usize = 64 * 1024;
const RECEIPT_CONFLICT: &str = "agent_org_tool_call_receipt_conflict";

pub(super) fn create_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(&format!(
        "CREATE TABLE IF NOT EXISTS {TABLE_NAME} (
             org_run_id TEXT NOT NULL,
             session_id TEXT NOT NULL,
             turn_intent_id TEXT NOT NULL,
             call_id TEXT NOT NULL,
             tool_name TEXT NOT NULL,
             operation TEXT NOT NULL,
             canonical_digest TEXT NOT NULL,
             result_text TEXT,
             error_kind TEXT,
             error_text TEXT,
             created_at TEXT NOT NULL,
             PRIMARY KEY (org_run_id, session_id, turn_intent_id, call_id),
             FOREIGN KEY (org_run_id)
                 REFERENCES agent_org_runtime_runs(id) ON DELETE CASCADE,
             CHECK (trim(org_run_id) <> '' AND org_run_id = trim(org_run_id)),
             CHECK (trim(session_id) <> '' AND session_id = trim(session_id)),
             CHECK (trim(turn_intent_id) <> '' AND turn_intent_id = trim(turn_intent_id)),
             CHECK (trim(call_id) <> '' AND call_id = trim(call_id)),
             CHECK (trim(tool_name) <> '' AND length(CAST(tool_name AS BLOB)) <= {TOOL_NAME_MAX_BYTES}),
             CHECK (trim(operation) <> '' AND length(CAST(operation AS BLOB)) <= {OPERATION_MAX_BYTES}),
             CHECK (length(canonical_digest) = 64 AND canonical_digest NOT GLOB '*[^0-9a-f]*'),
             CHECK (
                 (result_text IS NOT NULL AND error_kind IS NULL AND error_text IS NULL)
                 OR
                 (result_text IS NULL AND error_kind IN ('invalid_params','execution_failed','permission_denied','timeout') AND error_text IS NOT NULL)
             ),
             CHECK (result_text IS NULL OR length(CAST(result_text AS BLOB)) <= {RESULT_MAX_BYTES}),
             CHECK (error_text IS NULL OR length(CAST(error_text AS BLOB)) <= {ERROR_MAX_BYTES}),
             CHECK (length(created_at) <= {RFC3339_TIMESTAMP_MAX_CHARS} AND length(CAST(created_at AS BLOB)) <= {RFC3339_TIMESTAMP_MAX_BYTES})
         );"
    ))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentOrgToolReceiptKey {
    pub org_run_id: String,
    pub session_id: String,
    pub turn_intent_id: String,
    pub call_id: String,
}

impl AgentOrgToolReceiptKey {
    pub(crate) fn from_call_context(
        org_run_id: impl Into<String>,
        context: &CallContext,
    ) -> Result<Self, ToolError> {
        let key = Self {
            org_run_id: org_run_id.into(),
            session_id: context.session_id.clone(),
            turn_intent_id: context.turn_intent_id.clone(),
            call_id: context.call_id.clone(),
        };
        key.validate()?;
        Ok(key)
    }

    fn validate(&self) -> Result<(), ToolError> {
        for (field, value) in [
            ("org_run_id", self.org_run_id.as_str()),
            ("session_id", self.session_id.as_str()),
            ("turn_intent_id", self.turn_intent_id.as_str()),
            ("call_id", self.call_id.as_str()),
        ] {
            validate_message_identifier(field, value).map_err(ToolError::InvalidParams)?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AgentOrgToolReceiptDisposition {
    Fresh,
    Replayed,
}

#[derive(Debug)]
pub(crate) struct AgentOrgToolReceiptOutcome {
    pub result: Result<String, ToolError>,
    pub disposition: AgentOrgToolReceiptDisposition,
}

impl AgentOrgToolReceiptOutcome {
    pub(crate) fn is_fresh(&self) -> bool {
        self.disposition == AgentOrgToolReceiptDisposition::Fresh
    }
}

/// Abort a first-time call without creating a receipt.
///
/// `Rejected` is for stale authority and lifecycle fences. `Storage` is for
/// infrastructure failures. Deterministic domain failures should instead be
/// returned as the inner `Err(ToolError)` so that retries replay the same
/// error rather than executing the mutation path again.
#[derive(Debug)]
pub(crate) enum AgentOrgToolReceiptAbort {
    Rejected(ToolError),
    Storage(String),
}

impl AgentOrgToolReceiptAbort {
    pub(crate) fn rejected(error: ToolError) -> Self {
        Self::Rejected(error)
    }

    pub(crate) fn storage(error: impl ToString) -> Self {
        Self::Storage(error.to_string())
    }
}

#[derive(Debug)]
struct StoredReceipt {
    tool_name: String,
    operation: String,
    canonical_digest: String,
    result_text: Option<String>,
    error_kind: Option<String>,
    error_text: Option<String>,
}

impl StoredReceipt {
    fn into_result(self) -> Result<String, ToolError> {
        if let Some(result) = self.result_text {
            return Ok(result);
        }
        let message = self
            .error_text
            .unwrap_or_else(|| "stored Agent Org tool error is missing its message".to_string());
        Err(match self.error_kind.as_deref() {
            Some("invalid_params") => ToolError::InvalidParams(message),
            Some("permission_denied") => ToolError::PermissionDenied(message),
            Some("timeout") => ToolError::Timeout(message),
            _ => ToolError::ExecutionFailed(message),
        })
    }
}

pub(crate) struct AgentOrgToolReceiptStore;

impl AgentOrgToolReceiptStore {
    pub(crate) fn execute<F>(
        key: AgentOrgToolReceiptKey,
        tool_name: &str,
        operation: &str,
        canonical_params: &Value,
        mutation: F,
    ) -> Result<AgentOrgToolReceiptOutcome, ToolError>
    where
        F: FnOnce(&Connection) -> Result<Result<String, ToolError>, AgentOrgToolReceiptAbort>,
    {
        validate_tool_identity(tool_name, operation)?;
        let digest = canonical_tool_digest(tool_name, operation, canonical_params)?;
        with_sessions_writer(|| {
            let conn = get_connection().map_err(receipt_storage_error)?;
            Self::execute_with_connection(&conn, key, tool_name, operation, &digest, mutation)
        })
    }

    fn execute_with_connection<F>(
        conn: &Connection,
        key: AgentOrgToolReceiptKey,
        tool_name: &str,
        operation: &str,
        canonical_digest: &str,
        mutation: F,
    ) -> Result<AgentOrgToolReceiptOutcome, ToolError>
    where
        F: FnOnce(&Connection) -> Result<Result<String, ToolError>, AgentOrgToolReceiptAbort>,
    {
        let tx = database::db::begin_immediate(conn).map_err(receipt_storage_error)?;
        if let Some(stored) = read_receipt(&tx, &key).map_err(receipt_storage_error)? {
            if stored.tool_name != tool_name
                || stored.operation != operation
                || stored.canonical_digest != canonical_digest
            {
                return Err(ToolError::InvalidParams(RECEIPT_CONFLICT.to_string()));
            }
            let result = stored.into_result();
            tx.commit().map_err(receipt_storage_error)?;
            return Ok(AgentOrgToolReceiptOutcome {
                result,
                disposition: AgentOrgToolReceiptDisposition::Replayed,
            });
        }

        let result = match mutation(&tx) {
            Ok(result) => result,
            Err(AgentOrgToolReceiptAbort::Rejected(error)) => return Err(error),
            Err(AgentOrgToolReceiptAbort::Storage(error)) => {
                return Err(receipt_storage_error(error));
            }
        };
        insert_receipt(&tx, &key, tool_name, operation, canonical_digest, &result)
            .map_err(receipt_storage_error)?;
        tx.commit().map_err(receipt_storage_error)?;
        Ok(AgentOrgToolReceiptOutcome {
            result,
            disposition: AgentOrgToolReceiptDisposition::Fresh,
        })
    }
}

fn validate_tool_identity(tool_name: &str, operation: &str) -> Result<(), ToolError> {
    for (field, value, max_bytes) in [
        ("tool_name", tool_name, TOOL_NAME_MAX_BYTES),
        ("operation", operation, OPERATION_MAX_BYTES),
    ] {
        if value.trim().is_empty() || value != value.trim() || value.len() > max_bytes {
            return Err(ToolError::InvalidParams(format!(
                "{field} must be trimmed, non-empty, and <= {max_bytes} bytes"
            )));
        }
    }
    Ok(())
}

fn canonical_tool_digest(
    tool_name: &str,
    operation: &str,
    canonical_params: &Value,
) -> Result<String, ToolError> {
    let envelope = Value::Object(
        [
            (
                "operation".to_string(),
                Value::String(operation.to_string()),
            ),
            ("params".to_string(), canonicalize_json(canonical_params)),
            ("tool".to_string(), Value::String(tool_name.to_string())),
        ]
        .into_iter()
        .collect(),
    );
    let encoded = serde_json::to_vec(&envelope).map_err(|error| {
        ToolError::ExecutionFailed(format!(
            "failed to encode canonical Agent Org tool parameters: {error}"
        ))
    })?;
    Ok(format!("{:x}", Sha256::digest(encoded)))
}

fn canonicalize_json(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(canonicalize_json).collect()),
        Value::Object(object) => {
            let mut entries = object.iter().collect::<Vec<_>>();
            entries.sort_by_key(|(key, _)| *key);
            Value::Object(
                entries
                    .into_iter()
                    .map(|(key, value)| (key.clone(), canonicalize_json(value)))
                    .collect(),
            )
        }
        _ => value.clone(),
    }
}

fn read_receipt(
    conn: &Connection,
    key: &AgentOrgToolReceiptKey,
) -> rusqlite::Result<Option<StoredReceipt>> {
    conn.query_row(
        &format!(
            "SELECT tool_name,operation,canonical_digest,result_text,error_kind,error_text
             FROM {TABLE_NAME}
             WHERE org_run_id=?1 AND session_id=?2 AND turn_intent_id=?3 AND call_id=?4"
        ),
        params![
            &key.org_run_id,
            &key.session_id,
            &key.turn_intent_id,
            &key.call_id
        ],
        |row| {
            Ok(StoredReceipt {
                tool_name: row.get(0)?,
                operation: row.get(1)?,
                canonical_digest: row.get(2)?,
                result_text: row.get(3)?,
                error_kind: row.get(4)?,
                error_text: row.get(5)?,
            })
        },
    )
    .optional()
}

fn insert_receipt(
    conn: &Connection,
    key: &AgentOrgToolReceiptKey,
    tool_name: &str,
    operation: &str,
    canonical_digest: &str,
    result: &Result<String, ToolError>,
) -> rusqlite::Result<()> {
    let (result_text, error_kind, error_text) = match result {
        Ok(result) => (Some(result.as_str()), None, None),
        Err(ToolError::InvalidParams(error)) => {
            (None, Some("invalid_params"), Some(error.as_str()))
        }
        Err(ToolError::ExecutionFailed(error)) => {
            (None, Some("execution_failed"), Some(error.as_str()))
        }
        Err(ToolError::PermissionDenied(error)) => {
            (None, Some("permission_denied"), Some(error.as_str()))
        }
        Err(ToolError::Timeout(error)) => (None, Some("timeout"), Some(error.as_str())),
    };
    conn.execute(
        &format!(
            "INSERT INTO {TABLE_NAME} (
                 org_run_id,session_id,turn_intent_id,call_id,
                 tool_name,operation,canonical_digest,
                 result_text,error_kind,error_text,created_at
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)"
        ),
        params![
            &key.org_run_id,
            &key.session_id,
            &key.turn_intent_id,
            &key.call_id,
            tool_name,
            operation,
            canonical_digest,
            result_text,
            error_kind,
            error_text,
            chrono::Utc::now().to_rfc3339(),
        ],
    )?;
    Ok(())
}

fn receipt_storage_error(error: impl ToString) -> ToolError {
    ToolError::ExecutionFailed(format!(
        "Agent Org tool receipt storage failed: {}",
        error.to_string()
    ))
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::*;
    use crate::coordination::init_agent_org_schemas;

    fn fixture() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory SQLite");
        conn.execute_batch("PRAGMA foreign_keys=ON;")
            .expect("foreign keys");
        conn.execute_batch(
            "CREATE TABLE session_turn_intents (
                 session_id TEXT NOT NULL,
                 turn_intent_id TEXT NOT NULL,
                 PRIMARY KEY(session_id, turn_intent_id)
             );",
        )
        .expect("shared Turn fixture schema");
        init_agent_org_schemas(&conn).expect("Agent Org schema");
        conn.execute(
            "INSERT INTO agent_org_runtime_runs (
                 id,org_id,coordinator_agent_id,entry_mode,status,created_at,updated_at
             ) VALUES ('run-a','org-a','agent-a','standalone_session','running',?1,?1)",
            [chrono::Utc::now().to_rfc3339()],
        )
        .expect("run fixture");
        conn
    }

    fn key() -> AgentOrgToolReceiptKey {
        AgentOrgToolReceiptKey {
            org_run_id: "run-a".to_string(),
            session_id: "session-a".to_string(),
            turn_intent_id: "turn-a".to_string(),
            call_id: "call-a".to_string(),
        }
    }

    #[test]
    fn identical_retry_replays_result_without_running_mutation() {
        let conn = fixture();
        let calls = Cell::new(0);
        let digest =
            canonical_tool_digest("task_update", "patch", &serde_json::json!({"b": 2, "a": 1}))
                .expect("digest");
        let first = AgentOrgToolReceiptStore::execute_with_connection(
            &conn,
            key(),
            "task_update",
            "patch",
            &digest,
            |_| {
                calls.set(calls.get() + 1);
                Ok(Ok("saved".to_string()))
            },
        )
        .expect("first execution");
        let replay = AgentOrgToolReceiptStore::execute_with_connection(
            &conn,
            key(),
            "task_update",
            "patch",
            &digest,
            |_| {
                calls.set(calls.get() + 1);
                Ok(Ok("must not run".to_string()))
            },
        )
        .expect("replay");
        assert!(first.is_fresh());
        assert_eq!(first.result.expect("first result"), "saved");
        assert_eq!(replay.disposition, AgentOrgToolReceiptDisposition::Replayed);
        assert_eq!(replay.result.expect("replayed result"), "saved");
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn object_key_order_has_one_digest_but_changed_params_conflict() {
        let conn = fixture();
        let first_digest = canonical_tool_digest(
            "task_update",
            "patch",
            &serde_json::json!({"b": {"z": 2, "a": 1}, "a": 0}),
        )
        .expect("first digest");
        let reordered_digest = canonical_tool_digest(
            "task_update",
            "patch",
            &serde_json::json!({"a": 0, "b": {"a": 1, "z": 2}}),
        )
        .expect("reordered digest");
        assert_eq!(first_digest, reordered_digest);
        AgentOrgToolReceiptStore::execute_with_connection(
            &conn,
            key(),
            "task_update",
            "patch",
            &first_digest,
            |_| Ok(Ok("saved".to_string())),
        )
        .expect("first execution");
        let changed_digest = canonical_tool_digest(
            "task_update",
            "patch",
            &serde_json::json!({"a": 9, "b": {"a": 1, "z": 2}}),
        )
        .expect("changed digest");
        let error = AgentOrgToolReceiptStore::execute_with_connection(
            &conn,
            key(),
            "task_update",
            "patch",
            &changed_digest,
            |_| Ok(Ok("changed".to_string())),
        )
        .expect_err("same key with changed params must conflict");
        assert!(matches!(error, ToolError::InvalidParams(ref text) if text == RECEIPT_CONFLICT));
    }

    #[test]
    fn deterministic_error_replays_but_rejected_fence_leaves_no_receipt() {
        let conn = fixture();
        let digest =
            canonical_tool_digest("task_update", "patch", &serde_json::json!({})).expect("digest");
        let stored = AgentOrgToolReceiptStore::execute_with_connection(
            &conn,
            key(),
            "task_update",
            "patch",
            &digest,
            |_| Ok(Err(ToolError::InvalidParams("task cycle".to_string()))),
        )
        .expect("store deterministic error");
        assert!(
            matches!(stored.result, Err(ToolError::InvalidParams(ref text)) if text == "task cycle")
        );
        let replay = AgentOrgToolReceiptStore::execute_with_connection(
            &conn,
            key(),
            "task_update",
            "patch",
            &digest,
            |_| panic!("stored error must replay"),
        )
        .expect("replay deterministic error");
        assert_eq!(replay.disposition, AgentOrgToolReceiptDisposition::Replayed);

        let rejected_key = AgentOrgToolReceiptKey {
            call_id: "call-rejected".to_string(),
            ..key()
        };
        let error = AgentOrgToolReceiptStore::execute_with_connection(
            &conn,
            rejected_key,
            "task_update",
            "patch",
            &digest,
            |_| {
                Err(AgentOrgToolReceiptAbort::rejected(
                    ToolError::PermissionDenied("paused".to_string()),
                ))
            },
        )
        .expect_err("fence rejection");
        assert!(matches!(error, ToolError::PermissionDenied(ref text) if text == "paused"));
        let count: i64 = conn
            .query_row(&format!("SELECT COUNT(*) FROM {TABLE_NAME}"), [], |row| {
                row.get(0)
            })
            .expect("receipt count");
        assert_eq!(count, 1);
    }

    #[test]
    fn receipt_insert_failure_rolls_back_the_business_mutation() {
        let conn = fixture();
        conn.execute_batch(
            "CREATE TABLE business_effects (
                 id INTEGER PRIMARY KEY,
                 value TEXT NOT NULL
             );",
        )
        .expect("business fixture schema");
        let digest = canonical_tool_digest(
            "task_create",
            "create",
            &serde_json::json!({"subject": "oversized result"}),
        )
        .expect("digest");

        let error = AgentOrgToolReceiptStore::execute_with_connection(
            &conn,
            key(),
            "task_create",
            "create",
            &digest,
            |tx| {
                tx.execute(
                    "INSERT INTO business_effects (id,value) VALUES (1,'must roll back')",
                    [],
                )
                .expect("business mutation");
                Ok(Ok("x".repeat(RESULT_MAX_BYTES + 1)))
            },
        )
        .expect_err("receipt CHECK failure must fail the whole transaction");
        assert!(error
            .to_string()
            .contains("Agent Org tool receipt storage failed"));
        let business_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM business_effects", [], |row| {
                row.get(0)
            })
            .expect("business count");
        let receipt_count: i64 = conn
            .query_row(&format!("SELECT COUNT(*) FROM {TABLE_NAME}"), [], |row| {
                row.get(0)
            })
            .expect("receipt count");
        assert_eq!(business_count, 0);
        assert_eq!(receipt_count, 0);
    }

    #[test]
    fn team_delete_cascades_receipts() {
        let conn = fixture();
        let digest =
            canonical_tool_digest("task_create", "create", &serde_json::json!({})).expect("digest");
        AgentOrgToolReceiptStore::execute_with_connection(
            &conn,
            key(),
            "task_create",
            "create",
            &digest,
            |_| Ok(Ok("created".to_string())),
        )
        .expect("receipt");
        conn.execute("DELETE FROM agent_org_runtime_runs WHERE id='run-a'", [])
            .expect("delete Team");
        let count: i64 = conn
            .query_row(&format!("SELECT COUNT(*) FROM {TABLE_NAME}"), [], |row| {
                row.get(0)
            })
            .expect("receipt count");
        assert_eq!(count, 0);
    }
}

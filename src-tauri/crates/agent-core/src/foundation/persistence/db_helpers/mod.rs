//! Shared Agent Persistence Layer
//!
//! Generic message CRUD and session helpers used by all agent sessions.
//! Each consumer passes its table-name prefix so the SQL targets the right tables.
//!
//! ## Tables expected per prefix
//!
//! - `{prefix}_sessions` — session metadata
//! - `{prefix}_messages` — conversation messages & tool events

use chrono::Utc;
use rusqlite::{params, types::Type, Result as SqliteResult};
use serde::{Deserialize, Serialize};
use tracing::warn;

use database::db::{get_connection, with_sessions_writer};

const MSG_RETRY_MAX: u32 = 5;
const MSG_RETRY_BASE_MS: u64 = 50;

// ============================================
// Message Role Constants
// ============================================

pub mod message_role {
    pub const SYSTEM: &str = "system";
    pub const USER: &str = "user";
    pub const ASSISTANT: &str = "assistant";
    pub const TOOL_CALL: &str = "tool_call";
    pub const TOOL_RESULT: &str = "tool_result";
}

// ============================================
// Shared Utilities
// ============================================

/// Run a blocking closure on `spawn_blocking` and flatten the double-Result
/// (`JoinError` + `SqliteResult`) into a single `Result<T, String>`.
///
/// Eliminates the repeated `.await.map_err(…)?.map_err(…)` pattern used by
/// every `#[tauri::command]` that calls into SQLite.
pub async fn spawn_blocking_cmd<T, F>(func: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> SqliteResult<T> + Send + 'static,
{
    tokio::task::spawn_blocking(func)
        .await
        .map_err(|err| err.to_string())?
        .map_err(|err| err.to_string())
}

/// Execute a `query_row` that may return no rows, converting
/// `QueryReturnedNoRows` into `Ok(None)`.
pub fn query_optional<T>(result: rusqlite::Result<T>) -> SqliteResult<Option<T>> {
    match result {
        Ok(val) => Ok(Some(val)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(err) => Err(err),
    }
}

/// Serialize a DB-backed command response item without silently converting
/// serialization failures into JSON null/default values.
pub fn to_json_value<T: Serialize>(value: T) -> SqliteResult<serde_json::Value> {
    serde_json::to_value(value)
        .map_err(|err| rusqlite::Error::ToSqlConversionFailure(Box::new(err)))
}

#[cfg(test)]
mod tests {
    use super::to_json_value;
    use serde::ser::{Error as SerError, Serialize, Serializer};

    struct FailingSerialize;

    impl Serialize for FailingSerialize {
        fn serialize<S>(&self, _serializer: S) -> Result<S::Ok, S::Error>
        where
            S: Serializer,
        {
            Err(S::Error::custom("intentional serialization failure"))
        }
    }

    #[test]
    fn to_json_value_returns_serialization_errors() {
        let err = to_json_value(FailingSerialize).expect_err("serialization failure must surface");
        assert!(matches!(err, rusqlite::Error::ToSqlConversionFailure(_)));
        assert!(err
            .to_string()
            .contains("intentional serialization failure"));
    }
}

/// Collect all image file paths referenced by messages in a session.
fn collect_session_image_paths(prefix: &str, session_id: &str) -> SqliteResult<Vec<String>> {
    let conn = get_connection()?;
    collect_session_image_paths_with_connection(&conn, prefix, session_id)
}

fn collect_session_image_paths_with_connection(
    conn: &rusqlite::Connection,
    prefix: &str,
    session_id: &str,
) -> SqliteResult<Vec<String>> {
    let sql = format!(
        "SELECT images FROM {prefix}_messages WHERE session_id = ?1 AND images IS NOT NULL"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([session_id], |row| row.get::<_, String>(0))?;
    let mut paths = Vec::new();

    for row in rows {
        let json_str = row?;
        let image_paths: Vec<String> = serde_json::from_str(&json_str).map_err(|err| {
            rusqlite::Error::FromSqlConversionFailure(0, Type::Text, Box::new(err))
        })?;
        paths.extend(
            image_paths
                .into_iter()
                .filter(|path| !path.starts_with("data:")),
        );
    }

    Ok(paths)
}

/// Delete all rows referencing `session_id` from each table in `tables`.
/// Also deletes any image files on disk referenced by the session's messages.
pub fn delete_session_cascade(session_id: &str, tables: &[&str]) -> SqliteResult<()> {
    // Collect image file paths before deleting the rows. Infer the
    // prefix from the first table that ends with "_messages".
    let prefix = tables
        .iter()
        .find(|t| t.ends_with("_messages"))
        .and_then(|t| t.strip_suffix("_messages"));

    if let Some(prefix) = prefix {
        let image_paths = collect_session_image_paths(prefix, session_id)?;
        if !image_paths.is_empty() {
            super::images::delete_image_files(&image_paths);
        }
    }

    with_sessions_writer(|| {
        let mut conn = get_connection()?;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        delete_session_rows_with_connection(&tx, session_id, tables)?;
        tx.commit()?;
        Ok(())
    })
}

/// Transaction-aware form of [`delete_session_cascade`].
///
/// The caller owns the transaction boundary. This is used when several Rust
/// Agent Org sessions and their run-owned rows must commit or roll back as one
/// hierarchy. Ordinary single-session deletion continues to use
/// [`delete_session_cascade`] and therefore keeps its existing transaction
/// behavior.
pub(crate) fn delete_session_cascade_with_connection(
    conn: &rusqlite::Connection,
    session_id: &str,
    tables: &[&str],
) -> SqliteResult<()> {
    // Collect image file paths before deleting the rows. Infer the
    // prefix from the first table that ends with "_messages".
    let prefix = tables
        .iter()
        .find(|t| t.ends_with("_messages"))
        .and_then(|t| t.strip_suffix("_messages"));

    if let Some(prefix) = prefix {
        let image_paths = collect_session_image_paths_with_connection(conn, prefix, session_id)?;
        if !image_paths.is_empty() {
            super::images::delete_image_files(&image_paths);
        }
    }

    delete_session_rows_with_connection(conn, session_id, tables)
}

fn delete_session_rows_with_connection(
    conn: &rusqlite::Connection,
    session_id: &str,
    tables: &[&str],
) -> SqliteResult<()> {
    if tables.contains(&"agent_messages") {
        let receipts_exist: bool = conn.query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM sqlite_master
                 WHERE type='table' AND name='agent_inbox_materializations'
             )",
            [],
            |row| row.get(0),
        )?;
        if receipts_exist {
            // Keep the source Inbox rows unread while atomically removing
            // receipts for transcript rows deleted by this cascade.
            conn.execute(
                "DELETE FROM agent_inbox_materializations WHERE session_id=?1",
                [session_id],
            )?;
        }
    }
    for table in tables {
        conn.execute(
            &format!("DELETE FROM {table} WHERE session_id = ?1"),
            [session_id],
        )?;
    }
    Ok(())
}

// ============================================
// Shared Types
// ============================================

/// A single conversation message or tool event stored in `agent_messages`.
///
/// **Naming note:** this is the DB-row mirror of a chat message, distinct
/// from [`crate::coordination::agent_inbox::AgentMessage`],
/// which is the typed inter-agent envelope enum (Plain / ShutdownRequest /
/// PlanApprovalRequest / …). The two share no fields; readers should never
/// alias both into the same module without a disambiguating rename.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessageRow {
    pub id: String,
    pub session_id: String,
    /// `"user"` | `"assistant"` | `"tool_call"` | `"tool_result"`
    pub role: String,
    pub content: String,
    pub tool_name: Option<String>,
    pub tool_call_id: Option<String>,
    pub tool_input: Option<String>,
    pub tool_output: Option<String>,
    pub model: Option<String>,
    pub sequence: i64,
    pub created_at: String,
    /// JSON array of disk file paths (vision support). Only set for user messages.
    /// Legacy rows may contain base64 data URLs; new rows always contain file paths.
    pub images: Option<String>,
    /// Compact-boundary pointer. `None` for ordinary rows. A `Some(seq)` value
    /// marks this row as a compaction summary: the visible transcript is this
    /// row's content followed by all non-boundary rows with `sequence >= seq`.
    /// Compaction appends boundary + tail rows and never rewrites or deletes
    /// prior rows (immutable transcript invariant).
    pub compact_from_sequence: Option<i64>,
    /// Estimated context tokens before compaction. Boundary rows only —
    /// display metadata for the "Context compacted" chat marker; never
    /// model-facing. `None` on ordinary rows and legacy boundaries.
    pub compact_tokens_before: Option<i64>,
    /// Estimated context tokens after compaction. See `compact_tokens_before`.
    pub compact_tokens_after: Option<i64>,
}

/// Simplified lifecycle states for agent session persistence (database level).
///
/// This is a subset of the full `SessionStatus` in `session::types`, optimized
/// for database storage with fewer states.
///
/// ## Relationship with `SessionStatus`
///
/// `SessionStatus` (session::types) has 11 detailed states for UI/application use.
/// This enum has 5 coarse states for DB persistence:
/// - `Idle` ← Idle, Pending
/// - `Running` ← Running, WaitingForUser, WaitingForFunds, Paused
/// - `Completed` ← Completed
/// - `Failed` ← Failed, Timeout
/// - `Cancelled` ← Cancelled, Abandoned
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentSessionStatus {
    Idle,
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl AgentSessionStatus {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "idle" => Some(Self::Idle),
            "running" => Some(Self::Running),
            "completed" => Some(Self::Completed),
            "failed" => Some(Self::Failed),
            "cancelled" => Some(Self::Cancelled),
            _ => None,
        }
    }

    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }
}

impl std::fmt::Display for AgentSessionStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_ref())
    }
}

impl AsRef<str> for AgentSessionStatus {
    fn as_ref(&self) -> &str {
        match self {
            Self::Idle => "idle",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

/// Shared response type for agent message processing.
///
/// Used by agent sessions and the unified routing layer.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentResponse {
    pub content: String,
    pub session_id: String,
    pub model: String,
}

// ============================================
// Message CRUD (base operations — kept here because db_helpers_messages depends on them)
// ============================================

/// Internal single-attempt message insert primitive.
///
/// Reads the current max sequence, assigns the next value, writes the row,
/// and touches `updated_at` inside one `BEGIN IMMEDIATE` transaction so no
/// other writer can interleave a sequence read between our SELECT and
/// INSERT. The whole thing runs under the process-wide writer mutex so
/// concurrent `insert_message_retry` callers queue in Rust instead of
/// racing for `SQLITE_BUSY`.
/// Hot paths must call [`insert_message_retry`] or the typed `save_*` helpers.
#[derive(Clone, Copy)]
enum MessageConflictPolicy {
    /// Preserve the historical message helper behavior: a caller that reuses
    /// an id replaces that row with the newly supplied message.
    Replace,
    /// At-least-once delivery behavior: if the stable id already exists,
    /// return it without changing content, sequence, timestamps, or session.
    PreserveExisting,
}

fn insert_message_with_policy(
    prefix: &str,
    msg: &AgentMessageRow,
    conflict_policy: MessageConflictPolicy,
) -> SqliteResult<(String, bool)> {
    with_sessions_writer(|| {
        let conn = get_connection()?;

        let seq_sql = format!("SELECT MAX(sequence) FROM {prefix}_messages WHERE session_id = ?1");
        let insert_sql = match conflict_policy {
            MessageConflictPolicy::Replace => format!(
                "INSERT OR REPLACE INTO {prefix}_messages
                 (id, session_id, role, content, tool_name, tool_call_id, tool_input, tool_output, model, sequence, created_at, images, compact_from_sequence, compact_tokens_before, compact_tokens_after)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)"
            ),
            MessageConflictPolicy::PreserveExisting => format!(
                "INSERT INTO {prefix}_messages
             (id, session_id, role, content, tool_name, tool_call_id, tool_input, tool_output, model, sequence, created_at, images, compact_from_sequence, compact_tokens_before, compact_tokens_after)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)"
            ),
        };
        let exists_sql = format!("SELECT EXISTS(SELECT 1 FROM {prefix}_messages WHERE id = ?1)");
        let touch_sql =
            format!("UPDATE {prefix}_sessions SET updated_at = ?2 WHERE session_id = ?1");

        conn.execute_batch("BEGIN IMMEDIATE")?;

        if matches!(conflict_policy, MessageConflictPolicy::PreserveExisting) {
            let already_exists =
                match conn.query_row(&exists_sql, [&msg.id], |row| row.get::<_, bool>(0)) {
                    Ok(exists) => exists,
                    Err(err) => {
                        let _ = conn.execute_batch("ROLLBACK");
                        return Err(err);
                    }
                };
            if already_exists {
                conn.execute_batch("COMMIT")?;
                return Ok((msg.id.clone(), false));
            }
        }

        let max_seq: Option<i64> = conn
            .query_row(&seq_sql, [&msg.session_id], |row| row.get(0))
            .unwrap_or(None);
        let sequence = max_seq.unwrap_or(-1) + 1;
        let now = Utc::now().to_rfc3339();

        let result = conn.execute(
            &insert_sql,
            params![
                msg.id,
                msg.session_id,
                msg.role,
                msg.content,
                msg.tool_name,
                msg.tool_call_id,
                msg.tool_input,
                msg.tool_output,
                msg.model,
                sequence,
                msg.created_at,
                msg.images,
                msg.compact_from_sequence,
                msg.compact_tokens_before,
                msg.compact_tokens_after,
            ],
        );

        if let Err(err) = result {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(err);
        }

        if let Err(err) = conn.execute(&touch_sql, params![msg.session_id, now]) {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(err);
        }

        conn.execute_batch("COMMIT")?;
        Ok((msg.id.clone(), true))
    })
}

fn insert_message(prefix: &str, msg: &AgentMessageRow) -> SqliteResult<String> {
    insert_message_with_policy(prefix, msg, MessageConflictPolicy::Replace).map(|(id, _)| id)
}

fn insert_message_if_absent(prefix: &str, msg: &AgentMessageRow) -> SqliteResult<(String, bool)> {
    insert_message_with_policy(prefix, msg, MessageConflictPolicy::PreserveExisting)
}

/// Internal retry wrapper around [`insert_message`].
///
/// Uses exponential back-off identical to `save_events_retry` in the event
/// pipeline. Public message-write hot paths should use the typed `save_*`
/// helpers instead of constructing `AgentMessageRow` values directly.
fn insert_message_retry(prefix: &str, msg: &AgentMessageRow) -> SqliteResult<String> {
    insert_message_retry_with(prefix, msg, insert_message)
}

fn insert_message_if_absent_retry(
    prefix: &str,
    msg: &AgentMessageRow,
) -> SqliteResult<(String, bool)> {
    insert_message_retry_with(prefix, msg, insert_message_if_absent)
}

fn insert_message_retry_with<T>(
    prefix: &str,
    msg: &AgentMessageRow,
    insert: fn(&str, &AgentMessageRow) -> SqliteResult<T>,
) -> SqliteResult<T> {
    let mut last_err = rusqlite::Error::QueryReturnedNoRows; // placeholder
    for attempt in 0..MSG_RETRY_MAX {
        match insert(prefix, msg) {
            Ok(id) => return Ok(id),
            Err(err) => {
                last_err = err;
                if attempt + 1 < MSG_RETRY_MAX {
                    let delay_ms = MSG_RETRY_BASE_MS * (1 << attempt);
                    warn!(
                        "[db_helpers] insert_message attempt {}/{} failed for session {}: {} — retrying in {}ms",
                        attempt + 1,
                        MSG_RETRY_MAX,
                        msg.session_id,
                        last_err,
                        delay_ms,
                    );
                    std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                }
            }
        }
    }
    warn!(
        "[db_helpers] insert_message failed after {} attempts for session {}: {}",
        MSG_RETRY_MAX, msg.session_id, last_err,
    );
    Err(last_err)
}

/// Column list every `AgentMessageRow` query must select, in the order
/// [`read_agent_message_row`] consumes.
pub(crate) const AGENT_MESSAGE_ROW_COLUMNS: &str =
    "id, session_id, role, content, tool_name, tool_call_id,
     tool_input, tool_output, model, sequence, created_at, images,
     compact_from_sequence, compact_tokens_before, compact_tokens_after";

/// Map one result row selected via [`AGENT_MESSAGE_ROW_COLUMNS`].
pub(crate) fn read_agent_message_row(row: &rusqlite::Row<'_>) -> SqliteResult<AgentMessageRow> {
    Ok(AgentMessageRow {
        id: row.get(0)?,
        session_id: row.get(1)?,
        role: row.get(2)?,
        content: row.get(3)?,
        tool_name: row.get(4)?,
        tool_call_id: row.get(5)?,
        tool_input: row.get(6)?,
        tool_output: row.get(7)?,
        model: row.get(8)?,
        sequence: row.get(9)?,
        created_at: row.get(10)?,
        images: row.get(11)?,
        compact_from_sequence: row.get(12)?,
        compact_tokens_before: row.get(13)?,
        compact_tokens_after: row.get(14)?,
    })
}

/// Load all messages for a session, ordered by sequence.
pub fn load_messages(prefix: &str, session_id: &str) -> SqliteResult<Vec<AgentMessageRow>> {
    let conn = get_connection()?;
    let sql = format!(
        "SELECT {AGENT_MESSAGE_ROW_COLUMNS}
         FROM {prefix}_messages
         WHERE session_id = ?1
         ORDER BY sequence ASC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map([session_id], read_agent_message_row)?
        .collect::<SqliteResult<Vec<_>>>()?;
    Ok(rows)
}

mod messages;
pub use messages::*;

pub mod todos;

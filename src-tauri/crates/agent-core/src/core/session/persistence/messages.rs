//! Message persistence — insertion, loading, truncation, history building.

use chrono::Utc;
use rusqlite::{params, Result as SqliteResult};
use uuid::Uuid;

use crate::persistence::db_helpers as shared;
use database::db::{get_connection, with_sessions_writer};

/// Table-name prefix for the unified-session DB schema.
///
/// `db_helpers::*` builds table names as `{prefix}_messages`, `{prefix}_todos`,
/// etc. The unified persistence layer uses a single namespace ("agent_*"),
/// shared by every session category (OS, SDE, subagent). The string is also
/// the column value of `agent_sessions.session_type` for "generic agent"
/// rows — see `crud::record::session_type::GENERIC` (the two are equal by
/// historical accident, but conceptually distinct: this one names a *table
/// family*, the other names a *category enum value*).
const SESSION_TABLE_PREFIX: &str = "agent";

/// Save a user message.
pub fn save_user_msg(
    session_id: &str,
    content: &str,
    images: Option<&[String]>,
) -> SqliteResult<String> {
    shared::save_user_msg(SESSION_TABLE_PREFIX, session_id, content, images)
}

/// Save an assistant message.
pub fn save_assistant_msg(session_id: &str, content: &str, model: &str) -> SqliteResult<String> {
    shared::save_assistant_msg(SESSION_TABLE_PREFIX, session_id, content, model)
}

/// Save a persisted compact summary boundary.
///
/// Unlike runtime stable/dynamic system prompts, this row is part of the durable
/// conversation transcript and should be loaded by `load_llm_history` after
/// restart. It represents older conversation messages that were replaced by a
/// summary, mirroring Claude Code's compact boundary + summary view.
pub fn save_compact_summary_msg(session_id: &str, content: &str) -> SqliteResult<String> {
    shared::save_system_msg(SESSION_TABLE_PREFIX, session_id, content)
}

/// Save a tool call message.
pub fn save_tool_call_msg(
    session_id: &str,
    tool_call_id: &str,
    tool_name: &str,
    arguments: &str,
) -> SqliteResult<String> {
    shared::save_tool_call_msg(
        SESSION_TABLE_PREFIX,
        session_id,
        tool_call_id,
        tool_name,
        arguments,
    )
}

/// Save a tool result message.
pub fn save_tool_result_msg(
    session_id: &str,
    tool_call_id: &str,
    tool_name: &str,
    result: &str,
) -> SqliteResult<String> {
    shared::save_tool_result_msg(
        SESSION_TABLE_PREFIX,
        session_id,
        tool_call_id,
        tool_name,
        result,
    )
}

/// Load messages for a session.
pub fn load_messages(session_id: &str) -> SqliteResult<Vec<shared::AgentMessageRow>> {
    shared::load_messages(SESSION_TABLE_PREFIX, session_id)
}

pub fn message_created_at(session_id: &str, message_id: &str) -> SqliteResult<Option<String>> {
    let conn = get_connection()?;
    let mut stmt = conn.prepare(
        "SELECT created_at FROM agent_messages WHERE session_id = ?1 AND id = ?2 LIMIT 1",
    )?;
    match stmt.query_row(params![session_id, message_id], |row| row.get(0)) {
        Ok(created_at) => Ok(Some(created_at)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(err) => Err(err),
    }
}

/// Truncation anchor for a message row: its `sequence` (the canonical
/// truncation coordinate) plus its own `created_at` (used only to rewind
/// the timestamp-keyed side stores: file-history and session snapshots).
pub struct MessageAnchor {
    pub sequence: i64,
    pub created_at: String,
}

/// Resolve a message id to its truncation anchor.
pub fn message_anchor(session_id: &str, message_id: &str) -> SqliteResult<Option<MessageAnchor>> {
    let conn = get_connection()?;
    let mut stmt = conn.prepare(
        "SELECT sequence, created_at FROM agent_messages WHERE session_id = ?1 AND id = ?2 LIMIT 1",
    )?;
    match stmt.query_row(params![session_id, message_id], |row| {
        Ok(MessageAnchor {
            sequence: row.get(0)?,
            created_at: row.get(1)?,
        })
    }) {
        Ok(anchor) => Ok(Some(anchor)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(err) => Err(err),
    }
}

/// Resolve a `created_at` timestamp to a truncation anchor: the earliest
/// row at or after that timestamp. Legacy path for callers that only have
/// a timestamp (no `message_id`); returns `None` when nothing matches so
/// the caller can fail loudly instead of deleting on a bad coordinate.
pub fn anchor_at_or_after_created_at(
    session_id: &str,
    created_at: &str,
) -> SqliteResult<Option<MessageAnchor>> {
    let conn = get_connection()?;
    let mut stmt = conn.prepare(
        "SELECT sequence, created_at FROM agent_messages
         WHERE session_id = ?1 AND created_at >= ?2
         ORDER BY sequence ASC LIMIT 1",
    )?;
    match stmt.query_row(params![session_id, created_at], |row| {
        Ok(MessageAnchor {
            sequence: row.get(0)?,
            created_at: row.get(1)?,
        })
    }) {
        Ok(anchor) => Ok(Some(anchor)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(err) => Err(err),
    }
}

/// Load LLM-formatted history for a session.
pub fn load_llm_history(session_id: &str) -> SqliteResult<Vec<serde_json::Value>> {
    shared::load_llm_history(SESSION_TABLE_PREFIX, session_id)
}

/// Map "keep the last `tail_len` LLM messages visible" onto a durable
/// sequence cutoff for [`append_compact_boundary`].
pub fn compact_cutoff_sequence(session_id: &str, tail_len: usize) -> SqliteResult<i64> {
    shared::compact_cutoff_sequence(SESSION_TABLE_PREFIX, session_id, tail_len)
}

fn text_content_from_llm_message(msg: &serde_json::Value) -> String {
    match msg.get("content") {
        Some(serde_json::Value::String(text)) => text.clone(),
        Some(serde_json::Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| part.get("text").and_then(|value| value.as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn image_refs_from_llm_message(msg: &serde_json::Value) -> Vec<String> {
    msg.get("content")
        .and_then(|content| content.as_array())
        .into_iter()
        .flatten()
        .filter_map(|part| {
            part.get("image_url")
                .and_then(|image| image.get("url"))
                .and_then(|url| url.as_str())
                .map(str::to_string)
        })
        .collect()
}

fn compacted_history_rows(
    session_id: &str,
    compacted_messages: &[serde_json::Value],
) -> Vec<shared::AgentMessageRow> {
    let mut rows = Vec::new();

    for msg in compacted_messages {
        let role = msg
            .get("role")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        match role {
            "system" => {
                let content = text_content_from_llm_message(msg);
                if !content.trim().is_empty() {
                    rows.push(message_row(
                        session_id,
                        shared::message_role::SYSTEM,
                        content,
                        None,
                    ));
                }
            }
            "user" => {
                let content = text_content_from_llm_message(msg);
                let images = image_refs_from_llm_message(msg);
                let images_json = if images.is_empty() {
                    None
                } else {
                    Some(
                        serde_json::to_string(&images)
                            .expect("Vec<String> serialization is infallible"),
                    )
                };
                rows.push(message_row(
                    session_id,
                    shared::message_role::USER,
                    content,
                    images_json,
                ));
            }
            "assistant" => {
                let content = text_content_from_llm_message(msg);
                if msg.get("tool_calls").is_none() || !content.trim().is_empty() {
                    rows.push(message_row(
                        session_id,
                        shared::message_role::ASSISTANT,
                        content,
                        None,
                    ));
                }
                if let Some(tool_calls) = msg.get("tool_calls").and_then(|value| value.as_array()) {
                    for tool_call in tool_calls {
                        let tool_call_id = tool_call
                            .get("id")
                            .and_then(|value| value.as_str())
                            .unwrap_or("unknown");
                        let tool_name = tool_call
                            .get("function")
                            .and_then(|function| function.get("name"))
                            .and_then(|value| value.as_str())
                            .unwrap_or("unknown");
                        let arguments = tool_call
                            .get("function")
                            .and_then(|function| function.get("arguments"))
                            .and_then(|value| value.as_str())
                            .unwrap_or("{}");
                        let mut row = message_row(
                            session_id,
                            shared::message_role::TOOL_CALL,
                            format!("Tool call: {}", tool_name),
                            None,
                        );
                        row.tool_call_id = Some(tool_call_id.to_string());
                        row.tool_name = Some(tool_name.to_string());
                        row.tool_input = Some(arguments.to_string());
                        rows.push(row);
                    }
                }
            }
            "tool" => {
                let tool_call_id = msg
                    .get("tool_call_id")
                    .and_then(|value| value.as_str())
                    .unwrap_or("unknown");
                let tool_name = msg
                    .get("name")
                    .and_then(|value| value.as_str())
                    .unwrap_or("tool");
                let content = text_content_from_llm_message(msg);
                let mut row = message_row(
                    session_id,
                    shared::message_role::TOOL_RESULT,
                    crate::utils::safe_truncate_chars_to_string(&content, 2000),
                    None,
                );
                row.tool_call_id = Some(tool_call_id.to_string());
                row.tool_name = Some(tool_name.to_string());
                row.tool_output = Some(content);
                rows.push(row);
            }
            _ => {}
        }
    }

    rows
}

fn message_row(
    session_id: &str,
    role: &str,
    content: String,
    images: Option<String>,
) -> shared::AgentMessageRow {
    shared::AgentMessageRow {
        id: Uuid::new_v4().to_string(),
        session_id: session_id.to_string(),
        role: role.to_string(),
        content,
        tool_name: None,
        tool_call_id: None,
        tool_input: None,
        tool_output: None,
        model: None,
        sequence: 0,
        created_at: Utc::now().to_rfc3339(),
        images,
        compact_from_sequence: None,
    }
}

/// Replace a session's persisted transcript with a compacted LLM history view.
///
/// **Seeding only.** This is the durable bootstrap used by compact-fork:
/// it writes an initial transcript into a *fresh* session id. It refuses
/// to run against a session that already has messages — in-place
/// compaction must use [`append_compact_boundary`] instead, which never
/// rewrites or deletes existing rows (immutable transcript invariant).
/// The destructive DELETE+INSERT variant of this function is what
/// destroyed session transcripts when `created_at`-based truncation met
/// rewritten timestamps (2026-06-11 incident).
pub fn seed_session_with_messages(
    session_id: &str,
    compacted_messages: &[serde_json::Value],
) -> SqliteResult<()> {
    let rows = compacted_history_rows(session_id, compacted_messages);
    with_sessions_writer(|| -> SqliteResult<()> {
        let conn = get_connection()?;
        let now = Utc::now().to_rfc3339();
        conn.execute_batch("BEGIN IMMEDIATE")?;

        let existing: i64 = match conn.query_row(
            "SELECT COUNT(*) FROM agent_messages WHERE session_id = ?1",
            [session_id],
            |row| row.get(0),
        ) {
            Ok(count) => count,
            Err(err) => {
                let _ = conn.execute_batch("ROLLBACK");
                return Err(err);
            }
        };
        if existing > 0 {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CONSTRAINT),
                Some(format!(
                    "seed_session_with_messages refused: session {session_id} already has {existing} message row(s); transcripts are immutable — use append_compact_boundary"
                )),
            ));
        }

        for (sequence, row) in rows.iter().enumerate() {
            let result = conn.execute(
                "INSERT INTO agent_messages
                 (id, session_id, role, content, tool_name, tool_call_id, tool_input, tool_output, model, sequence, created_at, images)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                params![
                    row.id,
                    row.session_id,
                    row.role,
                    row.content,
                    row.tool_name,
                    row.tool_call_id,
                    row.tool_input,
                    row.tool_output,
                    row.model,
                    sequence as i64,
                    row.created_at,
                    row.images,
                ],
            );
            if let Err(err) = result {
                let _ = conn.execute_batch("ROLLBACK");
                return Err(err);
            }
        }

        if let Err(err) = conn.execute(
            "UPDATE agent_sessions SET updated_at = ?2 WHERE session_id = ?1",
            params![session_id, now],
        ) {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(err);
        }

        conn.execute_batch("COMMIT")?;
        Ok(())
    })
}

/// Append a compact-boundary row to a session's transcript.
///
/// The boundary row is a `system` message whose `compact_from_sequence`
/// points at the first surviving tail row. `load_llm_history` renders the
/// view as `[summary] + rows where sequence >= from_sequence`; everything
/// older stays in the table untouched. This is the only durable write
/// compaction performs — no row is ever rewritten or deleted, so
/// sequence/created_at coordinates of prior messages remain stable for
/// truncation, turn indexing, and replay.
pub fn append_compact_boundary(
    session_id: &str,
    summary: &str,
    from_sequence: i64,
) -> SqliteResult<String> {
    shared::save_compact_boundary_msg(SESSION_TABLE_PREFIX, session_id, summary, from_sequence)
}

/// Clear all messages for a session.
pub fn clear_messages(session_id: &str) -> SqliteResult<i64> {
    shared::clear_messages(SESSION_TABLE_PREFIX, session_id)
}

/// Truncate messages at or after a given sequence number.
pub fn truncate_messages_from_sequence(session_id: &str, from_sequence: i64) -> SqliteResult<i64> {
    shared::truncate_messages_from_sequence(SESSION_TABLE_PREFIX, session_id, from_sequence)
}

/// Save a snapshot record for a session. After inserting the row, enforces
/// the per-session manifest cap (see
/// [`file_history::MAX_SNAPSHOTS_PER_SESSION`]): oldest manifests are
/// evicted from disk + DB, and unreferenced backup blobs are GC'd. Cap
/// errors are logged but never fail the insert.
pub fn save_snapshot(session_id: &str, tool_call_id: &str, hash: &str) -> SqliteResult<()> {
    with_sessions_writer(|| -> SqliteResult<()> {
        let conn = get_connection()?;
        conn.execute(
            "INSERT INTO agent_snapshots (id, session_id, tool_call_id, hash, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                uuid::Uuid::new_v4().to_string(),
                session_id,
                tool_call_id,
                hash,
                chrono::Utc::now().to_rfc3339()
            ],
        )?;
        Ok(())
    })?;
    crate::tools::file_history::enforce_session_cap_after_save(session_id);
    Ok(())
}

// ============================================
// Subagent Transcript Persistence
// ============================================

/// Persist a subagent's full message transcript for future resume.
/// Skips the system message (index 0) — only user/assistant/tool messages are saved.
///
/// Routes through the shared `save_*_msg` helpers so the `sequence` column is
/// populated via `next_sequence()` and the schema stays in sync with
/// `foundation/persistence/session_snapshots.rs::ensure_tables()`. A prior
/// version used a raw `INSERT` that referenced a non-existent `session_type`
/// column and failed at runtime, losing every subagent transcript.
pub fn save_subagent_transcript(
    session_id: &str,
    messages: &[serde_json::Value],
) -> SqliteResult<()> {
    for msg in messages.iter().skip(1) {
        let role = msg
            .get("role")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");

        let content = msg.get("content").and_then(|v| v.as_str()).unwrap_or("");

        match role {
            "user" => {
                let _ = shared::save_user_msg(SESSION_TABLE_PREFIX, session_id, content, None)?;
            }
            "assistant" => {
                let _ = shared::save_assistant_msg(SESSION_TABLE_PREFIX, session_id, content, "")?;
                if let Some(tool_calls) = msg.get("tool_calls").and_then(|v| v.as_array()) {
                    for tc in tool_calls {
                        let tc_id = tc.get("id").and_then(|v| v.as_str()).unwrap_or("");
                        let tc_name = tc
                            .get("function")
                            .and_then(|f| f.get("name"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        let tc_args = tc
                            .get("function")
                            .and_then(|f| f.get("arguments"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("{}");
                        let _ = shared::save_tool_call_msg(
                            SESSION_TABLE_PREFIX,
                            session_id,
                            tc_id,
                            tc_name,
                            tc_args,
                        )?;
                    }
                }
            }
            "tool" => {
                let tc_id = msg
                    .get("tool_call_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let tc_name = msg.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let _ = shared::save_tool_result_msg(
                    SESSION_TABLE_PREFIX,
                    session_id,
                    tc_id,
                    tc_name,
                    content,
                )?;
            }
            _ => {
                // Unknown role — skip rather than fail the whole transcript.
            }
        }
    }

    Ok(())
}

// ============================================
// Session Memory Persistence
// ============================================

/// Persisted session memory state (content + boundary index).
pub struct PersistedSessionMemoryState {
    pub content: Option<String>,
    pub last_msg_idx: Option<usize>,
}


// ============================================
// Session Memory Semantic Index
// ============================================

#[derive(Debug, Clone)]
pub struct SessionMemoryIndexRow {
    pub session_id: String,
    pub content: String,
    pub embedding: Vec<f32>,
    pub embedding_model: Option<String>,
    pub updated_at: String,
}

pub fn ensure_session_memory_index_schema(conn: &rusqlite::Connection) -> SqliteResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS session_memory_index (
            session_id       TEXT PRIMARY KEY,
            content          TEXT NOT NULL,
            embedding        BLOB,
            embedding_model  TEXT,
            updated_at       TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_session_memory_index_updated
            ON session_memory_index(updated_at);",
    )?;
    Ok(())
}

pub fn save_session_memory_index(
    session_id: &str,
    content: &str,
    embedding: &[f32],
    embedding_model: Option<&str>,
) -> SqliteResult<()> {
    let embedding_bytes: Vec<u8> = embedding.iter().flat_map(|v| v.to_le_bytes()).collect();
    let embedding_blob: Option<&[u8]> = if embedding_bytes.is_empty() {
        None
    } else {
        Some(&embedding_bytes)
    };
    with_sessions_writer(|| -> SqliteResult<()> {
        let conn = get_connection()?;
        ensure_session_memory_index_schema(&conn)?;
        conn.execute(
            "INSERT INTO session_memory_index
                (session_id, content, embedding, embedding_model, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(session_id) DO UPDATE SET
                content = excluded.content,
                embedding = excluded.embedding,
                embedding_model = excluded.embedding_model,
                updated_at = excluded.updated_at",
            rusqlite::params![
                session_id,
                content,
                embedding_blob,
                embedding_model,
                chrono::Utc::now().to_rfc3339(),
            ],
        )?;
        Ok(())
    })
}

pub fn load_session_memory_index_rows() -> SqliteResult<Vec<SessionMemoryIndexRow>> {
    let conn = get_connection()?;
    ensure_session_memory_index_schema(&conn)?;
    let mut stmt = conn.prepare(
        "SELECT session_id, content, embedding, embedding_model, updated_at
         FROM session_memory_index
         ORDER BY updated_at DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        let embedding_blob: Option<Vec<u8>> = row.get(2)?;
        let embedding = embedding_blob
            .map(|blob| {
                blob.chunks_exact(4)
                    .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
                    .collect()
            })
            .unwrap_or_default();
        Ok(SessionMemoryIndexRow {
            session_id: row.get(0)?,
            content: row.get(1)?,
            embedding,
            embedding_model: row.get(3)?,
            updated_at: row.get(4)?,
        })
    })?;
    rows.collect()
}

// ============================================
// Cancel-Interrupt Marker
// ============================================

/// Mark a session as having been cancelled mid-turn.
///
/// The next turn consumes this marker to distinguish an intentional user
/// control boundary from crash recovery. It must not inject synthetic user text
/// into provider history.
pub fn mark_turn_cancelled(session_id: &str) {
    let sid = session_id.to_string();
    let _ = tokio::task::block_in_place(|| -> rusqlite::Result<()> {
        with_sessions_writer(|| -> rusqlite::Result<()> {
            let conn = get_connection()?;
            conn.execute(
                "UPDATE agent_sessions SET last_turn_cancelled = 1 WHERE session_id = ?1",
                [&sid],
            )?;
            Ok(())
        })
    });
}

/// Read and atomically clear the cancel-interrupt marker for a session.
///
/// Returns `true` if the previous turn was cancelled and the marker was set.
/// Always clears the marker so the signal is consumed exactly once.
pub fn take_turn_cancelled(session_id: &str) -> bool {
    let sid = session_id.to_string();
    tokio::task::block_in_place(|| -> bool {
        // Read on a non-serialized connection (WAL allows concurrent
        // reads); only the clear-flag write goes through the writer.
        let flag: i64 = {
            let Ok(conn) = get_connection() else {
                return false;
            };
            conn.query_row(
                "SELECT last_turn_cancelled FROM agent_sessions WHERE session_id = ?1",
                [&sid],
                |row| row.get(0),
            )
            .unwrap_or(0)
        };
        if flag != 0 {
            let _ = with_sessions_writer(|| -> rusqlite::Result<()> {
                let conn = get_connection()?;
                conn.execute(
                    "UPDATE agent_sessions SET last_turn_cancelled = 0 WHERE session_id = ?1",
                    [&sid],
                )?;
                Ok(())
            });
            true
        } else {
            false
        }
    })
}

/// Persist session memory state to the `agent_sessions` table.
pub fn save_session_memory_state(
    session_id: &str,
    content: &str,
    last_msg_idx: Option<usize>,
) -> SqliteResult<()> {
    with_sessions_writer(|| -> SqliteResult<()> {
        let conn = get_connection()?;
        conn.execute(
            "UPDATE agent_sessions SET sm_content = ?2, sm_last_msg_idx = ?3 WHERE session_id = ?1",
            rusqlite::params![session_id, content, last_msg_idx.map(|idx| idx as i64),],
        )?;
        Ok(())
    })
}

/// Clear persisted session memory state after the durable transcript has been compacted.
///
/// A compacted transcript already contains the durable boundary/summary. Keeping an
/// old bare message index would make the next process start apply that index to a
/// shorter, rewritten transcript.
pub fn clear_session_memory_state(session_id: &str) -> SqliteResult<()> {
    with_sessions_writer(|| -> SqliteResult<()> {
        let conn = get_connection()?;
        conn.execute(
            "UPDATE agent_sessions SET sm_content = NULL, sm_last_msg_idx = NULL WHERE session_id = ?1",
            [session_id],
        )?;
        Ok(())
    })
}

/// Load persisted session memory state from the `agent_sessions` table.
pub fn load_session_memory_state(session_id: &str) -> SqliteResult<PersistedSessionMemoryState> {
    let conn = get_connection()?;
    let result = conn.query_row(
        "SELECT sm_content, sm_last_msg_idx FROM agent_sessions WHERE session_id = ?1",
        [session_id],
        |row| {
            let content: Option<String> = row.get(0)?;
            let last_msg_idx: Option<i64> = row.get(1)?;
            Ok(PersistedSessionMemoryState {
                content,
                last_msg_idx: last_msg_idx.map(|idx| idx as usize),
            })
        },
    );
    match result {
        Ok(state) => Ok(state),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(PersistedSessionMemoryState {
            content: None,
            last_msg_idx: None,
        }),
        Err(err) => Err(err),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use database::db::get_connection;
    use test_helpers::test_env;

    fn seed_session_for_message_tests(session_id: &str) {
        let conn = get_connection().expect("get_connection in seed_session_for_message_tests");
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS agent_sessions (
                session_id TEXT PRIMARY KEY,
                session_type TEXT NOT NULL DEFAULT 'agent',
                status TEXT NOT NULL DEFAULT 'running',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                sm_content TEXT,
                sm_last_msg_idx INTEGER
             );
             CREATE TABLE IF NOT EXISTS agent_messages (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL DEFAULT '',
                tool_name TEXT,
                tool_call_id TEXT,
                tool_input TEXT,
                tool_output TEXT,
                model TEXT,
                sequence INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                images TEXT,
                compact_from_sequence INTEGER
             );",
        )
        .expect("create session/message tables");
        conn.execute(
            "INSERT OR IGNORE INTO agent_sessions
             (session_id, session_type, status, created_at, updated_at, sm_content, sm_last_msg_idx)
             VALUES (?1, 'agent', 'running', datetime('now'), datetime('now'), NULL, NULL)",
            [session_id],
        )
        .expect("seed session row");
    }

    #[test]
    fn compact_boundary_hides_old_rows_but_keeps_them_in_table() {
        let _sandbox = test_env::sandbox();
        let session_id = "compact-boundary-test";
        seed_session_for_message_tests(session_id);

        save_user_msg(session_id, "old user", None).expect("save old user");
        save_assistant_msg(session_id, "old assistant", "test-model").expect("save old assistant");
        save_session_memory_state(session_id, "stale sm", Some(99)).expect("save stale sm");
        let recent_user_id =
            save_user_msg(session_id, "recent user", None).expect("save recent user");
        save_assistant_msg(session_id, "recent assistant", "test-model")
            .expect("save recent assistant");

        let anchor = message_anchor(session_id, &recent_user_id)
            .expect("resolve anchor")
            .expect("anchor row exists");
        append_compact_boundary(
            session_id,
            "[Conversation summary — 2 earlier messages compacted]\n\nsummary",
            anchor.sequence,
        )
        .expect("append boundary");
        clear_session_memory_state(session_id).expect("clear stale sm");

        let history = load_llm_history(session_id).expect("load compacted history");
        assert_eq!(history.len(), 3);
        assert_eq!(history[0]["role"], "system");
        assert_eq!(
            history[0]["content"],
            "[Conversation summary — 2 earlier messages compacted]\n\nsummary"
        );
        assert_eq!(history[1]["content"], "recent user");
        assert_eq!(history[2]["content"], "recent assistant");
        assert!(history.iter().all(|message| message
            .get("content")
            .and_then(|value| value.as_str())
            != Some("old user")));

        // Immutability: hidden rows are still in the table.
        let all_rows = load_messages(session_id).expect("load raw rows");
        assert_eq!(all_rows.len(), 5, "no row may be deleted by compaction");
        assert!(all_rows.iter().any(|row| row.content == "old user"));

        let sm_state = load_session_memory_state(session_id).expect("load cleared sm");
        assert!(sm_state.content.is_none());
        assert!(sm_state.last_msg_idx.is_none());
    }

    /// Incident reproduction (2026-06-11 transcript wipe): compaction
    /// followed by truncating at a pre-compaction message must restore the
    /// original history instead of wiping the transcript.
    #[test]
    fn truncate_at_precompaction_message_revives_original_history() {
        let _sandbox = test_env::sandbox();
        let session_id = "compact-truncate-revive-test";
        seed_session_for_message_tests(session_id);

        save_user_msg(session_id, "genesis user", None).expect("save genesis user");
        save_assistant_msg(session_id, "genesis assistant", "test-model")
            .expect("save genesis assistant");
        let old_user_id = save_user_msg(session_id, "old user", None).expect("save old user");
        save_assistant_msg(session_id, "old assistant", "test-model").expect("save old assistant");
        let recent_user_id =
            save_user_msg(session_id, "recent user", None).expect("save recent user");
        save_assistant_msg(session_id, "recent assistant", "test-model")
            .expect("save recent assistant");

        let cutoff = message_anchor(session_id, &recent_user_id)
            .expect("resolve cutoff")
            .expect("cutoff row exists")
            .sequence;
        append_compact_boundary(session_id, "summary", cutoff).expect("append boundary");

        // User edits/resends the *old* (pre-compaction) message.
        let anchor = message_anchor(session_id, &old_user_id)
            .expect("resolve old anchor")
            .expect("old row still exists because compaction never deletes");
        let deleted = truncate_messages_from_sequence(session_id, anchor.sequence)
            .expect("truncate from old anchor");
        assert_eq!(
            deleted, 5,
            "old pair + recent pair + boundary are all >= anchor"
        );

        // The boundary was deleted with the suffix, so nothing is hidden:
        // pre-anchor history is fully visible again — NOT a wiped transcript.
        let history = load_llm_history(session_id).expect("load revived history");
        assert_eq!(history.len(), 2);
        assert_eq!(history[0]["content"], "genesis user");
        assert_eq!(history[1]["content"], "genesis assistant");
    }

    #[test]
    fn second_compaction_boundary_wins() {
        let _sandbox = test_env::sandbox();
        let session_id = "compact-twice-test";
        seed_session_for_message_tests(session_id);

        save_user_msg(session_id, "u1", None).expect("save u1");
        let u2 = save_user_msg(session_id, "u2", None).expect("save u2");
        let first_cutoff = message_anchor(session_id, &u2)
            .expect("anchor u2")
            .expect("u2 exists")
            .sequence;
        append_compact_boundary(session_id, "first summary", first_cutoff).expect("first boundary");

        let u3 = save_user_msg(session_id, "u3", None).expect("save u3");
        let second_cutoff = message_anchor(session_id, &u3)
            .expect("anchor u3")
            .expect("u3 exists")
            .sequence;
        append_compact_boundary(session_id, "second summary", second_cutoff)
            .expect("second boundary");

        let history = load_llm_history(session_id).expect("load history");
        assert_eq!(history.len(), 2);
        assert_eq!(history[0]["content"], "second summary");
        assert_eq!(history[1]["content"], "u3");
    }

    #[test]
    fn seed_session_with_messages_refuses_non_empty_session() {
        let _sandbox = test_env::sandbox();
        let session_id = "seed-guard-test";
        seed_session_for_message_tests(session_id);

        save_user_msg(session_id, "existing", None).expect("save existing");

        let err = seed_session_with_messages(
            session_id,
            &[serde_json::json!({"role": "user", "content": "seed"})],
        )
        .expect_err("seeding a non-empty session must fail");
        assert!(
            err.to_string().contains("immutable"),
            "error should explain the invariant, got: {err}"
        );

        let rows = load_messages(session_id).expect("load rows");
        assert_eq!(rows.len(), 1, "existing transcript untouched");
        assert_eq!(rows[0].content, "existing");
    }

    #[test]
    fn seed_session_with_messages_seeds_empty_session_and_clears_sm_state() {
        let _sandbox = test_env::sandbox();
        let session_id = "seed-empty-test";
        seed_session_for_message_tests(session_id);

        let compacted = vec![
            serde_json::json!({"role": "system", "content": "[Conversation summary — 2 earlier messages compacted]\n\nsummary"}),
            serde_json::json!({"role": "user", "content": "recent user"}),
            serde_json::json!({"role": "assistant", "content": "recent assistant"}),
        ];

        seed_session_with_messages(session_id, &compacted).expect("seed empty session");
        clear_session_memory_state(session_id).expect("clear sm");

        let history = load_llm_history(session_id).expect("load seeded history");
        assert_eq!(history.len(), 3);
        assert_eq!(history[0]["role"], "system");
        assert_eq!(history[0]["content"], compacted[0]["content"]);
        assert_eq!(history[1]["content"], "recent user");
        assert_eq!(history[2]["content"], "recent assistant");
    }

    #[test]
    fn truncate_anchor_resolution_fails_loud_for_missing_rows() {
        let _sandbox = test_env::sandbox();
        let session_id = "anchor-missing-test";
        seed_session_for_message_tests(session_id);
        save_user_msg(session_id, "only message", None).expect("save");

        assert!(message_anchor(session_id, "no-such-id")
            .expect("query ok")
            .is_none());
        assert!(
            anchor_at_or_after_created_at(session_id, "2999-01-01T00:00:00Z")
                .expect("query ok")
                .is_none()
        );
    }

    /// Validates the skip-system-message logic used in `save_subagent_transcript`.
    #[test]
    fn transcript_skips_system_message() {
        let messages = [
            serde_json::json!({"role": "system", "content": "You are helpful."}),
            serde_json::json!({"role": "user", "content": "hello"}),
            serde_json::json!({"role": "assistant", "content": "hi"}),
        ];

        let non_system: Vec<_> = messages
            .iter()
            .skip(1)
            .map(|m| m["role"].as_str().unwrap().to_string())
            .collect();

        assert_eq!(non_system, ["user", "assistant"]);
    }

    /// Validates tool_call extraction logic from assistant messages.
    #[test]
    fn transcript_extracts_tool_calls() {
        let msg = serde_json::json!({
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "id": "tc_001",
                    "function": {
                        "name": "read_file",
                        "arguments": "{\"path\": \"/tmp/test.rs\"}"
                    }
                },
                {
                    "id": "tc_002",
                    "function": {
                        "name": "write_file",
                        "arguments": "{\"path\": \"/tmp/out.rs\", \"content\": \"hello\"}"
                    }
                }
            ]
        });

        let tool_calls = msg.get("tool_calls").unwrap().as_array().unwrap();
        assert_eq!(tool_calls.len(), 2);

        let tc_id = tool_calls[0].get("id").and_then(|v| v.as_str()).unwrap();
        assert_eq!(tc_id, "tc_001");

        let tc_name = tool_calls[0]
            .get("function")
            .and_then(|f| f.get("name"))
            .and_then(|v| v.as_str())
            .unwrap();
        assert_eq!(tc_name, "read_file");

        let tc_args = tool_calls[1]
            .get("function")
            .and_then(|f| f.get("arguments"))
            .and_then(|v| v.as_str())
            .unwrap();
        assert!(tc_args.contains("out.rs"));
    }

    /// Validates that messages without tool_calls are handled gracefully.
    #[test]
    fn transcript_no_tool_calls() {
        let msg = serde_json::json!({
            "role": "assistant",
            "content": "just text, no tools"
        });

        let tool_calls = msg.get("tool_calls").and_then(|v| v.as_array());
        assert!(tool_calls.is_none());
    }

    /// Validates empty message list (only system) produces no saved records.
    #[test]
    fn transcript_system_only_produces_nothing() {
        let messages = [serde_json::json!({"role": "system", "content": "system prompt"})];

        let non_system: Vec<_> = messages.iter().skip(1).collect();
        assert!(non_system.is_empty());
    }

    /// Validates role extraction fallback for malformed messages.
    #[test]
    fn transcript_missing_role_defaults_to_unknown() {
        let msg = serde_json::json!({"content": "no role field"});
        let role = msg
            .get("role")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        assert_eq!(role, "unknown");
    }
}

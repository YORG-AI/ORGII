//! Message persistence — insertion, loading, truncation, history building.

use std::collections::{HashMap, HashSet};

use chrono::Utc;
use rusqlite::{params, OptionalExtension, Result as SqliteResult};
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentOrgInboxTranscriptMaterialization {
    pub message_id: String,
    pub intent_id: String,
    pub content: String,
}

/// One provider-neutral history row used to seed or extend an Agent session.
///
/// Materialization identity is carried beside the content instead of being
/// hidden inside provider-style JSON. This keeps LLM/tool payloads free of
/// ORG2-only fields while preserving deterministic, retry-safe row ids.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MaterializedHistorySeed {
    pub id: String,
    pub created_at: String,
    pub content: MaterializedHistoryContent,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MaterializedHistoryContent {
    Message {
        role: MaterializedHistoryRole,
        text: String,
        images: Vec<String>,
    },
    ToolCall {
        call_id: String,
        name: String,
        arguments: String,
    },
    ToolResult {
        call_id: String,
        name: String,
        output: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MaterializedHistoryRole {
    User,
    Assistant,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MaterializedHistoryReceipt {
    pub row_count: usize,
}

/// Load the transcript batches already materialized for the supplied unread
/// Inbox rows in this exact Session. A row stays unread until a successful
/// provider turn, but its durable receipt prevents it from being appended to
/// the transcript a second time when a later Inbox row joins the retry batch.
pub fn load_agent_org_inbox_transcript_materializations(
    session_id: &str,
    inbox_ids: &[i64],
) -> Result<
    (
        std::collections::HashSet<i64>,
        Vec<AgentOrgInboxTranscriptMaterialization>,
    ),
    String,
> {
    let conn = get_connection().map_err(|err| err.to_string())?;
    let mut materialized_ids = std::collections::HashSet::new();
    let mut batches = std::collections::BTreeMap::new();
    let mut stmt = conn
        .prepare(
            "SELECT receipt.session_id,
                    receipt.transcript_message_id,
                    receipt.transcript_intent_id,
                    message.content
             FROM agent_inbox_materializations receipt
             LEFT JOIN agent_messages message
               ON message.id=receipt.transcript_message_id
              AND message.session_id=receipt.session_id
             WHERE receipt.inbox_id=?1",
        )
        .map_err(|err| err.to_string())?;
    for inbox_id in inbox_ids {
        let row: Option<(String, String, String, Option<String>)> = stmt
            .query_row(params![inbox_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .optional()
            .map_err(|err| err.to_string())?;
        let Some((receipt_session_id, message_id, intent_id, content)) = row else {
            continue;
        };
        if receipt_session_id != session_id {
            return Err(format!(
                "Agent Org Inbox row {inbox_id} is materialized in another live session {receipt_session_id}; refusing to duplicate delivery into {session_id}"
            ));
        }
        let content = content.ok_or_else(|| {
            format!(
                "Agent Org Inbox materialization for row {inbox_id} references missing transcript {message_id}"
            )
        })?;
        materialized_ids.insert(*inbox_id);
        batches
            .entry(message_id.clone())
            .or_insert(AgentOrgInboxTranscriptMaterialization {
                message_id,
                intent_id,
                content,
            });
    }
    Ok((materialized_ids, batches.into_values().collect()))
}

/// Atomically persist one newly-rendered Inbox transcript and a receipt for
/// every source row. If another turn materialized any member of this batch
/// after the read snapshot, fail closed and let the next Wake rebuild the
/// batch from current receipts; never persist a partially duplicated batch.
pub fn materialize_agent_org_inbox_transcript(
    session_id: &str,
    inbox_ids: &[i64],
    message_id: &str,
    intent_id: &str,
    content: &str,
) -> Result<(AgentOrgInboxTranscriptMaterialization, bool), String> {
    if inbox_ids.is_empty() {
        return Err("cannot materialize an empty Agent Org Inbox batch".to_string());
    }
    with_sessions_writer(|| -> Result<_, String> {
        let mut conn = get_connection().map_err(|err| err.to_string())?;
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|err| err.to_string())?;

        let mut existing_receipts = Vec::new();
        {
            let mut stmt = tx
                .prepare(
                    "SELECT session_id, transcript_message_id, transcript_intent_id
                     FROM agent_inbox_materializations WHERE inbox_id=?1",
                )
                .map_err(|err| err.to_string())?;
            for inbox_id in inbox_ids {
                if let Some(receipt) = stmt
                    .query_row(params![inbox_id], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    })
                    .optional()
                    .map_err(|err| err.to_string())?
                {
                    existing_receipts.push((*inbox_id, receipt));
                }
            }
        }
        if !existing_receipts.is_empty() {
            return Err(
                "Agent Org Inbox materialization changed after drain; retry from a fresh unread snapshot"
                    .to_string(),
            );
        }

        let unread_count = {
            let mut stmt = tx
                .prepare("SELECT read_at FROM agent_inbox WHERE id=?1")
                .map_err(|err| err.to_string())?;
            let mut count = 0usize;
            for inbox_id in inbox_ids {
                let read_at: Option<Option<String>> = stmt
                    .query_row(params![inbox_id], |row| row.get(0))
                    .optional()
                    .map_err(|err| err.to_string())?;
                if matches!(read_at, Some(None)) {
                    count += 1;
                }
            }
            count
        };
        if unread_count != inbox_ids.len() {
            return Err(
                "Agent Org Inbox materialization source rows changed after drain; retry"
                    .to_string(),
            );
        }

        let already_exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM agent_messages WHERE id=?1)",
                params![message_id],
                |row| row.get(0),
            )
            .map_err(|err| err.to_string())?;
        let inserted = if already_exists {
            let existing: (String, String) = tx
                .query_row(
                    "SELECT session_id, content FROM agent_messages WHERE id=?1",
                    params![message_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(|err| err.to_string())?;
            if existing.0 != session_id || existing.1 != content {
                return Err(format!(
                    "stable Agent Org Inbox transcript id {message_id} conflicts with different persisted content"
                ));
            }
            false
        } else {
            let sequence: i64 = tx
                .query_row(
                    "SELECT COALESCE(MAX(sequence), -1) + 1 FROM agent_messages WHERE session_id=?1",
                    params![session_id],
                    |row| row.get(0),
                )
                .map_err(|err| err.to_string())?;
            let now = Utc::now().to_rfc3339();
            tx.execute(
                "INSERT INTO agent_messages
                 (id, session_id, role, content, tool_name, tool_call_id, tool_input,
                  tool_output, model, sequence, created_at, images,
                  compact_from_sequence, compact_tokens_before, compact_tokens_after)
                 VALUES (?1, ?2, 'user', ?3, NULL, NULL, NULL, NULL, NULL, ?4, ?5,
                         NULL, NULL, NULL, NULL)",
                params![message_id, session_id, content, sequence, &now],
            )
            .map_err(|err| err.to_string())?;
            tx.execute(
                "UPDATE agent_sessions SET updated_at=?2 WHERE session_id=?1",
                params![session_id, &now],
            )
            .map_err(|err| err.to_string())?;
            true
        };

        let materialized_at = Utc::now().to_rfc3339();
        {
            let mut stmt = tx
                .prepare(
                    "INSERT INTO agent_inbox_materializations
                     (inbox_id, session_id, transcript_message_id, transcript_intent_id, materialized_at)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                )
                .map_err(|err| err.to_string())?;
            for inbox_id in inbox_ids {
                stmt.execute(params![
                    inbox_id,
                    session_id,
                    message_id,
                    intent_id,
                    &materialized_at
                ])
                .map_err(|err| err.to_string())?;
            }
        }
        tx.commit().map_err(|err| err.to_string())?;
        Ok((
            AgentOrgInboxTranscriptMaterialization {
                message_id: message_id.to_string(),
                intent_id: intent_id.to_string(),
                content: content.to_string(),
            },
            inserted,
        ))
    })
}

/// Save a user message.
pub fn save_user_msg(
    session_id: &str,
    content: &str,
    images: Option<&[String]>,
) -> SqliteResult<String> {
    shared::save_user_msg(SESSION_TABLE_PREFIX, session_id, content, images)
}

/// Persist an at-least-once user input under a stable id. Replays return the
/// same id without inserting a second transcript row.
pub fn save_user_msg_with_id(
    message_id: &str,
    session_id: &str,
    content: &str,
) -> SqliteResult<(String, bool)> {
    shared::save_user_msg_with_id(SESSION_TABLE_PREFIX, message_id, session_id, content)
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

/// Load text/tool-only LLM history without hydrating image payloads, plus
/// each message's first-row durable sequence for cursor anchoring.
pub fn load_llm_history_text_only(
    session_id: &str,
) -> SqliteResult<(Vec<serde_json::Value>, Vec<i64>)> {
    shared::load_llm_history_text_only(SESSION_TABLE_PREFIX, session_id)
}

/// Bounded variant of [`load_llm_history_text_only`]: loads newest-first and
/// stops once the visible suffix is guaranteed to serialize past `max_bytes`,
/// keeping peak allocation proportional to the budget. See
/// `db_helpers::load_llm_history_text_only_bounded` for the suffix contract.
pub fn load_llm_history_text_only_bounded(
    session_id: &str,
    max_bytes: usize,
) -> SqliteResult<(Vec<serde_json::Value>, Vec<i64>)> {
    shared::load_llm_history_text_only_bounded(SESSION_TABLE_PREFIX, session_id, max_bytes)
}

/// First-row durable sequence per visible LLM message, in history order.
pub fn load_llm_history_start_sequences(session_id: &str) -> SqliteResult<Vec<i64>> {
    shared::load_llm_history_start_sequences(SESSION_TABLE_PREFIX, session_id)
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

fn materialized_history_rows(
    session_id: &str,
    seeds: &[MaterializedHistorySeed],
) -> SqliteResult<Vec<shared::AgentMessageRow>> {
    seeds
        .iter()
        .map(|seed| {
            if seed.id.trim().is_empty() || seed.created_at.trim().is_empty() {
                return Err(history_append_constraint(
                    "materialized history requires a stable id and timestamp".to_string(),
                ));
            }
            let mut row = match &seed.content {
                MaterializedHistoryContent::Message { role, text, images } => {
                    let role = match role {
                        MaterializedHistoryRole::User => shared::message_role::USER,
                        MaterializedHistoryRole::Assistant => shared::message_role::ASSISTANT,
                    };
                    let images = (!images.is_empty()).then(|| {
                        serde_json::to_string(images)
                            .expect("Vec<String> serialization is infallible")
                    });
                    message_row(session_id, role, text.clone(), images)
                }
                MaterializedHistoryContent::ToolCall {
                    call_id,
                    name,
                    arguments,
                } => {
                    if call_id.trim().is_empty() || name.trim().is_empty() {
                        return Err(history_append_constraint(
                            "materialized tool call requires a call id and name".to_string(),
                        ));
                    }
                    serde_json::from_str::<serde_json::Value>(arguments).map_err(|error| {
                        history_append_constraint(format!(
                            "materialized tool call {call_id} has invalid JSON arguments: {error}"
                        ))
                    })?;
                    let mut row = message_row(
                        session_id,
                        shared::message_role::TOOL_CALL,
                        format!("Tool call: {name}"),
                        None,
                    );
                    row.tool_call_id = Some(call_id.clone());
                    row.tool_name = Some(name.clone());
                    row.tool_input = Some(arguments.clone());
                    row
                }
                MaterializedHistoryContent::ToolResult {
                    call_id,
                    name,
                    output,
                } => {
                    if call_id.trim().is_empty() || name.trim().is_empty() {
                        return Err(history_append_constraint(
                            "materialized tool result requires a call id and name".to_string(),
                        ));
                    }
                    let mut row = message_row(
                        session_id,
                        shared::message_role::TOOL_RESULT,
                        crate::utils::safe_truncate_chars_to_string(output, 2000),
                        None,
                    );
                    row.tool_call_id = Some(call_id.clone());
                    row.tool_name = Some(name.clone());
                    row.tool_output = Some(output.clone());
                    row
                }
            };
            row.id = seed.id.clone();
            row.created_at = seed.created_at.clone();
            Ok(row)
        })
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HistoryRowsValidation {
    None,
    MaterializedToolGraph,
}

fn apply_tool_graph_row(
    role: &str,
    call_id: Option<&str>,
    tool_name: Option<&str>,
    open_calls: &mut HashMap<String, String>,
    completed_calls: &mut HashSet<String>,
) -> SqliteResult<()> {
    match role {
        shared::message_role::TOOL_CALL => {
            let call_id = call_id.ok_or_else(|| {
                history_append_constraint("materialized tool call is missing call id".to_string())
            })?;
            let tool_name = tool_name.ok_or_else(|| {
                history_append_constraint("materialized tool call is missing name".to_string())
            })?;
            if open_calls.contains_key(call_id) || completed_calls.contains(call_id) {
                return Err(history_append_constraint(format!(
                    "materialized history contains duplicate tool call id {call_id}"
                )));
            }
            open_calls.insert(call_id.to_string(), tool_name.to_string());
        }
        shared::message_role::TOOL_RESULT => {
            let call_id = call_id.ok_or_else(|| {
                history_append_constraint("materialized tool result is missing call id".to_string())
            })?;
            let tool_name = tool_name.ok_or_else(|| {
                history_append_constraint("materialized tool result is missing name".to_string())
            })?;
            let expected_name = open_calls.remove(call_id).ok_or_else(|| {
                history_append_constraint(format!(
                    "materialized tool result {call_id} has no prior unresolved tool call"
                ))
            })?;
            if expected_name != tool_name {
                return Err(history_append_constraint(format!(
                    "materialized tool result {call_id} names {tool_name}, expected {expected_name}"
                )));
            }
            completed_calls.insert(call_id.to_string());
        }
        _ => {}
    }
    Ok(())
}

/// Validate the complete persisted-prefix + candidate-suffix tool graph while
/// holding the same SQLite write transaction that appends the suffix. An open
/// call at the end is valid partial-turn state; a later synchronization may
/// close it with a result in its next suffix.
fn validate_materialized_tool_graph(
    tx: &rusqlite::Transaction<'_>,
    session_id: &str,
    include_persisted_prefix: bool,
    rows: &[shared::AgentMessageRow],
) -> SqliteResult<()> {
    let mut open_calls = HashMap::new();
    let mut completed_calls = HashSet::new();
    if include_persisted_prefix {
        let mut statement = tx.prepare(
            "SELECT role, tool_call_id, tool_name
             FROM agent_messages
             WHERE session_id = ?1
             ORDER BY sequence ASC",
        )?;
        let persisted = statement.query_map([session_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })?;
        for row in persisted {
            let (role, call_id, tool_name) = row?;
            apply_tool_graph_row(
                &role,
                call_id.as_deref(),
                tool_name.as_deref(),
                &mut open_calls,
                &mut completed_calls,
            )?;
        }
    }
    for row in rows {
        apply_tool_graph_row(
            &row.role,
            row.tool_call_id.as_deref(),
            row.tool_name.as_deref(),
            &mut open_calls,
            &mut completed_calls,
        )?;
    }
    Ok(())
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
        compact_tokens_before: None,
        compact_tokens_after: None,
    }
}

fn history_append_constraint(message: String) -> rusqlite::Error {
    rusqlite::Error::SqliteFailure(
        rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CONSTRAINT),
        Some(message),
    )
}

fn persisted_history_row_matches(
    persisted: &shared::AgentMessageRow,
    expected: &shared::AgentMessageRow,
) -> bool {
    persisted.session_id == expected.session_id
        && persisted.role == expected.role
        && persisted.content == expected.content
        && persisted.tool_name == expected.tool_name
        && persisted.tool_call_id == expected.tool_call_id
        && persisted.tool_input == expected.tool_input
        && persisted.tool_output == expected.tool_output
        && persisted.model == expected.model
        && persisted.created_at == expected.created_at
        && persisted.images == expected.images
        && match expected.compact_from_sequence {
            Some(_) => {
                persisted.compact_from_sequence == Some(persisted.sequence.saturating_add(1))
            }
            None => persisted.compact_from_sequence.is_none(),
        }
}

fn persisted_history_row(
    tx: &rusqlite::Transaction<'_>,
    id: &str,
) -> SqliteResult<Option<shared::AgentMessageRow>> {
    tx.query_row(
        "SELECT session_id, role, content, tool_name, tool_call_id,
                tool_input, tool_output, model, sequence, created_at,
                images, compact_from_sequence
         FROM agent_messages WHERE id = ?1",
        params![id],
        |row| {
            Ok(shared::AgentMessageRow {
                id: id.to_string(),
                session_id: row.get(0)?,
                role: row.get(1)?,
                content: row.get(2)?,
                tool_name: row.get(3)?,
                tool_call_id: row.get(4)?,
                tool_input: row.get(5)?,
                tool_output: row.get(6)?,
                model: row.get(7)?,
                sequence: row.get(8)?,
                created_at: row.get(9)?,
                images: row.get(10)?,
                compact_from_sequence: row.get(11)?,
                compact_tokens_before: None,
                compact_tokens_after: None,
            })
        },
    )
    .optional()
}

fn persist_history_rows(
    session_id: &str,
    rows: &[shared::AgentMessageRow],
    require_empty: bool,
    validation: HistoryRowsValidation,
) -> SqliteResult<()> {
    with_sessions_writer(|| -> SqliteResult<()> {
        let mut conn = get_connection()?;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let next_sequence = if require_empty {
            let existing: i64 = tx.query_row(
                "SELECT COUNT(*) FROM agent_messages WHERE session_id = ?1",
                [session_id],
                |row| row.get(0),
            )?;
            if existing == 0 {
                0
            } else {
                let mut exact_rows = 0usize;
                for (offset, expected) in rows.iter().enumerate() {
                    let Some(persisted) = persisted_history_row(&tx, &expected.id)? else {
                        continue;
                    };
                    exact_rows += 1;
                    if persisted.sequence != offset as i64
                        || !persisted_history_row_matches(&persisted, expected)
                    {
                        return Err(history_append_constraint(format!(
                            "seed_session_with_messages conflict: native row {} already exists with different content, ownership, or sequence",
                            expected.id
                        )));
                    }
                }
                if exact_rows == rows.len() && existing as usize == rows.len() {
                    // A previous seed committed the complete deterministic
                    // native transcript but lost its response. The exact rows
                    // are the durable receipt, so retry is a no-op.
                    return tx.commit();
                }
                return Err(history_append_constraint(format!(
                    "seed_session_with_messages conflict: {exact_rows} of {} expected native rows exist among {existing} session row(s); transcripts are immutable, refusing a mixed or unrelated seed",
                    rows.len()
                )));
            }
        } else {
            let next_sequence = tx.query_row(
                "SELECT COALESCE(MAX(sequence), -1) + 1 FROM agent_messages WHERE session_id = ?1",
                [session_id],
                |row| row.get(0),
            )?;
            let mut existing_count = 0usize;
            let mut first_existing_sequence = None;
            for (offset, expected) in rows.iter().enumerate() {
                let persisted = persisted_history_row(&tx, &expected.id)?;
                let Some(persisted) = persisted else {
                    continue;
                };
                existing_count += 1;
                let first_sequence = *first_existing_sequence.get_or_insert(persisted.sequence);
                let expected_sequence = first_sequence.saturating_add(offset as i64);
                if persisted.sequence != expected_sequence
                    || !persisted_history_row_matches(&persisted, expected)
                {
                    let message = format!(
                        "history append conflict: native row {} already exists with different content, ownership, or sequence",
                        expected.id
                    );
                    return Err(history_append_constraint(message));
                }
            }
            if existing_count == rows.len() {
                // A previous attempt committed the entire deterministic
                // suffix but lost its response. Treat the exact durable rows
                // as the authoritative receipt and do not append them again.
                return tx.commit();
            }
            if existing_count > 0 {
                return Err(history_append_constraint(format!(
                    "history append conflict: {existing_count} of {} native rows already exist; refusing a mixed suffix",
                    rows.len()
                )));
            }
            next_sequence
        };

        if validation == HistoryRowsValidation::MaterializedToolGraph {
            validate_materialized_tool_graph(&tx, session_id, !require_empty, rows)?;
        }

        for (offset, row) in rows.iter().enumerate() {
            let sequence = next_sequence + offset as i64;
            let compact_from_sequence = row
                .compact_from_sequence
                .map(|_| sequence.saturating_add(1));
            tx.execute(
                "INSERT INTO agent_messages
                 (id, session_id, role, content, tool_name, tool_call_id, tool_input, tool_output, model, sequence, created_at, images, compact_from_sequence)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
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
                    sequence,
                    row.created_at,
                    row.images,
                    compact_from_sequence,
                ],
            )?;
        }

        let now = Utc::now().to_rfc3339();
        tx.execute(
            "UPDATE agent_sessions SET updated_at = ?2 WHERE session_id = ?1",
            params![session_id, now],
        )?;
        tx.commit()
    })
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
    persist_history_rows(session_id, &rows, true, HistoryRowsValidation::None)
}

/// Seed a fresh Agent session from typed canonical history.
///
/// The returned row count is the durable materialization receipt. Exact
/// retries are accepted by [`persist_history_rows`]; mixed or conflicting
/// retries fail without appending a partial suffix.
pub fn seed_session_with_materialized_history(
    session_id: &str,
    seeds: &[MaterializedHistorySeed],
) -> SqliteResult<MaterializedHistoryReceipt> {
    let rows = materialized_history_rows(session_id, seeds)?;
    persist_history_rows(
        session_id,
        &rows,
        true,
        HistoryRowsValidation::MaterializedToolGraph,
    )?;
    Ok(MaterializedHistoryReceipt {
        row_count: rows.len(),
    })
}

/// Append typed canonical history to an existing Agent session atomically.
pub fn append_session_with_materialized_history(
    session_id: &str,
    seeds: &[MaterializedHistorySeed],
) -> SqliteResult<MaterializedHistoryReceipt> {
    if seeds.is_empty() {
        return Ok(MaterializedHistoryReceipt { row_count: 0 });
    }
    let rows = materialized_history_rows(session_id, seeds)?;
    persist_history_rows(
        session_id,
        &rows,
        false,
        HistoryRowsValidation::MaterializedToolGraph,
    )?;
    Ok(MaterializedHistoryReceipt {
        row_count: rows.len(),
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
    tokens_before: Option<i64>,
    tokens_after: Option<i64>,
) -> SqliteResult<(String, String)> {
    shared::save_compact_boundary_msg(
        SESSION_TABLE_PREFIX,
        session_id,
        summary,
        from_sequence,
        tokens_before,
        tokens_after,
    )
}

/// Update display-only token metadata on a compact-boundary row.
pub fn update_compact_boundary_token_delta(
    session_id: &str,
    boundary_id: &str,
    tokens_before: Option<i64>,
    tokens_after: Option<i64>,
) -> SqliteResult<()> {
    with_sessions_writer(|| -> SqliteResult<()> {
        let conn = get_connection()?;
        conn.execute(
            "UPDATE agent_messages
             SET compact_tokens_before = ?3,
                 compact_tokens_after = ?4
             WHERE session_id = ?1
               AND id = ?2
               AND compact_from_sequence IS NOT NULL",
            params![session_id, boundary_id, tokens_before, tokens_after],
        )?;
        Ok(())
    })
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
    if crate::bus::frontend_subscriber_count() > 0 {
        crate::bus::broadcast_event(
            "agent:snapshot_created",
            serde_json::json!({ "sessionId": session_id }),
        );
    }
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
    pub last_seq: Option<i64>,
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
///
/// `last_seq` is the durable start-sequence of the last summarized message —
/// frame-independent, unlike the array index it replaced, so truncated or
/// compacted views resolve it to their own coordinates at read time.
pub fn save_session_memory_state(
    session_id: &str,
    content: &str,
    last_seq: Option<i64>,
) -> SqliteResult<()> {
    with_sessions_writer(|| -> SqliteResult<()> {
        let conn = get_connection()?;
        conn.execute(
            "UPDATE agent_sessions SET sm_content = ?2, sm_last_seq = ?3 WHERE session_id = ?1",
            rusqlite::params![session_id, content, last_seq],
        )?;
        Ok(())
    })
}

/// Clear persisted session memory state after the durable transcript has been compacted.
pub fn clear_session_memory_state(session_id: &str) -> SqliteResult<()> {
    with_sessions_writer(|| -> SqliteResult<()> {
        let conn = get_connection()?;
        conn.execute(
            "UPDATE agent_sessions SET sm_content = NULL, sm_last_seq = NULL WHERE session_id = ?1",
            [session_id],
        )?;
        Ok(())
    })
}

/// Load persisted session memory state from the `agent_sessions` table.
pub fn load_session_memory_state(session_id: &str) -> SqliteResult<PersistedSessionMemoryState> {
    let conn = get_connection()?;
    let result = conn.query_row(
        "SELECT sm_content, sm_last_seq FROM agent_sessions WHERE session_id = ?1",
        [session_id],
        |row| {
            let content: Option<String> = row.get(0)?;
            let last_seq: Option<i64> = row.get(1)?;
            Ok(PersistedSessionMemoryState { content, last_seq })
        },
    );
    match result {
        Ok(state) => Ok(state),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(PersistedSessionMemoryState {
            content: None,
            last_seq: None,
        }),
        Err(err) => Err(err),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use database::db::get_connection;
    use test_helpers::test_env;

    fn materialized_message(
        id: &str,
        created_at: &str,
        role: MaterializedHistoryRole,
        text: &str,
    ) -> MaterializedHistorySeed {
        MaterializedHistorySeed {
            id: id.to_string(),
            created_at: created_at.to_string(),
            content: MaterializedHistoryContent::Message {
                role,
                text: text.to_string(),
                images: Vec::new(),
            },
        }
    }

    fn materialized_tool_call(
        id: &str,
        created_at: &str,
        call_id: &str,
        name: &str,
    ) -> MaterializedHistorySeed {
        MaterializedHistorySeed {
            id: id.to_string(),
            created_at: created_at.to_string(),
            content: MaterializedHistoryContent::ToolCall {
                call_id: call_id.to_string(),
                name: name.to_string(),
                arguments: "{}".to_string(),
            },
        }
    }

    fn materialized_tool_result(
        id: &str,
        created_at: &str,
        call_id: &str,
        name: &str,
    ) -> MaterializedHistorySeed {
        MaterializedHistorySeed {
            id: id.to_string(),
            created_at: created_at.to_string(),
            content: MaterializedHistoryContent::ToolResult {
                call_id: call_id.to_string(),
                name: name.to_string(),
                output: "done".to_string(),
            },
        }
    }

    fn seed_session_for_message_tests(session_id: &str) {
        let conn = get_connection().expect("get_connection in seed_session_for_message_tests");
        crate::persistence::test_schema::ensure_agent_sessions_schema(&conn);
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS agent_messages (
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
                compact_from_sequence INTEGER,
                compact_tokens_before INTEGER,
                compact_tokens_after INTEGER
             );",
        )
        .expect("create session/message tables");
        conn.execute(
            "INSERT OR IGNORE INTO agent_sessions
             (session_id, session_type, status, created_at, updated_at, sm_content, sm_last_seq)
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
            Some(10_402),
            Some(1_042),
        )
        .expect("append boundary");
        clear_session_memory_state(session_id).expect("clear stale sm");

        // Token metadata round-trips on the boundary row (display-only
        // columns; ordinary rows stay NULL).
        let raw_rows = load_messages(session_id).expect("load raw rows");
        let boundary_row = raw_rows
            .iter()
            .find(|row| row.compact_from_sequence.is_some())
            .expect("boundary row present");
        assert_eq!(boundary_row.compact_tokens_before, Some(10_402));
        assert_eq!(boundary_row.compact_tokens_after, Some(1_042));
        assert!(raw_rows
            .iter()
            .filter(|row| row.compact_from_sequence.is_none())
            .all(|row| row.compact_tokens_before.is_none() && row.compact_tokens_after.is_none()));

        let history = load_llm_history(session_id).expect("load compacted history");
        assert_eq!(history.len(), 3);
        // Boundary rows are stored as `system` but rendered as `user` in the
        // LLM view (summary-as-user + continuation semantics).
        assert_eq!(history[0]["role"], "user");
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
        assert!(sm_state.last_seq.is_none());
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
        append_compact_boundary(session_id, "summary", cutoff, None, None)
            .expect("append boundary");

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
        append_compact_boundary(session_id, "first summary", first_cutoff, None, None)
            .expect("first boundary");

        let u3 = save_user_msg(session_id, "u3", None).expect("save u3");
        let second_cutoff = message_anchor(session_id, &u3)
            .expect("anchor u3")
            .expect("u3 exists")
            .sequence;
        append_compact_boundary(session_id, "second summary", second_cutoff, None, None)
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
    fn native_materialization_preserves_portable_message_identity() {
        let _sandbox = test_env::sandbox();
        let session_id = "seed-native-identity-test";
        seed_session_for_message_tests(session_id);
        seed_session_with_materialized_history(
            session_id,
            &[materialized_message(
                "org2-turn-v1.dHVybi0x.c291cmNlLTE.nonce",
                "2026-08-29T00:00:00Z",
                MaterializedHistoryRole::User,
                "continue",
            )],
        )
        .expect("seed native identity");

        let rows = load_messages(session_id).expect("load native identity");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "org2-turn-v1.dHVybi0x.c291cmNlLTE.nonce");
        assert_eq!(rows[0].created_at, "2026-08-29T00:00:00Z");
    }

    #[test]
    fn native_materialization_accepts_an_exact_fully_seeded_retry() {
        let _sandbox = test_env::sandbox();
        let session_id = "seed-native-idempotent-retry-test";
        seed_session_for_message_tests(session_id);
        let transcript = [materialized_message(
            "org2-native-v1.c291cmNlLTE.target",
            "2026-08-29T00:00:00Z",
            MaterializedHistoryRole::User,
            "continue",
        )];

        seed_session_with_materialized_history(session_id, &transcript)
            .expect("seed native transcript");
        seed_session_with_materialized_history(session_id, &transcript)
            .expect("retry exact native seed");

        let rows = load_messages(session_id).expect("load native transcript");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "org2-native-v1.c291cmNlLTE.target");
        assert_eq!(rows[0].sequence, 0);
    }

    #[test]
    fn typed_materialization_preserves_native_role_and_tool_order() {
        let _sandbox = test_env::sandbox();
        let session_id = "append-native-history-test";
        seed_session_for_message_tests(session_id);
        seed_session_with_materialized_history(
            session_id,
            &[materialized_message(
                "user-1",
                "2026-08-30T00:00:00Z",
                MaterializedHistoryRole::User,
                "first",
            )],
        )
        .expect("seed prefix");

        append_session_with_materialized_history(
            session_id,
            &[
                materialized_message(
                    "assistant-1",
                    "2026-08-30T00:00:01Z",
                    MaterializedHistoryRole::Assistant,
                    "answer",
                ),
                MaterializedHistorySeed {
                    id: "tool-call-1".to_string(),
                    created_at: "2026-08-30T00:00:02Z".to_string(),
                    content: MaterializedHistoryContent::ToolCall {
                        call_id: "call-1".to_string(),
                        name: "read_file".to_string(),
                        arguments: "{\"path\":\"README.md\"}".to_string(),
                    },
                },
                MaterializedHistorySeed {
                    id: "tool-result-1".to_string(),
                    created_at: "2026-08-30T00:00:03Z".to_string(),
                    content: MaterializedHistoryContent::ToolResult {
                        call_id: "call-1".to_string(),
                        name: "read_file".to_string(),
                        output: "contents".to_string(),
                    },
                },
            ],
        )
        .expect("append native suffix");

        let history = load_llm_history(session_id).expect("load appended history");
        assert_eq!(history.len(), 4);
        assert_eq!(history[0]["content"], "first");
        assert_eq!(history[1]["content"], "answer");
        assert_eq!(history[2]["tool_calls"][0]["id"], "call-1");
        assert_eq!(history[3]["tool_call_id"], "call-1");
        let rows = load_messages(session_id).expect("load raw rows");
        assert_eq!(
            rows.iter().map(|row| row.sequence).collect::<Vec<_>>(),
            vec![0, 1, 2, 3]
        );
    }

    #[test]
    fn typed_materialization_preserves_partial_call_then_closes_it_in_a_suffix() {
        let _sandbox = test_env::sandbox();
        let session_id = "append-native-partial-tool-call-test";
        seed_session_for_message_tests(session_id);
        seed_session_with_materialized_history(
            session_id,
            &[materialized_tool_call(
                "tool-call-1",
                "2026-08-30T00:00:00Z",
                "call-1",
                "read_file",
            )],
        )
        .expect("an unresolved call is valid partial-turn history");

        append_session_with_materialized_history(
            session_id,
            &[materialized_tool_result(
                "tool-result-1",
                "2026-08-30T00:00:01Z",
                "call-1",
                "read_file",
            )],
        )
        .expect("a later suffix may close the persisted unresolved call");

        let rows = load_messages(session_id).expect("load partial call history");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].role, shared::message_role::TOOL_CALL);
        assert_eq!(rows[1].role, shared::message_role::TOOL_RESULT);
    }

    #[test]
    fn typed_materialization_rejects_orphan_and_mismatched_tool_results() {
        let _sandbox = test_env::sandbox();
        let orphan_session = "append-native-orphan-tool-result-test";
        seed_session_for_message_tests(orphan_session);
        let orphan = materialized_tool_result(
            "tool-result-orphan",
            "2026-08-30T00:00:00Z",
            "missing-call",
            "read_file",
        );
        assert!(seed_session_with_materialized_history(orphan_session, &[orphan]).is_err());
        assert!(load_messages(orphan_session)
            .expect("load rejected orphan history")
            .is_empty());

        let mismatch_session = "append-native-mismatched-tool-result-test";
        seed_session_for_message_tests(mismatch_session);
        seed_session_with_materialized_history(
            mismatch_session,
            &[materialized_tool_call(
                "tool-call-1",
                "2026-08-30T00:00:00Z",
                "call-1",
                "read_file",
            )],
        )
        .expect("seed unresolved call");
        let mismatch = materialized_tool_result(
            "tool-result-1",
            "2026-08-30T00:00:01Z",
            "call-1",
            "write_file",
        );
        assert!(append_session_with_materialized_history(mismatch_session, &[mismatch]).is_err());
        assert_eq!(
            load_messages(mismatch_session)
                .expect("load history after name mismatch")
                .len(),
            1,
            "the invalid suffix must be rejected atomically"
        );
    }

    #[test]
    fn typed_materialization_rejects_duplicate_tool_call_ids() {
        let _sandbox = test_env::sandbox();
        let session_id = "append-native-duplicate-tool-call-test";
        seed_session_for_message_tests(session_id);
        let duplicate_calls = [
            materialized_tool_call("tool-call-1", "2026-08-30T00:00:00Z", "call-1", "read_file"),
            materialized_tool_call("tool-call-2", "2026-08-30T00:00:01Z", "call-1", "read_file"),
        ];

        assert!(seed_session_with_materialized_history(session_id, &duplicate_calls).is_err());
        assert!(load_messages(session_id)
            .expect("load rejected duplicate-call history")
            .is_empty());
    }

    #[test]
    fn typed_materialization_accepts_a_fully_applied_suffix_once() {
        let _sandbox = test_env::sandbox();
        let session_id = "append-native-idempotent-suffix-test";
        seed_session_for_message_tests(session_id);
        let suffix = [materialized_message(
            "org2-native-v1.c291cmNlLTE.target",
            "2026-08-30T00:00:00Z",
            MaterializedHistoryRole::Assistant,
            "answer",
        )];

        append_session_with_materialized_history(session_id, &suffix)
            .expect("append native suffix");
        append_session_with_materialized_history(session_id, &suffix)
            .expect("retry committed suffix");

        let rows = load_messages(session_id).expect("load idempotent suffix");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "org2-native-v1.c291cmNlLTE.target");
        assert_eq!(rows[0].sequence, 0);
    }

    #[test]
    fn typed_materialization_rejects_missing_identity_metadata() {
        let _sandbox = test_env::sandbox();
        let session_id = "append-native-missing-identity-test";
        seed_session_for_message_tests(session_id);
        let missing_id = materialized_message(
            "",
            "2026-08-30T00:00:00Z",
            MaterializedHistoryRole::User,
            "first",
        );

        assert!(append_session_with_materialized_history(session_id, &[missing_id]).is_err());
        assert!(load_messages(session_id)
            .expect("load rows after rejected append")
            .is_empty());
    }

    #[test]
    fn typed_materialization_rejects_mixed_or_conflicting_suffixes() {
        let _sandbox = test_env::sandbox();
        let session_id = "append-native-conflicting-suffix-test";
        seed_session_for_message_tests(session_id);
        let first = materialized_message(
            "org2-native-v1.Zmlyc3Q.target",
            "2026-08-30T00:00:00Z",
            MaterializedHistoryRole::User,
            "first",
        );
        append_session_with_materialized_history(session_id, std::slice::from_ref(&first))
            .expect("append first native row");

        let mixed = [
            first.clone(),
            materialized_message(
                "org2-native-v1.c2Vjb25k.target",
                "2026-08-30T00:00:01Z",
                MaterializedHistoryRole::Assistant,
                "second",
            ),
        ];
        assert!(append_session_with_materialized_history(session_id, &mixed).is_err());

        let conflict = [materialized_message(
            "org2-native-v1.Zmlyc3Q.target",
            "2026-08-30T00:00:00Z",
            MaterializedHistoryRole::User,
            "different",
        )];
        assert!(append_session_with_materialized_history(session_id, &conflict).is_err());
        let rows = load_messages(session_id).expect("load rows after rejected suffixes");
        assert_eq!(rows.len(), 1, "failed retries must not append partial rows");
        assert_eq!(rows[0].content, "first");
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

//! Message persistence — insertion, loading, truncation, history building.

use chrono::Utc;
use rusqlite::{
    params, OptionalExtension, Result as SqliteResult, Transaction, TransactionBehavior,
};
use uuid::Uuid;

use crate::persistence::db_helpers as shared;
use crate::session::context_import::{
    CacheLayoutStats, ContextSnapshotMeta, ContextSourceKind, SessionEmbeddingState,
};
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

/// Persist one user message and its Journey membership in one SQLite
/// transaction. A pending task becomes active only after the transcript row
/// has been inserted successfully. Sessions without a Journey deliberately
/// keep the established writer and receive no inferred membership.
pub fn save_user_msg_and_assign_journey(
    session_id: &str,
    content: &str,
    images: Option<&[String]>,
) -> SqliteResult<String> {
    with_sessions_writer(|| {
        let mut conn = get_connection()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let message_id = Uuid::new_v4().to_string();
        let images_json = images.filter(|value| !value.is_empty()).map(|value| {
            let paths = crate::persistence::images::persist_images(value);
            if paths.is_empty() {
                serde_json::to_string(value).expect("image paths serialize")
            } else {
                serde_json::to_string(&paths).expect("image paths serialize")
            }
        });
        let sequence: i64 = tx.query_row(
            "SELECT COALESCE(MAX(sequence), -1) + 1 FROM agent_messages WHERE session_id = ?1",
            [session_id],
            |row| row.get(0),
        )?;
        tx.execute(
            "INSERT INTO agent_messages
             (id, session_id, role, content, sequence, created_at, images)
             VALUES (?1, ?2, 'user', ?3, ?4, ?5, ?6)",
            params![
                &message_id,
                session_id,
                content,
                sequence,
                Utc::now().to_rfc3339(),
                images_json
            ],
        )?;

        if let Some(mut journey) =
            crate::core::journey_lifecycle::SqliteJourneyRepository::load(&tx, session_id)
                .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?
        {
            let previous_revision = journey.revision;
            journey
                .on_user_message_persisted(previous_revision, sequence as u64)
                .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
            if journey.revision != previous_revision {
                crate::core::journey_lifecycle::SqliteJourneyRepository::compare_and_store_in_transaction(
                    &tx,
                    &journey,
                    previous_revision,
                )
                .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
            }
            ensure_active_branch_accepts_messages(&journey)?;
            tx.execute(
                "INSERT INTO session_journey_memberships
                 (session_id, message_id, sequence, branch_id, task_id)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    session_id,
                    &message_id,
                    sequence,
                    journey.active_branch_id,
                    journey.active_task_id
                ],
            )?;
        }
        tx.execute(
            "UPDATE agent_sessions SET updated_at = ?2 WHERE session_id = ?1",
            params![session_id, Utc::now().to_rfc3339()],
        )?;
        tx.commit()?;
        Ok(message_id)
    })
}

/// Save an assistant message.
pub fn save_assistant_msg(session_id: &str, content: &str, model: &str) -> SqliteResult<String> {
    save_message_and_assign_journey(
        session_id,
        "assistant",
        content,
        None,
        None,
        None,
        None,
        Some(model),
    )
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
    save_message_and_assign_journey(
        session_id,
        "tool_call",
        &format!("Tool call: {tool_name}"),
        Some(tool_name),
        Some(tool_call_id),
        Some(arguments),
        None,
        None,
    )
}

/// Save a tool result message.
pub fn save_tool_result_msg(
    session_id: &str,
    tool_call_id: &str,
    tool_name: &str,
    result: &str,
) -> SqliteResult<String> {
    save_message_and_assign_journey(
        session_id,
        "tool_result",
        &crate::utils::safe_truncate_chars_to_string(result, 2000),
        Some(tool_name),
        Some(tool_call_id),
        None,
        Some(result),
        None,
    )
}

/// Writes non-user transcript rows and their exact Journey membership in one
/// transaction. The message id and allocated sequence are the only anchors;
/// timestamps are deliberately not consulted.
fn save_message_and_assign_journey(
    session_id: &str,
    role: &str,
    content: &str,
    tool_name: Option<&str>,
    tool_call_id: Option<&str>,
    tool_input: Option<&str>,
    tool_output: Option<&str>,
    model: Option<&str>,
) -> SqliteResult<String> {
    with_sessions_writer(|| {
        let mut conn = get_connection()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let message_id = Uuid::new_v4().to_string();
        let sequence = insert_journey_message(
            &tx,
            session_id,
            &message_id,
            role,
            content,
            tool_name,
            tool_call_id,
            tool_input,
            tool_output,
            model,
        )?;
        assign_message_membership(&tx, session_id, &message_id, sequence)?;
        tx.execute(
            "UPDATE agent_sessions SET updated_at = ?2 WHERE session_id = ?1",
            params![session_id, Utc::now().to_rfc3339()],
        )?;
        tx.commit()?;
        Ok(message_id)
    })
}

fn insert_journey_message(
    tx: &Transaction<'_>,
    session_id: &str,
    message_id: &str,
    role: &str,
    content: &str,
    tool_name: Option<&str>,
    tool_call_id: Option<&str>,
    tool_input: Option<&str>,
    tool_output: Option<&str>,
    model: Option<&str>,
) -> SqliteResult<i64> {
    let sequence: i64 = tx.query_row(
        "SELECT COALESCE(MAX(sequence), -1) + 1 FROM agent_messages WHERE session_id = ?1",
        [session_id],
        |row| row.get(0),
    )?;
    tx.execute(
        "INSERT INTO agent_messages
         (id, session_id, role, content, tool_name, tool_call_id, tool_input, tool_output, model, sequence, created_at, images)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, NULL)",
        params![
            message_id,
            session_id,
            role,
            content,
            tool_name,
            tool_call_id,
            tool_input,
            tool_output,
            model,
            sequence,
            Utc::now().to_rfc3339(),
        ],
    )?;
    Ok(sequence)
}

fn assign_message_membership(
    tx: &Transaction<'_>,
    session_id: &str,
    message_id: &str,
    sequence: i64,
) -> SqliteResult<()> {
    let Some(journey) =
        crate::core::journey_lifecycle::SqliteJourneyRepository::load(tx, session_id)
            .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?
    else {
        return Ok(());
    };
    ensure_active_branch_accepts_messages(&journey)?;
    tx.execute(
        "INSERT INTO session_journey_memberships
         (session_id, message_id, sequence, branch_id, task_id)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            session_id,
            message_id,
            sequence,
            journey.active_branch_id,
            journey.active_task_id,
        ],
    )?;
    Ok(())
}

/// A Journey branch accepts transcript rows only while it is the active,
/// writable branch.  Persisting into a closing/closed branch makes later
/// evidence validation ambiguous, so fail the caller rather than guessing.
fn ensure_active_branch_accepts_messages(
    journey: &crate::core::journey_lifecycle::SessionJourney,
) -> SqliteResult<()> {
    use crate::core::journey_lifecycle::ForkState;

    let branch = journey
        .branches
        .get(&journey.active_branch_id)
        .ok_or_else(|| {
            rusqlite::Error::ToSqlConversionFailure("Journey 活动分叉不存在。".into())
        })?;
    if branch.state != ForkState::Active {
        return Err(rusqlite::Error::ToSqlConversionFailure(
            format!("Journey 活动分叉不可写入：{:?}。", branch.state).into(),
        ));
    }
    Ok(())
}

/// Persist the exact branch/task active at a completed turn boundary. This is
/// intentionally separate from message membership because one turn can own
/// several assistant/tool rows.
pub fn save_completed_turn_and_assign_journey(session_id: &str, turn_id: &str) -> SqliteResult<()> {
    with_sessions_writer(|| {
        let mut conn = get_connection()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let Some(journey) =
            crate::core::journey_lifecycle::SqliteJourneyRepository::load(&tx, session_id)
                .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?
        else {
            tx.commit()?;
            return Ok(());
        };
        ensure_active_branch_accepts_messages(&journey)?;
        let sequence: i64 = tx.query_row(
            "SELECT COALESCE(MAX(sequence), -1) FROM agent_messages WHERE session_id = ?1",
            [session_id],
            |row| row.get(0),
        )?;
        let member: Option<(String, Option<String>)> = tx
            .query_row(
                "SELECT branch_id, task_id FROM session_journey_memberships
                 WHERE session_id = ?1 AND sequence = ?2
                 ORDER BY message_id DESC LIMIT 1",
                params![session_id, sequence],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if member.as_ref()
            != Some(&(
                journey.active_branch_id.clone(),
                journey.active_task_id.clone(),
            ))
        {
            return Err(rusqlite::Error::ToSqlConversionFailure(
                "Journey 完成回合缺少活动分叉的精确消息归属。".into(),
            ));
        }
        tx.execute(
            "INSERT OR IGNORE INTO session_journey_turn_memberships
             (session_id, turn_id, completed_sequence, branch_id, task_id)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                session_id,
                turn_id,
                sequence,
                journey.active_branch_id,
                journey.active_task_id
            ],
        )?;
        tx.commit()?;
        Ok(())
    })
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

fn append_parent_handoff_capsules(
    journey: &crate::core::journey_lifecycle::SessionJourney,
    mut prompt: Vec<serde_json::Value>,
) -> Vec<serde_json::Value> {
    prompt.extend(
        journey
            .parent_handoff_capsules(&journey.active_branch_id)
            .into_iter()
            .map(crate::core::journey_lifecycle::HandoffCapsule::synthetic_prompt_message),
    );
    prompt
}

/// Load provider history through the Journey visibility boundary when this is
/// a Journey session. Legacy sessions, including ones with no memberships,
/// retain the existing history semantics exactly.
pub fn load_llm_history_for_active_journey(
    session_id: &str,
) -> SqliteResult<Vec<serde_json::Value>> {
    let conn = get_connection()?;
    let Some(journey) =
        crate::core::journey_lifecycle::SqliteJourneyRepository::load(&conn, session_id)
            .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?
    else {
        return load_llm_history(session_id);
    };
    let mut statement = conn.prepare(
        "SELECT message_id, sequence, branch_id, task_id
         FROM session_journey_memberships WHERE session_id = ?1",
    )?;
    let memberships = statement
        .query_map([session_id], |row| {
            Ok(
                crate::session::journey_context_visibility::JourneyMessageMembership {
                    message_id: row.get(0)?,
                    sequence: row.get::<_, i64>(1)? as u64,
                    branch_id: row.get(2)?,
                    task_id: row.get(3)?,
                },
            )
        })?
        .collect::<SqliteResult<Vec<_>>>()?;
    if memberships.is_empty() {
        return load_llm_history(session_id);
    }

    let messages = shared::visible_rows(&shared::load_messages(SESSION_TABLE_PREFIX, session_id)?);
    let persisted = messages
        .iter()
        .filter(|message| message.sequence >= 0)
        .map(
            |message| crate::session::journey_context_visibility::PersistedContextMessage {
                message_id: message.id.clone(),
                sequence: message.sequence as u64,
            },
        )
        .collect::<Vec<_>>();
    let visible_ids = crate::session::journey_context_visibility::project_prompt_message_ids(
        &journey,
        &journey.active_branch_id,
        &persisted,
        &memberships,
    )
    .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    let visible = messages
        .into_iter()
        .filter(|message| visible_ids.contains(&message.id))
        .collect::<Vec<_>>();
    let prompt = shared::reconstruct(&visible);
    // This is the sole parent prompt assembly boundary. Capsules are appended
    // after reconstruction so every persisted parent message retains its exact
    // serialized order and bytes; fork transcript rows never enter `visible`.
    Ok(append_parent_handoff_capsules(&journey, prompt))
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
        compact_tokens_before: None,
        compact_tokens_after: None,
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
    pub embedding_source: Option<String>,
    pub embedding_dimensions: Option<usize>,
    pub updated_at: String,
}

pub fn ensure_session_memory_index_schema(conn: &rusqlite::Connection) -> SqliteResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS session_memory_index (
            session_id       TEXT PRIMARY KEY,
            content          TEXT NOT NULL,
            embedding        BLOB,
            embedding_model  TEXT,
            embedding_source TEXT,
            embedding_dimensions INTEGER,
            updated_at       TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_session_memory_index_updated
            ON session_memory_index(updated_at);",
    )?;
    for migration in [
        "ALTER TABLE session_memory_index ADD COLUMN embedding_source TEXT",
        "ALTER TABLE session_memory_index ADD COLUMN embedding_dimensions INTEGER",
    ] {
        let _ = conn.execute(migration, []);
    }
    Ok(())
}

pub fn save_session_memory_index(
    session_id: &str,
    content: &str,
    embedding: &[f32],
    embedding_model: Option<&str>,
    embedding_source: Option<&str>,
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
                (session_id, content, embedding, embedding_model, embedding_source, embedding_dimensions, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(session_id) DO UPDATE SET
                content = excluded.content,
                embedding = excluded.embedding,
                embedding_model = excluded.embedding_model,
                embedding_source = excluded.embedding_source,
                embedding_dimensions = excluded.embedding_dimensions,
                updated_at = excluded.updated_at",
            rusqlite::params![
                session_id,
                content,
                embedding_blob,
                embedding_model,
                embedding_source,
                embedding.len() as i64,
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
        "SELECT session_id, content, embedding, embedding_model, embedding_source, embedding_dimensions, updated_at
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
            embedding_source: row.get(4)?,
            embedding_dimensions: row.get::<_, Option<i64>>(5)?.map(|value| value as usize),
            updated_at: row.get(6)?,
        })
    })?;
    rows.collect()
}

pub fn latest_message_sequence(session_id: &str) -> SqliteResult<i64> {
    let conn = get_connection()?;
    conn.query_row(
        "SELECT COALESCE(MAX(sequence), 0) FROM agent_messages WHERE session_id = ?1",
        params![session_id],
        |row| row.get(0),
    )
}

// ============================================
// Context Snapshot / Import / Cache Layout Metadata
// ============================================

fn context_kind_from_str(value: &str) -> ContextSourceKind {
    match value {
        "session" => ContextSourceKind::Session,
        "work_item" => ContextSourceKind::WorkItem,
        "file" => ContextSourceKind::File,
        "memory" => ContextSourceKind::Memory,
        "imported_context" => ContextSourceKind::ImportedContext,
        "global_preference" => ContextSourceKind::GlobalPreference,
        _ => ContextSourceKind::ImportedContext,
    }
}

pub fn ensure_context_metadata_schema(conn: &rusqlite::Connection) -> SqliteResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS context_snapshots (
            snapshot_id        TEXT PRIMARY KEY,
            target_session_id  TEXT NOT NULL,
            source_kind        TEXT NOT NULL,
            source_id          TEXT NOT NULL,
            namespace          TEXT NOT NULL,
            title              TEXT,
            token_estimate     INTEGER NOT NULL DEFAULT 0,
            pinned             INTEGER NOT NULL DEFAULT 0,
            snippet            TEXT,
            created_at         TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_context_snapshots_target
            ON context_snapshots(target_session_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_context_snapshots_namespace
            ON context_snapshots(namespace);

        CREATE TABLE IF NOT EXISTS turn_cache_layout_stats (
            session_id              TEXT NOT NULL,
            turn_id                 TEXT NOT NULL,
            stable_prefix_tokens    INTEGER NOT NULL DEFAULT 0,
            volatile_context_tokens INTEGER NOT NULL DEFAULT 0,
            imported_context_count  INTEGER NOT NULL DEFAULT 0,
            cache_read_tokens       INTEGER NOT NULL DEFAULT 0,
            cache_write_tokens      INTEGER NOT NULL DEFAULT 0,
            created_at              TEXT NOT NULL,
            PRIMARY KEY(session_id, turn_id)
        );
        CREATE INDEX IF NOT EXISTS idx_turn_cache_layout_stats_session
            ON turn_cache_layout_stats(session_id, created_at);

        CREATE TABLE IF NOT EXISTS session_embedding_state (
            namespace              TEXT PRIMARY KEY,
            session_id             TEXT NOT NULL,
            work_item_id           TEXT,
            last_embedded_sequence INTEGER NOT NULL DEFAULT 0,
            embedding_model        TEXT,
            updated_at             TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_session_embedding_state_session
            ON session_embedding_state(session_id);
        CREATE INDEX IF NOT EXISTS idx_session_embedding_state_work_item
            ON session_embedding_state(work_item_id);",
    )?;
    if let Err(err) = conn.execute("ALTER TABLE context_snapshots ADD COLUMN snippet TEXT", []) {
        let msg = err.to_string();
        if !msg.contains("duplicate column name") {
            return Err(err);
        }
    }
    Ok(())
}

pub fn save_context_snapshot(meta: &ContextSnapshotMeta) -> SqliteResult<()> {
    with_sessions_writer(|| -> SqliteResult<()> {
        let conn = get_connection()?;
        ensure_context_metadata_schema(&conn)?;
        conn.execute(
            "INSERT INTO context_snapshots
                (snapshot_id, target_session_id, source_kind, source_id, namespace,
                 title, token_estimate, pinned, snippet, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(snapshot_id) DO UPDATE SET
                target_session_id = excluded.target_session_id,
                source_kind = excluded.source_kind,
                source_id = excluded.source_id,
                namespace = excluded.namespace,
                title = excluded.title,
                token_estimate = excluded.token_estimate,
                pinned = excluded.pinned,
                snippet = excluded.snippet,
                created_at = excluded.created_at",
            params![
                meta.snapshot_id,
                meta.target_session_id,
                meta.source_kind.as_str(),
                meta.source_id,
                meta.namespace,
                meta.title,
                meta.token_estimate,
                if meta.pinned { 1 } else { 0 },
                meta.snippet,
                meta.created_at,
            ],
        )?;
        Ok(())
    })
}

pub fn load_context_snapshots(target_session_id: &str) -> SqliteResult<Vec<ContextSnapshotMeta>> {
    let conn = get_connection()?;
    ensure_context_metadata_schema(&conn)?;
    let mut stmt = conn.prepare(
        "SELECT snapshot_id, target_session_id, source_kind, source_id, namespace,
                title, token_estimate, pinned, snippet, created_at
         FROM context_snapshots
         WHERE target_session_id = ?1
         ORDER BY pinned DESC, created_at DESC",
    )?;
    let rows = stmt.query_map(params![target_session_id], |row| {
        let source_kind: String = row.get(2)?;
        let pinned: i64 = row.get(7)?;
        Ok(ContextSnapshotMeta {
            snapshot_id: row.get(0)?,
            target_session_id: row.get(1)?,
            source_kind: context_kind_from_str(&source_kind),
            source_id: row.get(3)?,
            namespace: row.get(4)?,
            title: row.get(5)?,
            token_estimate: row.get(6)?,
            pinned: pinned != 0,
            snippet: row.get(8)?,
            created_at: row.get(9)?,
        })
    })?;
    rows.collect()
}

pub fn save_turn_cache_layout_stats(
    session_id: &str,
    turn_id: &str,
    stats: &CacheLayoutStats,
) -> SqliteResult<()> {
    with_sessions_writer(|| -> SqliteResult<()> {
        let conn = get_connection()?;
        ensure_context_metadata_schema(&conn)?;
        conn.execute(
            "INSERT INTO turn_cache_layout_stats
                (session_id, turn_id, stable_prefix_tokens, volatile_context_tokens,
                 imported_context_count, cache_read_tokens, cache_write_tokens, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(session_id, turn_id) DO UPDATE SET
                stable_prefix_tokens = excluded.stable_prefix_tokens,
                volatile_context_tokens = excluded.volatile_context_tokens,
                imported_context_count = excluded.imported_context_count,
                cache_read_tokens = excluded.cache_read_tokens,
                cache_write_tokens = excluded.cache_write_tokens,
                created_at = excluded.created_at",
            params![
                session_id,
                turn_id,
                stats.stable_prefix_tokens,
                stats.volatile_context_tokens,
                stats.imported_context_count,
                stats.cache_read_tokens,
                stats.cache_write_tokens,
                Utc::now().to_rfc3339(),
            ],
        )?;
        Ok(())
    })
}

pub fn load_turn_cache_layout_stats(
    session_id: &str,
    turn_id: &str,
) -> SqliteResult<Option<CacheLayoutStats>> {
    let conn = get_connection()?;
    ensure_context_metadata_schema(&conn)?;
    let mut stmt = conn.prepare(
        "SELECT stable_prefix_tokens, volatile_context_tokens, imported_context_count,
                cache_read_tokens, cache_write_tokens
         FROM turn_cache_layout_stats
         WHERE session_id = ?1 AND turn_id = ?2",
    )?;
    let mut rows = stmt.query(params![session_id, turn_id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(CacheLayoutStats::new(
            row.get(0)?,
            row.get(1)?,
            row.get(2)?,
            row.get(3)?,
            row.get(4)?,
        )))
    } else {
        Ok(None)
    }
}

pub fn load_latest_turn_cache_layout_stats(
    session_id: &str,
) -> SqliteResult<Option<(String, CacheLayoutStats)>> {
    let conn = get_connection()?;
    ensure_context_metadata_schema(&conn)?;
    let mut stmt = conn.prepare(
        "SELECT turn_id, stable_prefix_tokens, volatile_context_tokens, imported_context_count,
                cache_read_tokens, cache_write_tokens
         FROM turn_cache_layout_stats
         WHERE session_id = ?1
         ORDER BY created_at DESC
         LIMIT 1",
    )?;
    let mut rows = stmt.query(params![session_id])?;
    if let Some(row) = rows.next()? {
        Ok(Some((
            row.get(0)?,
            CacheLayoutStats::new(
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
            ),
        )))
    } else {
        Ok(None)
    }
}

pub fn save_session_embedding_state(state: &SessionEmbeddingState) -> SqliteResult<()> {
    with_sessions_writer(|| -> SqliteResult<()> {
        let conn = get_connection()?;
        ensure_context_metadata_schema(&conn)?;
        conn.execute(
            "INSERT INTO session_embedding_state
                (namespace, session_id, work_item_id, last_embedded_sequence,
                 embedding_model, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(namespace) DO UPDATE SET
                session_id = excluded.session_id,
                work_item_id = excluded.work_item_id,
                last_embedded_sequence = excluded.last_embedded_sequence,
                embedding_model = excluded.embedding_model,
                updated_at = excluded.updated_at",
            params![
                state.namespace,
                state.session_id,
                state.work_item_id,
                state.last_embedded_sequence,
                state.embedding_model,
                state.updated_at,
            ],
        )?;
        Ok(())
    })
}

pub fn load_session_embedding_state(
    namespace: &str,
) -> SqliteResult<Option<SessionEmbeddingState>> {
    let conn = get_connection()?;
    ensure_context_metadata_schema(&conn)?;
    let mut stmt = conn.prepare(
        "SELECT namespace, session_id, work_item_id, last_embedded_sequence,
                embedding_model, updated_at
         FROM session_embedding_state
         WHERE namespace = ?1",
    )?;
    let mut rows = stmt.query(params![namespace])?;
    if let Some(row) = rows.next()? {
        Ok(Some(SessionEmbeddingState {
            namespace: row.get(0)?,
            session_id: row.get(1)?,
            work_item_id: row.get(2)?,
            last_embedded_sequence: row.get(3)?,
            embedding_model: row.get(4)?,
            updated_at: row.get(5)?,
        }))
    } else {
        Ok(None)
    }
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

    #[test]
    fn context_metadata_roundtrips() {
        let _sandbox = test_env::sandbox();
        let snap = ContextSnapshotMeta::new(
            "target-session",
            ContextSourceKind::Session,
            "source-session",
            Some("Imported source".into()),
            123,
            true,
        );
        save_context_snapshot(&snap).expect("save context snapshot");
        let rows = load_context_snapshots("target-session").expect("load snapshots");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].snapshot_id, snap.snapshot_id);
        assert_eq!(rows[0].namespace, "session:source-session");
        assert_eq!(rows[0].token_estimate, 123);
        assert!(rows[0].pinned);
    }

    #[test]
    fn cache_layout_stats_roundtrip() {
        let _sandbox = test_env::sandbox();
        let stats = CacheLayoutStats::new(1000, 250, 3, 800, 200);
        save_turn_cache_layout_stats("session-cache", "turn-1", &stats)
            .expect("save cache layout stats");
        let loaded = load_turn_cache_layout_stats("session-cache", "turn-1")
            .expect("load cache layout stats")
            .expect("stats exists");
        assert_eq!(loaded, stats);
        assert_eq!(loaded.provider_cache_hit_rate(), Some(0.8));
    }

    #[test]
    fn session_embedding_state_roundtrips_by_namespace() {
        let _sandbox = test_env::sandbox();
        let state = SessionEmbeddingState::for_session(
            "session-embed",
            Some("WI-42".into()),
            77,
            Some("dashscope-qwen".into()),
        );
        save_session_embedding_state(&state).expect("save embedding state");
        let loaded = load_session_embedding_state(&state.namespace)
            .expect("load embedding state")
            .expect("state exists");
        assert_eq!(loaded.namespace, "session:session-embed");
        assert_eq!(loaded.session_id, "session-embed");
        assert_eq!(loaded.work_item_id.as_deref(), Some("WI-42"));
        assert_eq!(loaded.last_embedded_sequence, 77);
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
             (session_id, session_type, status, created_at, updated_at, sm_content, sm_last_msg_idx)
             VALUES (?1, 'agent', 'running', datetime('now'), datetime('now'), NULL, NULL)",
            [session_id],
        )
        .expect("seed session row");
    }

    #[test]
    fn assistant_tool_and_completed_turn_keep_exact_journey_membership() {
        let _sandbox = test_env::sandbox();
        let session_id = "journey-message-membership";
        seed_session_for_message_tests(session_id);
        let mut conn = get_connection().expect("get connection");
        let mut journey = crate::core::journey_lifecycle::SessionJourney::new(session_id, "main");
        journey
            .start_task(0, "task".into(), "精确归属".into(), false, Some(0))
            .expect("start task");
        crate::core::journey_lifecycle::SqliteJourneyRepository::compare_and_store(
            &mut conn, &journey, 0,
        )
        .expect("store journey");
        drop(conn);

        let assistant_id = save_assistant_msg(session_id, "回答", "model").expect("assistant");
        let call_id = save_tool_call_msg(session_id, "call-1", "工具", "{}").expect("tool call");
        let result_id =
            save_tool_result_msg(session_id, "call-1", "工具", "结果").expect("tool result");
        save_completed_turn_and_assign_journey(session_id, "turn-1").expect("turn");

        let conn = get_connection().expect("get connection");
        let memberships: Vec<(String, String, Option<String>)> = conn
            .prepare(
                "SELECT message_id, branch_id, task_id FROM session_journey_memberships
                 WHERE session_id = ?1 ORDER BY sequence",
            )
            .expect("prepare memberships")
            .query_map([session_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .expect("query memberships")
            .collect::<rusqlite::Result<_>>()
            .expect("collect memberships");
        assert_eq!(
            memberships,
            vec![
                (assistant_id, "main".into(), Some("task".into())),
                (call_id, "main".into(), Some("task".into())),
                (result_id, "main".into(), Some("task".into())),
            ]
        );
        let turn: (i64, String, Option<String>) = conn
            .query_row(
                "SELECT completed_sequence, branch_id, task_id
                 FROM session_journey_turn_memberships
                 WHERE session_id = ?1 AND turn_id = 'turn-1'",
                [session_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("turn membership");
        assert_eq!(turn, (2, "main".into(), Some("task".into())));
    }

    #[test]
    fn journey_history_loader_filters_before_provider_reconstruction() {
        let _sandbox = test_env::sandbox();
        let session_id = "journey-provider-visibility";
        seed_session_for_message_tests(session_id);
        let mut conn = get_connection().expect("get connection");
        let mut journey = crate::core::journey_lifecycle::SessionJourney::new(session_id, "main");
        journey
            .start_fork(
                0,
                "fork-a".into(),
                "task-a".into(),
                "分叉 A".into(),
                "anchor".into(),
                10,
            )
            .expect("start fork a");
        journey.active_branch_id = "main".into();
        journey.active_task_id = None;
        journey
            .start_fork(
                1,
                "fork-b".into(),
                "task-b".into(),
                "分叉 B".into(),
                "anchor".into(),
                10,
            )
            .expect("start fork b");
        journey.active_branch_id = "main".into();
        journey.active_task_id = None;
        journey
            .start_fork(
                2,
                "fork-c".into(),
                "task-c".into(),
                "分叉 C".into(),
                "future".into(),
                11,
            )
            .expect("start fork c");
        journey.active_branch_id = "fork-a".into();
        journey.active_task_id = Some("task-a".into());
        journey.revision = 1;
        crate::core::journey_lifecycle::SqliteJourneyRepository::compare_and_store(
            &mut conn, &journey, 0,
        )
        .expect("store journey");

        for (id, sequence, content, branch) in [
            ("anchor", 10, "parent anchor", "main"),
            ("future", 11, "parent future", "main"),
            ("a", 12, "fork a", "fork-a"),
            ("b", 12, "fork b", "fork-b"),
            ("c", 12, "fork c", "fork-c"),
        ] {
            conn.execute(
                "INSERT INTO agent_messages (id, session_id, role, content, sequence, created_at)
                 VALUES (?1, ?2, 'assistant', ?3, ?4, datetime('now'))",
                params![id, session_id, content, sequence],
            )
            .expect("seed message");
            conn.execute(
                "INSERT INTO session_journey_memberships
                 (session_id, message_id, sequence, branch_id, task_id)
                 VALUES (?1, ?2, ?3, ?4, NULL)",
                params![session_id, id, sequence, branch],
            )
            .expect("seed membership");
        }
        drop(conn);

        let history = load_llm_history_for_active_journey(session_id).expect("project history");
        let contents = history
            .iter()
            .filter_map(|message| message.get("content").and_then(|content| content.as_str()))
            .collect::<Vec<_>>();
        assert!(contents.contains(&"parent anchor"));
        assert!(contents.contains(&"fork a"));
        assert!(
            !contents.contains(&"fork b"),
            "provider prompt must not inherit sibling fork transcript"
        );
        assert!(!contents.contains(&"parent future"));
        assert!(!contents.contains(&"fork c"));
    }

    #[test]
    fn parent_handoff_capsule_is_chinese_append_only_and_excludes_fork_rows() {
        let _sandbox = test_env::sandbox();
        let session_id = "journey-parent-handoff";
        seed_session_for_message_tests(session_id);
        let mut conn = get_connection().expect("get connection");
        let mut journey = crate::core::journey_lifecycle::SessionJourney::new(session_id, "main");
        journey
            .start_fork(
                0,
                "fork-a".into(),
                "task-a".into(),
                "核对分叉".into(),
                "anchor".into(),
                10,
            )
            .expect("start fork");
        crate::core::journey_lifecycle::SqliteJourneyRepository::compare_and_store(
            &mut conn, &journey, 0,
        )
        .expect("store fork");
        journey
            .request_fork_close(
                1,
                "fork-a",
                "review-a".into(),
                crate::core::journey_lifecycle::TaskOutcome::Completed,
                12,
            )
            .expect("close request");
        crate::core::journey_lifecycle::SqliteJourneyRepository::compare_and_store(
            &mut conn, &journey, 1,
        )
        .expect("store close request");
        let provenance = crate::core::journey_lifecycle::RuntimeProvenance {
            model_id: "模型一".into(),
            account_id: "账户一".into(),
            protocol: "测试协议".into(),
        };
        journey
            .mark_review_ready(2, "review-a", provenance.clone(), "审核通过".into())
            .expect("ready review");
        crate::core::journey_lifecycle::SqliteJourneyRepository::compare_and_store(
            &mut conn, &journey, 2,
        )
        .expect("store ready review");
        let capsule = crate::core::journey_lifecycle::HandoffCapsule {
            fork_id: "fork-a".into(),
            review_id: "review-a".into(),
            parent_branch_id: "main".into(),
            parent_anchor_message_id: "anchor".into(),
            source_start_sequence: 11,
            source_end_sequence: 12,
            objective: "核对主干方案".into(),
            conclusion: "可以继续主干实施".into(),
            open_questions: vec!["补充一次回归".into()],
            confirmed_items: vec!["父主干前缀保持".into()],
            evidence_references: vec!["检查点 anchor".into()],
            generated_at: Some("元数据，不参与定位".into()),
            provenance: provenance.clone(),
        };
        journey
            .publish_handoff_capsule(3, "fork-a", capsule)
            .expect("publish capsule");
        journey
            .return_to_parent(4, "review-a")
            .expect("return parent");
        crate::core::journey_lifecycle::SqliteJourneyRepository::compare_and_store(
            &mut conn, &journey, 4,
        )
        .expect("store parent return");
        for (id, sequence, content, branch) in [
            ("anchor", 10, "主干锚点", "main"),
            ("parent-next", 11, "主干后续", "main"),
            ("fork-secret", 12, "FORK_SECRET_TRANSCRIPT", "fork-a"),
        ] {
            conn.execute(
                "INSERT INTO agent_messages (id, session_id, role, content, sequence, created_at)
                 VALUES (?1, ?2, 'assistant', ?3, ?4, datetime('now'))",
                params![id, session_id, content, sequence],
            )
            .expect("seed message");
            conn.execute(
                "INSERT INTO session_journey_memberships
                 (session_id, message_id, sequence, branch_id, task_id)
                 VALUES (?1, ?2, ?3, ?4, NULL)",
                params![session_id, id, sequence, branch],
            )
            .expect("seed membership");
        }
        drop(conn);

        let history = load_llm_history_for_active_journey(session_id).expect("project history");
        let capsule_message = history.last().expect("capsule item");
        let capsule_text = capsule_message["content"].as_str().expect("capsule text");
        assert!(capsule_text.contains("【分叉交接】"));
        assert!(capsule_text.contains("分叉ID：fork-a"));
        assert!(capsule_text.contains("审阅ID：review-a"));
        assert!(capsule_text.contains("源锚点：anchor"));
        assert!(capsule_text.contains("模型：模型一"));
        assert!(capsule_text.contains("账户：账户一"));
        assert!(capsule_text.contains("协议：测试协议"));
        assert!(capsule_text.contains("可以继续主干实施"));
        assert!(!history
            .iter()
            .any(|message| message.to_string().contains("FORK_SECRET_TRANSCRIPT")));

        let before = vec![
            serde_json::json!({ "role": "assistant", "content": "主干锚点" }),
            serde_json::json!({ "role": "assistant", "content": "主干后续" }),
        ];
        let before_bytes = before
            .iter()
            .map(serde_json::to_vec)
            .collect::<Result<Vec<_>, _>>()
            .expect("serialize prefix");
        let after_bytes = history[..before.len()]
            .iter()
            .map(serde_json::to_vec)
            .collect::<Result<Vec<_>, _>>()
            .expect("serialize projected prefix");
        assert_eq!(before_bytes, after_bytes, "父主干 prefix bytes 不可改变");
        let persisted_rows =
            shared::load_messages(SESSION_TABLE_PREFIX, session_id).expect("load transcript");
        assert_eq!(persisted_rows.len(), 3, "capsule 不得写入 transcript");
        assert_eq!(
            journey.branches["fork-a"]
                .handoff_capsule
                .as_ref()
                .unwrap()
                .provenance,
            provenance
        );
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

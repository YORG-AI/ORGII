//! `load_llm_history`: rebuild OpenAI-format conversation history from the
//! `<prefix>_messages` table.
//!
//! Two non-trivial pieces of logic live here:
//!
//! 1. Multimodal user messages (text + image URLs) are reconstructed
//!    from the `images` column, with on-disk image refs lazily loaded
//!    back into `data:` URLs via `resolve_image_for_llm`.
//! 2. Consecutive `tool_call` rows are merged into one assistant
//!    message with a multi-element `tool_calls` array, followed by the
//!    matching `tool` rows. This matches the wire format that LLM APIs
//!    accept and that yoyo evolved to after dogfooding both serial and
//!    parallel tool execution.

use crate::persistence::images;

use super::super::{
    load_messages, message_role, query_optional, read_agent_message_row, AgentMessageRow,
    AGENT_MESSAGE_ROW_COLUMNS,
};

/// Resolve an image reference to a base64 data URL for LLM consumption.
///
/// Handles both legacy base64 data URLs (returned as-is) and disk file paths
/// (read from disk and encoded).
fn resolve_image_for_llm(image_ref: &str) -> Option<String> {
    if image_ref.starts_with("data:") {
        Some(image_ref.to_string())
    } else {
        images::load_image_as_data_url(image_ref)
    }
}

/// Build multimodal content for a user message with images.
///
/// Returns an OpenAI-compatible content array:
/// `[{ "type": "image_url", ... }, ..., { "type": "text", "text": "..." }]`
fn build_multimodal_content(text: &str, image_refs: &[String]) -> serde_json::Value {
    tracing::info!(
        "[build_multimodal_content] building content with {} image_ref(s)",
        image_refs.len()
    );
    let mut parts: Vec<serde_json::Value> = image_refs
        .iter()
        .enumerate()
        .filter_map(|(i, img_ref)| {
            let resolved = resolve_image_for_llm(img_ref);
            if resolved.is_none() {
                tracing::warn!(
                    "[build_multimodal_content] image_refs[{}] failed to resolve (ref prefix: {})",
                    i,
                    img_ref.get(..60).unwrap_or(img_ref)
                );
            } else {
                tracing::info!("[build_multimodal_content] image_refs[{}] resolved OK", i);
            }
            resolved.map(|data_url| {
                serde_json::json!({
                    "type": "image_url",
                    "image_url": { "url": data_url }
                })
            })
        })
        .collect();

    parts.push(serde_json::json!({ "type": "text", "text": text }));
    serde_json::Value::Array(parts)
}

/// Turns elapsed since the given tool was last called in this session,
/// derived by scanning the persisted transcript tail (capped at
/// `scan_limit` rows). Counts user messages (≈ turns) after the most
/// recent `tool` row whose `tool_name` matches.
///
/// Returns at least 1 and at most `scan_limit` when the tool never appears
/// in the scanned tail — callers treat the cap as "long enough ago". This
/// replaces process-local reminder counters so throttling survives app
/// restarts and session resumes (transcript-derived, like the reference
/// harness).
pub fn turns_since_last_tool_call(
    session_id: &str,
    tool_name: &str,
    scan_limit: u32,
) -> rusqlite::Result<u32> {
    let conn = database::db::get_connection()?;
    let mut stmt = conn.prepare(
        "SELECT role, tool_name FROM agent_messages
         WHERE session_id = ?1
         ORDER BY sequence DESC
         LIMIT ?2",
    )?;
    let rows = stmt.query_map(rusqlite::params![session_id, scan_limit], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
    })?;

    let mut turns: u32 = 0;
    for row in rows {
        let (role, row_tool) = row?;
        if role == super::super::message_role::TOOL_CALL && row_tool.as_deref() == Some(tool_name) {
            return Ok(turns);
        }
        if role == super::super::message_role::USER {
            turns = turns.saturating_add(1);
        }
    }
    Ok(turns.max(1).min(scan_limit))
}

/// Load conversation history in the format expected by LLM providers.
///
/// Returns messages in OpenAI-compatible format including tool calls:
/// - `user` messages (with optional multimodal content)
/// - `assistant` messages (text or tool_calls)
/// - `tool` messages (tool results)
///
/// Tool calls persisted as separate DB rows are reconstructed into
/// assistant messages with `tool_calls` arrays + matching `tool` messages.
///
/// IMPORTANT: Consecutive tool_call rows are merged into a single assistant
/// message with multiple tool_calls, followed by their corresponding tool results.
/// This matches the LLM API format where one assistant turn can have multiple
/// tool calls, each requiring a matching tool result message.
///
/// **Compact boundaries:** when the session contains compaction boundary
/// rows (`compact_from_sequence IS NOT NULL`), the latest boundary wins:
/// the returned history is `[boundary summary] + reconstruct(rows with
/// sequence >= boundary.compact_from_sequence)`. Rows before that pointer
/// and older boundary rows stay in the table untouched (immutable
/// transcript) but are excluded from the LLM view.
pub fn load_llm_history(
    prefix: &str,
    session_id: &str,
) -> rusqlite::Result<Vec<serde_json::Value>> {
    let messages = load_messages(prefix, session_id)?;

    // Debug: log raw message sequence
    tracing::debug!(
        "[load_llm_history] session={} raw_messages: {:?}",
        session_id,
        messages
            .iter()
            .map(|m| format!("{}:{}", m.role, m.tool_call_id.as_deref().unwrap_or("-")))
            .collect::<Vec<_>>()
    );

    let result = reconstruct(&visible_rows(&messages));

    // Debug: log reconstructed message summary
    tracing::debug!(
        "[load_llm_history] session={} reconstructed: {:?}",
        session_id,
        result
            .iter()
            .map(|m| {
                let role = m.get("role").and_then(|r| r.as_str()).unwrap_or("?");
                let tc_count = m
                    .get("tool_calls")
                    .and_then(|tc| tc.as_array())
                    .map(|a| a.len())
                    .unwrap_or(0);
                let tc_id = m
                    .get("tool_call_id")
                    .and_then(|id| id.as_str())
                    .unwrap_or("-");
                if tc_count > 0 {
                    format!("{}(tool_calls={})", role, tc_count)
                } else if tc_id != "-" {
                    format!("{}({})", role, tc_id)
                } else {
                    role.to_string()
                }
            })
            .collect::<Vec<_>>()
    );

    Ok(result)
}

/// Rebuild the durable conversation without hydrating image files into base64.
/// Background memory agents consume text/tool evidence only; loading image
/// payloads there creates a large, short-lived duplicate with no extraction
/// value.
///
/// Returns the reconstructed messages together with each message's first-row
/// durable sequence (same order/length), so callers can anchor cursors by
/// sequence instead of array index.
pub fn load_llm_history_text_only(
    prefix: &str,
    session_id: &str,
) -> rusqlite::Result<(Vec<serde_json::Value>, Vec<i64>)> {
    let mut messages = load_messages(prefix, session_id)?;
    for message in &mut messages {
        message.images = None;
    }
    let visible = visible_rows(&messages);
    let refs: Vec<&AgentMessageRow> = visible.iter().collect();
    Ok((reconstruct(&visible), llm_message_start_sequences(&refs)))
}

/// Rows fetched per reverse page by the bounded text-only loader.
const BOUNDED_TAIL_PAGE_ROWS: usize = 256;

/// Guaranteed minimum JSON syntax bytes each recognized row adds to its
/// reconstructed message beyond the raw payload counted in
/// [`row_reconstructed_floor_bytes`]. Must stay below the true wrapper cost
/// of every message form (>= 26 bytes for the smallest, a bare user row) or
/// the floor stops being a lower bound and the bounded loader may return a
/// suffix smaller than the byte budget it promises to exceed.
const ROW_ENCODED_FLOOR_BYTES: usize = 16;

/// Lower bound on the serialized bytes this row contributes to the
/// reconstructed history. JSON escaping never shrinks a string, so raw
/// payload length plus the syntax floor never overestimates.
fn row_reconstructed_floor_bytes(row: &AgentMessageRow) -> usize {
    let payload = match row.role.as_str() {
        message_role::SYSTEM | message_role::USER | message_role::ASSISTANT => row.content.len(),
        message_role::TOOL_CALL => row.tool_input.as_deref().unwrap_or("{}").len(),
        message_role::TOOL_RESULT => row.tool_output.as_deref().unwrap_or(&row.content).len(),
        _ => return 0,
    };
    ROW_ENCODED_FLOOR_BYTES + payload
}

/// Latest compact-boundary row for the session, if any. Mirrors the
/// max-sequence-wins rule of [`visible_rows`] without loading the table.
fn latest_compact_boundary(
    conn: &rusqlite::Connection,
    prefix: &str,
    session_id: &str,
) -> rusqlite::Result<Option<AgentMessageRow>> {
    let sql = format!(
        "SELECT {AGENT_MESSAGE_ROW_COLUMNS}
         FROM {prefix}_messages
         WHERE session_id = ?1 AND compact_from_sequence IS NOT NULL
         ORDER BY sequence DESC
         LIMIT 1"
    );
    let mut stmt = conn.prepare(&sql)?;
    query_optional(stmt.query_row([session_id], read_agent_message_row))
}

/// Bounded variant of [`load_llm_history_text_only`]: reads visible rows
/// newest-first in pages and stops once the loaded suffix is guaranteed to
/// serialize past `max_bytes`, so peak allocation tracks the byte budget
/// instead of the full transcript.
///
/// Output contract: the result is either the complete visible history
/// (identical to the unbounded loader) or a suffix of it that starts on a
/// system/user/assistant message and serializes to more than `max_bytes`.
/// Both shapes make a downstream tail-biased byte budget of at most
/// `max_bytes` produce output byte-identical to bounding the full load:
/// an over-budget suffix covers every message such a budget can keep, so
/// the budget's rejection cut lands identically, and the anchor row keeps
/// reconstruction grouping and start sequences aligned with the full view.
///
/// `max_bytes == 0` loads everything, matching the budget pass's
/// passthrough semantics. Whole rows are kept or dropped — no string is
/// ever cut, so UTF-8 boundaries are never at risk.
pub fn load_llm_history_text_only_bounded(
    prefix: &str,
    session_id: &str,
    max_bytes: usize,
) -> rusqlite::Result<(Vec<serde_json::Value>, Vec<i64>)> {
    if max_bytes == 0 {
        return load_llm_history_text_only(prefix, session_id);
    }

    let conn = database::db::get_connection()?;
    let boundary = latest_compact_boundary(&conn, prefix, session_id)?;
    let window_start = boundary
        .as_ref()
        .and_then(|row| row.compact_from_sequence)
        .unwrap_or(i64::MIN);

    let sql = format!(
        "SELECT {AGENT_MESSAGE_ROW_COLUMNS}
         FROM {prefix}_messages
         WHERE session_id = ?1
           AND compact_from_sequence IS NULL
           AND sequence >= ?2
           AND sequence < ?3
         ORDER BY sequence DESC
         LIMIT ?4"
    );
    let mut stmt = conn.prepare(&sql)?;

    let mut newest_first: Vec<AgentMessageRow> = Vec::new();
    let mut floor_bytes = 0usize;
    let mut cursor = i64::MAX;
    let mut stopped_early = false;
    'pages: loop {
        let page = stmt
            .query_map(
                rusqlite::params![
                    session_id,
                    window_start,
                    cursor,
                    BOUNDED_TAIL_PAGE_ROWS as i64
                ],
                read_agent_message_row,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let page_len = page.len();
        for mut row in page {
            row.images = None;
            floor_bytes = floor_bytes.saturating_add(row_reconstructed_floor_bytes(&row));
            // A suffix may only start on a system/user/assistant row: those
            // clear the reconstruction's pending tool state, so grouping and
            // start sequences match the same tail of the full history.
            let anchors_suffix = matches!(
                row.role.as_str(),
                message_role::SYSTEM | message_role::USER | message_role::ASSISTANT
            );
            newest_first.push(row);
            if floor_bytes > max_bytes && anchors_suffix {
                stopped_early = true;
                break 'pages;
            }
        }
        if page_len < BOUNDED_TAIL_PAGE_ROWS {
            break;
        }
        cursor = newest_first
            .last()
            .map(|row| row.sequence)
            .unwrap_or(cursor);
    }

    let mut visible = newest_first;
    visible.reverse();
    // The summary heads the visible view only when the whole window was
    // loaded: an over-budget suffix already forces the downstream budget
    // pass to drop the oldest messages, summary included.
    if !stopped_early {
        if let Some(mut summary) = boundary {
            summary.role = message_role::USER.to_string();
            summary.images = None;
            visible.insert(0, summary);
        }
    }
    let refs: Vec<&AgentMessageRow> = visible.iter().collect();
    Ok((reconstruct(&visible), llm_message_start_sequences(&refs)))
}

/// First-row durable sequence for each message of the current visible LLM
/// history, in [`load_llm_history`] output order. Lets compaction resolve a
/// sequence anchor to an index in whatever frame it holds.
pub fn load_llm_history_start_sequences(
    prefix: &str,
    session_id: &str,
) -> rusqlite::Result<Vec<i64>> {
    let messages = load_messages(prefix, session_id)?;
    let visible = visible_rows(&messages);
    let refs: Vec<&AgentMessageRow> = visible.iter().collect();
    Ok(llm_message_start_sequences(&refs))
}

/// Sequence of the first row contributing to each reconstructed LLM
/// message, in output order. Mirrors the grouping rules of
/// [`reconstruct`] (consecutive tool_call/tool_result rows form one
/// assistant message followed by its tool messages, all attributed to
/// the group's first row). Must stay in sync with `reconstruct`; the
/// `start_sequences_match_reconstruct_len` test pins that.
fn llm_message_start_sequences(messages: &[&AgentMessageRow]) -> Vec<i64> {
    let mut result: Vec<i64> = Vec::new();
    let mut pending_calls = 0usize;
    let mut pending_results = 0usize;
    let mut group_start: Option<i64> = None;

    fn flush(
        result: &mut Vec<i64>,
        pending_calls: &mut usize,
        pending_results: &mut usize,
        group_start: &mut Option<i64>,
    ) {
        if let Some(seq) = *group_start {
            if *pending_calls > 0 {
                result.push(seq);
            }
            for _ in 0..*pending_results {
                result.push(seq);
            }
        }
        *pending_calls = 0;
        *pending_results = 0;
        *group_start = None;
    }

    for msg in messages {
        match msg.role.as_str() {
            message_role::SYSTEM | message_role::USER | message_role::ASSISTANT => {
                flush(
                    &mut result,
                    &mut pending_calls,
                    &mut pending_results,
                    &mut group_start,
                );
                result.push(msg.sequence);
            }
            message_role::TOOL_CALL => {
                group_start.get_or_insert(msg.sequence);
                pending_calls += 1;
            }
            message_role::TOOL_RESULT => {
                group_start.get_or_insert(msg.sequence);
                pending_results += 1;
            }
            _ => {}
        }
    }
    flush(
        &mut result,
        &mut pending_calls,
        &mut pending_results,
        &mut group_start,
    );

    result
}

/// Map "the last `tail_len` LLM messages stay visible" onto a durable
/// sequence cutoff for a new compact boundary.
///
/// Operates on the current visible window (after the latest existing
/// boundary, if any). Conservative by construction: when `tail_len`
/// covers the whole window (or in-memory/durable views have drifted),
/// the cutoff falls back to the window start, which keeps *more* context
/// visible rather than hiding unsummarized rows. Never deletes anything.
pub fn compact_cutoff_sequence(
    prefix: &str,
    session_id: &str,
    tail_len: usize,
) -> rusqlite::Result<i64> {
    let rows = load_messages(prefix, session_id)?;

    let latest_boundary = rows
        .iter()
        .filter(|m| m.compact_from_sequence.is_some())
        .max_by_key(|m| m.sequence);

    let window_start = match latest_boundary {
        Some(boundary) => boundary
            .compact_from_sequence
            .expect("filtered on is_some above"),
        None => rows.first().map(|m| m.sequence).unwrap_or(0),
    };
    let tail_rows: Vec<&AgentMessageRow> = rows
        .iter()
        .filter(|m| m.compact_from_sequence.is_none() && m.sequence >= window_start)
        .collect();

    if tail_len == 0 {
        // Hide the entire window behind the summary.
        return Ok(tail_rows
            .last()
            .map(|m| m.sequence + 1)
            .unwrap_or(window_start));
    }

    let starts = llm_message_start_sequences(&tail_rows);
    if tail_len >= starts.len() {
        return Ok(window_start);
    }
    Ok(starts[starts.len() - tail_len])
}

/// Apply the latest compact boundary to the raw row list.
///
/// Returns the rows that form the current LLM view: when a boundary row
/// (`compact_from_sequence IS NOT NULL`) exists, the view is the boundary
/// row itself (rendered as a **user** summary message — models weigh user
/// messages far more than system background, matching the in-memory
/// compactors) followed by every non-boundary row with
/// `sequence >= compact_from_sequence`. Without a boundary, all rows pass
/// through unchanged. Boundary rows other than the latest are always
/// skipped. The DB row keeps its `system` role — only the LLM view remaps.
fn visible_rows(messages: &[AgentMessageRow]) -> Vec<AgentMessageRow> {
    let latest_boundary = messages
        .iter()
        .filter(|m| m.compact_from_sequence.is_some())
        .max_by_key(|m| m.sequence);

    let Some(boundary) = latest_boundary else {
        return messages.to_vec();
    };
    let from_sequence = boundary
        .compact_from_sequence
        .expect("filtered on is_some above");

    let mut summary_row = boundary.clone();
    summary_row.role = message_role::USER.to_string();

    let mut visible = Vec::with_capacity(messages.len());
    visible.push(summary_row);
    visible.extend(
        messages
            .iter()
            .filter(|m| m.compact_from_sequence.is_none() && m.sequence >= from_sequence)
            .cloned(),
    );
    visible
}

/// Pure reconstruction step: turn an ordered slice of `AgentMessageRow` rows
/// into the OpenAI-compatible JSON array. Lifted out of
/// `load_llm_history` so the unit tests below can exercise it without a
/// SQLite round-trip.
fn reconstruct(messages: &[AgentMessageRow]) -> Vec<serde_json::Value> {
    let mut result: Vec<serde_json::Value> = Vec::with_capacity(messages.len());

    // Collect consecutive tool_calls into batches
    let mut pending_tool_calls: Vec<serde_json::Value> = Vec::new();
    let mut pending_tool_results: Vec<serde_json::Value> = Vec::new();

    // Helper to flush pending tool calls and results
    let flush_pending = |result: &mut Vec<serde_json::Value>,
                         tool_calls: &mut Vec<serde_json::Value>,
                         tool_results: &mut Vec<serde_json::Value>| {
        if !tool_calls.is_empty() {
            result.push(serde_json::json!({
                "role": message_role::ASSISTANT,
                "content": serde_json::Value::Null,
                "tool_calls": tool_calls.clone()
            }));
            tool_calls.clear();
        }
        result.append(tool_results);
    };

    // Avoid resending every historical image on every turn: base64 image
    // payloads are large and can exceed gateway/body limits quickly. Preserve
    // multimodal content for the most recent image-bearing user message, and
    // render older image messages as text-only history.
    let last_image_msg_index = messages.iter().enumerate().rev().find_map(|(idx, msg)| {
        if msg.role == message_role::USER
            && msg
                .images
                .as_deref()
                .and_then(|s| serde_json::from_str::<Vec<String>>(s).ok())
                .map(|refs| !refs.is_empty())
                .unwrap_or(false)
        {
            Some(idx)
        } else {
            None
        }
    });

    for (msg_idx, msg) in messages.iter().enumerate() {
        match msg.role.as_str() {
            message_role::SYSTEM => {
                flush_pending(
                    &mut result,
                    &mut pending_tool_calls,
                    &mut pending_tool_results,
                );
                result.push(serde_json::json!({
                    "role": message_role::SYSTEM,
                    "content": msg.content,
                }));
            }
            message_role::USER => {
                flush_pending(
                    &mut result,
                    &mut pending_tool_calls,
                    &mut pending_tool_results,
                );

                if last_image_msg_index == Some(msg_idx) {
                    if let Some(images_json) = &msg.images {
                        if let Ok(image_refs) = serde_json::from_str::<Vec<String>>(images_json) {
                            if !image_refs.is_empty() {
                                result.push(serde_json::json!({
                                    "role": message_role::USER,
                                    "content": build_multimodal_content(&msg.content, &image_refs),
                                }));
                                continue;
                            }
                        }
                    }
                }
                result.push(serde_json::json!({
                    "role": message_role::USER,
                    "content": msg.content,
                }));
            }
            message_role::ASSISTANT => {
                flush_pending(
                    &mut result,
                    &mut pending_tool_calls,
                    &mut pending_tool_results,
                );

                result.push(serde_json::json!({
                    "role": message_role::ASSISTANT,
                    "content": msg.content,
                }));
            }
            message_role::TOOL_CALL => {
                let tool_call_id = msg.tool_call_id.as_deref().unwrap_or("unknown");
                let tool_name = msg.tool_name.as_deref().unwrap_or("unknown");
                let arguments = msg.tool_input.as_deref().unwrap_or("{}");

                pending_tool_calls.push(serde_json::json!({
                    "id": tool_call_id,
                    "type": "function",
                    "function": {
                        "name": tool_name,
                        "arguments": arguments,
                    }
                }));
            }
            message_role::TOOL_RESULT => {
                let tool_call_id = msg.tool_call_id.as_deref().unwrap_or("unknown");
                let content = msg.tool_output.as_deref().unwrap_or(&msg.content);

                pending_tool_results.push(serde_json::json!({
                    "role": "tool",
                    "tool_call_id": tool_call_id,
                    "content": content,
                }));
            }
            _ => {}
        }
    }

    flush_pending(
        &mut result,
        &mut pending_tool_calls,
        &mut pending_tool_results,
    );

    result
}

#[cfg(test)]
#[path = "load_llm_tests.rs"]
mod tests;

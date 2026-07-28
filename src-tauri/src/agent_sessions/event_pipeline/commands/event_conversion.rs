//! Event conversion helpers: dedup, backfill, synthetic filtering,
//! and CachedEvent <-> SessionEvent conversion.

use std::collections::{HashMap, HashSet};

use crate::agent_sessions::event_pipeline::extractors::extract_event_data_with_bounded_shell_output;
use crate::agent_sessions::event_pipeline::ingestion::function_map::resolve_ui_canonical;
use crate::agent_sessions::event_pipeline::payload_compaction::is_compacted_event;
use crate::agent_sessions::event_pipeline::types::{
    ActivityStatus, EventDisplayStatus, EventDisplayVariant, EventSource, SessionEvent,
};
use session_persistence as sqlite_cache;

const ACTION_TYPE_TOOL_CALL: &str = "tool_call";
const ACTION_TYPE_TOOL_RESULT: &str = "tool_result";
const CACHED_SHELL_OUTPUT_PREVIEW_BYTES: usize = 32 * 1024;

const FILE_PATH_KEYS: &[&str] = &["file_path", "path", "fileName", "file_name", "target_file"];

/// Cache rows predate the durable replay format and may still hold a complete
/// shell transcript in `args` or `result`. Keep extraction fresh for every
/// tool, but cap only shell output before allocating the derived envelope.
/// The subsequent legacy migration/EventStore hydration pass consumes this
/// tail preview and removes the raw duplicate payload.
fn recompute_cached_extracted(event: &mut SessionEvent) {
    event.extracted =
        extract_event_data_with_bounded_shell_output(event, CACHED_SHELL_OUTPUT_PREVIEW_BYTES);
    event.last_extract_at = Some(std::time::Instant::now());
}

// ============================================================================
// Post-load dedup: call_id collision + agent description collision
// ============================================================================

/// True when a JSON value is null, `{}`, `[]`, or an empty string.
fn is_empty_json(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Null => true,
        serde_json::Value::Object(m) => m.is_empty(),
        serde_json::Value::Array(a) => a.is_empty(),
        serde_json::Value::String(s) => s.is_empty(),
        _ => false,
    }
}

/// Merge non-empty fields from `loser` into `winner`. Only fills gaps — never
/// overwrites an existing value on the winner. The loser is consumed so owned
/// values can be moved rather than cloned.
fn merge_loser_into_winner(winner: &mut SessionEvent, loser: SessionEvent) {
    let loser_is_terminal_result = loser.action_type == ACTION_TYPE_TOOL_RESULT
        && matches!(
            loser.display_status,
            EventDisplayStatus::Completed | EventDisplayStatus::Failed
        );
    let loser_display_status = loser.display_status.clone();
    let loser_activity_status = loser.activity_status.clone();

    if is_empty_json(&winner.result) && !is_empty_json(&loser.result) {
        winner.result = loser.result;
    }

    if let (Some(winner_args), Some(loser_args)) =
        (winner.args.as_object_mut(), loser.args.as_object())
    {
        for (key, value) in loser_args {
            if !winner_args.contains_key(key) {
                winner_args.insert(key.clone(), value.clone());
            }
        }
    }

    // Preserve the richer display_text if the winner lacks one.
    if winner.display_text.trim().is_empty() && !loser.display_text.trim().is_empty() {
        winner.display_text = loser.display_text;
    }

    if loser_is_terminal_result {
        winner.display_status = loser_display_status;
        winner.activity_status = loser_activity_status;
    }

    // Recompute extractors so derived fields (e.g. subagent result content)
    // reflect the merged payload.
    recompute_cached_extracted(winner);
}

pub(crate) fn dedup_by_call_id(events: Vec<SessionEvent>) -> Vec<SessionEvent> {
    // winner_idx -> list of loser indices that should merge into it.
    let mut merges: HashMap<usize, Vec<usize>> = HashMap::new();
    let mut drop_set: HashSet<usize> = HashSet::new();
    let mut best_idx_by_call_id: HashMap<String, usize> = HashMap::new();

    // Pass 1: same call_id -> keep the tool_call identity row, merge the
    // matching tool_result/result-bearing row into it. If both are tool_call
    // rows, keep the one with richer args.
    for (idx, event) in events.iter().enumerate() {
        if event.action_type != "tool_call" && event.action_type != "tool_result" {
            continue;
        }
        let Some(ref cid) = event.call_id else {
            continue;
        };
        let arg_count = event.args.as_object().map_or(0, |m| m.len());

        if let Some(&prev_idx) = best_idx_by_call_id.get(cid) {
            let prev = &events[prev_idx];
            let prev_arg_count = prev.args.as_object().map_or(0, |m| m.len());
            let current_is_call = event.action_type == "tool_call";
            let prev_is_call = prev.action_type == "tool_call";
            let (winner, loser) = match (current_is_call, prev_is_call) {
                (true, false) => (idx, prev_idx),
                (false, true) => (prev_idx, idx),
                _ if arg_count > prev_arg_count => (idx, prev_idx),
                _ => (prev_idx, idx),
            };
            drop_set.insert(loser);
            merges.entry(winner).or_default().push(loser);
            best_idx_by_call_id.insert(cid.clone(), winner);
        } else {
            best_idx_by_call_id.insert(cid.clone(), idx);
        }
    }

    // Pass 2: agent tool_calls with different call_ids but same description.
    // Prefer the one with `subagentSessionId`; fall back to richest args.
    let mut best_idx_by_agent_desc: HashMap<String, usize> = HashMap::new();
    for (idx, event) in events.iter().enumerate() {
        if drop_set.contains(&idx) {
            continue;
        }
        if event.action_type != "tool_call" || event.function_name != "agent" {
            continue;
        }
        let Some(desc) = event
            .args
            .as_object()
            .and_then(|m| m.get("description"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
        else {
            continue;
        };
        if desc.is_empty() {
            continue;
        }

        let has_sid = event
            .args
            .as_object()
            .is_some_and(|m| m.contains_key("subagentSessionId"));
        let arg_count = event.args.as_object().map_or(0, |m| m.len());

        if let Some(&prev_idx) = best_idx_by_agent_desc.get(&desc) {
            let prev_has_sid = events[prev_idx]
                .args
                .as_object()
                .is_some_and(|m| m.contains_key("subagentSessionId"));
            let prev_arg_count = events[prev_idx].args.as_object().map_or(0, |m| m.len());

            let new_wins = (has_sid && !prev_has_sid)
                || (has_sid == prev_has_sid && arg_count > prev_arg_count);
            let (winner, loser) = if new_wins {
                (idx, prev_idx)
            } else {
                (prev_idx, idx)
            };
            drop_set.insert(loser);
            merges.entry(winner).or_default().push(loser);
            best_idx_by_agent_desc.insert(desc, winner);
        } else {
            best_idx_by_agent_desc.insert(desc, idx);
        }
    }

    if drop_set.is_empty() {
        return events;
    }

    // Apply merges: move loser payloads into winner in a single pass.
    // Use `Option<SessionEvent>` placeholders so we can take ownership out of
    // the vec without shifting indices.
    let mut slots: Vec<Option<SessionEvent>> = events.into_iter().map(Some).collect();

    for (winner_idx, loser_indices) in &merges {
        // Collect losers first so the winner borrow can be mutable afterwards.
        let mut losers: Vec<SessionEvent> = Vec::with_capacity(loser_indices.len());
        for &loser_idx in loser_indices {
            if let Some(loser) = slots[loser_idx].take() {
                losers.push(loser);
            }
        }
        if let Some(winner) = slots[*winner_idx].as_mut() {
            for loser in losers {
                merge_loser_into_winner(winner, loser);
            }
        }
    }

    slots
        .into_iter()
        .enumerate()
        .filter_map(
            |(idx, opt)| {
                if drop_set.contains(&idx) {
                    None
                } else {
                    opt
                }
            },
        )
        .collect()
}

fn is_stream_transcript_id(id: &str) -> bool {
    id.starts_with("stream-msg-") || id.starts_with("stream-think-")
}

fn is_stream_transcript_event(event: &SessionEvent) -> bool {
    if !is_stream_transcript_id(&event.id) {
        return false;
    }
    if matches!(
        event.display_variant,
        EventDisplayVariant::Message | EventDisplayVariant::Thinking
    ) {
        return true;
    }
    matches!(
        event.action_type.as_str(),
        "assistant" | "assistant_delta" | "llm_thinking" | "thinking" | "message" | "message_delta"
    ) || matches!(
        event.function_name.as_str(),
        "assistant" | "assistant_message" | "thinking" | "message" | "message_delta"
    )
}

pub(crate) fn dedup_stream_transcript_chunk_pairs(events: Vec<SessionEvent>) -> Vec<SessionEvent> {
    let event_by_id: HashMap<&str, &SessionEvent> = events
        .iter()
        .map(|event| (event.id.as_str(), event))
        .collect();
    let drop_ids: HashSet<String> = events
        .iter()
        .filter_map(|event| {
            let base_id = event.id.strip_suffix("-chunk")?;
            let base_event = event_by_id.get(base_id)?;
            if !is_stream_transcript_id(base_id) {
                return None;
            }
            if !is_stream_transcript_event(base_event) || !is_stream_transcript_event(event) {
                return None;
            }
            Some(event.id.clone())
        })
        .collect();

    if drop_ids.is_empty() {
        return events;
    }

    events
        .into_iter()
        .filter(|event| !drop_ids.contains(&event.id))
        .collect()
}

// ============================================================================
// Subagent link backfill for historical sessions
// ============================================================================

fn read_tool_inputs_by_call_id(
    session_id: &str,
) -> Result<HashMap<String, serde_json::Value>, String> {
    use rusqlite::params;

    let conn = sqlite_cache::get_connection().map_err(|err| err.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT tool_call_id, tool_input
             FROM agent_messages
             WHERE session_id = ?1
               AND tool_call_id IS NOT NULL
               AND tool_input IS NOT NULL
               AND TRIM(tool_input) != ''",
        )
        .map_err(|err| err.to_string())?;

    let rows = stmt
        .query_map(params![session_id], |row| {
            let call_id: String = row.get(0)?;
            let tool_input: String = row.get(1)?;
            Ok((call_id, tool_input))
        })
        .map_err(|err| err.to_string())?;

    let mut inputs = HashMap::new();
    for row in rows {
        let (call_id, tool_input) = row.map_err(|err| err.to_string())?;
        let parsed = serde_json::from_str::<serde_json::Value>(&tool_input)
            .map_err(|err| format!("failed to parse tool_input for call_id {call_id}: {err}"))?;
        inputs.insert(call_id, normalize_event_record_value(parsed));
    }

    Ok(inputs)
}

fn extract_file_path_from_json(value: &serde_json::Value) -> Option<String> {
    let obj = value.as_object()?;
    FILE_PATH_KEYS.iter().find_map(|key| {
        obj.get(*key)
            .and_then(|path| path.as_str())
            .filter(|path| !path.trim().is_empty())
            .map(String::from)
    })
}

fn merge_missing_args_from_tool_input(event: &mut SessionEvent, tool_input: &serde_json::Value) {
    if let (Some(event_args), Some(input_args)) =
        (event.args.as_object_mut(), tool_input.as_object())
    {
        for (key, value) in input_args {
            if !event_args.contains_key(key) {
                event_args.insert(key.clone(), value.clone());
            }
        }
    }

    if event.file_path.is_none() {
        event.file_path = extract_file_path_from_json(&event.args)
            .or_else(|| extract_file_path_from_json(tool_input));
    }

    recompute_cached_extracted(event);
}

pub(crate) fn backfill_tool_inputs_from_messages(session_id: &str, events: &mut [SessionEvent]) {
    let candidates: Vec<usize> = events
        .iter()
        .enumerate()
        .filter(|(_, event)| event.action_type == ACTION_TYPE_TOOL_CALL)
        .filter(|(_, event)| event.call_id.is_some())
        .filter(|(_, event)| {
            event.args.as_object().is_none_or(|args| args.is_empty()) || event.file_path.is_none()
        })
        .map(|(idx, _)| idx)
        .collect();

    if candidates.is_empty() {
        return;
    }

    let tool_inputs = match read_tool_inputs_by_call_id(session_id) {
        Ok(inputs) => inputs,
        Err(err) => {
            tracing::warn!(
                "[cache_bridge] failed to load tool inputs for {}: {}",
                session_id,
                err
            );
            return;
        }
    };

    if tool_inputs.is_empty() {
        return;
    }

    let mut backfilled = 0usize;
    for idx in candidates {
        let Some(call_id) = events[idx].call_id.as_deref() else {
            continue;
        };
        let Some(tool_input) = tool_inputs.get(call_id) else {
            continue;
        };
        merge_missing_args_from_tool_input(&mut events[idx], tool_input);
        backfilled += 1;
    }

    if backfilled > 0 {
        tracing::info!(
            "[cache_bridge] backfilled {} tool event(s) from agent_messages for {}",
            backfilled,
            session_id
        );
    }
}

pub(crate) fn backfill_subagent_links(session_id: &str, events: &mut [SessionEvent]) {
    let total_agent_events = events
        .iter()
        .filter(|e| e.action_type == "tool_call" && e.function_name == "agent")
        .count();
    log::debug!(
        "[cache_bridge] backfill_subagent_links: session={session_id} total_agent_tool_calls={total_agent_events} total_events={}",
        events.len()
    );

    let children = match agent_core::session::persistence::get_child_sessions(session_id) {
        Ok(rows) => rows,
        Err(err) => {
            log::debug!(
                "[cache_bridge] backfill_subagent_links: get_child_sessions({session_id}) failed: {err}"
            );
            return;
        }
    };

    log::debug!(
        "[cache_bridge] backfill_subagent_links: children_count={} children={:?}",
        children.len(),
        children.iter().map(|c| &c.session_id).collect::<Vec<_>>()
    );

    if children.is_empty() {
        return;
    }

    // Collect session IDs already linked to events (from stamp or prior merge).
    let already_linked: std::collections::HashSet<&str> = events
        .iter()
        .filter_map(|e| {
            e.args
                .as_object()
                .and_then(|m| m.get("subagentSessionId"))
                .and_then(|v| v.as_str())
        })
        .collect();

    log::debug!(
        "[cache_bridge] backfill_subagent_links: already_linked={:?}",
        already_linked
    );

    // Children not yet linked to any event.
    let unlinked_children: Vec<_> = children
        .iter()
        .filter(|c| !already_linked.contains(c.session_id.as_str()))
        .collect();

    if unlinked_children.is_empty() {
        log::debug!("[cache_bridge] backfill_subagent_links: all children already linked, skip");
        return;
    }

    // Candidate events: `agent` tool_calls missing `subagentSessionId`.
    let candidates: Vec<usize> = events
        .iter()
        .enumerate()
        .filter(|(_, e)| {
            e.action_type == "tool_call"
                && e.function_name == "agent"
                && e.args
                    .as_object()
                    .is_none_or(|m| !m.contains_key("subagentSessionId"))
        })
        .map(|(idx, _)| idx)
        .collect();

    log::debug!(
        "[cache_bridge] backfill_subagent_links: candidates={} unlinked_children={}",
        candidates.len(),
        unlinked_children.len()
    );

    if candidates.is_empty() {
        log::debug!("[cache_bridge] backfill_subagent_links: no candidates, skip");
        return;
    }

    let mut stamped = 0usize;
    for (candidate_idx, child) in candidates.iter().zip(unlinked_children.iter()) {
        let Some(obj) = events[*candidate_idx].args.as_object_mut() else {
            continue;
        };
        obj.insert(
            "subagentSessionId".to_string(),
            serde_json::Value::String(child.session_id.clone()),
        );
        obj.entry("action")
            .or_insert_with(|| serde_json::Value::String("delegate".to_string()));
        recompute_cached_extracted(&mut events[*candidate_idx]);
        stamped += 1;
    }

    if stamped > 0 {
        log::info!(
            "[cache_bridge] backfill_subagent_links: stamped {stamped} subagentSessionId(s) onto {session_id}"
        );
    }
}

// ============================================================================
// Synthetic event filtering
// ============================================================================

// ============================================================================
// Compact-boundary merge for loaded sessions
// ============================================================================

/// Merge persisted compact-boundary rows into a loaded event list.
///
/// Compaction appends its boundary as a `system` row in `agent_messages`
/// only — it is never broadcast as a live event, so the SQLite event cache
/// (and therefore `es_load_from_cache`) has no trace of it. Without this
/// merge the "Context compacted" marker exists in the durable transcript
/// but never appears in the chat. Covers manual and automatic compaction,
/// including boundaries written before this code existed.
///
/// Rows already present in `events` (matched by event id) are skipped, so
/// a future producer that starts caching boundary events stays idempotent.
pub(crate) fn merge_compact_boundary_events(session_id: &str, events: &mut Vec<SessionEvent>) {
    let rows = match read_compact_boundary_rows(session_id) {
        Ok(rows) => rows,
        Err(err) => {
            tracing::warn!(
                "[cache_bridge] failed to read compact boundaries for {session_id}: {err}"
            );
            return;
        }
    };
    if rows.is_empty() {
        return;
    }

    let existing_ids: HashSet<String> = events.iter().map(|e| e.id.clone()).collect();
    for row in rows {
        if existing_ids.contains(&row.id) {
            continue;
        }
        let event = compact_boundary_row_to_event(session_id, row);
        // RFC3339 timestamps compare correctly as strings; place the marker
        // after every event that happened before the compaction.
        let insert_at = events
            .iter()
            .position(|e| e.created_at.as_str() > event.created_at.as_str())
            .unwrap_or(events.len());
        events.insert(insert_at, event);
    }
}

/// One persisted compact-boundary row, as read for chat-marker display.
pub(crate) struct CompactBoundaryRow {
    pub(crate) id: String,
    pub(crate) content: String,
    pub(crate) created_at: String,
    /// Estimated context tokens before/after the compaction. `None` on
    /// boundaries persisted before the metadata columns existed.
    pub(crate) tokens_before: Option<i64>,
    pub(crate) tokens_after: Option<i64>,
}

fn read_compact_boundary_rows(session_id: &str) -> Result<Vec<CompactBoundaryRow>, String> {
    use rusqlite::params;

    let conn = sqlite_cache::get_connection().map_err(|err| err.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, content, created_at, compact_tokens_before, compact_tokens_after
             FROM agent_messages
             WHERE session_id = ?1
               AND compact_from_sequence IS NOT NULL
             ORDER BY sequence ASC",
        )
        .map_err(|err| err.to_string())?;

    let rows = stmt
        .query_map(params![session_id], |row| {
            Ok(CompactBoundaryRow {
                id: row.get(0)?,
                content: row.get(1)?,
                created_at: row.get(2)?,
                tokens_before: row.get(3)?,
                tokens_after: row.get(4)?,
            })
        })
        .map_err(|err| err.to_string())?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|err| err.to_string())?);
    }
    Ok(out)
}

/// Build the chat-marker event for one persisted boundary row. Mirrors the
/// TS adapter's `compactBoundaryToSessionEvent` (`agentMessageAdapters.ts`)
/// so both load paths produce the same `context_compacted` shape.
pub(crate) fn compact_boundary_row_to_event(
    session_id: &str,
    row: CompactBoundaryRow,
) -> SessionEvent {
    let CompactBoundaryRow {
        id,
        content,
        created_at,
        tokens_before,
        tokens_after,
    } = row;
    let parsed =
        agent_core::model_context::session_memory::parse_compact_boundary_content(&content);

    let mut result = serde_json::Map::new();
    result.insert(
        "observation".to_string(),
        serde_json::Value::String(parsed.body.clone()),
    );
    if let Some(header) = &parsed.header {
        result.insert(
            "header".to_string(),
            serde_json::Value::String(header.clone()),
        );
    }
    if let Some(count) = parsed.compacted_count {
        result.insert("compactedCount".to_string(), serde_json::json!(count));
    }
    if let (Some(before), Some(after)) = (tokens_before, tokens_after) {
        result.insert("tokensBefore".to_string(), serde_json::json!(before));
        result.insert("tokensAfter".to_string(), serde_json::json!(after));
    }

    let display_text = if parsed.body.is_empty() {
        parsed.header.clone().unwrap_or_default()
    } else {
        parsed.body
    };

    SessionEvent {
        chunk_id: Some(id.clone()),
        id,
        session_id: session_id.to_string(),
        created_at,
        function_name: "context_compacted".to_string(),
        ui_canonical: resolve_ui_canonical("context_compacted"),
        action_type: "system".to_string(),
        args: serde_json::json!({}),
        result: serde_json::Value::Object(result),
        source: EventSource::System,
        display_text,
        display_status: EventDisplayStatus::Completed,
        display_variant: EventDisplayVariant::Message,
        activity_status: ActivityStatus::Agent,
        thread_id: None,
        process_id: None,
        call_id: None,
        file_path: None,
        command: None,
        is_delta: None,
        repo_id: None,
        repo_path: None,
        extracted: None,
        payload_refs: Vec::new(),
        shell_replay: None,
        shell_replay_bookmarks: None,
        last_extract_at: None,
    }
}

pub(crate) fn is_ts_placeholder_id(id: &str) -> bool {
    id.starts_with("stream-msg-ts-") || id.starts_with("stream-think-ts-")
}

pub(crate) fn is_turn_placeholder_event(event: &SessionEvent) -> bool {
    event.function_name == "turn_placeholder" || event.id.starts_with("turn-placeholder-")
}

pub(crate) fn is_synthetic_turn_header_event(event: &SessionEvent) -> bool {
    event
        .result
        .get("syntheticTurnHeader")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

pub(crate) fn is_synthetic_persistence_artifact(event: &SessionEvent) -> bool {
    is_ts_placeholder_id(&event.id)
        || is_turn_placeholder_event(event)
        || is_synthetic_turn_header_event(event)
        || is_compacted_event(event)
}

// ============================================================================
// CachedEvent <-> SessionEvent Conversion
// ============================================================================

pub(crate) fn normalize_event_record_value(value: serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(_) => value,
        serde_json::Value::String(text) => serde_json::json!({
            "content": text,
            "observation": text,
        }),
        serde_json::Value::Null => serde_json::json!({}),
        other => serde_json::json!({ "value": other }),
    }
}

/// Convert a `CachedEvent` (from SQLite) to `SessionEvent` (in-memory).
///
/// Mirrors the JS `fromCachedEvent` in `sqliteCache.ts` — metadata fields
/// are packed into `meta_json`.
pub(crate) fn cached_event_to_session_event(cached: &sqlite_cache::CachedEvent) -> SessionEvent {
    // The three JSON columns below were originally serialized from
    // `serde_json::Value`, so a parse failure here means the SQLite
    // row was tampered with or the schema drifted. Defaulting to
    // `{}` keeps the rest of the session loadable (better UX than
    // failing the whole snapshot load on one corrupt row), but we
    // warn so the corruption shows up in logs instead of being
    // indistinguishable from a tool that legitimately had no args.
    let meta: serde_json::Value = match cached.meta_json.as_deref() {
        Some(json) => match serde_json::from_str(json) {
            Ok(v) => v,
            Err(err) => {
                tracing::warn!(
                    "[cache_bridge] failed to parse meta_json for event {:?}: {} (raw: {:?})",
                    cached.id,
                    err,
                    json
                );
                serde_json::json!({})
            }
        },
        None => serde_json::json!({}),
    };

    let meta_obj = meta.as_object();

    let args: serde_json::Value = match serde_json::from_str(&cached.args_json) {
        Ok(v) => normalize_event_record_value(v),
        Err(err) => {
            tracing::warn!(
                "[cache_bridge] failed to parse args_json for event {:?}: {} (raw: {:?})",
                cached.id,
                err,
                cached.args_json
            );
            serde_json::json!({})
        }
    };
    let result: serde_json::Value = match serde_json::from_str(&cached.result_json) {
        Ok(v) => normalize_event_record_value(v),
        Err(err) => {
            tracing::warn!(
                "[cache_bridge] failed to parse result_json for event {:?}: {} (raw: {:?})",
                cached.id,
                err,
                cached.result_json
            );
            serde_json::json!({})
        }
    };

    let source_str = meta_obj
        .and_then(|m| m.get("source"))
        .and_then(|v| v.as_str())
        .unwrap_or("system");
    let source = match source_str {
        "user" => EventSource::User,
        "assistant" => EventSource::Assistant,
        _ => EventSource::System,
    };

    let display_text = meta_obj
        .and_then(|m| m.get("displayText"))
        .and_then(|v| v.as_str())
        .unwrap_or_else(|| cached.function_name.as_deref().unwrap_or("unknown"))
        .to_string();

    let display_status_str = meta_obj
        .and_then(|m| m.get("displayStatus"))
        .and_then(|v| v.as_str())
        .unwrap_or("running");
    let display_status = serde_json::from_value(serde_json::json!(display_status_str))
        .unwrap_or(EventDisplayStatus::Running);

    let display_variant_str = meta_obj
        .and_then(|m| m.get("displayVariant"))
        .and_then(|v| v.as_str())
        .unwrap_or("tool_call");
    let display_variant = serde_json::from_value(serde_json::json!(display_variant_str))
        .unwrap_or(EventDisplayVariant::ToolCall);

    let activity_status_str = meta_obj
        .and_then(|m| m.get("activityStatus"))
        .and_then(|v| v.as_str())
        .unwrap_or("agent");
    let activity_status = serde_json::from_value(serde_json::json!(activity_status_str))
        .unwrap_or(ActivityStatus::Agent);

    let chunk_id = meta_obj
        .and_then(|m| m.get("chunk_id"))
        .and_then(|v| v.as_str())
        .map(String::from);

    let call_id = meta_obj
        .and_then(|m| m.get("callId"))
        .and_then(|v| v.as_str())
        .map(String::from);

    let file_path = meta_obj
        .and_then(|m| m.get("filePath"))
        .and_then(|v| v.as_str())
        .map(String::from);

    let command = meta_obj
        .and_then(|m| m.get("command"))
        .and_then(|v| v.as_str())
        .map(String::from);

    let is_delta = meta_obj
        .and_then(|m| m.get("isDelta"))
        .and_then(|v| v.as_bool());

    let repo_id = meta_obj
        .and_then(|m| m.get("repoId"))
        .and_then(|v| v.as_str())
        .map(String::from);

    let repo_path = meta_obj
        .and_then(|m| m.get("repoPath"))
        .and_then(|v| v.as_str())
        .map(String::from);

    let process_id = meta_obj
        .and_then(|m| m.get("processId"))
        .and_then(|v| v.as_str())
        .map(String::from);

    let shell_replay = meta_obj
        .and_then(|m| m.get("shellReplay"))
        .filter(|value| !value.is_null())
        .and_then(|value| match serde_json::from_value(value.clone()) {
            Ok(state) => Some(state),
            Err(err) => {
                tracing::warn!(
                    "[cache_bridge] failed to parse shellReplay for event {:?}: {}",
                    cached.id,
                    err
                );
                None
            }
        });

    let shell_replay_bookmarks = meta_obj
        .and_then(|m| m.get("shellReplayBookmarks"))
        .filter(|value| !value.is_null())
        .and_then(|value| match serde_json::from_value(value.clone()) {
            Ok(bookmarks) => Some(bookmarks),
            Err(err) => {
                tracing::warn!(
                    "[cache_bridge] failed to parse shellReplayBookmarks for event {:?}: {}",
                    cached.id,
                    err
                );
                None
            }
        });

    let function_name = cached.function_name.clone().unwrap_or_default();
    let ui_canonical = meta_obj
        .and_then(|m| m.get("uiCanonical"))
        .and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or_else(|| resolve_ui_canonical(&function_name));

    let mut event = SessionEvent {
        id: cached.id.clone(),
        chunk_id,
        session_id: cached.session_id.clone(),
        created_at: cached.created_at.clone(),
        function_name,
        ui_canonical,
        action_type: cached.event_type.clone(),
        args,
        result,
        source,
        display_text,
        display_status,
        display_variant,
        activity_status,
        thread_id: cached.thread_id.clone(),
        process_id,
        call_id,
        file_path,
        command,
        is_delta,
        repo_id,
        repo_path,
        extracted: None,
        payload_refs: Vec::new(),
        shell_replay,
        shell_replay_bookmarks,
        last_extract_at: None,
    };
    // Restore from SQLite cache — always compute a fresh extraction. Legacy
    // shell payloads are tailed before copying so a 10 MiB stdout does not
    // become a second 10 MiB `extracted.shell.output` allocation.
    recompute_cached_extracted(&mut event);
    event
}

/// Convert a `SessionEvent` to `CachedEvent` for SQLite storage.
///
/// Mirrors the JS `toCachedEvent` — packs display/metadata fields into `meta_json`.
pub fn session_event_to_cached_event(event: &SessionEvent) -> sqlite_cache::CachedEvent {
    let meta = serde_json::json!({
        "source": event.source,
        "displayText": event.display_text,
        "displayStatus": event.display_status,
        "displayVariant": event.display_variant,
        "activityStatus": event.activity_status,
        "uiCanonical": event.ui_canonical,
        "chunk_id": event.chunk_id,
        "callId": event.call_id,
        "filePath": event.file_path,
        "command": event.command,
        "isDelta": event.is_delta,
        "processId": event.process_id,
        "repoId": event.repo_id,
        "repoPath": event.repo_path,
        "shellReplay": event.shell_replay,
        "shellReplayBookmarks": event.shell_replay_bookmarks,
    });

    let content = build_searchable_content(event);

    sqlite_cache::CachedEvent {
        id: event.id.clone(),
        session_id: event.session_id.clone(),
        event_type: event.action_type.clone(),
        function_name: if event.function_name.is_empty() {
            None
        } else {
            Some(event.function_name.clone())
        },
        thread_id: event.thread_id.clone(),
        // `serde_json::Value` is structurally always serializable, so
        // these `expect`s document the invariant rather than masking a
        // real failure mode. If they ever fire it indicates a serde
        // recursion / cycle bug worth crashing on.
        args_json: serde_json::to_string(&event.args)
            .expect("args is serde_json::Value, must serialize"),
        result_json: serde_json::to_string(&normalize_event_record_value(event.result.clone()))
            .expect("result is serde_json::Value, must serialize"),
        content,
        created_at: event.created_at.clone(),
        meta_json: Some(
            serde_json::to_string(&meta).expect("meta is serde_json::Value, must serialize"),
        ),
        history_sequence: None,
    }
}

/// Build searchable text content from a SessionEvent.
fn build_searchable_content(event: &SessionEvent) -> String {
    let mut parts = Vec::with_capacity(4);
    if !event.function_name.is_empty() {
        parts.push(event.function_name.as_str());
    }
    if !event.display_text.is_empty() {
        let truncated = if event.display_text.len() > 500 {
            let mut end = 500;
            while end > 0 && !event.display_text.is_char_boundary(end) {
                end -= 1;
            }
            &event.display_text[..end]
        } else {
            &event.display_text
        };
        parts.push(truncated);
    }
    parts.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_stream_event(id: &str, variant: EventDisplayVariant) -> SessionEvent {
        SessionEvent {
            id: id.to_string(),
            chunk_id: Some(id.to_string()),
            session_id: "test-session".to_string(),
            created_at: "2026-07-05T00:00:00Z".to_string(),
            function_name: match variant {
                EventDisplayVariant::Thinking => "thinking".to_string(),
                _ => "assistant".to_string(),
            },
            ui_canonical: match variant {
                EventDisplayVariant::Thinking => "thinking".to_string(),
                _ => "message".to_string(),
            },
            action_type: match variant {
                EventDisplayVariant::Thinking => "llm_thinking".to_string(),
                _ => "assistant".to_string(),
            },
            args: serde_json::json!({}),
            result: serde_json::json!({ "content": "same transcript" }),
            source: EventSource::Assistant,
            display_text: "same transcript".to_string(),
            display_status: EventDisplayStatus::Completed,
            display_variant: variant,
            activity_status: ActivityStatus::Processed,
            thread_id: None,
            process_id: None,
            call_id: None,
            file_path: None,
            command: None,
            is_delta: None,
            repo_id: None,
            repo_path: None,
            extracted: None,
            payload_refs: Vec::new(),
            shell_replay: None,
            shell_replay_bookmarks: None,
            last_extract_at: None,
        }
    }

    fn make_tool_event(id: &str) -> SessionEvent {
        let mut event = make_stream_event(id, EventDisplayVariant::ToolCall);
        event.function_name = "subagent".to_string();
        event.ui_canonical = "subagent".to_string();
        event.action_type = "tool_call".to_string();
        event
    }

    fn ids(events: Vec<SessionEvent>) -> Vec<String> {
        events.into_iter().map(|event| event.id).collect()
    }

    #[test]
    fn shell_replay_state_and_bookmarks_round_trip_through_cached_meta() {
        use std::collections::HashMap;

        use crate::agent_sessions::event_pipeline::types::{
            ShellReplayBookmark, ShellReplayRef, ShellReplayState, ShellReplayStatus,
        };

        let state = ShellReplayState {
            replay_ref: ShellReplayRef {
                session_id: "test-session".to_string(),
                call_id: "call-shell-1".to_string(),
                format_version: 1,
            },
            bookmark: ShellReplayBookmark {
                visible_through_sequence: 42,
                visible_bytes: 4096,
            },
            terminal_preview: "bounded preview".to_string(),
            status: ShellReplayStatus::Running,
            error: None,
            completed_at: None,
        };
        let mut event = make_tool_event("shell-event");
        event.session_id = "test-session".to_string();
        event.call_id = Some("call-shell-1".to_string());
        event.shell_replay = Some(state.clone());
        event.shell_replay_bookmarks =
            Some(HashMap::from([("call-shell-1".to_string(), state.clone())]));

        let cached = session_event_to_cached_event(&event);
        let restored = cached_event_to_session_event(&cached);

        assert_eq!(restored.shell_replay, Some(state.clone()));
        assert_eq!(
            restored.shell_replay_bookmarks,
            Some(HashMap::from([("call-shell-1".to_string(), state)]))
        );
    }

    #[test]
    fn cached_shell_extraction_bounds_ten_megabyte_legacy_payload() {
        use crate::agent_sessions::event_pipeline::extractors::ExtractedData;

        const FIVE_MIB: usize = 5 * 1024 * 1024;
        let stdout = format!("{}\nSTDOUT-尾部🙂", "x".repeat(FIVE_MIB));
        let stream_output = format!("{}\nSTREAM-尾部🚀", "y".repeat(FIVE_MIB));

        let mut event = make_tool_event("legacy-large-shell");
        event.function_name = "run_shell".to_string();
        event.ui_canonical = core_types::tool_names::RUN_SHELL.to_string();
        event.call_id = Some("legacy-large-call".to_string());
        event.args = serde_json::json!({
            "command": "emit a large historical transcript",
            "streamOutput": stream_output,
        });
        event.result = serde_json::json!({
            "output": {
                "success": {
                    "stdout": stdout,
                    "exitCode": 0,
                }
            }
        });

        let cached = session_event_to_cached_event(&event);
        let restored = cached_event_to_session_event(&cached);
        let ExtractedData::Shell(shell) = restored.extracted.expect("bounded shell extraction")
        else {
            panic!("expected shell extraction");
        };

        let output = shell.output.expect("bounded stdout preview");
        let stream = shell.stream_output.expect("bounded stream preview");
        assert!(output.len() <= CACHED_SHELL_OUTPUT_PREVIEW_BYTES);
        assert!(stream.len() <= CACHED_SHELL_OUTPUT_PREVIEW_BYTES);
        assert!(output.ends_with("STDOUT-尾部🙂"));
        assert!(stream.ends_with("STREAM-尾部🚀"));
        assert!(!output.starts_with('\u{fffd}'));
        assert!(!stream.starts_with('\u{fffd}'));
    }

    #[test]
    fn dedup_stream_transcript_chunk_pairs_drops_observed_opencode_assistant_pair() {
        let base = make_stream_event(
            "stream-msg-cliagent-1783254446151-a5be-1-a4ab19579c184ade8c933c513170ba2f",
            EventDisplayVariant::Message,
        );
        let chunk = make_stream_event(
            "stream-msg-cliagent-1783254446151-a5be-1-a4ab19579c184ade8c933c513170ba2f-chunk",
            EventDisplayVariant::Message,
        );

        assert_eq!(
            ids(dedup_stream_transcript_chunk_pairs(vec![base, chunk])),
            vec!["stream-msg-cliagent-1783254446151-a5be-1-a4ab19579c184ade8c933c513170ba2f"]
        );
    }

    #[test]
    fn dedup_stream_transcript_chunk_pairs_drops_thinking_pair() {
        let base = make_stream_event("stream-think-session-1-abc", EventDisplayVariant::Thinking);
        let chunk = make_stream_event(
            "stream-think-session-1-abc-chunk",
            EventDisplayVariant::Thinking,
        );

        assert_eq!(
            ids(dedup_stream_transcript_chunk_pairs(vec![base, chunk])),
            vec!["stream-think-session-1-abc"]
        );
    }

    #[test]
    fn dedup_stream_transcript_chunk_pairs_keeps_history_only_chunk() {
        let chunk = make_stream_event(
            "stream-msg-session-1-abc-chunk",
            EventDisplayVariant::Message,
        );

        assert_eq!(
            ids(dedup_stream_transcript_chunk_pairs(vec![chunk])),
            vec!["stream-msg-session-1-abc-chunk"]
        );
    }

    #[test]
    fn dedup_stream_transcript_chunk_pairs_keeps_non_stream_chunk_pairs() {
        let base = make_stream_event("some-event", EventDisplayVariant::Message);
        let chunk = make_stream_event("some-event-chunk", EventDisplayVariant::Message);

        assert_eq!(
            ids(dedup_stream_transcript_chunk_pairs(vec![base, chunk])),
            vec!["some-event", "some-event-chunk"]
        );
    }

    #[test]
    fn dedup_stream_transcript_chunk_pairs_keeps_tool_chunk_pairs() {
        let base = make_tool_event("stream-msg-session-1-tool");
        let chunk = make_tool_event("stream-msg-session-1-tool-chunk");

        assert_eq!(
            ids(dedup_stream_transcript_chunk_pairs(vec![base, chunk])),
            vec![
                "stream-msg-session-1-tool",
                "stream-msg-session-1-tool-chunk"
            ]
        );
    }

    #[test]
    fn dedup_stream_transcript_chunk_pairs_preserves_survivor_order() {
        let first = make_stream_event("user-visible-before", EventDisplayVariant::Message);
        let base = make_stream_event("stream-msg-session-1-abc", EventDisplayVariant::Message);
        let chunk = make_stream_event(
            "stream-msg-session-1-abc-chunk",
            EventDisplayVariant::Message,
        );
        let last = make_stream_event("user-visible-after", EventDisplayVariant::Message);

        assert_eq!(
            ids(dedup_stream_transcript_chunk_pairs(vec![
                first, base, chunk, last
            ])),
            vec![
                "user-visible-before",
                "stream-msg-session-1-abc",
                "user-visible-after"
            ]
        );
    }
}

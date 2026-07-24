use super::*;

pub(super) enum ResolvedReplayWindow {
    Imported(ReplayChunkWindow),
    ManagedChunks(ReplayChunkWindow),
    CollaborationSnapshot(ExternalReplayWindow),
    NotReady,
}

pub(super) enum ResolvedReplayDelta {
    Imported(ReplayChunkDelta),
    ManagedChunks(ReplayChunkDelta),
    CollaborationSnapshot(ExternalReplayDelta),
    NotReady,
}

pub(super) fn load_external_replay_handoff(
    source_id: &str,
    session_id: &str,
    source_name: &str,
) -> Result<ExternalReplayHandoff, String> {
    let source_name = source_name.trim();
    if source_name.is_empty() {
        return Err("external replay handoff sourceName is required".to_string());
    }
    if source_name.encode_utf16().count() > 200 {
        return Err("external replay handoff sourceName exceeds 200 characters".to_string());
    }
    if matches!(
        resolve_target(source_id, session_id)?,
        ResolvedReplayTarget::CollaborationSnapshot
    ) {
        return collect_collaboration_snapshot_handoff(session_id, source_name);
    }
    collect_external_replay_handoff(source_name, |before_sequence, turn_index, limits| {
        load_replay_query_window(
            source_id,
            session_id,
            before_sequence,
            None,
            turn_index,
            limits,
        )
    })
}

pub(super) fn collect_external_replay_handoff(
    source_name: &str,
    mut load_page: impl FnMut(
        Option<i64>,
        Option<i64>,
        ReplayLimits,
    ) -> Result<ResolvedReplayWindow, String>,
) -> Result<ExternalReplayHandoff, String> {
    let mut before_sequence = None;
    let mut requested_turn_index = None;
    let mut generation: Option<String> = None;
    let mut revision: Option<u64> = None;
    let mut remaining_bytes = EXTERNAL_REPLAY_HANDOFF_SCAN_BYTES;
    let mut scanned_bytes = 0_u64;
    let mut scanned_events = 0_u64;
    let mut items = Vec::new();

    while remaining_bytes > 0 && items.len() < EXTERNAL_REPLAY_HANDOFF_MAX_ITEMS {
        let page = load_page(
            before_sequence,
            requested_turn_index,
            ReplayLimits {
                max_turns: replay::HARD_MAX_TURNS,
                max_events: replay::HARD_MAX_EVENTS,
                max_ipc_bytes: remaining_bytes,
            },
        )?;
        let (window, imported) = match page {
            ResolvedReplayWindow::Imported(window) => (window, true),
            ResolvedReplayWindow::ManagedChunks(window) => (window, false),
            ResolvedReplayWindow::CollaborationSnapshot(_) => {
                return Err(
                    "collaboration snapshot handoff must use its direct bounded SQL fold"
                        .to_string(),
                )
            }
            ResolvedReplayWindow::NotReady => {
                return Ok(ExternalReplayHandoff {
                    items: Vec::new(),
                    generation: "pending".to_string(),
                    scanned_bytes: 0,
                    scanned_events: 0,
                })
            }
        };
        if let Some(expected) = generation.as_deref() {
            if expected != window.cursor.generation {
                return Err(format!(
                    "External replay changed generation while building Fork handoff: expected {expected}, found {}; retry the Fork from the new generation",
                    window.cursor.generation
                ));
            }
        } else {
            generation = Some(window.cursor.generation.clone());
        }
        if let Some(expected) = revision {
            if expected != window.cursor.revision {
                return Err(format!(
                    "External replay changed revision while building Fork handoff: expected {expected}, found {}; retry the Fork from a consistent replay snapshot",
                    window.cursor.revision
                ));
            }
        } else {
            revision = Some(window.cursor.revision);
        }

        let compact_bytes = compact_handoff_page_bytes(&window.chunks);
        let page_bytes = compact_bytes.max(window.stats.ipc_bytes as usize);
        if page_bytes > remaining_bytes {
            return Err(format!(
                "External replay handoff page exceeded its remaining {remaining_bytes} byte scan budget"
            ));
        }
        remaining_bytes = remaining_bytes.saturating_sub(page_bytes);
        scanned_bytes = scanned_bytes.saturating_add(page_bytes as u64);
        scanned_events = scanned_events.saturating_add(window.chunks.len() as u64);

        let oldest_sequence = window.chunks.iter().map(|chunk| chunk.sequence).min();
        let oldest_turn_index = window
            .turn_headers
            .iter()
            .map(|header| header.turn_index)
            .min();
        let mut page_items = window
            .chunks
            .iter()
            .filter_map(|indexed| handoff_item_from_chunk(&indexed.chunk, source_name))
            .collect::<Vec<_>>();
        page_items.append(&mut items);
        if page_items.len() > EXTERNAL_REPLAY_HANDOFF_MAX_ITEMS {
            page_items.drain(..page_items.len() - EXTERNAL_REPLAY_HANDOFF_MAX_ITEMS);
        }
        items = page_items;

        let has_older_compact_turn = imported && oldest_turn_index.is_some_and(|index| index > 0);
        if items.len() >= EXTERNAL_REPLAY_HANDOFF_MAX_ITEMS
            || (!window.has_older && !has_older_compact_turn)
            || remaining_bytes == 0
        {
            break;
        }
        if let Some(oldest_turn_index) = oldest_turn_index.filter(|index| imported && *index > 0) {
            let next_turn_index = oldest_turn_index - 1;
            if requested_turn_index.is_some_and(|previous| next_turn_index >= previous) {
                return Err(
                    "External replay handoff turn cursor did not advance to an older turn"
                        .to_string(),
                );
            }
            requested_turn_index = Some(next_turn_index);
            before_sequence = None;
            continue;
        }
        let Some(next_before) = oldest_sequence else {
            return Err("External replay handoff hasOlder page contained no events".to_string());
        };
        if before_sequence.is_some_and(|previous| next_before >= previous) {
            return Err(
                "External replay handoff cursor did not advance to older events".to_string(),
            );
        }
        before_sequence = Some(next_before);
        requested_turn_index = None;
    }

    Ok(ExternalReplayHandoff {
        items,
        generation: generation.unwrap_or_else(|| "empty".to_string()),
        scanned_bytes,
        scanned_events,
    })
}

pub(super) fn collect_collaboration_snapshot_handoff(
    session_id: &str,
    source_name: &str,
) -> Result<ExternalReplayHandoff, String> {
    let conn = database::db::get_connection()
        .map_err(|error| format!("open collaboration handoff DB: {error}"))?;
    let state = collaboration_snapshot_state(&conn, session_id)?;
    let mut upper_exclusive = i64::MAX;
    let mut remaining_bytes = EXTERNAL_REPLAY_HANDOFF_SCAN_BYTES;
    let mut scanned_bytes = 0_u64;
    let mut scanned_events = 0_u64;
    let mut items = Vec::new();
    while remaining_bytes > 0 && items.len() < EXTERNAL_REPLAY_HANDOFF_MAX_ITEMS {
        let page = query_collaboration_snapshot_events(
            &conn,
            session_id,
            &state.generation,
            -1,
            upper_exclusive,
            ReplayLimits {
                max_turns: replay::HARD_MAX_TURNS,
                max_events: replay::HARD_MAX_EVENTS,
                max_ipc_bytes: remaining_bytes,
            },
            true,
        )?;
        if page.is_empty() {
            break;
        }
        let page_bytes = page.iter().try_fold(0_usize, |total, (_, event)| {
            serde_json::to_vec(event)
                .map(|bytes| total.saturating_add(bytes.len()))
                .map_err(|error| format!("measure collaboration handoff page: {error}"))
        })?;
        if page_bytes > remaining_bytes {
            return Err(format!(
                "Collaboration replay handoff page exceeded its remaining {remaining_bytes} byte scan budget"
            ));
        }
        remaining_bytes = remaining_bytes.saturating_sub(page_bytes);
        scanned_bytes = scanned_bytes.saturating_add(page_bytes as u64);
        scanned_events = scanned_events.saturating_add(page.len() as u64);
        let oldest_sequence = page.first().map(|(sequence, _)| *sequence).unwrap_or(-1);
        let mut page_items = page
            .iter()
            .filter_map(|(_, event)| {
                let chunk = ActivityChunk {
                    chunk_id: event.id.clone(),
                    session_id: event.session_id.clone(),
                    action_type: event.action_type.clone(),
                    function: event.function_name.clone(),
                    args: event.args.clone(),
                    result: event.result.clone(),
                    thread_id: event.thread_id.clone(),
                    process_id: event.process_id.clone(),
                    created_at: event.created_at.clone(),
                    broadcast_only: false,
                };
                handoff_item_from_chunk(&chunk, source_name)
            })
            .collect::<Vec<_>>();
        page_items.append(&mut items);
        if page_items.len() > EXTERNAL_REPLAY_HANDOFF_MAX_ITEMS {
            page_items.drain(..page_items.len() - EXTERNAL_REPLAY_HANDOFF_MAX_ITEMS);
        }
        items = page_items;
        if items.len() >= EXTERNAL_REPLAY_HANDOFF_MAX_ITEMS || oldest_sequence < 0 {
            break;
        }
        let has_older = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM events
                 WHERE session_id=?1 AND history_sequence<?2)",
                rusqlite::params![session_id, oldest_sequence],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| format!("query older collaboration handoff rows: {error}"))?
            != 0;
        if !has_older {
            break;
        }
        if oldest_sequence >= upper_exclusive {
            return Err("Collaboration replay handoff cursor did not advance".to_string());
        }
        upper_exclusive = oldest_sequence;
    }
    let current = collaboration_snapshot_state(&conn, session_id)?;
    validate_query_apply_version(
        &state.generation,
        state.revision,
        &current.generation,
        current.revision,
    )?;
    Ok(ExternalReplayHandoff {
        items,
        generation: state.generation,
        scanned_bytes,
        scanned_events,
    })
}

pub(super) fn compact_handoff_page_bytes(chunks: &[ReplayIndexedChunk]) -> usize {
    chunks.iter().fold(0_usize, |total, indexed| {
        total
            .saturating_add(serde_json::to_vec(&indexed.chunk).map_or(0, |bytes| bytes.len()))
            .saturating_add(serde_json::to_vec(&indexed.payloads).map_or(0, |bytes| bytes.len()))
    })
}

pub(super) fn handoff_item_from_chunk(chunk: &ActivityChunk, source_name: &str) -> Option<String> {
    let action_type = chunk.action_type.as_str();
    let function = chunk.function.as_str();
    if action_type.contains("thinking")
        || action_type.contains("reasoning")
        || matches!(function, "thinking" | "thinking_delta" | "reasoning")
    {
        return None;
    }

    let result_text = handoff_text_value(&chunk.result);
    let args_text = handoff_text_value(&chunk.args);
    let content = result_text.as_deref().or(args_text.as_deref());
    let item = if matches!(action_type, "user" | "user_message")
        || matches!(function, "user" | "user_message")
    {
        content.map(|text| format!("User: {text}"))
    } else if matches!(
        action_type,
        "assistant" | "assistant_message" | "llm_response"
    ) || matches!(
        function,
        "agent_message" | "assistant" | "assistant_message"
    ) {
        content.map(|text| format!("Assistant: {text}"))
    } else if action_type.contains("tool") {
        let mut lines = vec![
            format!("[Imported {source_name} action]"),
            format!(
                "Tool: {}",
                if function.is_empty() {
                    "unknown_tool"
                } else {
                    function
                }
            ),
        ];
        if let Some(args) = args_text {
            lines.push(format!("Input: {args}"));
        }
        if let Some(result) = result_text {
            lines.push(format!("Result at that time: {result}"));
        }
        Some(lines.join("\n"))
    } else {
        content.map(|text| format!("Assistant context: {text}"))
    }?;
    Some(truncate_handoff_utf16(&item))
}

pub(super) fn handoff_text_value(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(text) => {
            let trimmed = text.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        }
        serde_json::Value::Array(values) => {
            let joined = values
                .iter()
                .filter_map(handoff_text_value)
                .collect::<Vec<_>>()
                .join("\n");
            (!joined.is_empty()).then_some(joined)
        }
        serde_json::Value::Object(object) => ["text", "content", "message", "output", "summary"]
            .into_iter()
            .find_map(|key| object.get(key).and_then(handoff_text_value)),
        _ => None,
    }
}

pub(super) fn truncate_handoff_utf16(text: &str) -> String {
    if text.encode_utf16().count() <= EXTERNAL_REPLAY_HANDOFF_MAX_TEXT_UTF16 {
        return text.to_string();
    }
    let content_budget = EXTERNAL_REPLAY_HANDOFF_MAX_TEXT_UTF16.saturating_sub(1);
    let mut output = String::new();
    let mut units = 0_usize;
    for character in text.chars() {
        let next = units.saturating_add(character.len_utf16());
        if next > content_budget {
            break;
        }
        output.push(character);
        units = next;
    }
    output.push('…');
    output
}

/// Build the last usable imported-history handoff items entirely in Rust.
///
/// Like `external_replay_query_window`, this may bring ORGII's rebuildable
/// compact index up to date. It intentionally has no AppHandle, EventStore
/// State, episode id, watcher lease, notification, or request-token side
/// effect. Cross-page reads are pinned to one source generation and revision.
#[tauri::command]
pub async fn external_replay_handoff(
    source_id: String,
    session_id: String,
    source_name: String,
) -> Result<ExternalReplayHandoff, String> {
    let handoff = tokio::task::spawn_blocking(move || {
        load_external_replay_handoff(&source_id, &session_id, &source_name)
    })
    .await
    .map_err(|err| format!("join pure replay handoff task: {err}"))??;
    schedule_replay_cache_prune();
    Ok(handoff)
}

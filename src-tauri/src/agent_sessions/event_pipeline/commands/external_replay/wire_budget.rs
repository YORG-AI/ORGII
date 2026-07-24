use super::*;

pub(super) fn normalize_window(
    window: ReplayChunkWindow,
    session_id: &str,
) -> ExternalReplayWindow {
    let window_start_sequence = window.chunks.iter().map(|chunk| chunk.sequence).min();
    let (events, ipc_bytes) = normalize_indexed_chunks(
        window.chunks,
        session_id,
        &window.cursor.source_id,
        &window.cursor.generation,
    );
    let mut stats = window.stats;
    stats.normalized_events = events.len() as u64;
    stats.ipc_bytes = ipc_bytes;
    ExternalReplayWindow {
        cursor: window.cursor,
        events,
        window_start_sequence,
        turn_headers: window.turn_headers,
        total_turn_count: window.total_turn_count,
        total_event_count: window.total_event_count,
        has_older: window.has_older,
        stats,
        watcher_available: false,
    }
}

pub(super) fn normalize_delta(delta: ReplayChunkDelta, session_id: &str) -> ExternalReplayDelta {
    let (events, ipc_bytes) = normalize_indexed_chunks(
        delta.chunks,
        session_id,
        &delta.cursor.source_id,
        &delta.cursor.generation,
    );
    let mut stats = delta.stats;
    stats.normalized_events = events.len() as u64;
    stats.ipc_bytes = ipc_bytes;
    ExternalReplayDelta {
        cursor: delta.cursor,
        events,
        removed_event_ids: delta.removed_event_ids,
        reset_required: delta.reset_required,
        stats,
        watcher_available: false,
    }
}

pub(super) fn refresh_window_wire_bytes(
    response: &mut ExternalReplayWindow,
) -> Result<usize, String> {
    let mut candidate = 0_u64;
    for _ in 0..8 {
        response.stats.ipc_bytes = candidate;
        let measured = serde_json::to_vec(response)
            .map_err(|error| format!("serialize bounded replay window: {error}"))?
            .len() as u64;
        if measured == candidate {
            return Ok(measured as usize);
        }
        candidate = measured;
    }
    response.stats.ipc_bytes = candidate;
    let measured = serde_json::to_vec(response)
        .map_err(|error| format!("serialize bounded replay window: {error}"))?
        .len() as u64;
    response.stats.ipc_bytes = measured;
    Ok(measured as usize)
}

pub(super) fn refresh_delta_wire_bytes(
    response: &mut ExternalReplayDelta,
) -> Result<usize, String> {
    let mut candidate = 0_u64;
    for _ in 0..8 {
        response.stats.ipc_bytes = candidate;
        let measured = serde_json::to_vec(response)
            .map_err(|error| format!("serialize bounded replay delta: {error}"))?
            .len() as u64;
        if measured == candidate {
            return Ok(measured as usize);
        }
        candidate = measured;
    }
    response.stats.ipc_bytes = candidate;
    let measured = serde_json::to_vec(response)
        .map_err(|error| format!("serialize bounded replay delta: {error}"))?
        .len() as u64;
    response.stats.ipc_bytes = measured;
    Ok(measured as usize)
}

pub(super) fn finalize_window_wire_budget(
    response: &mut ExternalReplayWindow,
    max_ipc_bytes: usize,
) -> Result<(), String> {
    let wire_bytes = refresh_window_wire_bytes(response)?;
    if wire_bytes > max_ipc_bytes {
        return Err(format!(
            "Bounded replay window requires {wire_bytes} serialized bytes after normalization; limit is {max_ipc_bytes}. Reduce maxEvents/maxTurns or read payloads by range"
        ));
    }
    Ok(())
}

pub(super) fn finalize_delta_wire_budget(
    response: &mut ExternalReplayDelta,
    max_ipc_bytes: usize,
) -> Result<(), String> {
    let wire_bytes = refresh_delta_wire_bytes(response)?;
    if wire_bytes > max_ipc_bytes {
        return Err(format!(
            "Bounded replay delta requires {wire_bytes} serialized bytes after normalization; limit is {max_ipc_bytes}. Retry with a smaller event window"
        ));
    }
    Ok(())
}

pub(super) fn normalize_indexed_chunks(
    indexed: Vec<ReplayIndexedChunk>,
    session_id: &str,
    replay_source_id: &str,
    replay_generation: &str,
) -> (Vec<SessionEvent>, u64) {
    let payloads = indexed
        .iter()
        .map(|indexed| {
            (
                indexed.chunk.chunk_id.clone(),
                (indexed.chunk.chunk_id.clone(), indexed.payloads.clone()),
            )
        })
        .collect::<HashMap<_, _>>();
    let raw = indexed
        .into_iter()
        .map(|indexed| activity_to_raw(indexed.chunk))
        .collect::<Vec<_>>();
    let mut events = ingestion::ingest_raw_chunks(&raw, session_id).events;
    for event in &mut events {
        let source_payloads = event
            .chunk_id
            .as_ref()
            .and_then(|chunk_id| payloads.get(chunk_id))
            .or_else(|| payloads.get(&event.id));
        let Some((source_event_id, descriptors)) = source_payloads else {
            continue;
        };
        for descriptor in descriptors {
            event.payload_refs.push(PayloadRef {
                event_id: event.id.clone(),
                field_path: descriptor.field_path.clone(),
                preview: json_field_preview(event, &descriptor.field_path),
                full_size_bytes: descriptor.total_bytes.min(usize::MAX as u64) as usize,
                truncated: true,
                replay_encoding: Some(match descriptor.resolved_encoding() {
                    ReplayPayloadEncoding::JsonValue => PayloadRefEncoding::JsonValue,
                    ReplayPayloadEncoding::Utf8Text => PayloadRefEncoding::Utf8Text,
                    ReplayPayloadEncoding::LegacyPathInferred => {
                        unreachable!("resolved replay payload encoding cannot remain legacy")
                    }
                }),
                replay_source_id: Some(replay_source_id.to_string()),
                replay_generation: Some(replay_generation.to_string()),
                replay_source_event_id: Some(source_event_id.clone()),
            });
        }
    }
    let ipc_bytes = serde_json::to_vec(&events).map_or(0, |bytes| bytes.len()) as u64;
    (events, ipc_bytes)
}

pub(super) fn activity_to_raw(chunk: ActivityChunk) -> RawActivityChunk {
    RawActivityChunk {
        chunk_id: Some(chunk.chunk_id),
        session_id: Some(chunk.session_id),
        action_type: Some(chunk.action_type),
        function: Some(chunk.function),
        args: Some(chunk.args),
        result: Some(chunk.result),
        created_at: Some(chunk.created_at),
        thread_id: chunk.thread_id,
        process_id: chunk.process_id,
        call_id: None,
    }
}

pub(super) fn json_field_preview(event: &SessionEvent, field_path: &str) -> String {
    let (root, path) = field_path.split_once('.').unwrap_or((field_path, ""));
    let mut value = match root {
        "args" => &event.args,
        "result" => &event.result,
        _ => return String::new(),
    };
    for segment in path.split('.').filter(|segment| !segment.is_empty()) {
        value = match value {
            serde_json::Value::Object(object) => match object.get(segment) {
                Some(next) => next,
                None => return String::new(),
            },
            serde_json::Value::Array(array) => {
                let Ok(index) = segment.parse::<usize>() else {
                    return String::new();
                };
                match array.get(index) {
                    Some(next) => next,
                    None => return String::new(),
                }
            }
            _ => return String::new(),
        };
    }
    value
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| value.to_string())
}

pub(super) fn remap_cursor(cursor: &mut ReplayCursor, source_id: &str, session_id: &str) {
    cursor.source_id = source_id.to_string();
    cursor.session_id = session_id.to_string();
}

pub(super) fn validate_display_cursor(
    source_id: &str,
    session_id: &str,
    cursor: &ReplayCursor,
) -> Result<(), String> {
    if cursor.source_id != source_id || cursor.session_id != session_id {
        return Err("Replay cursor belongs to another display session".to_string());
    }
    Ok(())
}

pub(super) fn not_ready_window(source_id: &str, session_id: &str) -> ExternalReplayWindow {
    ExternalReplayWindow {
        cursor: ReplayCursor {
            source_id: source_id.to_string(),
            session_id: session_id.to_string(),
            generation: "pending".to_string(),
            revision: 0,
            through_sequence: -1,
        },
        events: Vec::new(),
        window_start_sequence: None,
        turn_headers: Vec::new(),
        total_turn_count: 0,
        total_event_count: 0,
        has_older: false,
        stats: ReplayStats {
            not_ready: true,
            ..ReplayStats::default()
        },
        watcher_available: false,
    }
}

pub(super) fn not_ready_delta(source_id: &str, session_id: &str) -> ExternalReplayDelta {
    ExternalReplayDelta {
        cursor: not_ready_window(source_id, session_id).cursor,
        events: Vec::new(),
        removed_event_ids: Vec::new(),
        reset_required: false,
        stats: ReplayStats {
            not_ready: true,
            ..ReplayStats::default()
        },
        watcher_available: false,
    }
}

pub(super) fn session_events_equal(left: &SessionEvent, right: &SessionEvent) -> bool {
    serde_json::to_vec(left).ok() == serde_json::to_vec(right).ok()
}

pub(super) const REPLAY_REQUEST_STATE_TTL: Duration = Duration::from_secs(5 * 60);
pub(super) const MAX_REPLAY_REQUEST_STATES: usize = 64;
pub(super) const PREWARM_REQUEST_STATE_TTL: Duration = Duration::from_secs(5 * 60);
pub(super) const MAX_PREWARM_REQUEST_STATES: usize = 64;

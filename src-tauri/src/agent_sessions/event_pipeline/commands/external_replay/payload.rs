use super::*;

pub(super) fn validate_stream_replay_cursor(
    expected_generation: &str,
    expected_revision: u64,
    current: &ReplayCursor,
    operation: &str,
) -> Result<(), String> {
    if current.generation == expected_generation && current.revision == expected_revision {
        return Ok(());
    }
    Err(format!(
        "Replay source changed while {operation}: expected {expected_generation}@{expected_revision}, found {}@{}; retry from the new replay cursor",
        current.generation, current.revision
    ))
}

#[cfg(test)]
pub(super) fn replace_event_payload(event: &mut SessionEvent, field_path: &str, text: String) {
    let preview = json_field_preview(event, field_path);
    if event.display_text == preview {
        event.display_text = text.clone();
    }
    if field_path == "args" {
        event.args = serde_json::from_str(&text).unwrap_or(serde_json::Value::String(text));
        return;
    }
    if field_path == "result" {
        event.result = serde_json::from_str(&text).unwrap_or(serde_json::Value::String(text));
        return;
    }
    let Some((root, path)) = field_path.split_once('.') else {
        return;
    };
    let value = match root {
        "args" => &mut event.args,
        "result" => &mut event.result,
        _ => return,
    };
    set_json_string_path(value, path, text);
}

pub(super) fn set_json_string_path(value: &mut serde_json::Value, path: &str, text: String) {
    let mut current = value;
    let mut segments = path.split('.').peekable();
    while let Some(segment) = segments.next() {
        if segments.peek().is_none() {
            match current {
                serde_json::Value::Object(object) => {
                    object.insert(segment.to_string(), serde_json::Value::String(text));
                }
                serde_json::Value::Array(array) => {
                    let Ok(index) = segment.parse::<usize>() else {
                        return;
                    };
                    let Some(value) = array.get_mut(index) else {
                        return;
                    };
                    *value = serde_json::Value::String(text);
                }
                _ => {}
            }
            return;
        }
        current = match current {
            serde_json::Value::Object(object) => {
                let Some(next) = object.get_mut(segment) else {
                    return;
                };
                next
            }
            serde_json::Value::Array(array) => {
                let Ok(index) = segment.parse::<usize>() else {
                    return;
                };
                let Some(next) = array.get_mut(index) else {
                    return;
                };
                next
            }
            _ => return,
        };
    }
}

#[tauri::command]
#[allow(
    clippy::too_many_arguments,
    reason = "Tauri wire and replay storage boundaries keep stable fields explicit"
)]
pub async fn external_replay_read_payload_range(
    source_id: String,
    session_id: String,
    generation: String,
    event_id: String,
    field_path: String,
    offset: u64,
    max_bytes: Option<usize>,
) -> Result<ReplayPayloadRange, String> {
    tokio::task::spawn_blocking(move || {
        match resolve_secondary_consumer_target(&source_id, &session_id)? {
            ResolvedReplayTarget::Imported {
                source,
                imported_session_id,
            } => {
                let mut conn = database::db::get_connection()
                    .map_err(|err| format!("open replay index DB: {err}"))?;
                replay::read_payload_range(
                    &mut conn,
                    source,
                    &imported_session_id,
                    &generation,
                    &event_id,
                    &field_path,
                    offset,
                    max_bytes,
                )
            }
            ResolvedReplayTarget::CollaborationSnapshot => {
                let max_bytes = max_bytes
                    .unwrap_or(replay::DEFAULT_PAYLOAD_RANGE_BYTES)
                    .clamp(1, replay::HARD_MAX_PAYLOAD_RANGE_BYTES);
                let conn = database::db::get_connection()
                    .map_err(|err| format!("open collaboration replay DB: {err}"))?;
                collaboration_snapshot_payload_range_from_conn(
                    &conn,
                    &session_id,
                    &generation,
                    &event_id,
                    &field_path,
                    offset,
                    max_bytes,
                )
            }
            ResolvedReplayTarget::ManagedChunkStore => {
                managed_chunk_payload_range(&session_id, &event_id, &field_path, offset, max_bytes)
            }
            ResolvedReplayTarget::NotReady => {
                Err("Managed native transcript is not bound yet".into())
            }
        }
    })
    .await
    .map_err(|err| format!("join replay payload task: {err}"))?
}

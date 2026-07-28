//! Windsurf composer/bubble loading and `ActivityChunk` conversion.

use serde_json::json;

use super::*;

pub(super) fn load_windsurf_history_from_conn(
    conn: &Connection,
    session_id: &str,
    composer_id: &str,
) -> Result<Vec<ActivityChunk>, String> {
    let composer = load_composer(conn, composer_id)?;
    if composer.full_conversation_headers_only.is_empty() {
        return Ok(Vec::new());
    }
    let bubbles = load_bubbles_by_id(conn, composer_id, &composer.full_conversation_headers_only)?;
    Ok(bubbles_to_chunks(conn, session_id, &bubbles))
}

fn load_composer(conn: &Connection, composer_id: &str) -> Result<RawComposerData, String> {
    let key = format!("composerData:{composer_id}");
    let Some(json_str) = conn
        .query_row(
            "SELECT value FROM cursorDiskKV WHERE key = ?1",
            [&key],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|err| format!("Failed to read Windsurf composer {composer_id}: {err}"))?
        .flatten()
    else {
        return Ok(RawComposerData::default());
    };
    if json_str.is_empty() {
        return Ok(RawComposerData::default());
    }
    serde_json::from_str(&json_str)
        .map_err(|err| format!("Failed to parse Windsurf composer {composer_id}: {err}"))
}

pub(super) fn load_bubbles_by_id(
    conn: &Connection,
    composer_id: &str,
    order: &[RawComposerHeader],
) -> Result<Vec<OrderedBubble>, String> {
    let keyed_headers: Vec<(&RawComposerHeader, String)> = order
        .iter()
        .filter(|header| !header.bubble_id.is_empty())
        .map(|header| {
            (
                header,
                format!("bubbleId:{composer_id}:{}", header.bubble_id),
            )
        })
        .collect();
    if keyed_headers.is_empty() {
        return Ok(Vec::new());
    }

    let mut values_by_key = HashMap::with_capacity(keyed_headers.len());
    for chunk in keyed_headers.chunks(SQLITE_IN_QUERY_CHUNK_SIZE) {
        let placeholders = vec!["?"; chunk.len()].join(",");
        let sql = format!("SELECT key, value FROM cursorDiskKV WHERE key IN ({placeholders})");
        let keys = chunk
            .iter()
            .map(|(_, key)| key.as_str())
            .collect::<Vec<_>>();
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|err| format!("Failed to prepare Windsurf bubble query: {err}"))?;
        let rows = stmt
            .query_map(params_from_iter(keys), |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
            })
            .map_err(|err| format!("Failed to read Windsurf bubbles: {err}"))?;

        for row in rows {
            let (key, Some(value)) =
                row.map_err(|err| format!("Failed to read Windsurf bubble row: {err}"))?
            else {
                continue;
            };
            values_by_key.insert(key, value);
        }
    }

    let mut out = Vec::with_capacity(keyed_headers.len());
    for (header, key) in keyed_headers {
        let Some(json_str) = values_by_key.get(&key) else {
            continue;
        };
        if let Ok(raw) = serde_json::from_str::<RawBubble>(json_str) {
            out.push(OrderedBubble {
                bubble_id: header.bubble_id.clone(),
                bubble_type: header.bubble_type,
                raw,
            });
        }
    }

    Ok(out)
}

pub(super) fn bubbles_to_chunks(
    conn: &Connection,
    session_id: &str,
    bubbles: &[OrderedBubble],
) -> Vec<ActivityChunk> {
    let mut chunks = Vec::with_capacity(bubbles.len());
    for (sequence, bubble) in bubbles.iter().enumerate() {
        let bubble_type = if bubble.raw.bubble_type != 0 {
            bubble.raw.bubble_type
        } else {
            bubble.bubble_type
        };
        match bubble_type {
            BUBBLE_TYPE_USER => {
                if let Some(chunk) = user_bubble_to_chunk(session_id, sequence, bubble) {
                    chunks.push(chunk);
                }
            }
            BUBBLE_TYPE_ASSISTANT => {
                if let Some(chunk) =
                    assistant_tool_bubble_to_chunk(conn, session_id, sequence, bubble)
                {
                    chunks.push(chunk);
                } else if let Some(chunk) =
                    assistant_text_bubble_to_chunk(session_id, sequence, bubble)
                {
                    chunks.push(chunk);
                }
            }
            _ => {}
        }
    }
    chunks
}

fn user_bubble_to_chunk(
    session_id: &str,
    sequence: usize,
    bubble: &OrderedBubble,
) -> Option<ActivityChunk> {
    let text = bubble.raw.text.trim();
    if text.is_empty() {
        return None;
    }
    Some(imported_history::user_message_chunk(
        session_id,
        WINDSURF_PROVIDER_SLUG,
        sequence,
        &imported_history::normalize_created_at(&bubble.raw.created_at),
        text,
    ))
}

fn assistant_text_bubble_to_chunk(
    session_id: &str,
    sequence: usize,
    bubble: &OrderedBubble,
) -> Option<ActivityChunk> {
    let text = bubble.raw.text.trim();
    if text.is_empty() {
        return None;
    }
    Some(imported_history::assistant_message_chunk(
        session_id,
        WINDSURF_PROVIDER_SLUG,
        sequence,
        &imported_history::normalize_created_at(&bubble.raw.created_at),
        text,
    ))
}

fn assistant_tool_bubble_to_chunk(
    conn: &Connection,
    session_id: &str,
    sequence: usize,
    bubble: &OrderedBubble,
) -> Option<ActivityChunk> {
    let tool_data = bubble.raw.tool_former_data.as_ref()?;
    if tool_data.name.trim().is_empty() {
        return None;
    }
    let args = imported_history::parse_inner_json(&tool_data.params);
    let mut result = imported_history::parse_inner_json(&tool_data.result);
    merge_additional_data(&mut result, &tool_data.additional_data);
    resolve_content_ids(conn, &mut result);
    let (canonical_name, args) = normalize_windsurf_tool_call(&tool_data.name, args);
    let call_id = if tool_data.tool_call_id.trim().is_empty() {
        bubble.bubble_id.clone()
    } else {
        tool_data.tool_call_id.clone()
    };
    let output = tool_output_text(&result);
    let call = ImportedToolCall {
        call_id,
        raw_name: tool_data.name.clone(),
        canonical_name,
        args,
        created_at: imported_history::normalize_created_at(&bubble.raw.created_at),
    };
    let mut chunk = imported_history::tool_call_chunk(
        session_id,
        WINDSURF_PROVIDER_SLUG,
        sequence,
        &call,
        &output,
    );
    if let Some(result_obj) = chunk.result.as_object_mut() {
        if !tool_data.status.trim().is_empty() {
            result_obj.insert(
                "status".to_string(),
                Value::String(tool_data.status.clone()),
            );
        }
        if let Some(source_result) = result.as_object() {
            for key in ["old_content", "new_content"] {
                if let Some(value) = source_result.get(key) {
                    result_obj.insert(key.to_string(), value.clone());
                }
            }
        }
    }
    Some(chunk)
}

fn normalize_windsurf_tool_call(raw_name: &str, args: Value) -> (String, Value) {
    match raw_name {
        "shell" | "run_command" | "terminal" | "terminal_command" => (
            imported_history::FUNCTION_RUN_COMMAND_LINE.to_string(),
            normalize_shell_args(args),
        ),
        "edit_file" | "edit_file_v2" | "write_file" | "apply_patch" => (
            imported_history::FUNCTION_EDIT_FILE.to_string(),
            normalize_edit_args(raw_name, args),
        ),
        _ => (raw_name.to_string(), args),
    }
}

fn normalize_shell_args(args: Value) -> Value {
    let command = args
        .get("command")
        .and_then(Value::as_str)
        .or_else(|| args.get("cmd").and_then(Value::as_str))
        .unwrap_or_default();
    json!({
        "command": command,
        "cmd": command,
    })
}

fn normalize_edit_args(raw_name: &str, args: Value) -> Value {
    let file_path = args
        .get("file_path")
        .and_then(Value::as_str)
        .or_else(|| args.get("targetFile").and_then(Value::as_str))
        .or_else(|| args.get("relativeWorkspacePath").and_then(Value::as_str))
        .unwrap_or_default();
    json!({
        "action": raw_name,
        "file_path": file_path,
        "payload": args,
    })
}

fn merge_additional_data(result: &mut Value, additional_data: &Value) {
    let (Some(result_obj), Some(additional_obj)) =
        (result.as_object_mut(), additional_data.as_object())
    else {
        return;
    };
    for (key, value) in additional_obj {
        result_obj
            .entry(key.clone())
            .or_insert_with(|| value.clone());
    }
}

fn resolve_content_ids(conn: &Connection, result: &mut Value) {
    let Some(obj) = result.as_object_mut() else {
        return;
    };
    if let Some(text) = obj
        .get("beforeContentId")
        .and_then(Value::as_str)
        .and_then(|content_id| load_content_blob(conn, content_id))
    {
        obj.insert("old_content".to_string(), Value::String(text));
    }
    if let Some(text) = obj
        .get("afterContentId")
        .and_then(Value::as_str)
        .and_then(|content_id| load_content_blob(conn, content_id))
    {
        obj.insert("new_content".to_string(), Value::String(text));
    }
}

fn load_content_blob(conn: &Connection, content_id: &str) -> Option<String> {
    if content_id.trim().is_empty() {
        return None;
    }
    conn.query_row(
        "SELECT value FROM cursorDiskKV WHERE key = ?1",
        [content_id],
        |row| row.get::<_, Option<String>>(0),
    )
    .optional()
    .ok()
    .flatten()
    .flatten()
}

fn tool_output_text(result: &Value) -> String {
    result
        .get("output")
        .and_then(Value::as_str)
        .or_else(|| result.get("observation").and_then(Value::as_str))
        .or_else(|| result.get("content").and_then(Value::as_str))
        .map(str::to_string)
        .unwrap_or_else(|| result.to_string())
}

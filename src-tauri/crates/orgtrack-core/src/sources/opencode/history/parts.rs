//! OpenCode message/part parsing and `ActivityChunk` conversion.

use serde_json::json;

use super::*;

pub(super) fn load_ordered_parts(
    conn: &Connection,
    source_session_id: &str,
) -> Result<Vec<OpenCodePartRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT p.id, p.message_id, json_extract(m.data, '$.role'), p.data, p.time_created \
             FROM part p \
             JOIN message m ON m.id = p.message_id \
             WHERE p.session_id = ?1 \
             ORDER BY p.time_created ASC, p.id ASC",
        )
        .map_err(|err| format!("Failed to prepare OpenCode part query: {err}"))?;
    let rows = stmt
        .query_map([source_session_id], |row| {
            Ok((
                row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<i64>>(4)?.unwrap_or_default(),
            ))
        })
        .map_err(|err| format!("Failed to query OpenCode parts: {err}"))?;

    let mut parts = Vec::new();
    for row in rows {
        let (part_id, message_id, role, Some(raw_data), time_created) =
            row.map_err(|err| format!("Failed to read OpenCode part row: {err}"))?
        else {
            continue;
        };
        let Ok(part) = serde_json::from_str::<OpenCodePart>(&raw_data) else {
            continue;
        };
        parts.push(OpenCodePartRow {
            part_id,
            message_id,
            role,
            part,
            time_created,
        });
    }
    Ok(parts)
}

pub(super) fn part_row_to_chunk(
    session_id: &str,
    provider_slug: &str,
    sequence: usize,
    row: &OpenCodePartRow,
) -> Option<ActivityChunk> {
    match row.part.part_type.as_str() {
        "text" if row.role == "user" => {
            text_to_user_chunk_with_provider(session_id, provider_slug, sequence, row)
        }
        "text" => text_to_assistant_chunk(session_id, provider_slug, sequence, row),
        "reasoning" => reasoning_to_chunk(session_id, provider_slug, sequence, row),
        "tool" => tool_to_chunk(session_id, provider_slug, sequence, row),
        _ => None,
    }
}

pub(super) fn text_to_user_chunk_with_provider(
    session_id: &str,
    provider_slug: &str,
    sequence: usize,
    row: &OpenCodePartRow,
) -> Option<ActivityChunk> {
    // Strip the GUI exec-mode briefing; a bridge-only part carries no
    // user-authored text, so emit no bubble.
    let text = imported_history::strip_orgii_exec_mode_bridge(row.part.text.trim());
    if text.trim().is_empty() {
        return None;
    }
    Some(imported_history::user_message_chunk(
        session_id,
        provider_slug,
        sequence,
        &row_created_at(row),
        text,
    ))
}

fn text_to_assistant_chunk(
    session_id: &str,
    provider_slug: &str,
    sequence: usize,
    row: &OpenCodePartRow,
) -> Option<ActivityChunk> {
    let text = row.part.text.trim();
    if text.is_empty() {
        return None;
    }
    Some(imported_history::assistant_message_chunk(
        session_id,
        provider_slug,
        sequence,
        &row_created_at(row),
        text,
    ))
}

fn reasoning_to_chunk(
    session_id: &str,
    provider_slug: &str,
    sequence: usize,
    row: &OpenCodePartRow,
) -> Option<ActivityChunk> {
    let text = row.part.text.trim();
    if text.is_empty() {
        return None;
    }
    Some(imported_history::thinking_chunk(
        session_id,
        provider_slug,
        sequence,
        &row_created_at(row),
        text,
    ))
}

fn tool_to_chunk(
    session_id: &str,
    provider_slug: &str,
    sequence: usize,
    row: &OpenCodePartRow,
) -> Option<ActivityChunk> {
    let state = row.part.state.as_ref()?;
    let raw_name = row.part.tool.trim();
    if raw_name.is_empty() {
        return None;
    }
    let call_id = if row.part.call_id.trim().is_empty() {
        row.part_id.clone()
    } else {
        row.part.call_id.clone()
    };
    let args = state.input.clone();
    let (canonical_name, args) = normalize_opencode_tool_call(raw_name, args);
    let call = ImportedToolCall {
        call_id,
        raw_name: raw_name.to_string(),
        canonical_name,
        args,
        created_at: row_created_at(row),
    };
    let output = tool_output_text(state);
    let mut chunk =
        imported_history::tool_call_chunk(session_id, provider_slug, sequence, &call, &output);
    if let Some(result_obj) = chunk.result.as_object_mut() {
        if !state.status.trim().is_empty() {
            result_obj.insert("status".to_string(), Value::String(state.status.clone()));
        }
        if !state.title.trim().is_empty() {
            result_obj.insert("title".to_string(), Value::String(state.title.clone()));
        }
        if !row.message_id.trim().is_empty() {
            result_obj.insert(
                "message_id".to_string(),
                Value::String(row.message_id.clone()),
            );
        }
    }
    Some(chunk)
}

fn normalize_opencode_tool_call(raw_name: &str, args: Value) -> (String, Value) {
    match raw_name {
        "bash" | "shell" | "execute" => (
            imported_history::FUNCTION_RUN_COMMAND_LINE.to_string(),
            normalize_shell_args(args),
        ),
        "write" | "edit" | "patch" | "apply_patch" => (
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
        "payload": args,
    })
}

fn normalize_edit_args(raw_name: &str, args: Value) -> Value {
    let file_path = args
        .get("filePath")
        .and_then(Value::as_str)
        .or_else(|| args.get("file_path").and_then(Value::as_str))
        .or_else(|| args.get("path").and_then(Value::as_str))
        .unwrap_or_default();
    json!({
        "action": raw_name,
        "file_path": file_path,
        "payload": args,
    })
}

fn tool_output_text(state: &OpenCodeToolState) -> String {
    if !state.output.trim().is_empty() {
        return state.output.clone();
    }
    state
        .metadata
        .get("output")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_default()
}

fn row_created_at(row: &OpenCodePartRow) -> String {
    let timestamp = row
        .part
        .time
        .as_ref()
        .map(|time| {
            if time.start > 0 {
                time.start
            } else if time.end > 0 {
                time.end
            } else {
                row.time_created
            }
        })
        .unwrap_or(row.time_created);
    imported_history::epoch_ms_to_iso(timestamp)
}

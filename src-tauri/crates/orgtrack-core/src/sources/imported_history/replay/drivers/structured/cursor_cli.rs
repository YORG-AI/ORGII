use super::*;

pub(super) fn sync_cursor_cli(
    tx: &Transaction<'_>,
    display_session_id: &str,
    source_session_id: &str,
    source_path: &Path,
    generation: &str,
    write_revision: u64,
    previous_state: Option<&ReplayIndexState>,
) -> Result<StructuredSyncOutcome, String> {
    let source = ImportedHistorySourceId::CursorCli;
    let source_conn = open_source_db(source_path)?;
    validate_cursor_schema(&source_conn)?;
    let schema_version = source_conn
        .query_row("PRAGMA schema_version", [], |row| row.get::<_, i64>(0))
        .map_err(|err| format!("read Cursor CLI schema version: {err}"))?;
    let meta = read_cursor_meta(&source_conn)?;
    let mut cursor = previous_state
        .map(|state| serde_json::from_str::<CursorCliReplayCursor>(&state.driver_cursor_json))
        .transpose()
        .map_err(|err| format!("decode Cursor CLI replay cursor: {err}"))?
        .filter(|cursor| cursor.driver == "cursor_cli")
        .unwrap_or_else(|| CursorCliReplayCursor {
            schema_version,
            driver: "cursor_cli".to_string(),
            cursor_turn_index: -1,
            ..CursorCliReplayCursor::default()
        });

    // Content-addressed roots never mutate. This remains a true zero-parse,
    // zero-upsert poll even after the coordinator's 60 second integrity tick.
    if cursor.root_blob_id == meta.latest_root_blob_id && previous_state.is_some() {
        return unchanged_outcome(tx, source, source_session_id, generation, cursor);
    }

    let root = read_blob(&source_conn, &meta.latest_root_blob_id)?
        .ok_or_else(|| "Cursor CLI root blob is missing".to_string())?;
    if previous_state.is_some()
        && cursor.message_count > 0
        && cursor.root_blob_id != meta.latest_root_blob_id
    {
        let (current_count, current_prefix_hash) =
            manifest_prefix_hash(&root, cursor.message_count)?;
        if current_count < cursor.message_count
            || current_prefix_hash != cursor.manifest_prefix_hash
        {
            // The coordinator checked lineage before opening this source
            // snapshot. A concurrent fork/reorder must roll the ORGII index
            // transaction back and retry as a new generation, never append
            // the new suffix onto the old conversation.
            return Err("Cursor CLI replay lineage changed during synchronization".to_string());
        }
    }
    let created_at = imported_history::epoch_ms_to_iso(meta.created_at);
    let mut stats = ReplayStats::default();
    let mut changed = false;
    let mut message_count = 0_u64;
    let mut prefix_hash = Hash64::default();
    visit_manifest_message_ids(&root, |blob_id| {
        prefix_hash.update(blob_id.as_bytes());
        let ordinal = message_count;
        message_count = message_count.saturating_add(1);
        if ordinal < cursor.message_count {
            return Ok(());
        }
        let Some(data) = read_blob(&source_conn, blob_id)? else {
            return Ok(());
        };
        stats.parsed_rows = stats.parsed_rows.saturating_add(1);
        stats.parsed_bytes = stats.parsed_bytes.saturating_add(data.len() as u64);
        let Ok(message) = serde_json::from_slice::<Value>(&data) else {
            return Ok(());
        };
        let emitted = fold_cursor_message(
            display_session_id,
            source_session_id,
            blob_id,
            ordinal,
            &message,
            &created_at,
            &source_conn,
            &mut cursor,
        )?;
        for emitted in emitted {
            upsert_emitted(
                tx,
                source,
                source_session_id,
                generation,
                write_revision,
                emitted,
                &mut stats,
            )?;
            changed = true;
        }
        Ok(())
    })?;

    cursor.schema_version = schema_version;
    cursor.driver = "cursor_cli".to_string();
    cursor.root_blob_id = meta.latest_root_blob_id;
    cursor.message_count = message_count;
    cursor.manifest_prefix_hash = prefix_hash.finish_hex();
    if changed {
        payload_artifact::delete_orphans(tx, source, source_session_id, generation)?;
        rebuild_turns(tx, source, source_session_id, generation)?;
    }
    finish_outcome(
        tx,
        source,
        source_session_id,
        generation,
        cursor,
        stats,
        changed,
        Vec::new(),
    )
}

#[allow(
    clippy::too_many_arguments,
    reason = "Replay adapter boundaries keep cursor, generation, and payload fields explicit"
)]
pub(super) fn fold_cursor_message(
    display_session_id: &str,
    source_session_id: &str,
    blob_id: &str,
    manifest_ordinal: u64,
    message: &Value,
    created_at: &str,
    source_conn: &Connection,
    cursor: &mut CursorCliReplayCursor,
) -> Result<Vec<EmittedChunk>, String> {
    let mut emitted = Vec::new();
    match message.get("role").and_then(Value::as_str) {
        Some("user") => {
            let text = cursor_message_text(message.get("content"));
            let Some(text) = clean_cursor_user_text(&text) else {
                return Ok(emitted);
            };
            if cursor.last_user_text.as_deref() == Some(text.as_str()) {
                return Ok(emitted);
            }
            cursor.last_user_text = Some(text.clone());
            cursor.cursor_turn_index = cursor.cursor_turn_index.saturating_add(1).max(0);
            let chunk = imported_history::user_message_chunk(
                display_session_id,
                CURSOR_PROVIDER,
                manifest_ordinal as usize,
                created_at,
                &text,
            );
            emitted.push(EmittedChunk {
                event_key: format!("message:{manifest_ordinal}:user"),
                turn_index: cursor.cursor_turn_index,
                chunk,
                locator: StructuredPayloadLocator::Cursor {
                    call_blob_id: blob_id.to_string(),
                    result_blob_id: None,
                    item_index: 0,
                    result_item_index: None,
                    event_kind: CursorEventKind::User,
                    segment_index: 0,
                },
            });
        }
        Some("assistant") => {
            for (item_index, item) in cursor_message_items(message.get("content")).enumerate() {
                match item.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        let text = item.get("text").and_then(Value::as_str).unwrap_or_default();
                        let (thoughts, visible) = split_think_blocks(text);
                        for (segment_index, thought) in thoughts.into_iter().enumerate() {
                            let chunk = imported_history::thinking_chunk(
                                display_session_id,
                                CURSOR_PROVIDER,
                                manifest_ordinal as usize,
                                created_at,
                                &thought,
                            );
                            emitted.push(EmittedChunk {
                                event_key: format!(
                                    "message:{manifest_ordinal}:item:{item_index}:thought:{segment_index}"
                                ),
                                turn_index: cursor.cursor_turn_index.max(0),
                                chunk,
                                locator: StructuredPayloadLocator::Cursor {
                                    call_blob_id: blob_id.to_string(),
                                    result_blob_id: None,
                                    item_index,
                                    result_item_index: None,
                                    event_kind: CursorEventKind::Thinking,
                                    segment_index,
                                },
                            });
                        }
                        let visible = visible.trim();
                        if !visible.is_empty() {
                            let chunk = imported_history::assistant_message_chunk(
                                display_session_id,
                                CURSOR_PROVIDER,
                                manifest_ordinal as usize,
                                created_at,
                                visible,
                            );
                            emitted.push(EmittedChunk {
                                event_key: format!(
                                    "message:{manifest_ordinal}:item:{item_index}:assistant"
                                ),
                                turn_index: cursor.cursor_turn_index.max(0),
                                chunk,
                                locator: StructuredPayloadLocator::Cursor {
                                    call_blob_id: blob_id.to_string(),
                                    result_blob_id: None,
                                    item_index,
                                    result_item_index: None,
                                    event_kind: CursorEventKind::AssistantVisible,
                                    segment_index: 0,
                                },
                            });
                        }
                    }
                    Some("tool-call") => {
                        let Some(call) = cursor_tool_call(item, created_at) else {
                            continue;
                        };
                        let event_id = stable_event_id(
                            ImportedHistorySourceId::CursorCli,
                            source_session_id,
                            &format!("call:{manifest_ordinal}:{}", call.call_id),
                        );
                        let chunk = imported_history::tool_call_chunk(
                            display_session_id,
                            CURSOR_PROVIDER,
                            manifest_ordinal as usize,
                            &call,
                            "",
                        );
                        emitted.push(EmittedChunk {
                            event_key: format!("call:{manifest_ordinal}:{}", call.call_id),
                            turn_index: cursor.cursor_turn_index.max(0),
                            chunk,
                            locator: StructuredPayloadLocator::Cursor {
                                call_blob_id: blob_id.to_string(),
                                result_blob_id: None,
                                item_index,
                                result_item_index: None,
                                event_kind: CursorEventKind::Tool,
                                segment_index: 0,
                            },
                        });
                        cursor.pending_cursor_calls.insert(
                            call.call_id.clone(),
                            PendingCursorCall {
                                call_blob_id: blob_id.to_string(),
                                item_index,
                                manifest_ordinal,
                                event_id,
                                turn_index: cursor.cursor_turn_index.max(0),
                            },
                        );
                    }
                    _ => {}
                }
            }
        }
        Some("tool") => {
            for (result_item_index, item) in
                cursor_message_items(message.get("content")).enumerate()
            {
                if item.get("type").and_then(Value::as_str) != Some("tool-result") {
                    continue;
                }
                let Some(call_id) = item.get("toolCallId").and_then(Value::as_str) else {
                    continue;
                };
                let Some(pending) = cursor.pending_cursor_calls.remove(call_id) else {
                    continue;
                };
                let Some(call_blob) = read_blob(source_conn, &pending.call_blob_id)? else {
                    continue;
                };
                let Ok(call_message) = serde_json::from_slice::<Value>(&call_blob) else {
                    continue;
                };
                let Some(call_item) =
                    cursor_message_items(call_message.get("content")).nth(pending.item_index)
                else {
                    continue;
                };
                let Some(call) = cursor_tool_call(call_item, created_at) else {
                    continue;
                };
                let output = cursor_tool_result_text(item.get("result"));
                let mut chunk = imported_history::tool_call_chunk(
                    display_session_id,
                    CURSOR_PROVIDER,
                    pending.manifest_ordinal as usize,
                    &call,
                    &output,
                );
                chunk.chunk_id = pending.event_id;
                emitted.push(EmittedChunk {
                    event_key: format!("call:{}:{call_id}", pending.manifest_ordinal),
                    turn_index: pending.turn_index,
                    chunk,
                    locator: StructuredPayloadLocator::Cursor {
                        call_blob_id: pending.call_blob_id,
                        result_blob_id: Some(blob_id.to_string()),
                        item_index: pending.item_index,
                        result_item_index: Some(result_item_index),
                        event_kind: CursorEventKind::Tool,
                        segment_index: 0,
                    },
                });
            }
        }
        _ => {}
    }
    Ok(emitted)
}

pub(super) fn reconstruct_cursor_chunk(
    conn: &Connection,
    event_id: &str,
    locator: &StructuredPayloadLocator,
) -> Result<ActivityChunk, String> {
    let StructuredPayloadLocator::Cursor {
        call_blob_id,
        result_blob_id,
        item_index,
        result_item_index,
        event_kind,
        segment_index,
    } = locator
    else {
        return Err("not a Cursor replay locator".to_string());
    };
    let data = read_blob(conn, call_blob_id)?
        .ok_or_else(|| "Cursor replay payload blob no longer exists".to_string())?;
    let message: Value = serde_json::from_slice(&data)
        .map_err(|err| format!("decode Cursor replay payload message: {err}"))?;
    let created_at = String::new();
    let mut chunk = match event_kind {
        CursorEventKind::User => {
            let text = clean_cursor_user_text(&cursor_message_text(message.get("content")))
                .unwrap_or_default();
            imported_history::user_message_chunk(
                "cursorcliapp-payload",
                CURSOR_PROVIDER,
                0,
                &created_at,
                &text,
            )
        }
        CursorEventKind::AssistantVisible | CursorEventKind::Thinking => {
            let item = cursor_message_items(message.get("content"))
                .nth(*item_index)
                .ok_or_else(|| "Cursor replay text item no longer exists".to_string())?;
            let text = item.get("text").and_then(Value::as_str).unwrap_or_default();
            let (thoughts, visible) = split_think_blocks(text);
            if matches!(event_kind, CursorEventKind::Thinking) {
                let thought = thoughts.get(*segment_index).cloned().unwrap_or_default();
                imported_history::thinking_chunk(
                    "cursorcliapp-payload",
                    CURSOR_PROVIDER,
                    0,
                    &created_at,
                    &thought,
                )
            } else {
                imported_history::assistant_message_chunk(
                    "cursorcliapp-payload",
                    CURSOR_PROVIDER,
                    0,
                    &created_at,
                    visible.trim(),
                )
            }
        }
        CursorEventKind::Tool => {
            let item = cursor_message_items(message.get("content"))
                .nth(*item_index)
                .ok_or_else(|| "Cursor replay tool call no longer exists".to_string())?;
            let call = cursor_tool_call(item, &created_at)
                .ok_or_else(|| "Cursor replay tool call is invalid".to_string())?;
            let output = match (result_blob_id, result_item_index) {
                (Some(result_blob_id), Some(result_item_index)) => {
                    let result_data = read_blob(conn, result_blob_id)?
                        .ok_or_else(|| "Cursor replay result blob no longer exists".to_string())?;
                    let result_message: Value = serde_json::from_slice(&result_data)
                        .map_err(|err| format!("decode Cursor replay result: {err}"))?;
                    let output = cursor_message_items(result_message.get("content"))
                        .nth(*result_item_index)
                        .map(|item| cursor_tool_result_text(item.get("result")))
                        .unwrap_or_default();
                    output
                }
                _ => String::new(),
            };
            imported_history::tool_call_chunk(
                "cursorcliapp-payload",
                CURSOR_PROVIDER,
                0,
                &call,
                &output,
            )
        }
    };
    chunk.chunk_id = event_id.to_string();
    Ok(chunk)
}

pub(super) fn validate_cursor_schema(conn: &Connection) -> Result<(), String> {
    conn.prepare("SELECT value FROM meta WHERE key='0' LIMIT 0")
        .and_then(|_| conn.prepare("SELECT id,data FROM blobs LIMIT 0"))
        .map(|_| ())
        .map_err(|err| format!("unsupported Cursor CLI replay schema: {err}"))
}

pub(super) fn read_cursor_meta(conn: &Connection) -> Result<CursorMeta, String> {
    let raw = conn
        .query_row("SELECT value FROM meta WHERE key='0'", [], |row| {
            row.get::<_, rusqlite::types::Value>(0)
        })
        .optional()
        .map_err(|err| format!("read Cursor CLI replay meta: {err}"))?
        .ok_or_else(|| "Cursor CLI replay meta is missing".to_string())?;
    let bytes = match raw {
        rusqlite::types::Value::Text(text) => text.into_bytes(),
        rusqlite::types::Value::Blob(bytes) => bytes,
        _ => return Err("Cursor CLI replay meta has unsupported type".to_string()),
    };
    let decoded = if bytes.first() == Some(&b'{') {
        bytes
    } else {
        hex_decode(std::str::from_utf8(&bytes).unwrap_or_default())
            .ok_or_else(|| "Cursor CLI replay meta is not valid hex JSON".to_string())?
    };
    serde_json::from_slice(&decoded).map_err(|err| format!("decode Cursor CLI replay meta: {err}"))
}

pub(super) fn read_blob(conn: &Connection, blob_id: &str) -> Result<Option<Vec<u8>>, String> {
    conn.query_row("SELECT data FROM blobs WHERE id=?1", [blob_id], |row| {
        row.get::<_, Vec<u8>>(0)
    })
    .optional()
    .map_err(|err| format!("read structured replay blob {blob_id}: {err}"))
}

pub(super) fn visit_manifest_message_ids(
    data: &[u8],
    mut visit: impl FnMut(&str) -> Result<(), String>,
) -> Result<(), String> {
    let mut offset = 0usize;
    while offset < data.len() {
        let (tag, next) = read_varint(data, offset)
            .ok_or_else(|| "Cursor CLI manifest has a truncated tag".to_string())?;
        offset = next;
        match tag & 7 {
            0 => {
                offset = read_varint(data, offset)
                    .ok_or_else(|| "Cursor CLI manifest has a truncated varint".to_string())?
                    .1;
            }
            1 => offset = offset.saturating_add(8),
            2 => {
                let (length, next) = read_varint(data, offset)
                    .ok_or_else(|| "Cursor CLI manifest has a truncated length".to_string())?;
                offset = next;
                let end = offset
                    .checked_add(length as usize)
                    .filter(|end| *end <= data.len())
                    .ok_or_else(|| "Cursor CLI manifest field exceeds root blob".to_string())?;
                if tag >> 3 == 1 && length == 32 {
                    let id = hex_encode(&data[offset..end]);
                    visit(&id)?;
                }
                offset = end;
            }
            5 => offset = offset.saturating_add(4),
            _ => return Err("Cursor CLI manifest uses an unsupported wire type".to_string()),
        }
        if offset > data.len() {
            return Err("Cursor CLI manifest is truncated".to_string());
        }
    }
    Ok(())
}

pub(super) fn manifest_prefix_hash(
    data: &[u8],
    prefix_count: u64,
) -> Result<(u64, String), String> {
    let mut count = 0_u64;
    let mut hash = Hash64::default();
    visit_manifest_message_ids(data, |id| {
        if count < prefix_count {
            hash.update(id.as_bytes());
        }
        count = count.saturating_add(1);
        Ok(())
    })?;
    Ok((count, hash.finish_hex()))
}

pub(super) fn read_varint(data: &[u8], mut offset: usize) -> Option<(u64, usize)> {
    let mut value = 0_u64;
    let mut shift = 0_u32;
    loop {
        let byte = *data.get(offset)?;
        offset += 1;
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Some((value, offset));
        }
        shift += 7;
        if shift >= 64 {
            return None;
        }
    }
}

pub(super) fn cursor_message_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .filter(|item| item.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|item| item.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

pub(super) fn cursor_message_items(content: Option<&Value>) -> impl Iterator<Item = &Value> {
    content.and_then(Value::as_array).into_iter().flatten()
}

pub(super) fn clean_cursor_user_text(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.starts_with("<user_info>") {
        return None;
    }
    let inner = if let Some(start) = trimmed.find("<user_query>") {
        let rest = &trimmed[start + "<user_query>".len()..];
        rest.split_once("</user_query>")
            .map_or(rest, |(inner, _)| inner)
    } else {
        trimmed
    };
    let mut clean = trim_cursor_edges(inner);
    if let Some(request) = clean.strip_prefix("USER REQUEST:") {
        let cut = [request.find("\n---"), request.find("\\n---")]
            .into_iter()
            .flatten()
            .min()
            .unwrap_or(request.len());
        clean = trim_cursor_edges(&request[..cut]);
    }
    (!clean.is_empty()).then(|| clean.to_string())
}

pub(super) fn trim_cursor_edges(mut text: &str) -> &str {
    loop {
        let before = text;
        text = text.trim();
        text = text.strip_prefix("\\n").unwrap_or(text);
        text = text.strip_suffix("\\n").unwrap_or(text);
        if before == text {
            return text;
        }
    }
}

pub(super) fn split_think_blocks(text: &str) -> (Vec<String>, String) {
    let mut thoughts = Vec::new();
    let mut visible = String::new();
    let mut rest = text;
    while let Some(start) = rest.find("<think>") {
        visible.push_str(&rest[..start]);
        let after = &rest[start + "<think>".len()..];
        if let Some(end) = after.find("</think>") {
            let thought = after[..end].trim();
            if !thought.is_empty() {
                thoughts.push(thought.to_string());
            }
            rest = &after[end + "</think>".len()..];
        } else {
            let thought = after.trim();
            if !thought.is_empty() {
                thoughts.push(thought.to_string());
            }
            rest = "";
        }
    }
    visible.push_str(rest);
    (thoughts, visible)
}

pub(super) fn cursor_tool_call(item: &Value, created_at: &str) -> Option<ImportedToolCall> {
    let call_id = item.get("toolCallId")?.as_str()?.to_string();
    let raw_name = item.get("toolName")?.as_str()?.to_string();
    let args = item.get("args").cloned().unwrap_or_else(|| json!({}));
    let (canonical_name, args) = normalize_cursor_tool(&raw_name, args);
    Some(ImportedToolCall {
        call_id,
        raw_name,
        canonical_name,
        args,
        created_at: created_at.to_string(),
    })
}

pub(super) fn normalize_cursor_tool(raw_name: &str, args: Value) -> (String, Value) {
    match raw_name {
        "shell" | "bash" | "run_terminal_cmd" => {
            let command = args
                .get("command")
                .and_then(Value::as_str)
                .or_else(|| args.get("cmd").and_then(Value::as_str))
                .unwrap_or_default();
            (
                imported_history::FUNCTION_RUN_COMMAND_LINE.to_string(),
                json!({"command":command,"cmd":command,"payload":args}),
            )
        }
        "search_replace" | "edit_file" | "write" | "write_file" | "create_file" | "multi_edit"
        | "MultiEdit" | "apply_patch" => {
            let file_path = args
                .get("file_path")
                .and_then(Value::as_str)
                .or_else(|| args.get("filePath").and_then(Value::as_str))
                .or_else(|| args.get("target_file").and_then(Value::as_str))
                .or_else(|| args.get("path").and_then(Value::as_str))
                .unwrap_or_default();
            (
                imported_history::FUNCTION_EDIT_FILE.to_string(),
                json!({"action":raw_name,"file_path":file_path,"payload":args}),
            )
        }
        _ => (raw_name.to_string(), args),
    }
}

pub(super) fn cursor_tool_result_text(result: Option<&Value>) -> String {
    match result {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | None => String::new(),
        Some(value) => value.to_string(),
    }
}

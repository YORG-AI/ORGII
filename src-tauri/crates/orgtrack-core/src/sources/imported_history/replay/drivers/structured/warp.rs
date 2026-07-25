use super::*;

pub(super) fn sync_warp(
    tx: &Transaction<'_>,
    display_session_id: &str,
    source_session_id: &str,
    source_path: &Path,
    generation: &str,
    write_revision: u64,
    previous_state: Option<&ReplayIndexState>,
) -> Result<StructuredSyncOutcome, String> {
    let source = ImportedHistorySourceId::Warp;
    let source_conn = open_source_db(source_path)?;
    validate_warp_schema(&source_conn)?;
    let schema_version = source_conn
        .query_row("PRAGMA schema_version", [], |row| row.get::<_, i64>(0))
        .map_err(|err| format!("read Warp schema version: {err}"))?;
    let summary = warp_summary(&source_conn, source_session_id, source_path)?;
    let previous_cursor = previous_state
        .map(|state| serde_json::from_str::<WarpReplayCursor>(&state.driver_cursor_json))
        .transpose()
        .map_err(|err| format!("decode Warp replay cursor: {err}"))?
        .filter(|cursor| cursor.driver == "warp")
        .unwrap_or_default();
    if previous_state.is_some()
        && previous_cursor.source_row_count == summary.row_count
        && previous_cursor.source_signal == summary.signal
    {
        return unchanged_outcome(tx, source, source_session_id, generation, previous_cursor);
    }

    tx.execute_batch(
        "CREATE TEMP TABLE IF NOT EXISTS imported_structured_seen_rows(
             source_key TEXT PRIMARY KEY
         ) WITHOUT ROWID;
         DELETE FROM imported_structured_seen_rows;",
    )
    .map_err(|err| format!("prepare Warp replay seen rows: {err}"))?;

    let mut stats = ReplayStats::default();
    let mut changed = false;
    let mut removed_event_ids = Vec::new();
    let mut stmt = source_conn
        .prepare(
            "SELECT CAST(id AS TEXT), COALESCE(task_id, CAST(id AS TEXT)), task
             FROM agent_tasks WHERE conversation_id=?1 ORDER BY id ASC",
        )
        .map_err(|err| format!("prepare Warp task replay stream: {err}"))?;
    let mut rows = stmt
        .query([source_session_id])
        .map_err(|err| format!("query Warp task replay stream: {err}"))?;
    while let Some(row) = rows
        .next()
        .map_err(|err| format!("stream Warp task replay row: {err}"))?
    {
        let row_id: String = row.get(0).map_err(|err| err.to_string())?;
        let task_id: String = row.get(1).map_err(|err| err.to_string())?;
        let blob: Vec<u8> = row.get(2).map_err(|err| err.to_string())?;
        tx.execute(
            "INSERT OR IGNORE INTO imported_structured_seen_rows(source_key) VALUES (?1)",
            [&row_id],
        )
        .map_err(|err| format!("mark Warp replay row seen: {err}"))?;
        let content_hash = content_digest(&[task_id.as_bytes(), &blob]);
        let previous_hash = tx
            .query_row(
                "SELECT content_hash FROM imported_replay_structured_rows
                 WHERE source=?1 AND source_session_id=?2 AND generation=?3 AND source_key=?4",
                params![source.as_str(), source_session_id, generation, row_id],
                |db_row| db_row.get::<_, String>(0),
            )
            .optional()
            .map_err(|err| format!("read Warp replay row hash: {err}"))?;
        if previous_hash.as_deref() == Some(content_hash.as_str()) {
            continue;
        }

        stats.parsed_rows = stats.parsed_rows.saturating_add(1);
        stats.parsed_bytes = stats.parsed_bytes.saturating_add(blob.len() as u64);
        let chunks = normalize_warp_task(display_session_id, &blob, summary.fallback_ms)?;
        let upserts_before = stats.upserted_events;
        let removals_before = removed_event_ids.len();
        reconcile_structured_row(
            tx,
            source,
            source_session_id,
            generation,
            write_revision,
            &row_id,
            &task_id,
            chunks,
            summary.fallback_ms,
            &mut stats,
            &mut removed_event_ids,
        )?;
        tx.execute(
            "INSERT INTO imported_replay_structured_rows(
                 source,source_session_id,generation,source_key,content_hash,seen_revision
             ) VALUES (?1,?2,?3,?4,?5,?6)
             ON CONFLICT(source,source_session_id,generation,source_key) DO UPDATE SET
                 content_hash=excluded.content_hash,seen_revision=excluded.seen_revision",
            params![
                source.as_str(),
                source_session_id,
                generation,
                row_id,
                content_hash,
                write_revision.min(i64::MAX as u64) as i64
            ],
        )
        .map_err(|err| format!("publish Warp replay row hash: {err}"))?;
        changed |=
            stats.upserted_events > upserts_before || removed_event_ids.len() > removals_before;
    }

    let deleted = remove_missing_structured_rows(
        tx,
        source,
        source_session_id,
        generation,
        &mut removed_event_ids,
    )?;
    changed |= deleted;
    if changed {
        payload_artifact::delete_orphans(tx, source, source_session_id, generation)?;
        rebuild_turns(tx, source, source_session_id, generation)?;
    }
    stats.removed_events = removed_event_ids.len() as u64;
    let cursor = WarpReplayCursor {
        schema_version,
        driver: "warp".to_string(),
        source_row_count: summary.row_count,
        source_signal: summary.signal,
        ..WarpReplayCursor::default()
    };
    finish_outcome(
        tx,
        source,
        source_session_id,
        generation,
        cursor,
        stats,
        changed,
        removed_event_ids,
    )
}

pub(super) fn warp_summary(
    conn: &Connection,
    source_session_id: &str,
    source_path: &Path,
) -> Result<WarpSummary, String> {
    let (row_count, total_bytes, max_id, max_modified) = conn
        .query_row(
            "SELECT COUNT(*), COALESCE(SUM(LENGTH(task)),0),
                    COALESCE(MAX(id),0), COALESCE(MAX(CAST(last_modified_at AS TEXT)),'')
             FROM agent_tasks WHERE conversation_id=?1",
            [source_session_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?.max(0) as u64,
                    row.get::<_, i64>(1)?.max(0),
                    row.get::<_, i64>(2)?.max(0),
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .map_err(|err| format!("summarize Warp task rows: {err}"))?;
    let conversation_modified = conn
        .query_row(
            "SELECT COALESCE(CAST(last_modified_at AS TEXT),'') FROM agent_conversations
             WHERE conversation_id=?1",
            [source_session_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|err| format!("read Warp conversation watermark: {err}"))?
        .unwrap_or_default();
    let fallback_ms = parse_warp_timestamp_ms(&conversation_modified).unwrap_or_default();
    let physical_signal = sqlite_physical_signal(source_path)?;
    Ok(WarpSummary {
        row_count,
        signal: format!(
            "{row_count}:{total_bytes}:{max_id}:{max_modified}:{conversation_modified}:{physical_signal}"
        ),
        fallback_ms,
    })
}

pub(super) fn sqlite_physical_signal(path: &Path) -> Result<String, String> {
    let mut hash = ContentDigest::default();
    for candidate in [
        path.to_path_buf(),
        std::path::PathBuf::from(format!("{}-wal", path.to_string_lossy())),
    ] {
        hash.update_part(candidate.to_string_lossy().as_bytes());
        match std::fs::metadata(&candidate) {
            Ok(metadata) => {
                hash.update_part(&metadata.len().to_le_bytes());
                let modified = metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|duration| {
                        duration.as_secs() as i64 * 1_000_000_000 + duration.subsec_nanos() as i64
                    })
                    .unwrap_or_default();
                hash.update_part(&modified.to_le_bytes());
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                hash.update_part(b"missing")
            }
            Err(error) => {
                return Err(format!(
                    "stat Warp replay source {}: {error}",
                    candidate.display()
                ));
            }
        }
    }
    Ok(hash.finish_hex())
}

pub(super) fn normalize_warp_task(
    session_id: &str,
    blob: &[u8],
    fallback_ms: i64,
) -> Result<Vec<ActivityChunk>, String> {
    let task = decode_warp_task(blob)?;
    let fallback_created_at = imported_history::epoch_ms_to_iso(fallback_ms);
    let messages = field(&task, &["messages"])
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let mut tool_results = HashMap::new();
    for message in messages {
        let Some(result) = field(message, &["toolCallResult", "tool_call_result"]) else {
            continue;
        };
        if let Some(call_id) = field_str(result, &["toolCallId", "tool_call_id"]) {
            tool_results.insert(call_id.to_string(), result);
        }
    }
    let mut chunks = Vec::new();
    for (ordinal, message) in messages.iter().enumerate() {
        let created_at = field(message, &["timestamp"])
            .and_then(timestamp_value_to_iso)
            .unwrap_or_else(|| fallback_created_at.clone());
        if let Some(user_query) = field(message, &["userQuery", "user_query"]) {
            if let Some(query) =
                field_str(user_query, &["query"]).filter(|text| !text.trim().is_empty())
            {
                chunks.push(imported_history::user_message_chunk(
                    session_id,
                    WARP_PROVIDER,
                    ordinal,
                    &created_at,
                    query.trim(),
                ));
            }
            continue;
        }
        if let Some(agent_output) = field(message, &["agentOutput", "agent_output"]) {
            if let Some(text) =
                field_str(agent_output, &["text"]).filter(|text| !text.trim().is_empty())
            {
                chunks.push(imported_history::assistant_message_chunk(
                    session_id,
                    WARP_PROVIDER,
                    ordinal,
                    &created_at,
                    text.trim(),
                ));
            }
            continue;
        }
        if let Some(reasoning) = field(message, &["agentReasoning", "agent_reasoning"]) {
            if let Some(text) =
                field_str(reasoning, &["reasoning"]).filter(|text| !text.trim().is_empty())
            {
                chunks.push(imported_history::thinking_chunk(
                    session_id,
                    WARP_PROVIDER,
                    ordinal,
                    &created_at,
                    text.trim(),
                ));
            }
            continue;
        }
        let Some(tool_call) = field(message, &["toolCall", "tool_call"]) else {
            continue;
        };
        let Some((raw_name, payload)) = warp_tool_variant(tool_call) else {
            continue;
        };
        let call_id = field_str(tool_call, &["toolCallId", "tool_call_id"])
            .filter(|id| !id.trim().is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("warp-{ordinal}"));
        let (canonical_name, args) = normalize_warp_tool_call(raw_name, payload.clone());
        let output = tool_results
            .get(&call_id)
            .map(|result| warp_tool_result_text(result))
            .unwrap_or_default();
        let call = ImportedToolCall {
            call_id,
            raw_name: camel_to_snake(raw_name),
            canonical_name,
            args,
            created_at: created_at.clone(),
        };
        chunks.push(imported_history::tool_call_chunk(
            session_id,
            WARP_PROVIDER,
            ordinal,
            &call,
            &output,
        ));
    }
    Ok(chunks)
}

pub(super) fn decode_warp_task(blob: &[u8]) -> Result<Value, String> {
    let pool = WARP_DESCRIPTOR_POOL.as_ref().map_err(Clone::clone)?;
    let descriptor = pool
        .get_message_by_name(WARP_TASK_PROTO_NAME)
        .ok_or_else(|| format!("missing Warp descriptor {WARP_TASK_PROTO_NAME}"))?;
    let message = DynamicMessage::decode(descriptor, blob)
        .map_err(|err| format!("decode Warp task protobuf: {err}"))?;
    serde_json::to_value(message).map_err(|err| format!("project Warp task JSON: {err}"))
}

pub(super) fn validate_warp_schema(conn: &Connection) -> Result<(), String> {
    conn.prepare(
        "SELECT id,task_id,task,last_modified_at FROM agent_tasks
         WHERE conversation_id='' LIMIT 0",
    )
    .and_then(|_| {
        conn.prepare("SELECT conversation_id,last_modified_at FROM agent_conversations LIMIT 0")
    })
    .map(|_| ())
    .map_err(|err| format!("unsupported Warp replay schema: {err}"))
}

pub(super) fn warp_tool_variant(tool_call: &Value) -> Option<(&str, &Value)> {
    tool_call.as_object()?.iter().find_map(|(key, value)| {
        (!matches!(key.as_str(), "toolCallId" | "tool_call_id")).then_some((key.as_str(), value))
    })
}

pub(super) fn normalize_warp_tool_call(raw_name: &str, payload: Value) -> (String, Value) {
    match raw_name {
        "runShellCommand" | "run_shell_command" => {
            let command = field_str(&payload, &["command"]).unwrap_or_default();
            (
                imported_history::FUNCTION_RUN_COMMAND_LINE.to_string(),
                json!({"command":command,"cmd":command,"payload":payload}),
            )
        }
        "readFiles" | "read_files" => (imported_history::FUNCTION_READ_FILE.to_string(), payload),
        "applyFileDiffs" | "apply_file_diffs" | "editDocuments" | "edit_documents"
        | "createDocuments" | "create_documents" => {
            let file_path = first_warp_edited_file_path(&payload).unwrap_or_default();
            (
                imported_history::FUNCTION_EDIT_FILE.to_string(),
                json!({
                    "action":camel_to_snake(raw_name),
                    "file_path":file_path,
                    "payload":payload,
                }),
            )
        }
        "grep" | "searchCodebase" | "search_codebase" => {
            (imported_history::FUNCTION_CODE_SEARCH.to_string(), payload)
        }
        "fileGlob" | "file_glob" | "fileGlobV2" | "file_glob_v2" => (
            imported_history::FUNCTION_GLOB_FILE_SEARCH.to_string(),
            payload,
        ),
        _ => (camel_to_snake(raw_name), payload),
    }
}

pub(super) fn first_warp_edited_file_path(payload: &Value) -> Option<String> {
    [
        "diffs",
        "newFiles",
        "new_files",
        "deletedFiles",
        "deleted_files",
        "v4aUpdates",
        "v4a_updates",
    ]
    .iter()
    .find_map(|key| {
        field(payload, &[*key])
            .and_then(Value::as_array)
            .and_then(|rows| rows.first())
            .and_then(|row| field_str(row, &["filePath", "file_path", "documentId", "document_id"]))
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .map(str::to_string)
    })
}

pub(super) fn warp_tool_result_text(result: &Value) -> String {
    let payload = result
        .as_object()
        .and_then(|object| {
            object.iter().find_map(|(key, value)| {
                (!matches!(key.as_str(), "toolCallId" | "tool_call_id")).then_some(value)
            })
        })
        .unwrap_or(result);
    if let Some(output) = find_warp_output_text(payload) {
        return output.to_string();
    }
    serde_json::to_string(payload).unwrap_or_default()
}

pub(super) fn find_warp_output_text(value: &Value) -> Option<&str> {
    let object = value.as_object()?;
    for key in [
        "output",
        "stdout",
        "interleavedOutput",
        "interleaved_output",
    ] {
        if let Some(output) = object.get(key).and_then(Value::as_str) {
            return Some(output);
        }
    }
    object.values().find_map(find_warp_output_text)
}

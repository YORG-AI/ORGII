//! Transcript conversion: walking the manifest's message blobs into canonical
//! `ActivityChunk`s, unwrapping `<user_query>`/`<think>` scaffolding, and
//! normalizing cursor-agent tool calls onto ORGII's canonical functions.

use super::*;

pub(super) fn load_history_from_store_conn(
    store_conn: &Connection,
    session_id: &str,
) -> Result<Vec<ActivityChunk>, String> {
    let Some(store_meta) = read_store_meta(store_conn)? else {
        return Ok(Vec::new());
    };
    let Some(manifest) = read_store_manifest(store_conn, &store_meta.latest_root_blob_id)? else {
        return Ok(Vec::new());
    };
    // The store carries no per-message timestamps; every chunk gets the
    // session's creation time and ordering comes from the manifest.
    let created_at = imported_history::epoch_ms_to_iso(store_meta.created_at);

    let mut chunks = Vec::new();
    let mut sequence = 0usize;
    let mut pending_tool_calls: HashMap<String, ImportedToolCall> = HashMap::new();
    let mut last_user_text: Option<String> = None;

    for blob_id in &manifest.message_blob_ids {
        let Some(data) = read_blob(store_conn, blob_id)? else {
            continue;
        };
        let Ok(message) = serde_json::from_slice::<Value>(&data) else {
            continue;
        };
        match message.get("role").and_then(Value::as_str) {
            Some("user") => {
                let text = message_content_text(message.get("content"));
                let Some(text) = clean_user_text(&text) else {
                    continue;
                };
                // The agent loop re-injects the pending query around tool
                // calls; content-addressing makes those repeats byte-identical,
                // so collapse consecutive duplicates into one bubble.
                if last_user_text.as_deref() == Some(text.as_str()) {
                    continue;
                }
                last_user_text = Some(text.clone());
                chunks.push(imported_history::user_message_chunk(
                    session_id,
                    CURSOR_CLI_PROVIDER_SLUG,
                    sequence,
                    &created_at,
                    &text,
                ));
                sequence += 1;
            }
            Some("assistant") => {
                for item in message_content_items(message.get("content")) {
                    match item.get("type").and_then(Value::as_str) {
                        Some("text") => {
                            let text = item.get("text").and_then(Value::as_str).unwrap_or_default();
                            let (thoughts, visible) = split_think_blocks(text);
                            for thought in thoughts {
                                chunks.push(imported_history::thinking_chunk(
                                    session_id,
                                    CURSOR_CLI_PROVIDER_SLUG,
                                    sequence,
                                    &created_at,
                                    &thought,
                                ));
                                sequence += 1;
                            }
                            let visible = visible.trim();
                            if !visible.is_empty() {
                                chunks.push(imported_history::assistant_message_chunk(
                                    session_id,
                                    CURSOR_CLI_PROVIDER_SLUG,
                                    sequence,
                                    &created_at,
                                    visible,
                                ));
                                sequence += 1;
                            }
                        }
                        Some("tool-call") => {
                            if let Some(call) = tool_call_from_item(item, &created_at) {
                                pending_tool_calls.insert(call.call_id.clone(), call);
                            }
                        }
                        _ => {}
                    }
                }
            }
            Some("tool") => {
                for item in message_content_items(message.get("content")) {
                    if item.get("type").and_then(Value::as_str) != Some("tool-result") {
                        continue;
                    }
                    let Some(call_id) = item.get("toolCallId").and_then(Value::as_str) else {
                        continue;
                    };
                    let Some(call) = pending_tool_calls.remove(call_id) else {
                        continue;
                    };
                    let output = tool_result_output_text(item.get("result"));
                    chunks.push(imported_history::tool_call_chunk(
                        session_id,
                        CURSOR_CLI_PROVIDER_SLUG,
                        sequence,
                        &call,
                        &output,
                    ));
                    sequence += 1;
                }
            }
            _ => {}
        }
    }

    // In-flight calls at the tail of an interrupted session: still show them.
    for call in pending_tool_calls.into_values() {
        chunks.push(imported_history::tool_call_chunk(
            session_id,
            CURSOR_CLI_PROVIDER_SLUG,
            sequence,
            &call,
            "",
        ));
        sequence += 1;
    }

    Ok(chunks)
}

pub(super) fn scan_manifest_catalog(
    store_conn: &Connection,
    session_id: &str,
    manifest: &CursorStoreManifest,
    created_at_ms: i64,
) -> Result<(Option<String>, ImportedHistoryImpactStats), String> {
    let created_at = imported_history::epoch_ms_to_iso(created_at_ms);
    let mut first_prompt = None;
    let mut touched_files = std::collections::BTreeSet::new();
    let mut impact = ImportedHistoryImpactStats::default();
    for blob_id in &manifest.message_blob_ids {
        let Some(data) = read_catalog_blob(store_conn, blob_id)? else {
            continue;
        };
        let Ok(message) = serde_json::from_slice::<Value>(&data) else {
            continue;
        };
        match message.get("role").and_then(Value::as_str) {
            Some("user") if first_prompt.is_none() => {
                first_prompt = clean_user_text(&message_content_text(message.get("content")));
            }
            Some("assistant") => {
                for item in message_content_items(message.get("content")) {
                    if item.get("type").and_then(Value::as_str) != Some("tool-call") {
                        continue;
                    }
                    let Some(call) = tool_call_from_item(item, &created_at) else {
                        continue;
                    };
                    if call.canonical_name != imported_history::FUNCTION_EDIT_FILE {
                        continue;
                    }
                    let chunk = imported_history::tool_call_chunk(
                        session_id,
                        CURSOR_CLI_PROVIDER_SLUG,
                        0,
                        &call,
                        "",
                    );
                    let one = imported_history::impact_from_edit_chunks(&[chunk]);
                    impact.lines_added = impact.lines_added.saturating_add(one.lines_added);
                    impact.lines_removed = impact.lines_removed.saturating_add(one.lines_removed);
                    touched_files.extend(one.touched_files);
                }
            }
            _ => {}
        }
    }
    impact.touched_files = touched_files.into_iter().collect();
    impact.files_changed = impact.touched_files.len() as i64;
    Ok((first_prompt, impact))
}

fn message_content_text(content: Option<&Value>) -> String {
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

fn message_content_items(content: Option<&Value>) -> Vec<&Value> {
    match content {
        Some(Value::Array(items)) => items.iter().collect(),
        _ => Vec::new(),
    }
}

/// Recover the user-authored text from a `role: "user"` message.
///
/// Real turns are wrapped in `<user_query>…</user_query>`; everything else on
/// the user role (`<user_info>` environment header, attached-file context) is
/// injected scaffolding and yields `None`. Inside the wrapper, the
/// element-picker form (`USER REQUEST:` … `--- Model: …` / `SELECTED
/// COMPONENT` / DOM dump) is cut down to the request itself.
pub(super) fn clean_user_text(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let inner = match trimmed.find("<user_query>") {
        Some(start) => {
            let rest = &trimmed[start + "<user_query>".len()..];
            match rest.find("</user_query>") {
                Some(end) => &rest[..end],
                None => rest,
            }
        }
        None => {
            if trimmed.starts_with("<user_info>") {
                return None;
            }
            // Unwrapped user text: keep verbatim so a future format change
            // degrades to showing the raw prompt instead of dropping it.
            trimmed
        }
    };
    let cleaned = strip_user_query_scaffold(inner);
    (!cleaned.is_empty()).then(|| cleaned.to_string())
}

fn strip_user_query_scaffold(inner: &str) -> &str {
    let text = trim_wrapper_edges(inner);
    let Some(request) = text.strip_prefix("USER REQUEST:") else {
        return text;
    };
    // The injected context after the request starts at a `---` separator.
    // Some builds serialize the wrapper with literal `\n` two-character
    // sequences instead of newlines, so both separator spellings count.
    let request = match [request.find("\n---"), request.find("\\n---")]
        .into_iter()
        .flatten()
        .min()
    {
        Some(cut) => &request[..cut],
        None => request,
    };
    trim_wrapper_edges(request)
}

/// Trim whitespace and literal `\n` two-character sequences from both edges.
fn trim_wrapper_edges(mut text: &str) -> &str {
    loop {
        let before = text;
        text = text.trim();
        text = text.strip_prefix("\\n").unwrap_or(text);
        text = text.strip_suffix("\\n").unwrap_or(text);
        if text == before {
            return text;
        }
    }
}

/// Split inline `<think>…</think>` blocks out of assistant text. Returns the
/// extracted thoughts (in order) and the remaining visible text. An unclosed
/// block swallows the rest of the text as thought.
pub(super) fn split_think_blocks(text: &str) -> (Vec<String>, String) {
    let mut thoughts = Vec::new();
    let mut visible = String::new();
    let mut rest = text;
    while let Some(start) = rest.find("<think>") {
        visible.push_str(&rest[..start]);
        let after = &rest[start + "<think>".len()..];
        match after.find("</think>") {
            Some(end) => {
                thoughts.push(after[..end].trim().to_string());
                rest = &after[end + "</think>".len()..];
            }
            None => {
                thoughts.push(after.trim().to_string());
                rest = "";
            }
        }
    }
    visible.push_str(rest);
    thoughts.retain(|thought| !thought.is_empty());
    (thoughts, visible)
}

fn tool_call_from_item(item: &Value, created_at: &str) -> Option<ImportedToolCall> {
    let call_id = item.get("toolCallId")?.as_str()?.to_string();
    let raw_name = item.get("toolName")?.as_str()?.to_string();
    let args = item.get("args").cloned().unwrap_or_else(|| json!({}));
    let (canonical_name, args) = normalize_cursor_tool_call(&raw_name, args);
    Some(ImportedToolCall {
        call_id,
        raw_name,
        canonical_name,
        args,
        created_at: created_at.to_string(),
    })
}

fn tool_result_output_text(result: Option<&Value>) -> String {
    match result {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

/// Map cursor-agent tool names onto ORGII's canonical functions. Observed
/// names: `read_file`, `grep`, `glob_file_search` (already canonical),
/// `search_replace` (edit), plus the shell/write family.
fn normalize_cursor_tool_call(raw_name: &str, args: Value) -> (String, Value) {
    match raw_name {
        "shell" | "bash" | "run_terminal_cmd" => (
            imported_history::FUNCTION_RUN_COMMAND_LINE.to_string(),
            normalize_shell_args(args),
        ),
        "search_replace" | "edit_file" | "write" | "write_file" | "create_file" | "multi_edit"
        | "MultiEdit" | "apply_patch" => (
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
        .get("file_path")
        .and_then(Value::as_str)
        .or_else(|| args.get("filePath").and_then(Value::as_str))
        .or_else(|| args.get("target_file").and_then(Value::as_str))
        .or_else(|| args.get("path").and_then(Value::as_str))
        .unwrap_or_default();
    // `payload` keeps old_string/new_string so the shared impact collector
    // can count the changed lines.
    json!({
        "action": raw_name,
        "file_path": file_path,
        "payload": args,
    })
}

pub(super) fn cursor_cli_source_id_from_session_id(session_id: &str) -> Result<&str, String> {
    let Some(source_session_id) = session_id.strip_prefix(CURSOR_CLI_SESSION_PREFIX) else {
        return Err(format!("Invalid Cursor CLI session id: {session_id}"));
    };
    if source_session_id.trim().is_empty() {
        return Err("Cursor CLI session id is missing source id".to_string());
    }
    Ok(source_session_id)
}

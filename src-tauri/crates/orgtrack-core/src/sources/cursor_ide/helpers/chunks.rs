//! Bubble → ActivityChunk normalization and per-canonical field mapping.

use super::*;

// ============================================================================
// Bubble → ActivityChunk normalization
// ============================================================================

pub(in crate::sources::cursor_ide) fn bubbles_to_chunks(
    conn: &Connection,
    session_id: &str,
    bubbles: &[OrderedBubble],
    composer_context: &CursorComposerContext,
) -> Vec<ActivityChunk> {
    let mut chunks = Vec::with_capacity(bubbles.len());

    for ob in bubbles {
        // Prefer the bubble's own `type`, fall back to the header's `type`
        // (the header is what `composerData.fullConversationHeadersOnly`
        // exposes — used as a backstop when the bubble blob is malformed).
        let bubble_type = if ob.raw.bubble_type != 0 {
            ob.raw.bubble_type
        } else {
            ob.bubble_type
        };

        match bubble_type {
            CURSOR_BUBBLE_TYPE_USER => {
                if let Some(subagent_info) = composer_context.subagent_info.as_ref() {
                    if let Some(chunk) =
                        cursor_subagent_prompt_bubble_to_chunk(session_id, ob, subagent_info)
                    {
                        chunks.push(chunk);
                    }
                } else if let Some(chunk) = user_bubble_to_chunk(session_id, ob) {
                    chunks.push(chunk);
                }
            }
            CURSOR_BUBBLE_TYPE_ASSISTANT => {
                if let Some(tool_chunk) = assistant_tool_bubble_to_chunk(conn, session_id, ob) {
                    chunks.push(tool_chunk);
                } else if let Some(text_chunk) = assistant_text_bubble_to_chunk(session_id, ob) {
                    chunks.push(text_chunk);
                }
                // Empty assistant bookkeeping bubbles are silently dropped.
            }
            _ => {
                // Unknown bubble type — skip rather than guess.
            }
        }
    }

    chunks
}

pub(in crate::sources::cursor_ide) fn cursor_subagent_prompt_bubble_to_chunk(
    session_id: &str,
    ob: &OrderedBubble,
    subagent_info: &RawCursorSubagentInfo,
) -> Option<ActivityChunk> {
    let prompt = ob.raw.text.trim();
    if prompt.is_empty() {
        return None;
    }

    let description = prompt.lines().next().unwrap_or("Cursor subagent").trim();
    let mut chunk = ActivityChunk::new(session_id, "tool_call", "subagent");
    chunk.chunk_id = format!("cursoride-subagent-prompt-{}", ob.bubble_id);
    chunk.created_at = normalize_created_at(&ob.raw.created_at);
    chunk.args = json!({
        "description": description,
        "prompt": prompt,
        "subagent_type": subagent_info.subagent_type_name.as_str(),
        "parentComposerId": subagent_info.parent_composer_id.as_str(),
        "cursorToolCallId": subagent_info.tool_call_id.as_str(),
    });
    chunk.result = json!({
        "success": true,
        "status": "completed",
        "call_id": subagent_info.tool_call_id.as_str(),
    });
    Some(chunk)
}

pub(in crate::sources::cursor_ide) fn user_bubble_to_chunk(
    session_id: &str,
    ob: &OrderedBubble,
) -> Option<ActivityChunk> {
    let text = ob.raw.text.trim();
    let content = if text.is_empty() {
        "User message not loaded."
    } else {
        text
    };
    let mut chunk = ActivityChunk::new(session_id, "raw", "user_message");
    chunk.chunk_id = format!("cursoride-user-{}", ob.bubble_id);
    chunk.created_at = normalize_created_at(&ob.raw.created_at);
    chunk.result = json!({
        "type": "user",
        "message": { "content": content, "role": "user" },
    });
    Some(chunk)
}

pub(in crate::sources::cursor_ide) fn assistant_text_bubble_to_chunk(
    session_id: &str,
    ob: &OrderedBubble,
) -> Option<ActivityChunk> {
    let text = ob.raw.text.trim();
    if text.is_empty() {
        return None;
    }
    let mut chunk = ActivityChunk::new(session_id, "assistant", "assistant");
    chunk.chunk_id = format!("cursoride-asst-{}", ob.bubble_id);
    chunk.created_at = normalize_created_at(&ob.raw.created_at);
    chunk.result = json!({
        "observation": text,
        "content": text,
        "role": "assistant",
        "is_delta": false,
        "is_full_content": true,
    });
    Some(chunk)
}

pub(in crate::sources::cursor_ide) fn assistant_tool_bubble_to_chunk(
    conn: &Connection,
    session_id: &str,
    ob: &OrderedBubble,
) -> Option<ActivityChunk> {
    let tfd = ob.raw.tool_former_data.as_ref()?;
    if tfd.name.is_empty() {
        return None;
    }

    let canonical = cursor_tool_name_to_canonical(&tfd.name);

    let mut args = parse_inner_json(&tfd.params);
    let mut result_payload = parse_inner_json(&tfd.result);
    merge_cursor_additional_data(&mut result_payload, &tfd.additional_data);

    // Translate Cursor's per-tool field names into the canonical names our
    // frontend extractors expect so existing chat blocks render Cursor history
    // identically to CLI agent output.
    normalize_args_for_canonical(canonical, &tfd.name, &mut args);
    normalize_result_for_canonical(conn, canonical, &tfd.name, &mut result_payload);
    // Cross-field rewrites that need both args and result in scope.
    link_subagent_session(canonical, &mut args, &mut result_payload);
    resolve_ask_question_answers(canonical, &args, &mut result_payload);

    let mut chunk = ActivityChunk::new(session_id, "tool_call", canonical);
    chunk.chunk_id = format!("cursoride-tool-{}", ob.bubble_id);
    chunk.created_at = normalize_created_at(&ob.raw.created_at);
    chunk.args = args;
    chunk.result = enrich_tool_result(result_payload, tfd);

    Some(chunk)
}

// ============================================================================
// Per-canonical field normalization
//
// Cursor IDE keeps each tool's own field names (`targetFile`, `globPattern`,
// `relativeWorkspacePath`, `finalTodos`, …). Our frontend extractors expect
// canonical names (`target_file`, `pattern`, `file_path`, `todos`, …). We
// translate at parse time — once, here — instead of in every extractor.
// ============================================================================

fn normalize_args_for_canonical(canonical: &str, cursor_name: &str, args: &mut Value) {
    let obj = match args.as_object_mut() {
        Some(map) => map,
        None => return,
    };
    match canonical {
        // read_file_v2 → read_file: `targetFile` is the absolute path; copy
        // it onto `target_file` so `extractFileData` finds it.
        "read_file" => {
            move_string_field(obj, "targetFile", "target_file");
            move_string_field(obj, "effectiveUri", "file_path");
        }
        // edit_file_v2 / delete_file: Cursor ships only the path here; the
        // diff lives in the result. Copy the path onto `file_path`.
        "edit_file_by_replace" | "delete_file" => {
            move_string_field(obj, "relativeWorkspacePath", "file_path");
        }
        // glob_file_search: Cursor uses `globPattern`; GlobAdapter reads
        // `pattern` / `glob`.
        "glob_file_search" => {
            move_string_field(obj, "globPattern", "pattern");
            move_string_field(obj, "targetDirectory", "path");
        }
        "run_command_line" => {
            move_string_field(obj, "commandDescription", "description");
        }
        // web_fetch is renamed to web_search but keeps Cursor's `url` field.
        // `WebSearchAdapter` reads `query` only — surface the URL there too
        // so the card shows something meaningful.
        "web_search" if cursor_name == "web_fetch" => {
            if let Some(Value::String(url)) = obj.get("url").cloned() {
                obj.entry("query".to_string()).or_insert(Value::String(url));
            }
        }
        _ => {}
    }
}

fn normalize_result_for_canonical(
    conn: &Connection,
    canonical: &str,
    _cursor_name: &str,
    result: &mut Value,
) {
    let obj = match result.as_object_mut() {
        Some(map) => map,
        None => return,
    };
    match canonical {
        // Cursor returns the whole file body under `contents`; our file
        // extractor reads `result.content` / `output`.
        "read_file" => {
            move_string_field(obj, "contents", "content");
        }
        // edit_file_v2 result is `{beforeContentId, afterContentId}` where
        // each id is a `composer.content.{hash}` SQLite key holding the raw
        // file body. Resolve both blobs and derive the actual touched lines.
        "edit_file_by_replace" => {
            let old_content = obj
                .get("beforeContentId")
                .and_then(|v| v.as_str())
                .and_then(|before_id| load_content_blob(conn, before_id));
            let new_content = obj
                .get("afterContentId")
                .and_then(|v| v.as_str())
                .and_then(|after_id| load_content_blob(conn, after_id));

            if let Some(text) = old_content.as_ref() {
                obj.insert("old_content".to_string(), Value::String(text.clone()));
            }
            if let Some(text) = new_content.as_ref() {
                obj.insert("new_content".to_string(), Value::String(text.clone()));
            }
            if let (Some(old_text), Some(new_text)) = (old_content.as_ref(), new_content.as_ref()) {
                let diff = build_cursor_edit_diff(old_text, new_text);
                obj.insert("linesAdded".to_string(), json!(diff.lines_added));
                obj.insert("linesRemoved".to_string(), json!(diff.lines_removed));
                if !diff.diff_string.is_empty() {
                    obj.insert("diffString".to_string(), Value::String(diff.diff_string));
                }
            }
        }
        // todo_write result puts the list under `finalTodos`; our extractor
        // reads `result.todos` (or `success.todos`).
        "manage_todo" => {
            if let Some(todos) = obj.remove("finalTodos") {
                obj.insert("todos".to_string(), todos);
            }
        }
        // task_v2 result is `{agentId: "<uuid>"}`. The `agentId` itself is
        // lifted onto `args.subagentSessionId` by `link_subagent_session`
        // so the Rust subagent extractor and the frontend `SubagentBlock` can
        // replay the child composer's events.
        "subagent" => {
            obj.entry("success".to_string())
                .or_insert(Value::Bool(true));
        }
        _ => {}
    }
}

/// Cross-field linkage step that runs after both args and result have been
/// normalized for the canonical tool. The only consumer today is `subagent`:
/// Cursor returns the spawned child composer's id under `result.agentId`,
/// but our subagent extractor reads `args.subagentSessionId`. We move-and-rename
/// the field here, prefixing it with `cursoride-` so the id is usable as a
/// top-level session id by the frontend EventStore lazy loader.
fn link_subagent_session(canonical: &str, args: &mut Value, result: &mut Value) {
    if canonical != "subagent" {
        return;
    }
    let result_obj = match result.as_object_mut() {
        Some(map) => map,
        None => return,
    };
    let agent_id = match result_obj.remove("agentId") {
        Some(Value::String(value)) if !value.is_empty() => value,
        Some(other) => {
            // Not a string we can prefix — keep the original value on the
            // result so we don't silently drop data we don't understand.
            result_obj.insert("agentId".to_string(), other);
            return;
        }
        None => return,
    };
    let prefixed = format!("{}{}", CURSORIDE_SESSION_PREFIX, agent_id);
    if let Some(args_obj) = args.as_object_mut() {
        args_obj
            .entry("subagentSessionId".to_string())
            .or_insert(Value::String(prefixed));
    }
}

/// Translate Cursor's `ask_question` result payload into the shape our
/// `AskQuestionEvent` / `extractAnsweredData` expects.
fn resolve_ask_question_answers(canonical: &str, args: &Value, result: &mut Value) {
    if canonical != "ask_user_questions" {
        return;
    }
    let questions = args.get("questions").and_then(|v| v.as_array());
    let result_obj = match result.as_object_mut() {
        Some(map) => map,
        None => return,
    };

    let raw_answers = match result_obj.remove("answers") {
        Some(Value::Array(arr)) => arr,
        Some(other) => {
            // Unknown shape — put it back and bail so we don't drop data.
            result_obj.insert("answers".to_string(), other);
            return;
        }
        None => return,
    };

    let mut converted: Vec<Value> = Vec::with_capacity(raw_answers.len());
    for (idx, answer) in raw_answers.into_iter().enumerate() {
        let option_id = match &answer {
            Value::Object(map) => map
                .get("questionId")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            Value::String(s) => Some(s.clone()),
            _ => None,
        };

        let label = option_id.as_ref().and_then(|id| {
            questions
                .and_then(|qs| qs.get(idx))
                .and_then(|q| q.get("options"))
                .and_then(|opts| opts.as_array())
                .and_then(|opts| {
                    opts.iter().find_map(|opt| {
                        let opt_id = opt.get("id").and_then(|v| v.as_str())?;
                        if opt_id == id {
                            opt.get("label")
                                .and_then(|v| v.as_str())
                                .map(str::to_string)
                        } else {
                            None
                        }
                    })
                })
        });

        let final_text = label.or(option_id).unwrap_or_default();
        converted.push(Value::Array(vec![Value::String(final_text)]));
    }

    result_obj.insert("answers".to_string(), Value::Array(converted));
    result_obj
        .entry("status".to_string())
        .or_insert_with(|| Value::String("answered".to_string()));
}

struct CursorEditDiff {
    diff_string: String,
    lines_added: usize,
    lines_removed: usize,
}

fn build_cursor_edit_diff(old_content: &str, new_content: &str) -> CursorEditDiff {
    let text_diff = similar::TextDiff::from_lines(old_content, new_content);
    let diff_string = text_diff
        .unified_diff()
        .context_radius(3)
        .header("before", "after")
        .to_string();
    let mut lines_added = 0;
    let mut lines_removed = 0;
    for change in text_diff.iter_all_changes() {
        match change.tag() {
            similar::ChangeTag::Insert => lines_added += 1,
            similar::ChangeTag::Delete => lines_removed += 1,
            similar::ChangeTag::Equal => {}
        }
    }
    CursorEditDiff {
        diff_string,
        lines_added,
        lines_removed,
    }
}

fn move_string_field(obj: &mut serde_json::Map<String, Value>, from: &str, to: &str) {
    if obj.contains_key(to) {
        return;
    }
    if let Some(Value::String(value)) = obj.get(from).cloned() {
        if !value.is_empty() {
            obj.insert(to.to_string(), Value::String(value));
        }
    }
}

/// Map a Cursor IDE tool's string id to our canonical tool name.
///
/// Unknown names pass through unchanged — the alias map and registry will
/// fall back to `tool_call` (`Fallback` block) for them.
pub(in crate::sources::cursor_ide) fn cursor_tool_name_to_canonical(name: &str) -> &str {
    match name {
        "read_file_v2" => "read_file",
        "edit_file_v2" => "edit_file_by_replace",
        "delete_file" => "delete_file",
        "run_terminal_command_v2" => "run_command_line",
        "glob_file_search" => "glob_file_search",
        "read_lints" => "query_lsp",
        "ripgrep_raw_search" => "grep",
        "semantic_search_full" => "codebase_search",
        "todo_write" => "manage_todo",
        "web_fetch" => "web_search",
        "task_v2" => "subagent",
        "ask_question" => "ask_user_questions",
        other => other,
    }
}

/// Cursor stores tool args/result as JSON-encoded strings. Parse them, and
/// fall back to a string-valued payload if parsing fails — never silently
/// drop the data.
pub(in crate::sources::cursor_ide) fn parse_inner_json(raw: &str) -> Value {
    if raw.is_empty() {
        return Value::Object(Default::default());
    }
    match serde_json::from_str::<Value>(raw) {
        Ok(value) => value,
        Err(_) => json!({ "raw": raw }),
    }
}

fn merge_cursor_additional_data(result: &mut Value, additional_data: &Value) {
    let additional = match additional_data.as_object() {
        Some(map) if !map.is_empty() => map,
        _ => return,
    };
    if !result.is_object() {
        *result = json!({ "value": result.clone() });
    }
    let result_obj = match result.as_object_mut() {
        Some(map) => map,
        None => return,
    };
    for (key, value) in additional {
        result_obj.entry(key.clone()).or_insert(value.clone());
    }
}

/// Attach `call_id` and `status` to the tool result so the existing extractors
/// and chat blocks recognize it the same way they would a `cursor-agent` CLI
/// chunk. Never overwrites fields the inner JSON already provides.
fn enrich_tool_result(mut payload: Value, tfd: &RawToolFormerData) -> Value {
    if !payload.is_object() {
        payload = json!({ "value": payload });
    }
    if let Some(obj) = payload.as_object_mut() {
        if let Some(additional) = tfd.additional_data.as_object() {
            if !additional.is_empty() {
                obj.entry("cursorAdditionalData".to_string())
                    .or_insert_with(|| tfd.additional_data.clone());
            }
        }
        if !tfd.tool_call_id.is_empty() {
            obj.entry("call_id".to_string())
                .or_insert_with(|| Value::String(tfd.tool_call_id.clone()));
        }
        if !tfd.status.is_empty() {
            obj.entry("status".to_string())
                .or_insert_with(|| Value::String(tfd.status.clone()));
        }
    }
    payload
}

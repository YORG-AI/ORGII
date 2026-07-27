//! Transcript loading and conversion: reading the JSONL transcript into
//! canonical `ActivityChunk`s, resolving the effective message/function-call
//! shapes, and normalizing WorkBuddy/CodeBuddy tool calls.

use super::*;

pub(super) fn load_workbuddy_history_from_path(
    session_id: &str,
    path: &Path,
) -> Result<Vec<ActivityChunk>, String> {
    let file = fs::File::open(path)
        .map_err(|err| format!("Failed to open WorkBuddy history {}: {err}", path.display()))?;
    let reader = BufReader::new(file);

    let mut chunks = Vec::new();
    let mut pending_tool_calls: HashMap<String, ImportedToolCall> = HashMap::new();
    let mut sequence = 0usize;

    for line in reader.lines() {
        let line = line.map_err(|err| format!("Failed to read WorkBuddy history line: {err}"))?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let parsed: WorkBuddyJsonlLine = match serde_json::from_str(trimmed) {
            Ok(parsed) => parsed,
            Err(_) => continue,
        };
        let created_at = timestamp_value_to_iso(parsed.timestamp.as_ref())
            .or_else(|| timestamp_value_to_iso(parsed.created_at.as_ref()))
            .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());

        if parsed.r#type == "reasoning" {
            if let Some(text) = reasoning_text(&parsed) {
                chunks.push(imported_history::assistant_message_chunk(
                    session_id,
                    WORKBUDDY_PROVIDER_SLUG,
                    sequence,
                    &created_at,
                    &text,
                ));
                sequence += 1;
            }
        }

        if let Some(call) = effective_function_call(&parsed)
            .as_ref()
            .and_then(|call| function_call_to_imported_tool_call(call, &created_at))
        {
            pending_tool_calls.insert(call.call_id.clone(), call);
        }

        if let Some(result) = effective_function_result(&parsed) {
            let call_id = function_result_call_id(&result);
            if !call_id.is_empty() {
                if let Some(call) = pending_tool_calls.remove(&call_id) {
                    chunks.push(imported_history::tool_call_chunk(
                        session_id,
                        WORKBUDDY_PROVIDER_SLUG,
                        sequence,
                        &call,
                        &function_result_output(&result),
                    ));
                    sequence += 1;
                }
            }
        }

        let Some(message) = effective_message(&parsed) else {
            continue;
        };
        match message.role.as_str() {
            "user" => {
                if let Some((call_id, output)) = tool_result_from_content(&message.content) {
                    if let Some(call) = pending_tool_calls.remove(&call_id) {
                        chunks.push(imported_history::tool_call_chunk(
                            session_id,
                            WORKBUDDY_PROVIDER_SLUG,
                            sequence,
                            &call,
                            &output,
                        ));
                        sequence += 1;
                    }
                } else if let Some(text) = content_text(&message.content) {
                    chunks.push(imported_history::user_message_chunk(
                        session_id,
                        WORKBUDDY_PROVIDER_SLUG,
                        sequence,
                        &created_at,
                        &text,
                    ));
                    sequence += 1;
                }
            }
            "assistant" => {
                for item in content_items(&message.content) {
                    match item.get("type").and_then(Value::as_str).unwrap_or_default() {
                        "text" => {
                            if let Some(text) = item.get("text").and_then(Value::as_str) {
                                chunks.push(imported_history::assistant_message_chunk(
                                    session_id,
                                    WORKBUDDY_PROVIDER_SLUG,
                                    sequence,
                                    &created_at,
                                    text,
                                ));
                                sequence += 1;
                            }
                        }
                        "thinking" => {
                            if let Some(text) = item
                                .get("thinking")
                                .and_then(Value::as_str)
                                .or_else(|| item.get("text").and_then(Value::as_str))
                            {
                                chunks.push(imported_history::assistant_message_chunk(
                                    session_id,
                                    WORKBUDDY_PROVIDER_SLUG,
                                    sequence,
                                    &created_at,
                                    text,
                                ));
                                sequence += 1;
                            }
                        }
                        "tool_use" | "function_call" => {
                            if let Some(call) = block_tool_call_from_item(item, &created_at) {
                                pending_tool_calls.insert(call.call_id.clone(), call);
                            }
                        }
                        _ => {}
                    }
                }
                if chunks
                    .last()
                    .is_none_or(|chunk| chunk.created_at != created_at)
                {
                    if let Some(text) = assistant_scalar_text(&message.content) {
                        chunks.push(imported_history::assistant_message_chunk(
                            session_id,
                            WORKBUDDY_PROVIDER_SLUG,
                            sequence,
                            &created_at,
                            &text,
                        ));
                        sequence += 1;
                    }
                }
            }
            _ => {}
        }
    }

    for call in pending_tool_calls.into_values() {
        chunks.push(imported_history::tool_call_chunk(
            session_id,
            WORKBUDDY_PROVIDER_SLUG,
            sequence,
            &call,
            "",
        ));
        sequence += 1;
    }

    Ok(chunks)
}

pub(super) fn effective_message(parsed: &WorkBuddyJsonlLine) -> Option<WorkBuddyMessage> {
    if let Some(message) = parsed.message.as_ref() {
        return Some(WorkBuddyMessage {
            role: message.role.clone(),
            model: message.model.clone(),
            content: message.content.clone(),
            usage: message.usage.clone(),
        });
    }
    if parsed.r#type != "message" || parsed.role.trim().is_empty() {
        return None;
    }
    let model = parsed
        .provider_data
        .get("requestModelName")
        .and_then(Value::as_str)
        .or_else(|| {
            parsed
                .provider_data
                .get("requestModelId")
                .and_then(Value::as_str)
        })
        .or_else(|| parsed.provider_data.get("model").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string();
    Some(WorkBuddyMessage {
        role: parsed.role.clone(),
        model,
        content: parsed.content.clone(),
        usage: None,
    })
}

pub(super) fn effective_function_call(
    parsed: &WorkBuddyJsonlLine,
) -> Option<WorkBuddyFunctionCall> {
    if let Some(call) = parsed.function_call.as_ref() {
        return Some(call.clone());
    }
    if parsed.r#type != "function_call" {
        return None;
    }
    Some(WorkBuddyFunctionCall {
        call_id: parsed.call_id.clone(),
        id: String::new(),
        name: parsed.name.clone(),
        arguments: parsed.arguments.clone(),
        input: Value::Null,
    })
}

pub(super) fn effective_function_result(
    parsed: &WorkBuddyJsonlLine,
) -> Option<WorkBuddyFunctionCallResult> {
    if let Some(result) = parsed.function_call_result.as_ref() {
        return Some(result.clone());
    }
    if parsed.r#type != "function_call_result" {
        return None;
    }
    Some(WorkBuddyFunctionCallResult {
        call_id: parsed.call_id.clone(),
        id: String::new(),
        output: parsed.output.clone(),
        result: Value::Null,
        content: Value::Null,
        status: parsed.status.clone(),
    })
}

pub(super) fn reasoning_text(parsed: &WorkBuddyJsonlLine) -> Option<String> {
    content_text(&parsed.content).or_else(|| content_text(&parsed.raw_content))
}

pub(super) fn block_tool_call_from_item(
    item: &Value,
    created_at: &str,
) -> Option<ImportedToolCall> {
    let call_id = item
        .get("id")
        .and_then(Value::as_str)
        .or_else(|| item.get("callId").and_then(Value::as_str))
        .or_else(|| item.get("call_id").and_then(Value::as_str))?
        .to_string();
    let raw_name = item
        .get("name")
        .and_then(Value::as_str)
        .or_else(|| item.get("tool").and_then(Value::as_str))?
        .to_string();
    let args = item
        .get("input")
        .or_else(|| item.get("arguments"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    let (canonical_name, args) = normalize_workbuddy_tool_call(&raw_name, args);
    Some(ImportedToolCall {
        call_id,
        raw_name,
        canonical_name,
        args,
        created_at: created_at.to_string(),
    })
}

pub(super) fn function_call_to_imported_tool_call(
    call: &WorkBuddyFunctionCall,
    created_at: &str,
) -> Option<ImportedToolCall> {
    let call_id = non_empty_string(&call.call_id).or_else(|| non_empty_string(&call.id))?;
    let raw_name = non_empty_string(&call.name)?;
    let args = if !call.arguments.is_null() {
        parse_argument_value(&call.arguments)
    } else if !call.input.is_null() {
        parse_argument_value(&call.input)
    } else {
        json!({})
    };
    let (canonical_name, args) = normalize_workbuddy_tool_call(&raw_name, args);
    Some(ImportedToolCall {
        call_id,
        raw_name,
        canonical_name,
        args,
        created_at: created_at.to_string(),
    })
}

pub(super) fn parse_argument_value(value: &Value) -> Value {
    match value {
        Value::String(text) => imported_history::parse_inner_json(text),
        other => other.clone(),
    }
}

pub(super) fn function_result_call_id(result: &WorkBuddyFunctionCallResult) -> String {
    non_empty_string(&result.call_id)
        .or_else(|| non_empty_string(&result.id))
        .unwrap_or_default()
}

pub(super) fn function_result_output(result: &WorkBuddyFunctionCallResult) -> String {
    if !result.output.is_null() {
        value_to_text(&result.output)
    } else if !result.result.is_null() {
        value_to_text(&result.result)
    } else if !result.content.is_null() {
        value_to_text(&result.content)
    } else {
        result.status.clone()
    }
}

pub(super) fn normalize_workbuddy_tool_call(raw_name: &str, args: Value) -> (String, Value) {
    match raw_name {
        "Bash" | "Shell" | "shell" | "run_command" | "terminal" | "terminal_command" => (
            imported_history::FUNCTION_RUN_COMMAND_LINE.to_string(),
            normalize_shell_args(args),
        ),
        "Edit" | "MultiEdit" | "Write" | "edit_file" | "edit_file_v2" | "write_file"
        | "apply_patch" => (
            imported_history::FUNCTION_EDIT_FILE.to_string(),
            normalize_edit_args(raw_name, args),
        ),
        _ => (raw_name.to_string(), args),
    }
}

pub(super) fn normalize_shell_args(args: Value) -> Value {
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

pub(super) fn normalize_edit_args(raw_name: &str, args: Value) -> Value {
    let file_path = args
        .get("file_path")
        .and_then(Value::as_str)
        .or_else(|| args.get("path").and_then(Value::as_str))
        .or_else(|| args.get("targetFile").and_then(Value::as_str))
        .or_else(|| args.get("relativeWorkspacePath").and_then(Value::as_str))
        .unwrap_or_default();
    json!({
        "action": raw_name,
        "file_path": file_path,
        "payload": args,
    })
}

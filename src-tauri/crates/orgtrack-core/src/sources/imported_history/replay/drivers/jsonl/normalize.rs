use super::*;

pub(super) fn normalize_line(source: ImportedHistorySourceId, raw: &Value) -> Vec<NormalizedEvent> {
    if source == ImportedHistorySourceId::Trae {
        return normalize_trae(raw);
    }
    let created_at = normalized_timestamp(raw.get("timestamp").or_else(|| raw.get("createdAt")));
    let mut events = Vec::new();

    // WorkBuddy also writes top-level function_call/result records.
    if source == ImportedHistorySourceId::WorkBuddy {
        if let Some(call) = workbuddy_top_level_call(raw, &created_at) {
            events.push(NormalizedEvent {
                created_at: created_at.clone(),
                starts_turn: false,
                kind: NormalizedKind::ToolUse(call),
            });
        }
        if let Some((call_id, output, failed)) = workbuddy_top_level_result(raw) {
            events.push(NormalizedEvent {
                created_at: created_at.clone(),
                starts_turn: false,
                kind: NormalizedKind::ToolResult {
                    call_id,
                    output,
                    failed,
                    diff: None,
                },
            });
        }
        if raw.get("type").and_then(Value::as_str) == Some("reasoning") {
            if let Some(text) = first_text(raw.get("content").or_else(|| raw.get("rawContent"))) {
                events.push(NormalizedEvent {
                    created_at: created_at.clone(),
                    starts_turn: false,
                    kind: NormalizedKind::AssistantText(text),
                });
            }
        }
    }

    let message = raw
        .get("message")
        .filter(|message| message.is_object())
        .or_else(|| {
            (raw.get("type").and_then(Value::as_str) == Some("message")
                && raw.get("role").is_some())
            .then_some(raw)
        });
    let Some(message) = message else {
        return events;
    };
    let role = message
        .get("role")
        .and_then(Value::as_str)
        .or_else(|| raw.get("role").and_then(Value::as_str))
        .or_else(|| raw.get("type").and_then(Value::as_str))
        .unwrap_or_default();
    let content = message.get("content").unwrap_or(&Value::Null);
    let claude_diff = (source == ImportedHistorySourceId::ClaudeCode)
        .then(|| raw.get("toolUseResult").and_then(claude_structured_diff))
        .flatten();
    normalize_content(
        source,
        role,
        content,
        &created_at,
        claude_diff.as_deref(),
        &mut events,
    );
    events
}

pub(super) fn normalize_content(
    source: ImportedHistorySourceId,
    role: &str,
    content: &Value,
    created_at: &str,
    tool_diff: Option<&str>,
    events: &mut Vec<NormalizedEvent>,
) {
    let items: Vec<&Value> = match content {
        Value::Array(items) => items.iter().collect(),
        Value::String(_) => vec![content],
        _ => Vec::new(),
    };
    let mut user_text_seen = false;
    for item in items {
        if let Some(text) = item.as_str() {
            let text = normalize_user_text(source, role, text);
            if text.is_empty() {
                continue;
            }
            let is_user = role == "user";
            events.push(NormalizedEvent {
                created_at: created_at.to_string(),
                starts_turn: is_user && !user_text_seen,
                kind: if is_user {
                    NormalizedKind::UserText(text)
                } else {
                    NormalizedKind::AssistantText(text)
                },
            });
            user_text_seen |= is_user;
            continue;
        }
        match item.get("type").and_then(Value::as_str).unwrap_or("text") {
            "text" => {
                let text = item.get("text").and_then(Value::as_str).unwrap_or_default();
                let text = normalize_user_text(source, role, text);
                if text.is_empty() {
                    continue;
                }
                let is_user = role == "user";
                events.push(NormalizedEvent {
                    created_at: created_at.to_string(),
                    starts_turn: is_user && !user_text_seen,
                    kind: if is_user {
                        NormalizedKind::UserText(text)
                    } else {
                        NormalizedKind::AssistantText(text)
                    },
                });
                user_text_seen |= is_user;
            }
            "thinking" | "reasoning" => {
                let text = item
                    .get("thinking")
                    .or_else(|| item.get("text"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim();
                if !text.is_empty() {
                    events.push(NormalizedEvent {
                        created_at: created_at.to_string(),
                        starts_turn: false,
                        kind: NormalizedKind::Thinking(text.to_string()),
                    });
                }
            }
            "tool_use" | "function_call" => {
                if let Some(call) = block_tool_call(source, item, created_at) {
                    events.push(NormalizedEvent {
                        created_at: created_at.to_string(),
                        starts_turn: false,
                        kind: NormalizedKind::ToolUse(call),
                    });
                }
            }
            "tool_result" | "function_call_result" => {
                if let Some(call_id) = item
                    .get("tool_use_id")
                    .or_else(|| item.get("callId"))
                    .or_else(|| item.get("call_id"))
                    .and_then(Value::as_str)
                {
                    let output = value_to_text(item.get("content").or_else(|| item.get("output")));
                    let failed = item.get("is_error").and_then(Value::as_bool) == Some(true);
                    events.push(NormalizedEvent {
                        created_at: created_at.to_string(),
                        starts_turn: false,
                        kind: NormalizedKind::ToolResult {
                            call_id: call_id.to_string(),
                            output,
                            failed,
                            diff: tool_diff.map(str::to_string),
                        },
                    });
                }
            }
            _ => {}
        }
    }
}

pub(super) fn normalize_trae(raw: &Value) -> Vec<NormalizedEvent> {
    let created_at = raw
        .get("message_summary_time")
        .and_then(Value::as_str)
        .and_then(trae_timestamp)
        .unwrap_or_default();
    let mut events = Vec::new();
    let intent = raw
        .get("intent")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if !intent.is_empty() {
        events.push(NormalizedEvent {
            created_at: created_at.clone(),
            starts_turn: true,
            kind: NormalizedKind::UserText(intent.to_string()),
        });
    }
    let mut body = String::new();
    if let Some(outcome) = raw
        .get("outcome")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        body.push_str(outcome);
    }
    append_summary_list(&mut body, "Actions:", raw.get("actions"));
    append_summary_list(&mut body, "Learned:", raw.get("learned"));
    if !body.is_empty() {
        events.push(NormalizedEvent {
            created_at,
            starts_turn: intent.is_empty(),
            kind: NormalizedKind::AssistantText(body),
        });
    }
    events
}

pub(super) fn append_summary_list(output: &mut String, heading: &str, value: Option<&Value>) {
    let Some(items) = value
        .and_then(Value::as_array)
        .filter(|items| !items.is_empty())
    else {
        return;
    };
    if !output.is_empty() {
        output.push_str("\n\n");
    }
    output.push_str(heading);
    for item in items.iter().filter_map(Value::as_str) {
        output.push_str("\n- ");
        output.push_str(item.trim());
    }
}

pub(super) fn block_tool_call(
    source: ImportedHistorySourceId,
    item: &Value,
    created_at: &str,
) -> Option<ImportedToolCall> {
    let call_id = item
        .get("id")
        .or_else(|| item.get("callId"))
        .or_else(|| item.get("call_id"))
        .and_then(Value::as_str)?
        .to_string();
    let raw_name = item
        .get("name")
        .or_else(|| item.get("tool"))
        .and_then(Value::as_str)
        .unwrap_or("tool")
        .to_string();
    let args = item
        .get("input")
        .or_else(|| item.get("arguments"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    let (canonical_name, args) = normalize_tool_call(source, &raw_name, parse_argument_value(args));
    Some(ImportedToolCall {
        call_id,
        raw_name,
        canonical_name,
        args,
        created_at: created_at.to_string(),
    })
}

pub(super) fn workbuddy_top_level_call(raw: &Value, created_at: &str) -> Option<ImportedToolCall> {
    let call = raw.get("functionCall").or_else(|| {
        (raw.get("type").and_then(Value::as_str) == Some("function_call")).then_some(raw)
    })?;
    block_tool_call(ImportedHistorySourceId::WorkBuddy, call, created_at)
}

pub(super) fn workbuddy_top_level_result(raw: &Value) -> Option<(String, String, bool)> {
    let result = raw.get("functionCallResult").or_else(|| {
        (raw.get("type").and_then(Value::as_str) == Some("function_call_result")).then_some(raw)
    })?;
    let call_id = result
        .get("callId")
        .or_else(|| result.get("call_id"))
        .or_else(|| result.get("id"))
        .and_then(Value::as_str)?
        .to_string();
    let value = result
        .get("output")
        .or_else(|| result.get("result"))
        .or_else(|| result.get("content"));
    let output = value_to_text(value);
    let failed = result
        .get("status")
        .and_then(Value::as_str)
        .is_some_and(|status| matches!(status, "failed" | "error"));
    Some((call_id, output, failed))
}

pub(super) fn normalize_tool_call(
    source: ImportedHistorySourceId,
    raw_name: &str,
    args: Value,
) -> (String, Value) {
    let lower = raw_name.to_ascii_lowercase();
    if matches!(
        lower.as_str(),
        "bash" | "shell" | "execute" | "run_command" | "terminal" | "terminal_command"
    ) {
        let command = args
            .get("command")
            .or_else(|| args.get("cmd"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        return (
            imported_history::FUNCTION_RUN_COMMAND_LINE.to_string(),
            json!({ "command": command, "cmd": command }),
        );
    }
    if source != ImportedHistorySourceId::Qoder
        && matches!(
            lower.as_str(),
            "edit"
                | "multiedit"
                | "write"
                | "edit_file"
                | "edit_file_v2"
                | "write_file"
                | "patch"
                | "apply_patch"
                | "str_replace"
        )
    {
        let file_path = args
            .get("file_path")
            .or_else(|| args.get("filePath"))
            .or_else(|| args.get("path"))
            .or_else(|| args.get("targetFile"))
            .or_else(|| args.get("relativeWorkspacePath"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        return (
            imported_history::FUNCTION_EDIT_FILE.to_string(),
            json!({ "action": raw_name, "file_path": file_path, "payload": args }),
        );
    }
    (raw_name.to_string(), args)
}

pub(super) fn parse_argument_value(value: Value) -> Value {
    match value {
        Value::String(text) => imported_history::parse_inner_json(&text),
        other => other,
    }
}

pub(super) fn normalize_user_text(
    source: ImportedHistorySourceId,
    role: &str,
    text: &str,
) -> String {
    if role != "user" {
        return text.trim().to_string();
    }
    let stripped = imported_history::strip_internal_context_blocks(text);
    if source == ImportedHistorySourceId::Qoder {
        if let Some(start) = stripped.find("<user_query>") {
            let rest = &stripped[start + "<user_query>".len()..];
            return rest
                .split("</user_query>")
                .next()
                .unwrap_or(rest)
                .trim()
                .to_string();
        }
        return strip_tag_blocks(stripped, "system-reminder");
    }
    stripped.trim().to_string()
}

pub(super) fn strip_tag_blocks(text: &str, tag: &str) -> String {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let mut output = String::new();
    let mut rest = text;
    while let Some(start) = rest.find(&open) {
        output.push_str(&rest[..start]);
        let Some(end) = rest[start + open.len()..].find(&close) else {
            break;
        };
        rest = &rest[start + open.len() + end + close.len()..];
    }
    output.push_str(rest);
    output.trim().to_string()
}

pub(super) fn first_text(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) => Some(text.clone()),
        Value::Array(items) => {
            let parts = items
                .iter()
                .filter_map(|item| {
                    item.get("text")
                        .or_else(|| item.get("content"))
                        .and_then(Value::as_str)
                })
                .collect::<Vec<_>>();
            (!parts.is_empty()).then(|| parts.join("\n"))
        }
        _ => None,
    }
}

pub(super) fn value_to_text(value: Option<&Value>) -> String {
    let Some(value) = value else {
        return String::new();
    };
    match value {
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| value_to_text(Some(item)))
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Object(map) => map
            .get("text")
            .or_else(|| map.get("content"))
            .map(|value| value_to_text(Some(value)))
            .unwrap_or_else(|| value.to_string()),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

pub(super) fn claude_structured_diff(result: &Value) -> Option<String> {
    let hunks = result.get("structuredPatch").and_then(Value::as_array)?;
    if hunks.is_empty() {
        return None;
    }
    let path = result
        .get("filePath")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut diff = format!("--- {path}\n+++ {path}\n");
    for hunk in hunks {
        let old_start = hunk
            .get("oldStart")
            .and_then(Value::as_i64)
            .unwrap_or_default();
        let old_lines = hunk
            .get("oldLines")
            .and_then(Value::as_i64)
            .unwrap_or_default();
        let new_start = hunk
            .get("newStart")
            .and_then(Value::as_i64)
            .unwrap_or_default();
        let new_lines = hunk
            .get("newLines")
            .and_then(Value::as_i64)
            .unwrap_or_default();
        diff.push_str(&format!(
            "@@ -{old_start},{old_lines} +{new_start},{new_lines} @@\n"
        ));
        for line in hunk
            .get("lines")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            diff.push_str(line);
            diff.push('\n');
        }
    }
    Some(diff)
}

pub(super) fn count_diff_lines(diff: &str) -> (i64, i64) {
    let mut added = 0;
    let mut removed = 0;
    for line in diff.lines() {
        if line.starts_with('+') && !line.starts_with("+++") {
            added += 1;
        } else if line.starts_with('-') && !line.starts_with("---") {
            removed += 1;
        }
    }
    (added, removed)
}

pub(super) fn normalized_timestamp(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(raw)) if !raw.trim().is_empty() => {
            imported_history::normalize_created_at(raw)
        }
        Some(Value::Number(number)) => number
            .as_i64()
            .map(|value| {
                if value < 10_000_000_000 {
                    value.saturating_mul(1_000)
                } else {
                    value
                }
            })
            .map(imported_history::epoch_ms_to_iso)
            .unwrap_or_default(),
        _ => String::new(),
    }
}

pub(super) fn trae_timestamp(raw: &str) -> Option<String> {
    chrono::NaiveDateTime::parse_from_str(raw.trim(), "%Y-%m-%d %H:%M:%S")
        .ok()
        .and_then(|naive| naive.and_local_timezone(chrono::Local).earliest())
        .map(|timestamp| timestamp.to_rfc3339())
}

pub(super) fn provider_slug(source: ImportedHistorySourceId) -> &'static str {
    match source {
        ImportedHistorySourceId::ClaudeCode => "claudecode",
        ImportedHistorySourceId::WorkBuddy => "workbuddy",
        ImportedHistorySourceId::Trae => "trae",
        ImportedHistorySourceId::Qoder => "qoder",
        ImportedHistorySourceId::Omp => "omp",
        ImportedHistorySourceId::QoderCli => "qoder_cli",
        _ => source.as_str(),
    }
}

pub(super) fn primary_sequence_step(source: ImportedHistorySourceId) -> i64 {
    if source == ImportedHistorySourceId::Qoder {
        QODER_PRIMARY_SEQUENCE_STEP
    } else {
        1
    }
}

pub(in crate::sources::imported_history::replay) fn compact_tool_args(
    args: &Value,
    function: &str,
) -> Value {
    let limit = if function == imported_history::FUNCTION_RUN_COMMAND_LINE {
        SHELL_PAYLOAD_PREVIEW_BYTES
    } else {
        NORMAL_PAYLOAD_PREVIEW_BYTES
    };
    let Ok(encoded) = serde_json::to_string(args) else {
        return json!({});
    };
    if encoded.len() <= limit {
        return args.clone();
    }
    let preview_budget = (limit / 2).max(256);
    let (preview, _) = head_preview(&encoded, preview_budget);
    let mut compact = json!({ "payloadPreview": preview, "payloadTruncated": true });
    if let (Some(target), Some(source)) = (compact.as_object_mut(), args.as_object()) {
        let semantic_keys = [
            "command",
            "cmd",
            "file_path",
            "filePath",
            "path",
            "action",
            "query",
            "pattern",
            "linesAdded",
            "linesRemoved",
            "operation",
            "agentType",
            "description",
            "cell_id",
            "session_id",
            "chars",
            "limit",
            "offset",
        ];
        let selected = semantic_keys
            .into_iter()
            .filter_map(|key| source.get(key).map(|value| (key, value)))
            .collect::<Vec<_>>();
        let per_value_budget = (limit / 2)
            .checked_div(selected.len().max(1))
            .unwrap_or(256)
            .max(128);
        for (key, value) in selected {
            target.insert(
                key.to_string(),
                compact_semantic_arg_value(value, per_value_budget),
            );
        }
    }
    compact
}

pub(super) fn compact_semantic_arg_value(value: &Value, max_bytes: usize) -> Value {
    let encoded = serde_json::to_string(value).unwrap_or_default();
    if encoded.len() <= max_bytes {
        return value.clone();
    }
    if let Some(text) = value.as_str() {
        return Value::String(head_preview(text, max_bytes).0);
    }
    Value::String(head_preview(&encoded, max_bytes).0)
}

pub(super) struct PayloadDescriptorInput<'a> {
    pub(super) field_path: &'a str,
    pub(super) kind: ReplayPayloadKind,
    pub(super) encoding: ReplayPayloadEncoding,
    pub(super) span: ReplaySourceSpan,
    pub(super) source_ordinal: u32,
    pub(super) total_bytes: usize,
    pub(super) truncated: bool,
    pub(super) body_projection: Option<ReplayPayloadBodyProjection>,
}

pub(super) fn payload_descriptor(
    input: PayloadDescriptorInput<'_>,
) -> Vec<ReplayPayloadDescriptor> {
    if !input.truncated {
        return Vec::new();
    }
    vec![ReplayPayloadDescriptor {
        field_path: input.field_path.to_string(),
        kind: input.kind,
        encoding: input.encoding,
        body_projection: input.body_projection,
        spans: vec![input.span],
        total_bytes: input.total_bytes as u64,
        source_ordinal: Some(input.source_ordinal),
        source_key: None,
    }]
}

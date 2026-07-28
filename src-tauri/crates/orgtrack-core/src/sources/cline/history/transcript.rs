//! Transcript loading and conversion: reading `<id>.messages.json`, pairing
//! tool calls with their results, and expanding Cline's batched tool calls into
//! canonical single-op `ActivityChunk`s.

use super::*;

pub(super) fn load_cline_history_from_path(
    session_id: &str,
    path: &Path,
) -> Result<Vec<ActivityChunk>, String> {
    let transcript = read_transcript(path)?;
    Ok(transcript_to_chunks(session_id, &transcript))
}

pub(super) fn transcript_to_chunks(
    session_id: &str,
    transcript: &ClineTranscript,
) -> Vec<ActivityChunk> {
    // Pass 1: collect every tool result as its raw `content` value (not flattened
    // text) so a batched call can pair each sub-operation with its own entry in
    // the parallel result list, regardless of which later user turn carried it.
    let mut tool_outputs: HashMap<String, Value> = HashMap::new();
    let mut tool_failures: HashMap<String, bool> = HashMap::new();
    for message in &transcript.messages {
        for block in content_blocks(&message.content) {
            if block_type(block) == "tool_result" {
                if let Some(id) = block
                    .get("tool_use_id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                {
                    tool_failures.insert(
                        id.to_string(),
                        block.get("is_error").and_then(Value::as_bool) == Some(true)
                            || block.get("success").and_then(Value::as_bool) == Some(false),
                    );
                    tool_outputs.insert(
                        id.to_string(),
                        block.get("content").cloned().unwrap_or(Value::Null),
                    );
                }
            }
        }
    }

    // Pass 2: emit chunks in transcript order.
    let mut chunks = Vec::new();
    let mut sequence = 0usize;
    for message in &transcript.messages {
        let created_at = message
            .ts
            .filter(|ms| *ms > 0)
            .map(imported_history::epoch_ms_to_iso)
            .unwrap_or_default();
        let is_user = message.role == "user";

        for block in content_blocks(&message.content) {
            match block_type(block) {
                "text" => {
                    let text = block.get("text").and_then(Value::as_str).unwrap_or("");
                    let text = if is_user {
                        strip_user_input_wrapper(text)
                    } else {
                        text.trim()
                    };
                    if text.is_empty() {
                        continue;
                    }
                    if is_user {
                        chunks.push(imported_history::user_message_chunk(
                            session_id,
                            CLINE_PROVIDER_SLUG,
                            sequence,
                            &created_at,
                            text,
                        ));
                    } else {
                        chunks.push(imported_history::assistant_message_chunk(
                            session_id,
                            CLINE_PROVIDER_SLUG,
                            sequence,
                            &created_at,
                            text,
                        ));
                    }
                    sequence += 1;
                }
                "tool_use" => {
                    let call_id = block
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    let raw_name = block
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("tool")
                        .to_string();
                    let input = block.get("input").cloned().unwrap_or(Value::Null);
                    let results = tool_outputs.get(&call_id);

                    // One Cline tool call can carry several operations; expand it
                    // into one canonical chunk per operation so each renders as
                    // its own typed card (read/shell/search/diff) instead of a
                    // single generic row.
                    let (sub_calls, batched) = expand_cline_tool_call(&raw_name, &input);
                    for (index, (canonical_name, args)) in sub_calls.into_iter().enumerate() {
                        let mut output = cline_sub_output(results, index, batched);
                        if raw_name == "read_files" {
                            output = strip_cline_read_gutter(&output);
                        }
                        let call = ImportedToolCall {
                            call_id: format!("{call_id}#{index}"),
                            raw_name: raw_name.clone(),
                            canonical_name,
                            args,
                            created_at: created_at.clone(),
                        };
                        let mut chunk = imported_history::tool_call_chunk(
                            session_id,
                            CLINE_PROVIDER_SLUG,
                            sequence,
                            &call,
                            &output,
                        );
                        if tool_failures.get(&call_id).copied().unwrap_or_default()
                            || cline_sub_success(results, index, batched) == Some(false)
                        {
                            if let Some(result) = chunk.result.as_object_mut() {
                                result.insert("success".to_string(), Value::Bool(false));
                                result.insert(
                                    "status".to_string(),
                                    Value::String("failed".to_string()),
                                );
                            }
                        }
                        chunks.push(chunk);
                        sequence += 1;
                    }
                }
                // `tool_result` blocks were consumed in pass 1.
                _ => {}
            }
        }
    }

    chunks
}

/// Cline packs several operations into one tool call (`commands[]`, `files[]`,
/// `queries[]`) and returns a parallel result list. Expand each batched call
/// into canonical single-op `(function, args)` pairs, reshaping args into the
/// keys the frontend extractors read (`command`, `file_path`, `query`,
/// `old_string`/`new_string`). The returned `bool` is `true` when outputs must
/// be paired with the result list **by index**.
///
/// Unknown or non-batched tools (`ask_question`, `fetch_web_content`, `team_*`,
/// …) fall through to a single passthrough call so nothing is dropped.
pub(super) fn expand_cline_tool_call(name: &str, input: &Value) -> (Vec<(String, Value)>, bool) {
    let sub_calls: Vec<(String, Value)> = match name {
        "run_commands" => input_array(input, "commands")
            .into_iter()
            .map(|command| {
                let command = command.clone();
                (
                    imported_history::FUNCTION_RUN_COMMAND_LINE.to_string(),
                    json!({ "command": command.clone(), "cmd": command }),
                )
            })
            .collect(),
        "read_files" => input_array(input, "files")
            .into_iter()
            .map(|file| {
                (
                    imported_history::FUNCTION_READ_FILE.to_string(),
                    json!({ "file_path": file.get("path").cloned().unwrap_or(Value::Null) }),
                )
            })
            .collect(),
        "search_codebase" => input_array(input, "queries")
            .into_iter()
            .map(|query| {
                (
                    imported_history::FUNCTION_CODE_SEARCH.to_string(),
                    json!({ "query": query.clone() }),
                )
            })
            .collect(),
        // `editor` is a single-op edit; reshape to the canonical diff args.
        // `old_text` is null when creating a file or inserting via `insert_line`.
        "editor" => {
            return (
                vec![(
                    imported_history::FUNCTION_EDIT_FILE.to_string(),
                    json!({
                        "file_path": input.get("path").cloned().unwrap_or(Value::Null),
                        "old_string": input
                            .get("old_text")
                            .cloned()
                            .filter(|value| !value.is_null())
                            .unwrap_or_else(|| json!("")),
                        "new_string": input.get("new_text").cloned().unwrap_or_else(|| json!("")),
                    }),
                )],
                false,
            );
        }
        _ => Vec::new(),
    };

    if sub_calls.is_empty() {
        return (vec![(name.to_string(), input.clone())], false);
    }
    (sub_calls, true)
}

/// Borrow the array under `key`, or an empty slice when it is missing/not an array.
pub(super) fn input_array<'a>(input: &'a Value, key: &str) -> Vec<&'a Value> {
    input
        .get(key)
        .and_then(Value::as_array)
        .map(|items| items.iter().collect())
        .unwrap_or_default()
}

/// Output text for the `index`-th sub-operation. Batched calls index into the
/// result list and take that entry's `result` field (falling back to the whole
/// entry); non-batched calls flatten the entire result.
pub(super) fn cline_sub_output(results: Option<&Value>, index: usize, batched: bool) -> String {
    if batched {
        if let Some(Value::Array(items)) = results {
            if let Some(item) = items.get(index) {
                return value_to_text(item.get("result").or(Some(item)));
            }
        }
        return String::new();
    }
    value_to_text(results)
}

pub(super) fn cline_sub_success(
    results: Option<&Value>,
    index: usize,
    batched: bool,
) -> Option<bool> {
    let result = if batched {
        results?.as_array()?.get(index)?
    } else if let Some(first) = results?.as_array().and_then(|items| items.first()) {
        first
    } else {
        results?
    };
    result.get("success").and_then(Value::as_bool)
}

/// Strip Cline's `<n> | ` read-file gutter so the read card shows clean file
/// content (the code viewer renders its own line numbers). Only strips when the
/// first non-empty line is gutter-prefixed, so command output that merely
/// contains a `|` is left untouched.
pub(super) fn strip_cline_read_gutter(text: &str) -> String {
    let looks_gutter = text
        .lines()
        .find(|line| !line.trim().is_empty())
        .and_then(gutter_body)
        .is_some();
    if !looks_gutter {
        return text.to_string();
    }
    text.lines()
        .map(|line| gutter_body(line).unwrap_or(line))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Return the content of a ` <n> | text` gutter line (here `text`), or `None`
/// when the line is not gutter-prefixed.
pub(super) fn gutter_body(line: &str) -> Option<&str> {
    let trimmed = line.trim_start();
    let digits_end = trimmed.find(|c: char| !c.is_ascii_digit())?;
    if digits_end == 0 {
        return None;
    }
    let after_digits = &trimmed[digits_end..];
    let rest = after_digits.strip_prefix(' ').unwrap_or(after_digits);
    let rest = rest.strip_prefix('|')?;
    Some(rest.strip_prefix(' ').unwrap_or(rest))
}

pub(super) fn read_transcript(path: &Path) -> Result<ClineTranscript, String> {
    let raw = fs::read_to_string(path)
        .map_err(|err| format!("Failed to open Cline history {}: {err}", path.display()))?;
    serde_json::from_str(&raw)
        .map_err(|err| format!("Failed to parse Cline history {}: {err}", path.display()))
}

/// Content is normally an array of blocks; tolerate a bare string too.
pub(super) fn content_blocks(content: &Value) -> Vec<&Value> {
    match content {
        Value::Array(items) => items.iter().collect(),
        _ => Vec::new(),
    }
}

pub(super) fn block_type(block: &Value) -> &str {
    block.get("type").and_then(Value::as_str).unwrap_or("")
}

pub(super) fn first_user_text(transcript: &ClineTranscript) -> Option<String> {
    for message in &transcript.messages {
        if message.role != "user" {
            continue;
        }
        for block in content_blocks(&message.content) {
            if block_type(block) == "text" {
                let text = strip_user_input_wrapper(
                    block.get("text").and_then(Value::as_str).unwrap_or(""),
                );
                if !text.is_empty() {
                    return Some(text.to_string());
                }
            }
        }
    }
    None
}

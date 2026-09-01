use std::collections::HashMap;
use std::path::Path;

use core_types::activity::ActivityChunk;
use serde_json::{json, Value};

use crate::sources::imported_history::{
    self, paths as imported_paths, watermark::WatermarkedTranscriptReader, ImportedToolCall,
};

use super::config::AnthropicJsonlSource;
use super::model::{
    is_harness_injected_line, JsonlLine, JsonlMessage, TranscriptRead, TranscriptTurn,
};
use super::tool_call::normalize_tool_call;
use super::value::{
    block_type, content_blocks, effective_role, first_content_text, normalized_timestamp,
    timestamp_ms, usage_tokens, value_to_text,
};

pub(super) fn load_from_path(
    config: &AnthropicJsonlSource,
    session_id: &str,
    path: &Path,
) -> Result<Vec<ActivityChunk>, String> {
    let read = read_transcript(config, path)?;
    Ok(messages_to_chunks(config, session_id, &read.turns))
}

pub(super) fn read_transcript(
    config: &AnthropicJsonlSource,
    path: &Path,
) -> Result<TranscriptRead, String> {
    let (mtime, size) = imported_paths::file_metadata_signature(path, config.display_name)?;
    let mut reader = WatermarkedTranscriptReader::open(
        path,
        config.display_name,
        None,
        config.parser_version,
        mtime,
        size,
    )?;
    let mut read = TranscriptRead::default();
    while let Some(line) = reader.next_line()? {
        let Ok(mut parsed) = serde_json::from_str::<JsonlLine>(line.text.trim()) else {
            continue;
        };
        let created_at = normalized_timestamp(&parsed.timestamp);
        if let Some(ms) = timestamp_ms(&parsed.timestamp) {
            if read.created_at_ms == 0 || ms < read.created_at_ms {
                read.created_at_ms = ms;
            }
            read.updated_at_ms = read.updated_at_ms.max(ms);
        }
        if read.repo_path.is_none() && !parsed.cwd.trim().is_empty() {
            read.repo_path = Some(parsed.cwd.trim().to_string());
        }
        if read.branch.is_none() && !parsed.git_branch.trim().is_empty() {
            read.branch = Some(parsed.git_branch.trim().to_string());
        }
        if read.model.is_none() && !parsed.model_id.trim().is_empty() {
            read.model = Some(parsed.model_id.trim().to_string());
        }
        if let Some(message) = parsed.message.as_ref() {
            if read.model.is_none() && !message.model.trim().is_empty() {
                read.model = Some(message.model.trim().to_string());
            }
            let (input, output, cache_read, cache_write) = usage_tokens(&message.usage);
            read.input_tokens = read.input_tokens.saturating_add(input);
            read.output_tokens = read.output_tokens.saturating_add(output);
            read.cache_read_tokens = read.cache_read_tokens.saturating_add(cache_read);
            read.cache_write_tokens = read.cache_write_tokens.saturating_add(cache_write);
            let role = effective_role(&parsed.line_type, &message.role);
            if read.first_user_text.is_none()
                && role == "user"
                && !is_harness_injected_line(&parsed)
            {
                read.first_user_text = first_content_text(&message.content);
            }
        }
        let harness_injected = is_harness_injected_line(&parsed);
        match parsed.line_type.as_str() {
            "message" | "user" | "assistant" => {
                if let Some(mut message) = parsed.message.take() {
                    if message.role.trim().is_empty() {
                        message.role = parsed.line_type;
                    }
                    read.turns.push(TranscriptTurn {
                        created_at,
                        message,
                        harness_injected,
                    });
                }
            }
            "reasoning" => {
                if let Some(message) = parsed.message.take() {
                    let text = first_content_text(&message.content).unwrap_or_default();
                    read.turns.push(TranscriptTurn {
                        created_at,
                        message: JsonlMessage {
                            role: "assistant".to_string(),
                            content: json!([{ "type": "thinking", "thinking": text }]),
                            ..JsonlMessage::default()
                        },
                        harness_injected: false,
                    });
                }
            }
            _ => {}
        }
    }
    Ok(read)
}

pub(super) fn messages_to_chunks(
    config: &AnthropicJsonlSource,
    session_id: &str,
    turns: &[TranscriptTurn],
) -> Vec<ActivityChunk> {
    let mut tool_outputs: HashMap<String, (String, bool)> = HashMap::new();
    for turn in turns {
        for block in content_blocks(&turn.message.content) {
            if block_type(&block) != "tool_result" {
                continue;
            }
            if let Some(id) = block
                .get("tool_use_id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
            {
                tool_outputs.insert(
                    id.to_string(),
                    (
                        value_to_text(block.get("content")),
                        block.get("is_error").and_then(Value::as_bool) == Some(true),
                    ),
                );
            }
        }
    }

    let mut chunks = Vec::new();
    let mut sequence = 0;
    for turn in turns {
        let is_user = turn.message.role == "user";
        for block in content_blocks(&turn.message.content) {
            match block_type(&block) {
                "text" => {
                    if is_user && turn.harness_injected {
                        continue;
                    }
                    let text = block
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .trim();
                    if text.is_empty() {
                        continue;
                    }
                    let chunk = if is_user {
                        imported_history::user_message_chunk(
                            session_id,
                            config.provider_slug,
                            sequence,
                            &turn.created_at,
                            text,
                        )
                    } else {
                        imported_history::assistant_message_chunk(
                            session_id,
                            config.provider_slug,
                            sequence,
                            &turn.created_at,
                            text,
                        )
                    };
                    chunks.push(chunk);
                    sequence += 1;
                }
                "thinking" => {
                    let text = block
                        .get("thinking")
                        .or_else(|| block.get("text"))
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .trim();
                    if !text.is_empty() {
                        chunks.push(imported_history::thinking_chunk(
                            session_id,
                            config.provider_slug,
                            sequence,
                            &turn.created_at,
                            text,
                        ));
                        sequence += 1;
                    }
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
                    let (canonical_name, args) = normalize_tool_call(
                        &raw_name,
                        block.get("input").cloned().unwrap_or(Value::Null),
                    );
                    let call = ImportedToolCall {
                        call_id: call_id.clone(),
                        raw_name,
                        canonical_name,
                        args,
                        created_at: turn.created_at.clone(),
                    };
                    let (output, failed) = tool_outputs.get(&call_id).cloned().unwrap_or_default();
                    let mut chunk = imported_history::tool_call_chunk(
                        session_id,
                        config.provider_slug,
                        sequence,
                        &call,
                        &output,
                    );
                    if failed {
                        if let Some(result) = chunk.result.as_object_mut() {
                            result.insert("success".to_string(), Value::Bool(false));
                            result
                                .insert("status".to_string(), Value::String("failed".to_string()));
                        }
                    }
                    chunks.push(chunk);
                    sequence += 1;
                }
                _ => {}
            }
        }
    }
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config() -> AnthropicJsonlSource {
        AnthropicJsonlSource {
            source: "test",
            session_prefix: "testapp-",
            provider_slug: "test",
            display_name: "Test",
            parser_version: 1,
            candidate_roots: Vec::new(),
            exclude_subagent_dirs: false,
            max_discovery_depth: None,
            incremental_metadata: false,
            session_id_from_header: false,
        }
    }

    #[test]
    fn harness_injected_user_lines_emit_no_bubble_and_no_title() {
        let temp_dir = std::env::temp_dir().join(format!(
            "orgii-anthropic-jsonl-synthetic-test-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&temp_dir).expect("create temp dir");
        let path = temp_dir.join("synthetic.jsonl");
        let content = r#"{"type":"user","timestamp":"2026-04-01T07:00:00Z","isMeta":true,"message":{"role":"user","content":[{"type":"text","text":"<local-command-caveat>Caveat</local-command-caveat>"}]}}
{"type":"user","timestamp":"2026-04-01T07:00:01Z","origin":{"kind":"task-notification"},"message":{"role":"user","content":[{"type":"text","text":"<task-notification><task-id>t1</task-id></task-notification>"}]}}
{"type":"user","timestamp":"2026-04-01T07:00:02Z","origin":{"kind":"human"},"message":{"role":"user","content":[{"type":"text","text":"real prompt"}]}}
{"type":"assistant","timestamp":"2026-04-01T07:00:03Z","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}
"#;
        std::fs::write(&path, content).expect("write fixture");

        let read = read_transcript(&test_config(), &path).expect("read transcript");
        assert_eq!(read.first_user_text.as_deref(), Some("real prompt"));

        let chunks = messages_to_chunks(&test_config(), "testapp-session", &read.turns);
        let user_texts = chunks
            .iter()
            .filter(|chunk| chunk.function == imported_history::FUNCTION_USER_MESSAGE)
            .map(|chunk| {
                chunk
                    .result
                    .pointer("/message/content")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string()
            })
            .collect::<Vec<_>>();
        assert_eq!(user_texts, vec!["real prompt"]);

        std::fs::remove_file(&path).expect("remove fixture");
        std::fs::remove_dir(&temp_dir).expect("remove temp dir");
    }

    #[test]
    fn tool_results_are_paired_with_calls() {
        let turns = vec![
            TranscriptTurn {
                created_at: String::new(),
                message: JsonlMessage {
                    role: "assistant".to_string(),
                    content: json!([{"type":"tool_use","id":"call-1","name":"bash","input":{"command":"pwd"}}]),
                    ..JsonlMessage::default()
                },
                harness_injected: false,
            },
            TranscriptTurn {
                created_at: String::new(),
                message: JsonlMessage {
                    role: "user".to_string(),
                    content: json!([{"type":"tool_result","tool_use_id":"call-1","content":"/repo"}]),
                    ..JsonlMessage::default()
                },
                harness_injected: false,
            },
        ];
        let chunks = messages_to_chunks(&test_config(), "testapp-session", &turns);
        assert_eq!(chunks.len(), 1);
        assert!(chunks[0].result.to_string().contains("/repo"));
    }
}

//! Shared reader for CLI transcripts that persist Anthropic-style JSONL.
//!
//! OMP and Qoder CLI use different directory layouts but the same core
//! `{message:{role,content}}` representation. Keeping discovery configurable
//! and conversion shared prevents their replay semantics from drifting.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use core_types::activity::ActivityChunk;
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::sources::imported_history::{
    self, cache as imported_cache,
    metadata::{
        ImportedHistoryCacheInput, ImportedHistoryDiscoveredRecord, ImportedHistoryImpactStats,
    },
    paths as imported_paths, ImportedHistoryRecentPath, ImportedHistorySessionPage,
    ImportedToolCall,
};

const MAX_TOOL_OUTPUT_CHARS: usize = 50_000;

/// Config for the generic Anthropic/Claude-style JSONL transcript reader. Any
/// tool that writes newline-delimited JSON transcripts under a set of root
/// directories is a value of this struct — no bespoke parser required (see
/// `omp` / `qoder_cli`, and the CLI's declarative loader plugins).
///
/// The identity fields are `&'static str` because built-in sources are static;
/// dynamic hosts (the CLI's plugin loader) intern their ids once for the
/// process lifetime. `candidate_roots` is owned so it can be built from a
/// manifest, not only a function.
#[derive(Debug, Clone)]
pub struct AnthropicJsonlSource {
    pub source: &'static str,
    pub session_prefix: &'static str,
    pub provider_slug: &'static str,
    pub display_name: &'static str,
    pub parser_version: i64,
    pub candidate_roots: Vec<PathBuf>,
    pub exclude_subagent_dirs: bool,
}

#[derive(Debug, Clone)]
struct SessionMeta {
    source_session_id: String,
    session_id: String,
    source_path: String,
    source_record_key: String,
    source_mtime_ms: i64,
    source_size_bytes: i64,
    name: String,
    created_at_ms: i64,
    updated_at_ms: i64,
    model: Option<String>,
    input_tokens: i64,
    output_tokens: i64,
    cache_read_tokens: i64,
    cache_write_tokens: i64,
    repo_path: Option<String>,
    branch: Option<String>,
    impact: ImportedHistoryImpactStats,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct JsonlLine {
    #[serde(rename = "type")]
    line_type: String,
    timestamp: Value,
    cwd: String,
    model_id: String,
    git_branch: String,
    message: Option<JsonlMessage>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct JsonlMessage {
    role: String,
    model: String,
    content: Value,
    usage: Value,
}

struct TranscriptTurn {
    created_at: String,
    message: JsonlMessage,
}

pub fn list_sessions_paginated(
    config: &AnthropicJsonlSource,
    conn: &mut Connection,
    limit: usize,
    offset: usize,
) -> Result<ImportedHistorySessionPage, String> {
    sync_cache(config, conn)?;
    imported_cache::query_imported_session_page_from_conn(conn, config.source, limit, offset)
}

pub fn list_recent_paths(
    config: &AnthropicJsonlSource,
    conn: &mut Connection,
    limit: usize,
) -> Result<Vec<ImportedHistoryRecentPath>, String> {
    sync_cache(config, conn)?;
    imported_cache::query_imported_recent_paths_from_conn(conn, config.source, limit)
}

pub fn load_session(
    config: &AnthropicJsonlSource,
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<ActivityChunk>, String> {
    let source_session_id = source_id_from_session_id(config, session_id)?;
    let cached =
        imported_cache::query_cached_session_from_conn(conn, config.source, source_session_id)?
            .ok_or_else(|| {
                format!(
                    "{} session not found: {source_session_id}",
                    config.display_name
                )
            })?;
    load_from_path(config, session_id, Path::new(&cached.source_path))
}

fn sync_cache(config: &AnthropicJsonlSource, conn: &mut Connection) -> Result<(), String> {
    let discovered = discover_records(config)?;
    let signatures = discovered
        .iter()
        .map(ImportedHistoryDiscoveredRecord::signature)
        .collect::<Vec<_>>();
    let changed = imported_cache::changed_records_from_conn(
        conn,
        config.source,
        &discovered,
        ImportedHistoryDiscoveredRecord::signature,
    )?;
    let mut inputs = Vec::new();
    for record in changed {
        inputs.push(meta_to_cache_input(
            config,
            parse_session_meta(config, record)?,
        ));
    }
    imported_cache::sync_source_cache_from_conn(
        conn,
        config.source,
        imported_cache::live_ids_from_signatures(&signatures),
        inputs,
    )
}

fn discover_records(
    config: &AnthropicJsonlSource,
) -> Result<Vec<ImportedHistoryDiscoveredRecord>, String> {
    let mut records = Vec::new();
    let mut seen_paths = HashSet::new();
    for root in config.candidate_roots.clone() {
        if !root.is_dir() {
            continue;
        }
        let mut files = Vec::new();
        collect_jsonl_files(&root, config.exclude_subagent_dirs, &mut files)?;
        for path in files {
            if !seen_paths.insert(path.clone()) {
                continue;
            }
            let relative = path.strip_prefix(&root).unwrap_or(&path);
            let mut source_session_id = relative.with_extension("").to_string_lossy().to_string();
            if std::path::MAIN_SEPARATOR != '/' {
                source_session_id = source_session_id.replace(std::path::MAIN_SEPARATOR, "/");
            }
            if source_session_id.trim().is_empty() {
                continue;
            }
            let (mtime, size) =
                imported_paths::file_metadata_signature(&path, config.display_name)?;
            records.push(ImportedHistoryDiscoveredRecord {
                source_session_id: source_session_id.clone(),
                source_path: path,
                source_record_key: source_session_id,
                source_mtime_ms: mtime,
                source_size_bytes: size,
                source_fingerprint: String::new(),
                parser_version: config.parser_version,
            });
        }
    }
    Ok(records)
}

fn collect_jsonl_files(
    dir: &Path,
    exclude_subagent_dirs: bool,
    out: &mut Vec<PathBuf>,
) -> Result<(), String> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return Ok(()),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if exclude_subagent_dirs
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name == "subagents")
            {
                continue;
            }
            collect_jsonl_files(&path, exclude_subagent_dirs, out)?;
        } else if path
            .extension()
            .is_some_and(|extension| extension == "jsonl")
        {
            out.push(path);
        }
    }
    Ok(())
}

fn parse_session_meta(
    config: &AnthropicJsonlSource,
    record: &ImportedHistoryDiscoveredRecord,
) -> Result<SessionMeta, String> {
    let turns = read_turns(config, &record.source_path)?;
    let mut created_at_ms = 0;
    let mut updated_at_ms = 0;
    let mut repo_path = None;
    let mut branch = None;
    let mut model = None;
    let mut input_tokens = 0;
    let mut output_tokens = 0;
    let mut cache_read_tokens = 0;
    let mut cache_write_tokens = 0;
    let mut first_user_text = None;

    let file = fs::File::open(&record.source_path).map_err(|err| {
        format!(
            "Failed to open {} history {}: {err}",
            config.display_name,
            record.source_path.display()
        )
    })?;
    for line in BufReader::new(file).lines() {
        let Ok(line) = line else { continue };
        let Ok(parsed) = serde_json::from_str::<JsonlLine>(line.trim()) else {
            continue;
        };
        if let Some(ms) = timestamp_ms(&parsed.timestamp) {
            if created_at_ms == 0 || ms < created_at_ms {
                created_at_ms = ms;
            }
            updated_at_ms = updated_at_ms.max(ms);
        }
        if repo_path.is_none() && !parsed.cwd.trim().is_empty() {
            repo_path = Some(parsed.cwd.trim().to_string());
        }
        if branch.is_none() && !parsed.git_branch.trim().is_empty() {
            branch = Some(parsed.git_branch.trim().to_string());
        }
        if model.is_none() && !parsed.model_id.trim().is_empty() {
            model = Some(parsed.model_id.trim().to_string());
        }
        if let Some(message) = parsed.message {
            if model.is_none() && !message.model.trim().is_empty() {
                model = Some(message.model.trim().to_string());
            }
            let (input, output, cache_read, cache_write) = usage_tokens(&message.usage);
            input_tokens += input;
            output_tokens += output;
            cache_read_tokens += cache_read;
            cache_write_tokens += cache_write;
            let role = effective_role(&parsed.line_type, &message.role);
            if first_user_text.is_none() && role == "user" {
                first_user_text = first_content_text(&message.content);
            }
        }
    }

    let fallback_ms = record.source_mtime_ms / 1_000_000;
    let session_id = format!("{}{}", config.session_prefix, record.source_session_id);
    let impact =
        imported_history::impact_from_edit_chunks(&messages_to_chunks(config, &session_id, &turns));
    Ok(SessionMeta {
        source_session_id: record.source_session_id.clone(),
        session_id,
        source_path: record.source_path.to_string_lossy().to_string(),
        source_record_key: record.source_record_key.clone(),
        source_mtime_ms: record.source_mtime_ms,
        source_size_bytes: record.source_size_bytes,
        name: first_user_text
            .map(|value| imported_history::truncate_name(&value, 200))
            .unwrap_or_else(|| record.source_record_key.clone()),
        created_at_ms: if created_at_ms > 0 {
            created_at_ms
        } else {
            fallback_ms
        },
        updated_at_ms: if updated_at_ms > 0 {
            updated_at_ms
        } else {
            fallback_ms
        },
        model,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        repo_path,
        branch,
        impact,
    })
}

fn meta_to_cache_input(
    config: &AnthropicJsonlSource,
    meta: SessionMeta,
) -> ImportedHistoryCacheInput {
    ImportedHistoryCacheInput {
        source: config.source,
        source_session_id: meta.source_session_id,
        session_id: meta.session_id,
        source_path: meta.source_path,
        source_record_key: meta.source_record_key,
        source_mtime_ms: meta.source_mtime_ms,
        source_size_bytes: meta.source_size_bytes,
        source_fingerprint: String::new(),
        parser_version: config.parser_version,
        name: meta.name,
        created_at_ms: meta.created_at_ms,
        updated_at_ms: meta.updated_at_ms,
        model: meta.model,
        input_tokens: meta.input_tokens,
        output_tokens: meta.output_tokens,
        cache_read_tokens: meta.cache_read_tokens,
        cache_write_tokens: meta.cache_write_tokens,
        repo_path: meta.repo_path,
        branch: meta.branch,
        impact: meta.impact,
        listable: true,
        source_metadata_json: None,
        parent_session_id: None,
    }
}

fn load_from_path(
    config: &AnthropicJsonlSource,
    session_id: &str,
    path: &Path,
) -> Result<Vec<ActivityChunk>, String> {
    let turns = read_turns(config, path)?;
    Ok(messages_to_chunks(config, session_id, &turns))
}

fn read_turns(config: &AnthropicJsonlSource, path: &Path) -> Result<Vec<TranscriptTurn>, String> {
    let file = fs::File::open(path).map_err(|err| {
        format!(
            "Failed to open {} history {}: {err}",
            config.display_name,
            path.display()
        )
    })?;
    let mut turns = Vec::new();
    for line in BufReader::new(file).lines() {
        let line = line
            .map_err(|err| format!("Failed to read {} history line: {err}", config.display_name))?;
        let Ok(mut parsed) = serde_json::from_str::<JsonlLine>(line.trim()) else {
            continue;
        };
        let created_at = normalized_timestamp(&parsed.timestamp);
        match parsed.line_type.as_str() {
            "message" | "user" | "assistant" => {
                if let Some(mut message) = parsed.message.take() {
                    if message.role.trim().is_empty() {
                        message.role = parsed.line_type;
                    }
                    turns.push(TranscriptTurn {
                        created_at,
                        message,
                    });
                }
            }
            "reasoning" => {
                if let Some(message) = parsed.message.take() {
                    let text = first_content_text(&message.content).unwrap_or_default();
                    turns.push(TranscriptTurn {
                        created_at,
                        message: JsonlMessage {
                            role: "assistant".to_string(),
                            content: json!([{ "type": "thinking", "thinking": text }]),
                            ..JsonlMessage::default()
                        },
                    });
                }
            }
            _ => {}
        }
    }
    Ok(turns)
}

fn messages_to_chunks(
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

fn normalize_tool_call(raw_name: &str, args: Value) -> (String, Value) {
    match raw_name.to_ascii_lowercase().as_str() {
        "bash" | "shell" | "execute" | "run_command" => {
            let command = args
                .get("command")
                .and_then(Value::as_str)
                .or_else(|| args.get("cmd").and_then(Value::as_str))
                .unwrap_or_default();
            (
                imported_history::FUNCTION_RUN_COMMAND_LINE.to_string(),
                json!({ "command": command, "cmd": command, "payload": args }),
            )
        }
        "write" | "edit" | "patch" | "apply_patch" | "str_replace" => {
            let file_path = args
                .get("filePath")
                .and_then(Value::as_str)
                .or_else(|| args.get("file_path").and_then(Value::as_str))
                .or_else(|| args.get("path").and_then(Value::as_str))
                .unwrap_or_default();
            (
                imported_history::FUNCTION_EDIT_FILE.to_string(),
                json!({ "action": raw_name, "file_path": file_path, "payload": args }),
            )
        }
        _ => (raw_name.to_string(), args),
    }
}

fn source_id_from_session_id<'a>(
    config: &AnthropicJsonlSource,
    session_id: &'a str,
) -> Result<&'a str, String> {
    session_id
        .strip_prefix(config.session_prefix)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("Invalid {} session id: {session_id}", config.display_name))
}

fn effective_role<'a>(line_type: &'a str, message_role: &'a str) -> &'a str {
    if message_role.trim().is_empty() {
        line_type
    } else {
        message_role
    }
}

fn timestamp_ms(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => normalize_epoch(number.as_i64()?),
        Value::String(raw) => raw
            .parse::<i64>()
            .ok()
            .and_then(normalize_epoch)
            .or_else(|| imported_history::parse_iso_to_epoch_ms_opt(raw)),
        _ => None,
    }
}

fn normalize_epoch(value: i64) -> Option<i64> {
    if value <= 0 {
        None
    } else if value < 10_000_000_000 {
        Some(value * 1_000)
    } else {
        Some(value)
    }
}

fn normalized_timestamp(value: &Value) -> String {
    match value {
        Value::String(raw) if !raw.trim().is_empty() => imported_history::normalize_created_at(raw),
        _ => timestamp_ms(value)
            .map(imported_history::epoch_ms_to_iso)
            .unwrap_or_default(),
    }
}

/// Returns `(input_folded, output, cache_read, cache_write)`. `input_folded`
/// is cache-inclusive (fresh + both cache kinds); the cache components are also
/// returned so the usage projection can split them out.
fn usage_tokens(usage: &Value) -> (i64, i64, i64, i64) {
    let read = |keys: &[&str]| {
        keys.iter()
            .find_map(|key| usage.get(*key).and_then(Value::as_i64))
            .unwrap_or_default()
    };
    let cache_read = read(&[
        "cache_read_input_tokens",
        "cacheReadInputTokens",
        "cache_read",
    ]);
    let cache_write = read(&[
        "cache_creation_input_tokens",
        "cacheCreationInputTokens",
        "cache_write",
    ]);
    let input = read(&["input_tokens", "inputTokens", "input"]) + cache_read + cache_write;
    let output = read(&["output_tokens", "outputTokens", "output"]);
    (input, output, cache_read, cache_write)
}

fn content_blocks(content: &Value) -> Vec<Value> {
    match content {
        Value::Array(items) => items.clone(),
        Value::String(text) => vec![json!({ "type": "text", "text": text })],
        _ => Vec::new(),
    }
}

fn block_type(block: &Value) -> &str {
    block.get("type").and_then(Value::as_str).unwrap_or("")
}

fn first_content_text(content: &Value) -> Option<String> {
    content_blocks(content).into_iter().find_map(|block| {
        (block_type(&block) == "text")
            .then(|| {
                block
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
            })
            .filter(|text| !text.is_empty())
            .map(str::to_string)
    })
}

fn value_to_text(value: Option<&Value>) -> String {
    let mut output = String::new();
    if let Some(value) = value {
        append_value_text(value, &mut output);
    }
    let output = output.trim();
    if output.chars().count() > MAX_TOOL_OUTPUT_CHARS {
        format!(
            "{}\n… (truncated)",
            output
                .chars()
                .take(MAX_TOOL_OUTPUT_CHARS)
                .collect::<String>()
        )
    } else {
        output.to_string()
    }
}

fn append_value_text(value: &Value, output: &mut String) {
    match value {
        Value::String(text) => push_line(output, text),
        Value::Array(items) => {
            for item in items {
                append_value_text(item, output);
            }
        }
        Value::Object(map) => {
            if let Some(text) = map.get("text").and_then(Value::as_str) {
                push_line(output, text);
            } else if let Some(content) = map.get("content") {
                append_value_text(content, output);
            } else if let Ok(encoded) = serde_json::to_string(value) {
                push_line(output, &encoded);
            }
        }
        Value::Null => {}
        other => push_line(output, &other.to_string()),
    }
}

fn push_line(output: &mut String, text: &str) {
    if !output.is_empty() {
        output.push('\n');
    }
    output.push_str(text);
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
        }
    }

    #[test]
    fn qoder_style_top_level_role_is_used_when_message_role_is_absent() {
        let line: JsonlLine =
            serde_json::from_str(r#"{"type":"user","message":{"content":"hello"}}"#).unwrap();
        assert_eq!(
            effective_role(&line.line_type, &line.message.unwrap().role),
            "user"
        );
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
            },
            TranscriptTurn {
                created_at: String::new(),
                message: JsonlMessage {
                    role: "user".to_string(),
                    content: json!([{"type":"tool_result","tool_use_id":"call-1","content":"/repo"}]),
                    ..JsonlMessage::default()
                },
            },
        ];
        let chunks = messages_to_chunks(&test_config(), "testapp-session", &turns);
        assert_eq!(chunks.len(), 1);
        assert!(chunks[0].result.to_string().contains("/repo"));
    }
}

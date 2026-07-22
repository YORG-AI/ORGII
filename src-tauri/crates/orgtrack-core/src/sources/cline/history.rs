//! Cline imported-history reader
//!
//! Reads the Cline CLI's local per-session store under
//! `~/.cline/data/sessions/<id>/` and converts each transcript into ORGII's
//! canonical `ActivityChunk` shape for read-only replay. The transcript is an
//! Anthropic-style `messages` array, so tool calls and their results are paired
//! back together (a `tool_use` in an assistant turn with the matching
//! `tool_result` from the following user turn).
//!
//! Cline batches several operations into one tool call (`run_commands`,
//! `read_files`, `search_codebase` each take a list and return a parallel result
//! list). Each call is expanded into one canonical single-op chunk per operation
//! so it renders as its own typed card; see [`expand_cline_tool_call`].

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use core_types::activity::ActivityChunk;
use rusqlite::{Connection, OpenFlags};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::sources::imported_history::{
    self, cache as imported_cache,
    metadata::{
        ImportedHistoryCacheInput, ImportedHistoryDiscoveredRecord, ImportedHistoryImpactStats,
        ImportedHistoryRecordSignature, SOURCE_CLINE,
    },
    paths as imported_paths, ImportedHistoryRecentPath, ImportedHistorySessionPage,
    ImportedHistorySessionRow, ImportedToolCall,
};

pub const CLINE_SESSION_PREFIX: &str = "clineapp-";
const CLINE_PROVIDER_SLUG: &str = "cline";
// Version 2 uses Cline's session index for child hierarchy and derives impact
// independently from each root/agent transcript.
const CLINE_METADATA_PARSER_VERSION: i64 = 2;
const MESSAGES_SUFFIX: &str = ".messages.json";
/// Cap a single tool-result body so a runaway command output can't bloat the
/// cache/replay payload. The replay UI virtualizes long text anyway.
const MAX_TOOL_OUTPUT_CHARS: usize = 50_000;

pub type ClineHistorySessionRow = ImportedHistorySessionRow;
pub type ClineHistorySessionPage = ImportedHistorySessionPage;
pub type ClineRecentPath = ImportedHistoryRecentPath;

#[derive(Debug, Clone)]
struct ClineHistoryMeta {
    source_session_id: String,
    session_id: String,
    source_path: String,
    source_record_key: String,
    source_mtime_ms: i64,
    source_size_bytes: i64,
    source_fingerprint: String,
    name: String,
    created_at_ms: i64,
    updated_at_ms: i64,
    model: Option<String>,
    repo_path: Option<String>,
    input_tokens: i64,
    output_tokens: i64,
    impact: ImportedHistoryImpactStats,
    parent_session_id: Option<String>,
}

#[derive(Debug, Clone)]
struct ClineDiscoveredRecord {
    record: ImportedHistoryDiscoveredRecord,
    db_meta: Option<ClineDbSessionMeta>,
}

impl ClineDiscoveredRecord {
    fn signature(&self) -> ImportedHistoryRecordSignature {
        self.record.signature()
    }
}

#[derive(Debug, Clone, Default)]
struct ClineDbSessionMeta {
    session_id: String,
    started_at: String,
    updated_at: String,
    provider: Option<String>,
    model: Option<String>,
    cwd: Option<String>,
    workspace_root: Option<String>,
    parent_session_id: Option<String>,
    is_subagent: bool,
    prompt: Option<String>,
    metadata_json: Option<String>,
    messages_path: String,
}

/// `<id>.json` — session metadata sidecar.
#[derive(Debug, Default, Deserialize)]
struct ClineSessionJson {
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    workspace_root: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    started_at: Option<String>,
    #[serde(default)]
    prompt: Option<String>,
    #[serde(default)]
    metadata: Option<ClineSessionMetadata>,
}

#[derive(Debug, Default, Deserialize)]
struct ClineSessionMetadata {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    usage: Option<ClineUsage>,
}

#[derive(Debug, Default, Deserialize)]
struct ClineUsage {
    #[serde(default, rename = "inputTokens")]
    input_tokens: Option<i64>,
    #[serde(default, rename = "outputTokens")]
    output_tokens: Option<i64>,
}

/// `<id>.messages.json` — the transcript.
#[derive(Debug, Default, Deserialize)]
struct ClineTranscript {
    #[serde(default)]
    messages: Vec<ClineMessage>,
}

#[derive(Debug, Default, Deserialize)]
struct ClineMessage {
    #[serde(default)]
    role: String,
    #[serde(default)]
    content: Value,
    #[serde(default)]
    ts: Option<i64>,
}

pub fn list_cline_history_sessions_paginated(
    conn: &mut Connection,
    limit: usize,
    offset: usize,
) -> Result<ClineHistorySessionPage, String> {
    sync_cline_history_cache(conn)?;
    imported_cache::query_imported_session_page_from_conn(conn, SOURCE_CLINE, limit, offset)
}

pub fn list_cline_recent_paths(
    conn: &mut Connection,
    limit: usize,
) -> Result<Vec<ClineRecentPath>, String> {
    sync_cline_history_cache(conn)?;
    imported_cache::query_imported_recent_paths_from_conn(conn, SOURCE_CLINE, limit)
}

pub fn load_cline_history_for_session(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<ActivityChunk>, String> {
    let source_session_id = cline_source_id_from_session_id(session_id)?;
    let path = resolve_cline_messages_path(conn, source_session_id)?;
    load_cline_history_from_path(session_id, &path)
}

pub(crate) fn refresh_catalog(conn: &mut Connection) -> Result<(), String> {
    sync_cline_history_cache(conn)
}

fn sync_cline_history_cache(conn: &mut Connection) -> Result<(), String> {
    let discovered = discover_cline_history_records()?;
    let signatures = discovered
        .iter()
        .map(ClineDiscoveredRecord::signature)
        .collect::<Vec<_>>();
    let changed =
        imported_cache::changed_records_from_conn(conn, SOURCE_CLINE, &discovered, |record| {
            record.signature()
        })?;
    let mut inputs = Vec::new();
    for record in changed {
        if let Some(meta) = parse_cline_session_meta(record)? {
            let mut input = session_meta_to_cache_input(meta);
            if let Some(cached) = imported_cache::query_cached_session_from_conn(
                conn,
                SOURCE_CLINE,
                &input.source_session_id,
            )? {
                // Message traversal belongs to whole-document replay. A
                // sidecar/DB catalog refresh must never erase the last valid
                // compact impact merely because it did not read messages.
                input.impact = cached.impact;
            }
            inputs.push(input);
        }
    }
    imported_cache::sync_source_cache_from_conn(
        conn,
        SOURCE_CLINE,
        imported_cache::live_ids_from_signatures(&signatures),
        inputs,
    )
}

fn discover_cline_history_records() -> Result<Vec<ClineDiscoveredRecord>, String> {
    let mut records = Vec::new();
    let mut discovered_ids = HashSet::new();
    for db_path in cline_db_paths()? {
        if !db_path.is_file() {
            continue;
        }
        if let Ok(db_records) = discover_cline_db_records(&db_path) {
            for record in db_records {
                discovered_ids.insert(record.record.source_session_id.clone());
                records.push(record);
            }
        }
    }
    for sessions_dir in cline_sessions_dirs()? {
        if !sessions_dir.is_dir() {
            continue;
        }
        let entries = match fs::read_dir(&sessions_dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }
            let Some(id) = dir.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            let messages_path = dir.join(format!("{id}{MESSAGES_SUFFIX}"));
            if !messages_path.is_file() || discovered_ids.contains(id) {
                continue;
            }
            let (source_mtime_ms, source_size_bytes) =
                imported_paths::file_metadata_signature(&messages_path, "Cline")?;
            records.push(ClineDiscoveredRecord {
                record: ImportedHistoryDiscoveredRecord {
                    source_session_id: id.to_string(),
                    source_path: messages_path,
                    source_record_key: id.to_string(),
                    source_mtime_ms,
                    source_size_bytes,
                    source_fingerprint: String::new(),
                    parser_version: CLINE_METADATA_PARSER_VERSION,
                },
                db_meta: None,
            });
        }
    }
    Ok(records)
}

fn discover_cline_db_records(db_path: &Path) -> Result<Vec<ClineDiscoveredRecord>, String> {
    let conn =
        Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|err| {
            format!(
                "Failed to open Cline session index {}: {err}",
                db_path.display()
            )
        })?;
    let mut stmt = conn
        .prepare(
            "SELECT session_id, started_at, updated_at, provider, model, cwd, workspace_root, \
                    parent_session_id, is_subagent, prompt, metadata_json, messages_path \
             FROM sessions WHERE messages_path IS NOT NULL AND messages_path != ''",
        )
        .map_err(|err| format!("Failed to prepare Cline session-index query: {err}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(ClineDbSessionMeta {
                session_id: row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                started_at: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                updated_at: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                provider: row.get(3)?,
                model: row.get(4)?,
                cwd: row.get(5)?,
                workspace_root: row.get(6)?,
                parent_session_id: row
                    .get::<_, Option<String>>(7)?
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty()),
                is_subagent: row.get::<_, Option<i64>>(8)?.unwrap_or_default() != 0,
                prompt: row.get(9)?,
                metadata_json: row.get(10)?,
                messages_path: row.get::<_, Option<String>>(11)?.unwrap_or_default(),
            })
        })
        .map_err(|err| format!("Failed to query Cline session index: {err}"))?;

    let mut records = Vec::new();
    for row in rows {
        let meta = row.map_err(|err| format!("Failed to read Cline session-index row: {err}"))?;
        if meta.session_id.trim().is_empty() || meta.messages_path.trim().is_empty() {
            continue;
        }
        let messages_path = PathBuf::from(&meta.messages_path);
        if !messages_path.is_file() {
            continue;
        }
        let (source_mtime_ms, source_size_bytes) =
            imported_paths::file_metadata_signature(&messages_path, "Cline")?;
        let source_fingerprint = cline_db_source_fingerprint(&meta);
        records.push(ClineDiscoveredRecord {
            record: ImportedHistoryDiscoveredRecord {
                source_session_id: meta.session_id.clone(),
                source_path: messages_path,
                source_record_key: meta.session_id.clone(),
                source_mtime_ms,
                source_size_bytes,
                source_fingerprint,
                parser_version: CLINE_METADATA_PARSER_VERSION,
            },
            db_meta: Some(meta),
        });
    }
    Ok(records)
}

fn cline_db_source_fingerprint(meta: &ClineDbSessionMeta) -> String {
    [
        meta.session_id.as_str(),
        meta.started_at.as_str(),
        meta.updated_at.as_str(),
        meta.provider.as_deref().unwrap_or_default(),
        meta.model.as_deref().unwrap_or_default(),
        meta.cwd.as_deref().unwrap_or_default(),
        meta.workspace_root.as_deref().unwrap_or_default(),
        meta.parent_session_id.as_deref().unwrap_or_default(),
        if meta.is_subagent { "1" } else { "0" },
        meta.prompt.as_deref().unwrap_or_default(),
        meta.metadata_json.as_deref().unwrap_or_default(),
        meta.messages_path.as_str(),
    ]
    .join("|")
}

fn parse_cline_session_meta(
    discovered: &ClineDiscoveredRecord,
) -> Result<Option<ClineHistoryMeta>, String> {
    let record = &discovered.record;
    let db_meta = discovered.db_meta.as_ref();
    let messages_path = &record.source_path;
    let sidecar = sidecar_json_path(messages_path, &record.source_session_id);
    let session_json: ClineSessionJson = sidecar
        .as_ref()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();

    let db_metadata = db_meta
        .and_then(|meta| meta.metadata_json.as_deref())
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .unwrap_or(Value::Null);

    let created_at_ms = session_json
        .started_at
        .as_deref()
        .and_then(imported_history::parse_iso_to_epoch_ms_opt)
        .or_else(|| {
            db_meta
                .map(|meta| meta.started_at.as_str())
                .and_then(imported_history::parse_iso_to_epoch_ms_opt)
        })
        .filter(|ms| *ms > 0)
        .unwrap_or(record.source_mtime_ms / 1_000_000);

    let updated_at_ms = db_meta
        .and_then(|meta| imported_history::parse_iso_to_epoch_ms_opt(meta.updated_at.as_str()))
        .filter(|ms| *ms > 0)
        .unwrap_or(record.source_mtime_ms / 1_000_000);

    let title = session_json
        .metadata
        .as_ref()
        .and_then(|meta| meta.title.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| json_nonempty_string(&db_metadata, &["title"]));
    let name = title
        .or_else(|| {
            session_json
                .prompt
                .as_deref()
                .map(strip_user_input_wrapper)
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        })
        .or_else(|| {
            db_meta
                .and_then(|meta| meta.prompt.as_deref())
                .map(strip_user_input_wrapper)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
        .map(|value| imported_history::truncate_name(&value, 200))
        .unwrap_or_else(|| record.source_record_key.clone());

    let repo_path = session_json
        .workspace_root
        .as_deref()
        .or(session_json.cwd.as_deref())
        .or_else(|| db_meta.and_then(|meta| meta.workspace_root.as_deref()))
        .or_else(|| db_meta.and_then(|meta| meta.cwd.as_deref()))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    let model = session_json
        .model
        .as_deref()
        .or_else(|| db_meta.and_then(|meta| meta.model.as_deref()))
        .or(session_json.provider.as_deref())
        .or_else(|| db_meta.and_then(|meta| meta.provider.as_deref()))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    let usage = session_json
        .metadata
        .as_ref()
        .and_then(|m| m.usage.as_ref());
    let input_tokens = usage.and_then(|u| u.input_tokens).unwrap_or_else(|| {
        json_i64_at_paths(
            &db_metadata,
            &[
                &["aggregateUsage", "inputTokens"],
                &["usage", "inputTokens"],
            ],
        )
        .unwrap_or_default()
    });
    let output_tokens = usage.and_then(|u| u.output_tokens).unwrap_or_else(|| {
        json_i64_at_paths(
            &db_metadata,
            &[
                &["aggregateUsage", "outputTokens"],
                &["usage", "outputTokens"],
            ],
        )
        .unwrap_or_default()
    });
    let session_id = format!("{CLINE_SESSION_PREFIX}{}", record.source_session_id);
    // The whole-document replay adapter owns message traversal. Catalog
    // refresh deliberately avoids deserializing the messages array merely to
    // populate a sidebar card; exact impact is projected from the compact
    // replay index when that metadata is requested.
    let impact = ImportedHistoryImpactStats::default();
    let parent_session_id = db_meta
        .filter(|meta| meta.is_subagent)
        .and_then(|meta| meta.parent_session_id.as_deref())
        .map(str::trim)
        .filter(|parent_id| !parent_id.is_empty() && *parent_id != record.source_session_id)
        .map(|parent_id| format!("{CLINE_SESSION_PREFIX}{parent_id}"));

    Ok(Some(ClineHistoryMeta {
        source_session_id: record.source_session_id.clone(),
        session_id,
        source_path: messages_path.to_string_lossy().to_string(),
        source_record_key: record.source_record_key.clone(),
        source_mtime_ms: record.source_mtime_ms,
        source_size_bytes: record.source_size_bytes,
        source_fingerprint: record.source_fingerprint.clone(),
        name,
        created_at_ms,
        updated_at_ms,
        model,
        repo_path,
        input_tokens,
        output_tokens,
        impact,
        parent_session_id,
    }))
}

fn session_meta_to_cache_input(meta: ClineHistoryMeta) -> ImportedHistoryCacheInput {
    ImportedHistoryCacheInput {
        source: SOURCE_CLINE,
        source_session_id: meta.source_session_id,
        session_id: meta.session_id,
        source_path: meta.source_path,
        source_record_key: meta.source_record_key,
        source_mtime_ms: meta.source_mtime_ms,
        source_size_bytes: meta.source_size_bytes,
        source_fingerprint: meta.source_fingerprint,
        parser_version: CLINE_METADATA_PARSER_VERSION,
        name: meta.name,
        created_at_ms: meta.created_at_ms,
        updated_at_ms: meta.updated_at_ms,
        model: meta.model,
        input_tokens: meta.input_tokens,
        output_tokens: meta.output_tokens,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        repo_path: meta.repo_path,
        branch: None,
        impact: meta.impact,
        listable: true,
        source_metadata_json: None,
        parent_session_id: meta.parent_session_id,
    }
}

fn load_cline_history_from_path(
    session_id: &str,
    path: &Path,
) -> Result<Vec<ActivityChunk>, String> {
    let transcript = read_transcript(path)?;
    Ok(transcript_to_chunks(session_id, &transcript))
}

fn transcript_to_chunks(session_id: &str, transcript: &ClineTranscript) -> Vec<ActivityChunk> {
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
fn expand_cline_tool_call(name: &str, input: &Value) -> (Vec<(String, Value)>, bool) {
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
fn input_array<'a>(input: &'a Value, key: &str) -> Vec<&'a Value> {
    input
        .get(key)
        .and_then(Value::as_array)
        .map(|items| items.iter().collect())
        .unwrap_or_default()
}

/// Output text for the `index`-th sub-operation. Batched calls index into the
/// result list and take that entry's `result` field (falling back to the whole
/// entry); non-batched calls flatten the entire result.
fn cline_sub_output(results: Option<&Value>, index: usize, batched: bool) -> String {
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

fn cline_sub_success(results: Option<&Value>, index: usize, batched: bool) -> Option<bool> {
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
fn strip_cline_read_gutter(text: &str) -> String {
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
fn gutter_body(line: &str) -> Option<&str> {
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

fn read_transcript(path: &Path) -> Result<ClineTranscript, String> {
    let raw = fs::read_to_string(path)
        .map_err(|err| format!("Failed to open Cline history {}: {err}", path.display()))?;
    serde_json::from_str(&raw)
        .map_err(|err| format!("Failed to parse Cline history {}: {err}", path.display()))
}

/// Content is normally an array of blocks; tolerate a bare string too.
fn content_blocks(content: &Value) -> Vec<&Value> {
    match content {
        Value::Array(items) => items.iter().collect(),
        _ => Vec::new(),
    }
}

fn block_type(block: &Value) -> &str {
    block.get("type").and_then(Value::as_str).unwrap_or("")
}

fn json_nonempty_string(value: &Value, path: &[&str]) -> Option<String> {
    let value = path
        .iter()
        .try_fold(value, |current, key| current.get(*key))?;
    let text = value.as_str()?.trim();
    (!text.is_empty()).then(|| text.to_string())
}

fn json_i64_at_paths(value: &Value, paths: &[&[&str]]) -> Option<i64> {
    paths.iter().find_map(|path| {
        let value = path
            .iter()
            .try_fold(value, |current, key| current.get(*key))?;
        value
            .as_i64()
            .or_else(|| value.as_u64().and_then(|number| i64::try_from(number).ok()))
            .or_else(|| value.as_f64().map(|number| number.round() as i64))
    })
}

/// Cline wraps user prompts as `<user_input mode="act">…</user_input>`; unwrap to
/// the inner text for a clean title/replay. Leaves non-wrapped text untouched.
fn strip_user_input_wrapper(text: &str) -> &str {
    let trimmed = text.trim();
    let Some(after_open) = trimmed.strip_prefix("<user_input") else {
        return trimmed;
    };
    let Some(gt) = after_open.find('>') else {
        return trimmed;
    };
    let inner = &after_open[gt + 1..];
    inner.strip_suffix("</user_input>").unwrap_or(inner).trim()
}

/// Flatten a `tool_result.content` value (string, array of blocks, or object)
/// into readable text, capped so a huge command output can't bloat the payload.
fn value_to_text(value: Option<&Value>) -> String {
    let mut out = String::new();
    if let Some(value) = value {
        append_value_text(value, &mut out);
    }
    let out = out.trim();
    if out.chars().count() > MAX_TOOL_OUTPUT_CHARS {
        let truncated: String = out.chars().take(MAX_TOOL_OUTPUT_CHARS).collect();
        format!("{truncated}\n… (truncated)")
    } else {
        out.to_string()
    }
}

fn append_value_text(value: &Value, out: &mut String) {
    match value {
        Value::String(text) => push_line(out, text),
        Value::Array(items) => {
            for item in items {
                append_value_text(item, out);
            }
        }
        Value::Object(map) => {
            if let Some(Value::String(text)) = map.get("text") {
                push_line(out, text);
            } else if let Some(Value::String(text)) = map.get("result") {
                push_line(out, text);
            } else {
                push_line(out, &value.to_string());
            }
        }
        Value::Null => {}
        other => push_line(out, &other.to_string()),
    }
}

fn push_line(out: &mut String, text: &str) {
    let text = text.trim();
    if text.is_empty() {
        return;
    }
    if !out.is_empty() {
        out.push('\n');
    }
    out.push_str(text);
}

fn sidecar_json_path(messages_path: &Path, source_session_id: &str) -> Option<PathBuf> {
    let parent = messages_path.parent()?;
    let candidate = parent.join(format!("{source_session_id}.json"));
    candidate.is_file().then_some(candidate)
}

fn cline_source_id_from_session_id(session_id: &str) -> Result<&str, String> {
    let Some(rest) = session_id.strip_prefix(CLINE_SESSION_PREFIX) else {
        return Err(format!("Invalid Cline history session id: {session_id}"));
    };
    if rest.is_empty() {
        return Err("Cline history session id is missing its source id".to_string());
    }
    Ok(rest)
}

fn resolve_cline_messages_path(
    conn: &Connection,
    source_session_id: &str,
) -> Result<PathBuf, String> {
    if let Some(path) =
        imported_cache::get_cached_source_path_from_conn(conn, SOURCE_CLINE, source_session_id)?
    {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
    }
    for sessions_dir in cline_sessions_dirs()? {
        let candidate = sessions_dir
            .join(source_session_id)
            .join(format!("{source_session_id}{MESSAGES_SUFFIX}"));
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(format!(
        "Cline history file not found for session: {source_session_id}"
    ))
}

fn cline_sessions_dirs() -> Result<Vec<PathBuf>, String> {
    let home = dirs::home_dir().ok_or_else(|| "Home directory not found".to_string())?;
    Ok(cline_sessions_dir_candidates(&home))
}

fn cline_db_paths() -> Result<Vec<PathBuf>, String> {
    let home = dirs::home_dir().ok_or_else(|| "Home directory not found".to_string())?;
    Ok(cline_db_path_candidates(&home))
}

/// `~/.cline/data/sessions` — the CLI's per-session store root.
fn cline_sessions_dir_candidates(home: &Path) -> Vec<PathBuf> {
    vec![home.join(".cline").join("data").join("sessions")]
}

fn cline_db_path_candidates(home: &Path) -> Vec<PathBuf> {
    vec![home
        .join(".cline")
        .join("data")
        .join("db")
        .join("sessions.db")]
}

#[cfg(test)]
#[path = "history_tests.rs"]
mod tests;

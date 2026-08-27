//! Shared reader for CLI transcripts that persist Anthropic-style JSONL.
//!
//! OMP and Qoder CLI use different directory layouts but the same core
//! `{message:{role,content}}` representation. Keeping discovery configurable
//! and conversion shared prevents their replay semantics from drifting.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use core_types::activity::ActivityChunk;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::sources::imported_history::{
    self, cache as imported_cache,
    metadata::{
        ImportedHistoryCacheInput, ImportedHistoryDiscoveredRecord, ImportedHistoryImpactStats,
    },
    paths as imported_paths, scan_snapshot,
    watermark::{self, ImportedParseWatermark, WatermarkedTranscriptReader},
    ImportedHistoryRecentPath, ImportedHistorySessionPage, ImportedToolCall,
};

const MAX_TOOL_OUTPUT_CHARS: usize = 50_000;
const MAX_INCREMENTAL_STATE_BYTES: usize = 4 * 1024 * 1024;
const MAX_PENDING_EDIT_IMPACTS: usize = 1_024;
const MAX_TOUCHED_FILES: usize = 4_096;
const MAX_STATE_ID_BYTES: usize = 1_024;
const MAX_STATE_PATH_BYTES: usize = 4_096;
const MAX_STATE_LABEL_BYTES: usize = 1_024;

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
    /// Exact directory depth for sources with a documented leaf shape.
    /// `Some(1)` accepts `<root>/<one-dir>/*.jsonl` and rejects both root
    /// files and deeper descendants. `None` retains legacy recursive
    /// discovery.
    pub max_discovery_depth: Option<usize>,
    /// Use the shared append watermark for metadata-only cache refreshes.
    pub incremental_metadata: bool,
    /// Prefer the session header's stable id for the canonical ORGII id.
    pub session_id_from_header: bool,
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
    id: String,
    timestamp: Value,
    cwd: String,
    model_id: String,
    git_branch: String,
    message: Option<JsonlMessage>,
    is_meta: bool,
    origin: Option<JsonlOrigin>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct JsonlOrigin {
    kind: String,
}

fn is_harness_injected_line(parsed: &JsonlLine) -> bool {
    imported_history::is_harness_injected_user_marker(
        parsed.is_meta,
        parsed.origin.as_ref().map(|origin| origin.kind.as_str()),
    )
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
    harness_injected: bool,
}

#[derive(Default)]
struct TranscriptRead {
    turns: Vec<TranscriptTurn>,
    created_at_ms: i64,
    updated_at_ms: i64,
    repo_path: Option<String>,
    branch: Option<String>,
    model: Option<String>,
    input_tokens: i64,
    output_tokens: i64,
    cache_read_tokens: i64,
    cache_write_tokens: i64,
    first_user_text: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
struct PendingEditImpact {
    call_id: String,
    impact: ImportedHistoryImpactStats,
}

/// Compact metadata accumulator persisted behind the append watermark. It
/// deliberately stores no chat text or tool output. Only unresolved edit-call
/// impacts remain pending until their result arrives; completed calls collapse
/// into aggregate counters and a de-duplicated touched-file set.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
struct SessionMetaState {
    declared_session_id: Option<String>,
    created_at_ms: i64,
    updated_at_ms: i64,
    repo_path: Option<String>,
    branch: Option<String>,
    model: Option<String>,
    input_tokens: i64,
    output_tokens: i64,
    cache_read_tokens: i64,
    cache_write_tokens: i64,
    first_user_text: Option<String>,
    impact: ImportedHistoryImpactStats,
    pending_edits: Vec<PendingEditImpact>,
}

struct IncrementalSessionMetaParse {
    meta: SessionMeta,
    watermark: ImportedParseWatermark,
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
    let cached = if config.session_id_from_header {
        imported_cache::query_cached_session_by_session_id_from_conn(conn, session_id)?
            .filter(|(source, _)| source == config.source)
            .map(|(_, cached)| cached)
    } else {
        let source_session_id = source_id_from_session_id(config, session_id)?;
        imported_cache::query_cached_session_from_conn(conn, config.source, source_session_id)?
    }
    .ok_or_else(|| format!("{} session not found: {session_id}", config.display_name))?;
    load_from_path(config, session_id, Path::new(&cached.source_path))
}

fn sync_cache(config: &AnthropicJsonlSource, conn: &mut Connection) -> Result<(), String> {
    let discovered = discover_records(config, conn)?;
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
        let meta = if config.incremental_metadata {
            let stored = watermark::read_parse_watermark_from_conn(
                conn,
                config.source,
                &record.source_session_id,
            )?;
            let Some(parse) = imported_history::skip_unparsable_record(
                config.source,
                &record.source_session_id,
                parse_session_meta_incremental(config, record, stored.as_ref()),
            ) else {
                continue;
            };
            watermark::write_parse_watermark_from_conn(
                conn,
                config.source,
                &record.source_session_id,
                &parse.watermark,
            )?;
            parse.meta
        } else {
            let Some(meta) = imported_history::skip_unparsable_record(
                config.source,
                &record.source_session_id,
                parse_session_meta(config, record),
            ) else {
                continue;
            };
            meta
        };
        inputs.push(meta_to_cache_input(config, meta));
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
    conn: &Connection,
) -> Result<Vec<ImportedHistoryDiscoveredRecord>, String> {
    let mut records = Vec::new();
    let mut seen_paths = HashSet::new();
    let previous_snapshots = config
        .max_discovery_depth
        .map(|_| scan_snapshot::read_dir_snapshots_from_conn(conn, config.source));
    let mut walker = previous_snapshots.as_ref().map(|previous| {
        scan_snapshot::SnapshotDirWalker::new(previous, "jsonl", config.display_name)
    });
    for root in config.candidate_roots.clone() {
        if !root.is_dir() {
            continue;
        }
        let mut files = Vec::new();
        if let (Some(max_depth), Some(walker)) = (config.max_discovery_depth, walker.as_mut()) {
            walker.collect_files_bounded(&root, &mut files, max_depth)?;
        } else {
            collect_jsonl_files(&root, config.exclude_subagent_dirs, &mut files)?;
        }
        for path in files {
            if !seen_paths.insert(path.clone()) {
                continue;
            }
            let relative = path.strip_prefix(&root).unwrap_or(&path);
            if config
                .max_discovery_depth
                .is_some_and(|expected| relative.components().count().saturating_sub(1) != expected)
            {
                continue;
            }
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
    if let (Some(previous), Some(walker)) = (previous_snapshots.as_ref(), walker) {
        let next = walker.into_snapshots();
        scan_snapshot::persist_dir_snapshots_if_changed(conn, config.source, previous, &next)?;
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
    let read = read_transcript(config, &record.source_path)?;

    let fallback_ms = record.source_mtime_ms / 1_000_000;
    let session_id = format!("{}{}", config.session_prefix, record.source_session_id);
    let impact = imported_history::impact_from_edit_chunks(&messages_to_chunks(
        config,
        &session_id,
        &read.turns,
    ));
    Ok(SessionMeta {
        source_session_id: record.source_session_id.clone(),
        session_id,
        source_path: record.source_path.to_string_lossy().to_string(),
        source_record_key: record.source_record_key.clone(),
        source_mtime_ms: record.source_mtime_ms,
        source_size_bytes: record.source_size_bytes,
        name: read
            .first_user_text
            .map(|value| imported_history::truncate_name(&value, 200))
            .unwrap_or_else(|| record.source_record_key.clone()),
        created_at_ms: if read.created_at_ms > 0 {
            read.created_at_ms
        } else {
            fallback_ms
        },
        updated_at_ms: if read.updated_at_ms > 0 {
            read.updated_at_ms
        } else {
            fallback_ms
        },
        model: read.model,
        input_tokens: read.input_tokens,
        output_tokens: read.output_tokens,
        cache_read_tokens: read.cache_read_tokens,
        cache_write_tokens: read.cache_write_tokens,
        repo_path: read.repo_path,
        branch: read.branch,
        impact,
    })
}

impl SessionMetaState {
    fn feed(&mut self, line: &str) -> Result<(), String> {
        let Ok(parsed) = serde_json::from_str::<JsonlLine>(line) else {
            return Ok(());
        };
        if parsed.line_type == "session" && !parsed.id.trim().is_empty() {
            ensure_bounded_state_value("session id", parsed.id.trim(), MAX_STATE_ID_BYTES)?;
            self.declared_session_id = Some(parsed.id.trim().to_string());
        }
        if let Some(ms) = timestamp_ms(&parsed.timestamp) {
            if self.created_at_ms == 0 || ms < self.created_at_ms {
                self.created_at_ms = ms;
            }
            self.updated_at_ms = self.updated_at_ms.max(ms);
        }
        if self.repo_path.is_none() && !parsed.cwd.trim().is_empty() {
            ensure_bounded_state_value("repository path", parsed.cwd.trim(), MAX_STATE_PATH_BYTES)?;
            self.repo_path = Some(parsed.cwd.trim().to_string());
        }
        if self.branch.is_none() && !parsed.git_branch.trim().is_empty() {
            ensure_bounded_state_value("branch", parsed.git_branch.trim(), MAX_STATE_LABEL_BYTES)?;
            self.branch = Some(parsed.git_branch.trim().to_string());
        }
        if self.model.is_none() && !parsed.model_id.trim().is_empty() {
            ensure_bounded_state_value("model", parsed.model_id.trim(), MAX_STATE_LABEL_BYTES)?;
            self.model = Some(parsed.model_id.trim().to_string());
        }
        let harness_injected = is_harness_injected_line(&parsed);
        let Some(message) = parsed.message else {
            return Ok(());
        };
        if self.model.is_none() && !message.model.trim().is_empty() {
            ensure_bounded_state_value("model", message.model.trim(), MAX_STATE_LABEL_BYTES)?;
            self.model = Some(message.model.trim().to_string());
        }
        let (input, output, cache_read, cache_write) = usage_tokens(&message.usage);
        self.input_tokens = self.input_tokens.saturating_add(input);
        self.output_tokens = self.output_tokens.saturating_add(output);
        self.cache_read_tokens = self.cache_read_tokens.saturating_add(cache_read);
        self.cache_write_tokens = self.cache_write_tokens.saturating_add(cache_write);
        let role = effective_role(&parsed.line_type, &message.role);
        if self.first_user_text.is_none() && role == "user" && !harness_injected {
            self.first_user_text = first_content_text(&message.content)
                .map(|text| imported_history::truncate_name(&text, 200));
        }
        self.feed_tool_impacts(&message.content)
    }

    fn feed_tool_impacts(&mut self, content: &Value) -> Result<(), String> {
        for block in content_blocks(content) {
            match block_type(&block) {
                "tool_result" => {
                    let Some(call_id) = block
                        .get("tool_use_id")
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty())
                    else {
                        continue;
                    };
                    let Some(index) = self
                        .pending_edits
                        .iter()
                        .position(|pending| pending.call_id == call_id)
                    else {
                        continue;
                    };
                    let pending = self.pending_edits.remove(index);
                    if block.get("is_error").and_then(Value::as_bool) != Some(true) {
                        merge_impact(&mut self.impact, &pending.impact)?;
                    }
                }
                "tool_use" => {
                    let raw_name = block.get("name").and_then(Value::as_str).unwrap_or("tool");
                    let (canonical_name, args) = normalize_tool_call(
                        raw_name,
                        block.get("input").cloned().unwrap_or(Value::Null),
                    );
                    if canonical_name != imported_history::FUNCTION_EDIT_FILE {
                        continue;
                    }
                    let call_id = block
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    ensure_bounded_state_value("tool call id", &call_id, MAX_STATE_ID_BYTES)?;
                    let call = ImportedToolCall {
                        call_id: call_id.clone(),
                        raw_name: raw_name.to_string(),
                        canonical_name,
                        args,
                        created_at: String::new(),
                    };
                    let chunk = imported_history::tool_call_chunk("", "", 0, &call, "");
                    let impact = imported_history::impact_from_edit_chunks(&[chunk]);
                    validate_impact_bounds(&impact)?;
                    if call_id.is_empty() {
                        merge_impact(&mut self.impact, &impact)?;
                    } else {
                        self.pending_edits
                            .retain(|pending| pending.call_id != call_id);
                        if self.pending_edits.len() >= MAX_PENDING_EDIT_IMPACTS {
                            return Err(format!(
                                "Incremental history state exceeds the \
                                 {MAX_PENDING_EDIT_IMPACTS}-pending-edit safety limit"
                            ));
                        }
                        self.pending_edits
                            .push(PendingEditImpact { call_id, impact });
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }

    fn validate_bounds(&self) -> Result<(), String> {
        if [
            self.input_tokens,
            self.output_tokens,
            self.cache_read_tokens,
            self.cache_write_tokens,
        ]
        .into_iter()
        .any(|value| value < 0)
        {
            return Err("Incremental history state contains negative token totals".to_string());
        }
        if let Some(value) = self.declared_session_id.as_deref() {
            ensure_bounded_state_value("session id", value, MAX_STATE_ID_BYTES)?;
        }
        if let Some(value) = self.repo_path.as_deref() {
            ensure_bounded_state_value("repository path", value, MAX_STATE_PATH_BYTES)?;
        }
        if let Some(value) = self.branch.as_deref() {
            ensure_bounded_state_value("branch", value, MAX_STATE_LABEL_BYTES)?;
        }
        if let Some(value) = self.model.as_deref() {
            ensure_bounded_state_value("model", value, MAX_STATE_LABEL_BYTES)?;
        }
        if self.pending_edits.len() > MAX_PENDING_EDIT_IMPACTS {
            return Err("Incremental history state has too many pending edits".to_string());
        }
        validate_impact_bounds(&self.impact)?;
        for pending in &self.pending_edits {
            ensure_bounded_state_value("tool call id", &pending.call_id, MAX_STATE_ID_BYTES)?;
            validate_impact_bounds(&pending.impact)?;
        }
        Ok(())
    }

    fn finish(
        mut self,
        config: &AnthropicJsonlSource,
        record: &ImportedHistoryDiscoveredRecord,
    ) -> Result<SessionMeta, String> {
        for pending in std::mem::take(&mut self.pending_edits) {
            merge_impact(&mut self.impact, &pending.impact)?;
        }
        let fallback_ms = record.source_mtime_ms / 1_000_000;
        let identity = if config.session_id_from_header {
            self.declared_session_id
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| record.source_session_id.clone())
        } else {
            record.source_session_id.clone()
        };
        Ok(SessionMeta {
            source_session_id: record.source_session_id.clone(),
            session_id: format!("{}{}", config.session_prefix, identity),
            source_path: record.source_path.to_string_lossy().to_string(),
            source_record_key: record.source_record_key.clone(),
            source_mtime_ms: record.source_mtime_ms,
            source_size_bytes: record.source_size_bytes,
            name: self
                .first_user_text
                .map(|value| imported_history::truncate_name(&value, 200))
                .unwrap_or_else(|| record.source_record_key.clone()),
            created_at_ms: if self.created_at_ms > 0 {
                self.created_at_ms
            } else {
                fallback_ms
            },
            updated_at_ms: if self.updated_at_ms > 0 {
                self.updated_at_ms
            } else {
                fallback_ms
            },
            model: self.model,
            input_tokens: self.input_tokens,
            output_tokens: self.output_tokens,
            cache_read_tokens: self.cache_read_tokens,
            cache_write_tokens: self.cache_write_tokens,
            repo_path: self.repo_path,
            branch: self.branch,
            impact: self.impact,
        })
    }
}

fn ensure_bounded_state_value(label: &str, value: &str, max_bytes: usize) -> Result<(), String> {
    if value.len() > max_bytes {
        return Err(format!(
            "Incremental history {label} exceeds the {max_bytes}-byte safety limit"
        ));
    }
    Ok(())
}

fn validate_impact_bounds(impact: &ImportedHistoryImpactStats) -> Result<(), String> {
    if impact.touched_files.len() > MAX_TOUCHED_FILES {
        return Err(format!(
            "Incremental history state exceeds the {MAX_TOUCHED_FILES}-file safety limit"
        ));
    }
    if impact
        .touched_files
        .iter()
        .any(|path| path.len() > MAX_STATE_PATH_BYTES)
    {
        return Err(format!(
            "Incremental history touched path exceeds the {MAX_STATE_PATH_BYTES}-byte safety limit"
        ));
    }
    Ok(())
}

fn merge_impact(
    target: &mut ImportedHistoryImpactStats,
    incoming: &ImportedHistoryImpactStats,
) -> Result<(), String> {
    validate_impact_bounds(target)?;
    validate_impact_bounds(incoming)?;
    target.lines_added = target.lines_added.saturating_add(incoming.lines_added);
    target.lines_removed = target.lines_removed.saturating_add(incoming.lines_removed);
    let mut paths = target
        .touched_files
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    paths.extend(incoming.touched_files.iter().cloned());
    if paths.len() > MAX_TOUCHED_FILES {
        return Err(format!(
            "Incremental history state exceeds the {MAX_TOUCHED_FILES}-file safety limit"
        ));
    }
    target.touched_files = paths.into_iter().collect();
    target.files_changed = target.touched_files.len() as i64;
    Ok(())
}

fn parse_session_meta_incremental(
    config: &AnthropicJsonlSource,
    record: &ImportedHistoryDiscoveredRecord,
    watermark: Option<&ImportedParseWatermark>,
) -> Result<IncrementalSessionMetaParse, String> {
    let mut reader = WatermarkedTranscriptReader::open(
        &record.source_path,
        config.display_name,
        watermark,
        config.parser_version,
        record.source_mtime_ms,
        record.source_size_bytes,
    )?;
    let mut state = SessionMetaState::default();
    if let Some(state_json) = reader.resume_state_json() {
        match (state_json.len() <= MAX_INCREMENTAL_STATE_BYTES)
            .then(|| serde_json::from_str::<SessionMetaState>(state_json))
        {
            Some(Ok(parsed)) if parsed.validate_bounds().is_ok() => {
                state = parsed;
            }
            _ => {
                reader = WatermarkedTranscriptReader::open(
                    &record.source_path,
                    config.display_name,
                    None,
                    config.parser_version,
                    record.source_mtime_ms,
                    record.source_size_bytes,
                )?;
            }
        }
    }
    let mut tail_state = None;
    while let Some(line) = reader.next_line()? {
        let trimmed = line.text.trim();
        if trimmed.is_empty() {
            continue;
        }
        if line.terminated {
            state.feed(trimmed)?;
        } else {
            let mut snapshot = state.clone();
            snapshot.feed(trimmed)?;
            tail_state = Some(snapshot);
        }
    }
    let state_json = serde_json::to_string(&state).map_err(|err| {
        format!(
            "Failed to serialize {} parse state: {err}",
            config.display_name
        )
    })?;
    if state_json.len() > MAX_INCREMENTAL_STATE_BYTES {
        return Err(format!(
            "{} incremental parse state exceeds the {}-byte safety limit",
            config.display_name, MAX_INCREMENTAL_STATE_BYTES
        ));
    }
    let next_watermark = reader.into_watermark(
        config.parser_version,
        record.source_mtime_ms,
        record.source_size_bytes,
        state_json,
    );
    let meta = tail_state.unwrap_or(state).finish(config, record)?;
    Ok(IncrementalSessionMetaParse {
        meta,
        watermark: next_watermark,
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
        client_origin: None,
        client_origin_raw: None,
    }
}

fn load_from_path(
    config: &AnthropicJsonlSource,
    session_id: &str,
    path: &Path,
) -> Result<Vec<ActivityChunk>, String> {
    let read = read_transcript(config, path)?;
    Ok(messages_to_chunks(config, session_id, &read.turns))
}

fn read_transcript(config: &AnthropicJsonlSource, path: &Path) -> Result<TranscriptRead, String> {
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
        value.checked_mul(1_000)
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
            .filter(|value| *value >= 0)
            .unwrap_or_default()
    };
    let cache_read = read(&[
        "cache_read_input_tokens",
        "cacheReadInputTokens",
        "cacheRead",
        "cache_read",
    ]);
    let cache_write = read(&[
        "cache_creation_input_tokens",
        "cacheCreationInputTokens",
        "cacheWrite",
        "cache_write",
    ]);
    let input = read(&["input_tokens", "inputTokens", "input"])
        .saturating_add(cache_read)
        .saturating_add(cache_write);
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
            max_discovery_depth: None,
            incremental_metadata: false,
            session_id_from_header: false,
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

    #[test]
    fn token_metadata_ignores_negatives_and_saturates() {
        assert_eq!(
            usage_tokens(&json!({
                "input": i64::MAX,
                "output": -1,
                "cacheRead": 10,
                "cacheWrite": 20
            })),
            (i64::MAX, 0, 10, 20)
        );
    }

    #[test]
    fn incremental_state_rejects_oversized_identity_and_pending_sets() {
        let mut state = SessionMetaState::default();
        let oversized_id = "x".repeat(MAX_STATE_ID_BYTES + 1);
        let line = json!({"type":"session","id":oversized_id}).to_string();
        assert!(state
            .feed(&line)
            .expect_err("oversized id")
            .contains("session id"));

        state.pending_edits = vec![PendingEditImpact::default(); MAX_PENDING_EDIT_IMPACTS + 1];
        assert!(state
            .validate_bounds()
            .expect_err("oversized pending state")
            .contains("pending edits"));
    }
}

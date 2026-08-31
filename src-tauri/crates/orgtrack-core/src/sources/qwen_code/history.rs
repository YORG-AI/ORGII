//! Bounded imported-history reader for Qwen Code.
//!
//! Qwen writes append-only JSONL transcripts at exactly
//! `~/.qwen/projects/<project>/chats/<session>.jsonl`. Metadata sync uses the
//! shared byte watermark, so a warm append validates only the 4 KiB seam and
//! parses the new suffix. There is no watcher, timer, subprocess, or fallback
//! home scan.

use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::{Component, Path, PathBuf};

use core_types::activity::ActivityChunk;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::sources::imported_history::{
    self, cache as imported_cache,
    metadata::{
        ImportedHistoryCacheInput, ImportedHistoryDiscoveredRecord, ImportedHistoryImpactStats,
        RoundUsage, StoredRoundUsage, SOURCE_QWEN_CODE,
    },
    paths as imported_paths, scan_snapshot,
    watermark::{ImportedParseWatermark, WatermarkedTranscriptReader},
    ImportedHistoryRecentPath, ImportedHistorySessionPage, ImportedToolCall,
};

pub const QWEN_CODE_SESSION_PREFIX: &str = "qwencodeapp-";
const QWEN_CODE_PARSER_VERSION: i64 = 2;

const MAX_TRANSCRIPT_BYTES: i64 = 64 * 1024 * 1024;
const MAX_CHANGED_SESSIONS_PER_SYNC: usize = 256;
const MAX_CHANGED_BYTES_PER_SYNC: i64 = 64 * 1024 * 1024;
const MAX_STATE_JSON_BYTES: usize = 4 * 1024 * 1024;
const MAX_STORED_ROUNDS: usize = 4_096;
const MAX_SESSION_ID_BYTES: usize = 512;
const MAX_MODEL_BYTES: usize = 512;
const MAX_PATH_BYTES: usize = 4_096;
const MAX_BRANCH_BYTES: usize = 512;
const MAX_ACTIVITY_CHUNKS: usize = 4_096;
const MAX_ACTIVITY_TEXT_CHARS: usize = 4 * 1024 * 1024;
const MAX_TEXT_CHARS_PER_CHUNK: usize = 50_000;
const MAX_TOOL_CALLS_IN_FLIGHT: usize = 1_024;
const MAX_TOOL_ARGS_BYTES: usize = 64 * 1024;

pub type QwenCodeRecentPath = ImportedHistoryRecentPath;

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct QwenLine {
    #[serde(rename = "type")]
    line_type: String,
    #[serde(rename = "sessionId")]
    session_id: String,
    timestamp: String,
    cwd: String,
    #[serde(rename = "gitBranch")]
    git_branch: String,
    model: String,
    message: Option<QwenMessage>,
    #[serde(rename = "usageMetadata")]
    usage_metadata: Option<QwenUsageMetadata>,
    #[serde(rename = "systemPayload")]
    system_payload: Value,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct QwenMessage {
    role: String,
    parts: Vec<Value>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct QwenUsageMetadata {
    #[serde(rename = "promptTokenCount")]
    prompt_token_count: Option<i64>,
    #[serde(rename = "candidatesTokenCount")]
    candidates_token_count: Option<i64>,
    #[serde(rename = "thoughtsTokenCount")]
    thoughts_token_count: Option<i64>,
    #[serde(rename = "cachedContentTokenCount")]
    cached_content_token_count: Option<i64>,
    #[serde(rename = "totalTokenCount")]
    total_token_count: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
struct QwenParseState {
    canonical_source_session_id: String,
    created_at_ms: i64,
    updated_at_ms: i64,
    custom_title: String,
    first_user_text: String,
    model: Option<String>,
    repo_path: Option<String>,
    branch: Option<String>,
    /// Qwen's prompt count is cache-inclusive.
    input_tokens: i64,
    /// ORGII has no reasoning bucket, so candidates + thoughts are folded
    /// into output to preserve the provider's reported total.
    output_tokens: i64,
    cache_read_tokens: i64,
    next_round_seq: i64,
    rounds: VecDeque<StoredRoundUsage>,
}

impl QwenParseState {
    fn validate(&self) -> bool {
        self.canonical_source_session_id.len() <= MAX_SESSION_ID_BYTES
            && self.custom_title.chars().count() <= 200
            && self.first_user_text.chars().count() <= 200
            && self
                .model
                .as_deref()
                .is_none_or(|value| value.len() <= MAX_MODEL_BYTES)
            && self
                .repo_path
                .as_deref()
                .is_none_or(|value| value.len() <= MAX_PATH_BYTES)
            && self
                .branch
                .as_deref()
                .is_none_or(|value| value.len() <= MAX_BRANCH_BYTES)
            && self.input_tokens >= 0
            && self.output_tokens >= 0
            && self.cache_read_tokens >= 0
            && self.next_round_seq >= 0
            && self.rounds.len() <= MAX_STORED_ROUNDS
            && self.rounds.iter().all(|round| {
                round.seq >= 0
                    && round
                        .model
                        .as_deref()
                        .is_none_or(|value| value.len() <= MAX_MODEL_BYTES)
                    && round.input_tokens >= 0
                    && round.output_tokens >= 0
                    && round.cache_read_tokens >= 0
                    && round.cache_write_tokens >= 0
            })
    }

    fn feed(&mut self, raw: &str) {
        let parsed = match serde_json::from_str::<QwenLine>(raw) {
            Ok(parsed) => parsed,
            Err(_) => return,
        };

        if self.canonical_source_session_id.is_empty() {
            self.canonical_source_session_id =
                bounded_nonempty(&parsed.session_id, MAX_SESSION_ID_BYTES).unwrap_or_default();
        }
        if let Some(timestamp) = imported_history::parse_iso_to_epoch_ms_opt(&parsed.timestamp) {
            if self.created_at_ms == 0 || timestamp < self.created_at_ms {
                self.created_at_ms = timestamp;
            }
            self.updated_at_ms = self.updated_at_ms.max(timestamp);
        }
        if self.repo_path.is_none() {
            self.repo_path = bounded_nonempty(&parsed.cwd, MAX_PATH_BYTES);
        }
        if self.branch.is_none() {
            self.branch = bounded_nonempty(&parsed.git_branch, MAX_BRANCH_BYTES);
        }
        if !parsed.model.trim().is_empty() {
            self.model = bounded_nonempty(&parsed.model, MAX_MODEL_BYTES);
        }
        if parsed.line_type == "system" {
            if let Some(title) = parsed
                .system_payload
                .get("title")
                .and_then(Value::as_str)
                .filter(|title| !title.trim().is_empty())
            {
                self.custom_title = imported_history::truncate_name(title.trim(), 200);
            }
        }
        if let Some(message) = parsed.message.as_ref() {
            if self.first_user_text.is_empty()
                && effective_role(&parsed.line_type, &message.role) == "user"
            {
                self.first_user_text = first_text(&message.parts)
                    .map(|value| imported_history::truncate_name(value.trim(), 200))
                    .unwrap_or_default();
            }
        }

        if parsed.line_type != "assistant" {
            return;
        }
        let Some(usage) = parsed.usage_metadata else {
            return;
        };
        let prompt = nonnegative(usage.prompt_token_count);
        let cache_read = nonnegative(usage.cached_content_token_count).min(prompt);
        let output = qwen_output_tokens(&usage, prompt);
        if prompt == 0 && output == 0 && cache_read == 0 {
            return;
        }

        self.input_tokens = self.input_tokens.saturating_add(prompt);
        self.output_tokens = self.output_tokens.saturating_add(output);
        self.cache_read_tokens = self.cache_read_tokens.saturating_add(cache_read);

        let created_at_ms = imported_history::parse_iso_to_epoch_ms_opt(&parsed.timestamp)
            .unwrap_or(self.updated_at_ms);
        let model = bounded_nonempty(&parsed.model, MAX_MODEL_BYTES).or_else(|| self.model.clone());
        self.push_round(StoredRoundUsage {
            seq: self.next_round_seq,
            model,
            // RoundUsage is fresh-input grain, unlike the cache-inclusive
            // session aggregate.
            input_tokens: prompt.saturating_sub(cache_read),
            output_tokens: output,
            cache_read_tokens: cache_read,
            cache_write_tokens: 0,
            created_at_ms,
        });
        self.next_round_seq = self.next_round_seq.saturating_add(1);
    }

    fn push_round(&mut self, round: StoredRoundUsage) {
        self.rounds.push_back(round);
        if self.rounds.len() > MAX_STORED_ROUNDS {
            self.rounds.pop_front();
        }
    }

    fn finish(
        self,
        record: &ImportedHistoryDiscoveredRecord,
    ) -> (ImportedHistoryCacheInput, Vec<RoundUsage>) {
        let fallback_ms = record.source_mtime_ms / 1_000_000;
        let canonical_source_session_id = if self.canonical_source_session_id.is_empty() {
            fallback_session_id(&record.source_session_id)
        } else {
            self.canonical_source_session_id
        };
        let session_id = format!("{QWEN_CODE_SESSION_PREFIX}{canonical_source_session_id}");
        let rounds = self
            .rounds
            .into_iter()
            .map(|round| {
                round.into_round_usage(SOURCE_QWEN_CODE, &record.source_session_id, &session_id)
            })
            .collect();
        let name = if !self.custom_title.is_empty() {
            self.custom_title
        } else if !self.first_user_text.is_empty() {
            self.first_user_text
        } else {
            record.source_record_key.clone()
        };
        (
            ImportedHistoryCacheInput {
                source: SOURCE_QWEN_CODE,
                source_session_id: record.source_session_id.clone(),
                session_id,
                source_path: record.source_path.to_string_lossy().to_string(),
                source_record_key: record.source_record_key.clone(),
                source_mtime_ms: record.source_mtime_ms,
                source_size_bytes: record.source_size_bytes,
                source_fingerprint: record.source_fingerprint.clone(),
                parser_version: QWEN_CODE_PARSER_VERSION,
                name,
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
                cache_write_tokens: 0,
                repo_path: self.repo_path,
                branch: self.branch,
                impact: ImportedHistoryImpactStats::default(),
                listable: true,
                source_metadata_json: None,
                parent_session_id: None,
                client_origin: None,
                client_origin_raw: None,
            },
            rounds,
        )
    }
}

struct QwenMetaParse {
    input: ImportedHistoryCacheInput,
    rounds: Vec<RoundUsage>,
    watermark: ImportedParseWatermark,
    #[cfg_attr(not(test), allow(dead_code))]
    resumed: bool,
    #[cfg(test)]
    lines_processed: usize,
}

pub fn list_qwen_code_history_sessions_paginated(
    conn: &mut Connection,
    limit: usize,
    offset: usize,
) -> Result<ImportedHistorySessionPage, String> {
    sync_qwen_code_history_cache(conn)?;
    imported_cache::query_imported_session_page_from_conn(conn, SOURCE_QWEN_CODE, limit, offset)
}

pub fn list_qwen_code_recent_paths(
    conn: &mut Connection,
    limit: usize,
) -> Result<Vec<QwenCodeRecentPath>, String> {
    sync_qwen_code_history_cache(conn)?;
    imported_cache::query_imported_recent_paths_from_conn(conn, SOURCE_QWEN_CODE, limit)
}

pub fn load_qwen_code_history_for_session(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<ActivityChunk>, String> {
    if !session_id.starts_with(QWEN_CODE_SESSION_PREFIX) {
        return Err(format!("Invalid Qwen Code session id: {session_id}"));
    }
    let (source, cached) =
        imported_cache::query_cached_session_by_session_id_from_conn(conn, session_id)?
            .ok_or_else(|| format!("Qwen Code session not found: {session_id}"))?;
    if source != SOURCE_QWEN_CODE {
        return Err(format!("Invalid Qwen Code session source: {source}"));
    }
    let path = Path::new(&cached.source_path);
    let root = qwen_code_history_root();
    load_activity_from_path(path, &root, session_id)
}

fn load_activity_from_path(
    path: &Path,
    root: &Path,
    session_id: &str,
) -> Result<Vec<ActivityChunk>, String> {
    ensure_exact_safe_transcript(path, root)?;
    let (mtime, size) = imported_paths::file_metadata_signature(path, "Qwen Code")?;
    ensure_file_size(size)?;
    let mut reader = WatermarkedTranscriptReader::open(
        path,
        "Qwen Code",
        None,
        QWEN_CODE_PARSER_VERSION,
        mtime,
        size,
    )?;
    let mut builder = ActivityBuilder::new(session_id);
    while let Some(line) = reader.next_line()? {
        builder.feed(line.text.trim());
    }
    Ok(builder.finish())
}

pub fn qwen_code_history_root() -> PathBuf {
    app_paths::external_history_home_dir().join(".qwen/projects")
}

fn sync_qwen_code_history_cache(conn: &mut Connection) -> Result<(), String> {
    sync_qwen_code_history_cache_at_root(conn, &qwen_code_history_root())
}

fn sync_qwen_code_history_cache_at_root(conn: &mut Connection, root: &Path) -> Result<(), String> {
    let previous_snapshots = scan_snapshot::read_dir_snapshots_from_conn(conn, SOURCE_QWEN_CODE);
    let mut walker =
        scan_snapshot::SnapshotDirWalker::new(&previous_snapshots, "jsonl", "Qwen Code");
    let discovered = discover_records(root, &mut walker)?;
    let next_snapshots = walker.into_snapshots();
    scan_snapshot::persist_dir_snapshots_if_changed(
        conn,
        SOURCE_QWEN_CODE,
        &previous_snapshots,
        &next_snapshots,
    )?;
    let signatures = discovered
        .iter()
        .map(ImportedHistoryDiscoveredRecord::signature)
        .collect::<Vec<_>>();
    let mut changed = imported_cache::changed_records_from_conn(
        conn,
        SOURCE_QWEN_CODE,
        &discovered,
        ImportedHistoryDiscoveredRecord::signature,
    )?;
    changed.sort_by(|left, right| {
        right
            .source_mtime_ms
            .cmp(&left.source_mtime_ms)
            .then_with(|| left.source_session_id.cmp(&right.source_session_id))
    });

    let mut processed_sessions = 0_usize;
    let mut processed_bytes = 0_i64;
    for record in changed {
        if processed_sessions >= MAX_CHANGED_SESSIONS_PER_SYNC
            || (processed_sessions > 0
                && processed_bytes.saturating_add(record.source_size_bytes)
                    > MAX_CHANGED_BYTES_PER_SYNC)
        {
            break;
        }
        let stored = imported_history::watermark::read_parse_watermark_from_conn(
            conn,
            SOURCE_QWEN_CODE,
            &record.source_session_id,
        )?;
        let Some(parsed) = imported_history::skip_unparsable_record(
            SOURCE_QWEN_CODE,
            &record.source_session_id,
            parse_qwen_session_meta(record, stored.as_ref(), root),
        ) else {
            continue;
        };
        // Recovery invariant: rounds and watermark are written first, while
        // the cache signature remains old. Any failure before the final cache
        // upsert therefore leaves this record eligible on the next demand
        // scan; a resumed retry reconstructs the same bounded state.
        imported_cache::write_session_rounds_from_conn(
            conn,
            std::slice::from_ref(&parsed.input.session_id),
            &parsed.rounds,
        )?;
        imported_history::watermark::write_parse_watermark_from_conn(
            conn,
            SOURCE_QWEN_CODE,
            &parsed.input.source_session_id,
            &parsed.watermark,
        )?;
        imported_cache::upsert_imported_session_cache_from_conn(
            conn,
            std::slice::from_ref(&parsed.input),
        )?;
        processed_sessions = processed_sessions.saturating_add(1);
        processed_bytes = processed_bytes.saturating_add(record.source_size_bytes);
    }
    imported_cache::sync_source_cache_from_conn(
        conn,
        SOURCE_QWEN_CODE,
        imported_cache::live_ids_from_signatures(&signatures),
        Vec::new(),
    )
}

fn parse_qwen_session_meta(
    record: &ImportedHistoryDiscoveredRecord,
    watermark: Option<&ImportedParseWatermark>,
    root: &Path,
) -> Result<QwenMetaParse, String> {
    ensure_exact_safe_transcript(&record.source_path, root)?;
    ensure_file_size(record.source_size_bytes)?;
    let mut reader = WatermarkedTranscriptReader::open(
        &record.source_path,
        "Qwen Code",
        watermark,
        QWEN_CODE_PARSER_VERSION,
        record.source_mtime_ms,
        record.source_size_bytes,
    )?;
    let mut state = QwenParseState::default();
    let mut resumed = false;
    if let Some(state_json) = reader.resume_state_json() {
        let parsed = (state_json.len() <= MAX_STATE_JSON_BYTES)
            .then(|| serde_json::from_str::<QwenParseState>(state_json).ok())
            .flatten()
            .filter(QwenParseState::validate);
        if let Some(parsed) = parsed {
            state = parsed;
            resumed = true;
        } else {
            reader = WatermarkedTranscriptReader::open(
                &record.source_path,
                "Qwen Code",
                None,
                QWEN_CODE_PARSER_VERSION,
                record.source_mtime_ms,
                record.source_size_bytes,
            )?;
        }
    }

    let mut tail_state = None;
    #[cfg(test)]
    let mut lines_processed = 0;
    while let Some(line) = reader.next_line()? {
        #[cfg(test)]
        {
            lines_processed += 1;
        }
        let trimmed = line.text.trim();
        if trimmed.is_empty() {
            continue;
        }
        if line.terminated {
            state.feed(trimmed);
        } else {
            let mut snapshot = state.clone();
            snapshot.feed(trimmed);
            tail_state = Some(snapshot);
        }
    }
    let state_json = serde_json::to_string(&state)
        .map_err(|err| format!("Failed to serialize Qwen Code parse state: {err}"))?;
    if state_json.len() > MAX_STATE_JSON_BYTES {
        return Err(format!(
            "Failed to serialize Qwen Code parse state: state exceeds {MAX_STATE_JSON_BYTES} bytes"
        ));
    }
    let next_watermark = reader.into_watermark(
        QWEN_CODE_PARSER_VERSION,
        record.source_mtime_ms,
        record.source_size_bytes,
        state_json,
    );
    let (input, rounds) = tail_state.unwrap_or(state).finish(record);
    Ok(QwenMetaParse {
        input,
        rounds,
        watermark: next_watermark,
        resumed,
        #[cfg(test)]
        lines_processed,
    })
}

fn discover_records(
    root: &Path,
    walker: &mut scan_snapshot::SnapshotDirWalker<'_>,
) -> Result<Vec<ImportedHistoryDiscoveredRecord>, String> {
    let root_metadata = match fs::symlink_metadata(root) {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(format!("Failed to inspect Qwen Code history root: {err}")),
    };
    if root_metadata.file_type().is_symlink() {
        return Err("Refusing symlinked Qwen Code history root".to_string());
    }
    if !root_metadata.is_dir() {
        return Ok(Vec::new());
    }

    let mut paths = Vec::new();
    walker.collect_files_bounded(root, &mut paths, 2)?;
    let mut records = Vec::with_capacity(paths.len());
    for path in paths {
        let Some((project_name, file_stem)) = qwen_source_parts(&path, root) else {
            continue;
        };
        ensure_exact_safe_transcript(&path, root)?;
        let (mtime, size) = imported_paths::file_metadata_signature(&path, "Qwen Code")?;
        ensure_file_size(size)?;
        let source_session_id = format!("{project_name}/{file_stem}");
        records.push(ImportedHistoryDiscoveredRecord {
            source_session_id: source_session_id.clone(),
            source_path: path,
            source_record_key: source_session_id,
            source_mtime_ms: mtime,
            source_size_bytes: size,
            source_fingerprint: String::new(),
            parser_version: QWEN_CODE_PARSER_VERSION,
        });
    }
    Ok(records)
}

fn qwen_source_parts(path: &Path, root: &Path) -> Option<(String, String)> {
    let relative = path.strip_prefix(root).ok()?;
    let mut components = relative.components();
    let project_name = match components.next()? {
        Component::Normal(name) => name.to_str()?,
        _ => return None,
    };
    if project_name.is_empty() || project_name.len() > MAX_PATH_BYTES {
        return None;
    }
    if !matches!(
        components.next(),
        Some(Component::Normal(name)) if name == std::ffi::OsStr::new("chats")
    ) {
        return None;
    }
    let filename = match components.next()? {
        Component::Normal(name) => name,
        _ => return None,
    };
    if components.next().is_some() || Path::new(filename).extension()? != "jsonl" {
        return None;
    }
    let file_stem = Path::new(filename).file_stem()?.to_str()?;
    if file_stem.is_empty() || file_stem.len() > MAX_SESSION_ID_BYTES {
        return None;
    }
    Some((project_name.to_string(), file_stem.to_string()))
}

fn ensure_exact_safe_transcript(path: &Path, root: &Path) -> Result<(), String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "Qwen Code transcript escaped the configured history root".to_string())?;
    let mut components = relative.components();
    let exact_shape = matches!(components.next(), Some(Component::Normal(_)))
        && matches!(
            components.next(),
            Some(Component::Normal(name)) if name == std::ffi::OsStr::new("chats")
        )
        && matches!(components.next(), Some(Component::Normal(_)))
        && components.next().is_none()
        && path
            .extension()
            .is_some_and(|extension| extension == "jsonl");
    if !exact_shape {
        return Err("Qwen Code transcript is outside projects/<project>/chats/*.jsonl".to_string());
    }

    for directory in [
        root,
        path.parent()
            .and_then(Path::parent)
            .ok_or_else(|| "Qwen Code transcript has no project directory".to_string())?,
        path.parent()
            .ok_or_else(|| "Qwen Code transcript has no chats directory".to_string())?,
    ] {
        let metadata = fs::symlink_metadata(directory)
            .map_err(|err| format!("Failed to inspect Qwen Code history directory: {err}"))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("Refusing symlinked Qwen Code history directory".to_string());
        }
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|err| format!("Failed to inspect Qwen Code transcript: {err}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Refusing symlinked or non-file Qwen Code transcript".to_string());
    }
    Ok(())
}

fn ensure_file_size(size: i64) -> Result<(), String> {
    if !(0..=MAX_TRANSCRIPT_BYTES).contains(&size) {
        return Err(format!(
            "Qwen Code transcript exceeds {MAX_TRANSCRIPT_BYTES} bytes"
        ));
    }
    Ok(())
}

fn fallback_session_id(source_session_id: &str) -> String {
    let mut parts = source_session_id.split('/');
    let project = parts.next().unwrap_or("unknown");
    let filename = parts.next().unwrap_or("unknown");
    format!("{project}-{filename}")
}

fn bounded_nonempty(value: &str, max_bytes: usize) -> Option<String> {
    let trimmed = value.trim();
    bounded_bytes(trimmed, max_bytes).filter(|value| !value.is_empty())
}

fn bounded_bytes(value: &str, max_bytes: usize) -> Option<String> {
    (value.len() <= max_bytes).then(|| value.to_string())
}

fn nonnegative(value: Option<i64>) -> i64 {
    value.unwrap_or_default().max(0)
}

fn qwen_output_tokens(usage: &QwenUsageMetadata, prompt: i64) -> i64 {
    if let Some(total) = usage.total_token_count {
        return total.saturating_sub(prompt).max(0);
    }
    let candidates = nonnegative(usage.candidates_token_count);
    let thoughts = nonnegative(usage.thoughts_token_count);
    // Official Qwen Code treats a strictly larger candidate count as
    // potentially including thoughts. Equality does not prove overlap.
    if candidates > thoughts {
        candidates
    } else {
        candidates.saturating_add(thoughts)
    }
}

fn effective_role<'a>(line_type: &'a str, message_role: &'a str) -> &'a str {
    if message_role.trim().is_empty() {
        line_type
    } else {
        message_role
    }
}

fn first_text(parts: &[Value]) -> Option<&str> {
    parts
        .iter()
        .find_map(|part| part.get("text").and_then(Value::as_str))
        .filter(|text| !text.trim().is_empty())
}

struct ActivityBuilder<'a> {
    session_id: &'a str,
    chunks: Vec<ActivityChunk>,
    pending_tools: HashMap<String, usize>,
    sequence: usize,
    text_chars: usize,
}

impl<'a> ActivityBuilder<'a> {
    fn new(session_id: &'a str) -> Self {
        Self {
            session_id,
            chunks: Vec::new(),
            pending_tools: HashMap::new(),
            sequence: 0,
            text_chars: 0,
        }
    }

    fn feed(&mut self, raw: &str) {
        if raw.is_empty() {
            return;
        }
        let parsed = match serde_json::from_str::<QwenLine>(raw) {
            Ok(parsed) => parsed,
            Err(_) => return,
        };
        let Some(message) = parsed.message else {
            return;
        };
        let created_at = imported_history::normalize_created_at(&parsed.timestamp);
        let role = effective_role(&parsed.line_type, &message.role);
        for part in message.parts {
            if let Some(text) = part.get("text").and_then(Value::as_str) {
                if parsed.line_type == "tool_result" {
                    continue;
                }
                let Some(text) = self.reserve_text(text) else {
                    continue;
                };
                let chunk = if part.get("thought").and_then(Value::as_bool) == Some(true) {
                    imported_history::thinking_chunk(
                        self.session_id,
                        "qwen",
                        self.sequence,
                        &created_at,
                        &text,
                    )
                } else if role == "user" {
                    imported_history::user_message_chunk(
                        self.session_id,
                        "qwen",
                        self.sequence,
                        &created_at,
                        &text,
                    )
                } else {
                    imported_history::assistant_message_chunk(
                        self.session_id,
                        "qwen",
                        self.sequence,
                        &created_at,
                        &text,
                    )
                };
                self.push_chunk(chunk);
            }
            if let Some(call) = part.get("functionCall") {
                self.push_tool_call(call, &created_at);
            }
            if let Some(response) = part.get("functionResponse") {
                self.attach_tool_response(response);
            }
        }
    }

    fn reserve_text(&mut self, value: &str) -> Option<String> {
        let remaining = MAX_ACTIVITY_TEXT_CHARS.saturating_sub(self.text_chars);
        if remaining == 0 {
            return None;
        }
        let cap = remaining.min(MAX_TEXT_CHARS_PER_CHUNK);
        let text = truncate_chars(value.trim(), cap);
        if text.is_empty() {
            return None;
        }
        self.text_chars = self.text_chars.saturating_add(text.chars().count());
        Some(text)
    }

    fn push_chunk(&mut self, chunk: ActivityChunk) {
        if self.chunks.len() >= MAX_ACTIVITY_CHUNKS {
            return;
        }
        self.chunks.push(chunk);
        self.sequence += 1;
    }

    fn push_tool_call(&mut self, call: &Value, created_at: &str) {
        if self.chunks.len() >= MAX_ACTIVITY_CHUNKS {
            return;
        }
        let raw_name = call
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("tool")
            .to_string();
        let explicit_id = call
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let call_id = explicit_id
            .clone()
            .unwrap_or_else(|| format!("qwen-call-{}", self.sequence));
        let args = bounded_json_value(call.get("args").unwrap_or(&Value::Null));
        let (canonical_name, args) = normalize_tool_call(&raw_name, args);
        let imported = ImportedToolCall {
            call_id: call_id.clone(),
            raw_name,
            canonical_name,
            args,
            created_at: created_at.to_string(),
        };
        let index = self.chunks.len();
        let chunk = imported_history::tool_call_chunk(
            self.session_id,
            "qwen",
            self.sequence,
            &imported,
            "",
        );
        self.push_chunk(chunk);
        if explicit_id.is_some() && self.pending_tools.len() < MAX_TOOL_CALLS_IN_FLIGHT {
            self.pending_tools.insert(call_id, index);
        }
    }

    fn attach_tool_response(&mut self, response: &Value) {
        let Some(call_id) = response
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        else {
            return;
        };
        let Some(index) = self.pending_tools.remove(call_id) else {
            return;
        };
        let Some(chunk) = self.chunks.get_mut(index) else {
            return;
        };
        let body = response
            .get("response")
            .or_else(|| response.get("result"))
            .unwrap_or(&Value::Null);
        let output = value_to_bounded_text(body);
        let failed = body
            .as_object()
            .is_some_and(|object| object.contains_key("error"));
        if let Some(result) = chunk.result.as_object_mut() {
            result.insert("output".to_string(), Value::String(output.clone()));
            result.insert("observation".to_string(), Value::String(output));
            if failed {
                result.insert("success".to_string(), Value::Bool(false));
                result.insert("status".to_string(), Value::String("failed".to_string()));
            }
        }
    }

    fn finish(self) -> Vec<ActivityChunk> {
        self.chunks
    }
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        value.to_string()
    } else {
        value.chars().take(max_chars).collect()
    }
}

fn bounded_json_value(value: &Value) -> Value {
    match serde_json::to_vec(value) {
        Ok(encoded) if encoded.len() <= MAX_TOOL_ARGS_BYTES => value.clone(),
        Ok(encoded) => json!({
            "truncated": true,
            "originalBytes": encoded.len(),
        }),
        Err(_) => json!({ "truncated": true }),
    }
}

fn value_to_bounded_text(value: &Value) -> String {
    let display_value = value
        .as_object()
        .and_then(|object| object.get("output").or_else(|| object.get("result")))
        .unwrap_or(value);
    let raw = display_value
        .as_str()
        .map(str::to_string)
        .or_else(|| serde_json::to_string(display_value).ok())
        .unwrap_or_default();
    truncate_chars(raw.trim(), MAX_TEXT_CHARS_PER_CHUNK)
}

fn normalize_tool_call(raw_name: &str, args: Value) -> (String, Value) {
    match raw_name.to_ascii_lowercase().as_str() {
        "run_shell_command" | "shell" | "bash" | "execute" => {
            let command = args
                .get("command")
                .and_then(Value::as_str)
                .unwrap_or_default();
            (
                imported_history::FUNCTION_RUN_COMMAND_LINE.to_string(),
                json!({ "command": command, "cmd": command, "payload": args }),
            )
        }
        "write_file" | "replace" | "edit" | "apply_patch" => {
            let file_path = args
                .get("file_path")
                .and_then(Value::as_str)
                .or_else(|| args.get("filePath").and_then(Value::as_str))
                .or_else(|| args.get("path").and_then(Value::as_str))
                .unwrap_or_default();
            (
                imported_history::FUNCTION_EDIT_FILE.to_string(),
                json!({ "action": raw_name, "file_path": file_path, "payload": args }),
            )
        }
        "read_file" => (imported_history::FUNCTION_READ_FILE.to_string(), args),
        "grep_search" | "search_file_content" => {
            (imported_history::FUNCTION_CODE_SEARCH.to_string(), args)
        }
        _ => (raw_name.to_string(), args),
    }
}

#[cfg(test)]
#[path = "history_tests.rs"]
mod tests;

//! Codex app event reader
//!
//! Reads Codex rollout JSONL files from `~/.codex/sessions/YYYY/MM/DD/` and
//! converts them into ORGII's canonical `ActivityChunk` shape. These rows are
//! imported history only: ORGII does not own the Codex process or write back to
//! Codex's local files.

use std::collections::{BTreeSet, HashMap, HashSet};
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
        SOURCE_CODEX_APP,
    },
    paths as imported_paths, strip_orgii_exec_mode_bridge, ImportedHistoryRecentPath,
    ImportedHistorySessionPage, ImportedHistorySessionRow, ImportedToolCall,
};
use crate::store::{sqlite::SqliteRecordStore, RecordStore};

mod desktop_exec;

use desktop_exec::{
    codex_tool_exit_code, codex_tool_output_failed, codex_tool_output_text,
    normalize_codex_exec_tool_calls,
};

use super::SESSION_PREFIX as CODEX_APP_SESSION_PREFIX;
const CODEX_PROVIDER_SLUG: &str = "codex";
// v9: derive impact from authoritative `patch_apply_end` events (structured
// `changes` map with unified diffs) instead of only scanning `apply_patch`
// tool calls, so `exec`-wrapped and other edit paths are counted too.
const CODEX_APP_METADATA_PARSER_VERSION: i64 = 9;

pub type CodexAppSessionRow = ImportedHistorySessionRow;
pub type CodexAppSessionPage = ImportedHistorySessionPage;
pub type CodexAppRecentPath = ImportedHistoryRecentPath;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexTranscriptLocator {
    pub source_session_id: String,
    pub session_id: String,
    pub source_path: PathBuf,
}

#[derive(Debug, Clone)]
struct CodexAppSessionMeta {
    source_session_id: String,
    session_id: String,
    source_path: String,
    source_record_key: String,
    source_mtime_ms: i64,
    source_size_bytes: i64,
    source_fingerprint: String,
    name: String,
    parent_session_id: Option<String>,
    created_at_ms: i64,
    updated_at_ms: i64,
    model: Option<String>,
    repo_path: Option<String>,
    input_tokens: i64,
    output_tokens: i64,
    impact: ImportedHistoryImpactStats,
}

#[derive(Debug, Deserialize)]
struct CodexJsonlLine {
    #[serde(default)]
    timestamp: Option<String>,
    #[serde(default, rename = "type")]
    line_type: String,
    #[serde(default)]
    payload: Value,
}

#[derive(Debug, Deserialize)]
struct CodexTurnContextPayload {
    #[serde(default)]
    cwd: String,
    #[serde(default)]
    model: String,
}

#[derive(Debug, Clone)]
struct CodexSessionIndexEntry {
    thread_name: String,
    updated_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CodexSessionIndexLine {
    #[serde(default)]
    id: String,
    #[serde(default)]
    thread_name: String,
    #[serde(default)]
    updated_at: Option<String>,
}

struct PendingBackgroundToolCall {
    calls: Vec<ImportedToolCall>,
    latest_output: String,
}

pub fn list_codex_app_sessions_paginated(
    conn: &mut Connection,
    limit: usize,
    offset: usize,
) -> Result<CodexAppSessionPage, String> {
    sync_codex_app_cache(conn)?;
    imported_cache::query_imported_session_page_from_conn(conn, SOURCE_CODEX_APP, limit, offset)
}

pub fn list_codex_app_recent_paths(
    conn: &mut Connection,
    limit: usize,
) -> Result<Vec<CodexAppRecentPath>, String> {
    sync_codex_app_cache(conn)?;
    imported_cache::query_imported_recent_paths_from_conn(conn, SOURCE_CODEX_APP, limit)
}

pub fn load_codex_app_for_session(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<ActivityChunk>, String> {
    let file_stem = codex_file_stem_from_session_id(session_id)?;
    let path = resolve_codex_session_path(conn, file_stem)?;
    load_codex_app_from_path(session_id, &path)
}

fn sync_codex_app_cache(conn: &mut Connection) -> Result<(), String> {
    let mut discovered = discover_codex_app_records()?;
    // Managed (GUI-launched) Codex sessions surface through their
    // code_sessions row (`cli_agent_type = 'codex'`); the imported twin goes
    // unlistable. Same pattern as the OpenCode/Claude readers.
    let managed_ids = crate::sources::imported_history::managed_mirror::
        managed_source_session_ids_from_conn(conn, "codex", SOURCE_CODEX_APP)?;
    for record in &mut discovered {
        crate::sources::imported_history::managed_mirror::append_managed_fingerprint(
            &mut record.source_fingerprint,
            // Suffix match: the imported key is the rollout stem while the
            // runner binds the bare thread uuid.
            crate::sources::imported_history::managed_mirror::is_managed_source_session_id(
                &managed_ids,
                &record.source_session_id,
            ),
        );
    }
    let signatures = discovered
        .iter()
        .map(ImportedHistoryDiscoveredRecord::signature)
        .collect::<Vec<_>>();
    let changed =
        imported_cache::changed_records_from_conn(conn, SOURCE_CODEX_APP, &discovered, |record| {
            record.signature()
        })?;
    let mut inputs = Vec::new();
    for record in changed {
        if let Some(meta) = parse_codex_session_meta(record)? {
            let is_managed_history_mirror =
                crate::sources::imported_history::managed_mirror::is_managed_source_session_id(
                    &managed_ids,
                    &meta.source_session_id,
                );
            let mut input = session_meta_to_cache_input(meta);
            input.listable = input.listable && !is_managed_history_mirror;
            inputs.push(input);
        }
    }
    imported_cache::sync_source_cache_from_conn(
        conn,
        SOURCE_CODEX_APP,
        imported_cache::live_ids_from_signatures(&signatures),
        inputs,
    )
}

fn discover_codex_app_records() -> Result<Vec<ImportedHistoryDiscoveredRecord>, String> {
    let mut sessions = Vec::new();
    for sessions_dir in codex_sessions_dirs()? {
        if sessions_dir.is_dir() {
            let title_index = load_codex_session_index_for_sessions_dir(&sessions_dir)?;
            let mut files = Vec::new();
            collect_codex_session_files(&sessions_dir, &mut files)?;
            for path in files {
                let Some(file_stem) = path
                    .file_stem()
                    .and_then(|value| value.to_str())
                    .map(ToString::to_string)
                else {
                    continue;
                };
                let (source_mtime_ms, source_size_bytes) =
                    imported_paths::file_metadata_signature(&path, "Codex")?;
                let source_fingerprint = codex_source_fingerprint(&file_stem, &title_index);
                sessions.push(ImportedHistoryDiscoveredRecord {
                    source_session_id: file_stem.clone(),
                    source_path: path,
                    source_record_key: file_stem,
                    source_mtime_ms,
                    source_size_bytes,
                    source_fingerprint,
                    parser_version: CODEX_APP_METADATA_PARSER_VERSION,
                });
            }
        }
    }
    Ok(sessions)
}

fn collect_codex_session_files(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|err| format!("Failed to read Codex dir: {err}"))? {
        let entry = entry.map_err(|err| format!("Failed to read Codex dir entry: {err}"))?;
        let path = entry.path();
        if path.is_dir() {
            collect_codex_session_files(&path, out)?;
        } else if path
            .extension()
            .is_some_and(|extension| extension == "jsonl")
        {
            out.push(path);
        }
    }
    Ok(())
}

fn load_codex_session_index_for_sessions_dir(
    sessions_dir: &Path,
) -> Result<HashMap<String, CodexSessionIndexEntry>, String> {
    let Some(root) = sessions_dir.parent() else {
        return Ok(HashMap::new());
    };
    load_codex_session_index(&root.join("session_index.jsonl"))
}

fn load_codex_session_index(
    index_path: &Path,
) -> Result<HashMap<String, CodexSessionIndexEntry>, String> {
    let mut entries = HashMap::new();
    if !index_path.is_file() {
        return Ok(entries);
    }

    let file = fs::File::open(index_path).map_err(|err| {
        format!(
            "Failed to open Codex session index {}: {err}",
            index_path.display()
        )
    })?;
    let reader = BufReader::new(file);

    for line in reader.lines() {
        let line = line.map_err(|err| {
            format!(
                "Failed to read Codex session index {}: {err}",
                index_path.display()
            )
        })?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let parsed: CodexSessionIndexLine = match serde_json::from_str(trimmed) {
            Ok(parsed) => parsed,
            Err(_) => continue,
        };
        let id = parsed.id.trim();
        let thread_name = parsed.thread_name.trim();
        if id.is_empty() || thread_name.is_empty() {
            continue;
        }
        entries.insert(
            id.to_string(),
            CodexSessionIndexEntry {
                thread_name: thread_name.to_string(),
                updated_at: parsed.updated_at,
            },
        );
    }

    Ok(entries)
}

fn codex_source_fingerprint(
    file_stem: &str,
    title_index: &HashMap<String, CodexSessionIndexEntry>,
) -> String {
    codex_title_entry_for_file_stem(file_stem, title_index)
        .map(|entry| {
            format!(
                "session-index:{}:{}",
                entry.updated_at.as_deref().unwrap_or_default(),
                entry.thread_name
            )
        })
        .unwrap_or_default()
}

fn codex_session_index_title_for_record(
    record: &ImportedHistoryDiscoveredRecord,
) -> Result<String, String> {
    let Some(index_path) = codex_index_path_for_session_path(&record.source_path) else {
        return Ok(String::new());
    };
    let title_index = load_codex_session_index(&index_path)?;
    Ok(
        codex_title_entry_for_file_stem(&record.source_record_key, &title_index)
            .map(|entry| imported_history::truncate_name(&entry.thread_name, 200))
            .unwrap_or_default(),
    )
}

fn codex_index_path_for_session_path(session_path: &Path) -> Option<PathBuf> {
    codex_sessions_dir_for_session_path(session_path).and_then(|sessions_dir| {
        sessions_dir
            .parent()
            .map(|root| root.join("session_index.jsonl"))
    })
}

fn codex_sessions_dir_for_session_path(session_path: &Path) -> Option<PathBuf> {
    session_path
        .ancestors()
        .find(|ancestor| ancestor.file_name().and_then(|name| name.to_str()) == Some("sessions"))
        .map(Path::to_path_buf)
}

fn codex_title_entry_for_file_stem<'a>(
    file_stem: &str,
    title_index: &'a HashMap<String, CodexSessionIndexEntry>,
) -> Option<&'a CodexSessionIndexEntry> {
    codex_thread_id_from_file_stem(file_stem).and_then(|thread_id| title_index.get(thread_id))
}

fn codex_thread_id_from_file_stem(file_stem: &str) -> Option<&str> {
    if is_uuid_like(file_stem) {
        return Some(file_stem);
    }
    if file_stem.len() < 36 {
        return None;
    }
    let candidate = &file_stem[file_stem.len() - 36..];
    is_uuid_like(candidate).then_some(candidate)
}

fn is_uuid_like(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    bytes.iter().enumerate().all(|(index, byte)| {
        if matches!(index, 8 | 13 | 18 | 23) {
            *byte == b'-'
        } else {
            byte.is_ascii_hexdigit()
        }
    })
}

fn parse_codex_session_meta(
    record: &ImportedHistoryDiscoveredRecord,
) -> Result<Option<CodexAppSessionMeta>, String> {
    let file = fs::File::open(&record.source_path).map_err(|err| {
        format!(
            "Failed to open Codex history {}: {err}",
            record.source_path.display()
        )
    })?;
    let reader = BufReader::new(file);

    let mut created_at_ms = 0;
    let mut updated_at_ms = 0;
    let mut external_title = codex_session_index_title_for_record(record)?;
    let mut first_prompt = String::new();
    let mut model: Option<String> = None;
    let mut repo_path: Option<String> = None;
    let mut input_tokens = 0;
    let mut output_tokens = 0;
    // Primary impact source: `patch_apply_end` events, which Codex emits after
    // every *successful* apply with a structured `changes` map (path ->
    // unified_diff). This covers every edit path uniformly — the `apply_patch`
    // tool, `exec`-wrapped patches, etc. The tool-call scan below is only a
    // fallback for older rollouts that predate `patch_apply_end`.
    let mut impact = ImportedHistoryImpactStats::default();
    let mut touched_files = BTreeSet::new();
    let mut fallback_impact = ImportedHistoryImpactStats::default();
    let mut fallback_touched = BTreeSet::new();
    let mut parent_thread_id: Option<String> = None;

    for line in reader.lines() {
        let line = line.map_err(|err| format!("Failed to read Codex history line: {err}"))?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let parsed: CodexJsonlLine = match serde_json::from_str(trimmed) {
            Ok(parsed) => parsed,
            Err(_) => continue,
        };
        if let Some(timestamp) = parsed
            .timestamp
            .as_deref()
            .and_then(imported_history::parse_iso_to_epoch_ms_opt)
        {
            if created_at_ms == 0 || timestamp < created_at_ms {
                created_at_ms = timestamp;
            }
            if timestamp > updated_at_ms {
                updated_at_ms = timestamp;
            }
        }
        if first_prompt.is_empty() {
            if let Some(message) = user_message_from_payload(&parsed.payload) {
                first_prompt = imported_history::truncate_name(&message, 200);
            }
        }
        if external_title.is_empty() && parsed.line_type == "session_meta" {
            if let Some(title) = session_title_from_payload(&parsed.payload) {
                external_title = imported_history::truncate_name(&title, 200);
            }
        }
        if parent_thread_id.is_none() && parsed.line_type == "session_meta" {
            parent_thread_id = parent_thread_id_from_session_meta_payload(
                &parsed.payload,
                codex_thread_id_from_file_stem(&record.source_record_key),
            );
        }
        if model.is_none() || repo_path.is_none() {
            if let Ok(turn_context) =
                serde_json::from_value::<CodexTurnContextPayload>(parsed.payload.clone())
            {
                if model.is_none() && !turn_context.model.trim().is_empty() {
                    model = Some(turn_context.model);
                }
                if repo_path.is_none() && !turn_context.cwd.trim().is_empty() {
                    repo_path = Some(turn_context.cwd);
                }
            }
        }
        if parsed.payload.get("type").and_then(Value::as_str) == Some("token_count") {
            if let Some(total_usage) = parsed.payload.get("total_token_usage") {
                input_tokens = total_usage
                    .get("input_tokens")
                    .and_then(Value::as_i64)
                    .unwrap_or(input_tokens);
                output_tokens = total_usage
                    .get("output_tokens")
                    .and_then(Value::as_i64)
                    .unwrap_or(output_tokens);
            }
        }
        collect_codex_impact_from_patch_apply_end(&parsed.payload, &mut impact, &mut touched_files);
        collect_codex_impact_from_payload(
            &parsed.payload,
            &mut fallback_impact,
            &mut fallback_touched,
        );
    }

    // Prefer the authoritative `patch_apply_end` tally; only fall back to the
    // tool-call scan when no successful applies were recorded (older rollouts).
    if touched_files.is_empty() && impact.lines_added == 0 && impact.lines_removed == 0 {
        impact = fallback_impact;
        touched_files = fallback_touched;
    }

    impact.touched_files = touched_files.into_iter().collect();
    impact.files_changed = impact.touched_files.len() as i64;

    if created_at_ms == 0 && record.source_mtime_ms == 0 {
        return Ok(None);
    }

    let name = if !external_title.is_empty() {
        external_title
    } else if first_prompt.is_empty() {
        record.source_record_key.clone()
    } else {
        first_prompt
    };
    Ok(Some(CodexAppSessionMeta {
        source_session_id: record.source_session_id.clone(),
        session_id: super::canonical_session_id(&record.source_session_id),
        source_path: record.source_path.to_string_lossy().to_string(),
        source_record_key: record.source_record_key.clone(),
        source_mtime_ms: record.source_mtime_ms,
        source_size_bytes: record.source_size_bytes,
        source_fingerprint: record.source_fingerprint.clone(),
        name,
        parent_session_id: parent_thread_id
            .as_deref()
            .and_then(|thread_id| codex_parent_session_id_for_record(record, thread_id)),
        created_at_ms: if created_at_ms > 0 {
            created_at_ms
        } else {
            record.source_mtime_ms
        },
        updated_at_ms: if updated_at_ms > 0 {
            updated_at_ms
        } else {
            record.source_mtime_ms
        },
        model,
        repo_path,
        input_tokens,
        output_tokens,
        impact,
    }))
}

fn session_meta_to_cache_input(meta: CodexAppSessionMeta) -> ImportedHistoryCacheInput {
    ImportedHistoryCacheInput {
        source: SOURCE_CODEX_APP,
        source_session_id: meta.source_session_id,
        session_id: meta.session_id,
        source_path: meta.source_path,
        source_record_key: meta.source_record_key,
        source_mtime_ms: meta.source_mtime_ms,
        source_size_bytes: meta.source_size_bytes,
        source_fingerprint: meta.source_fingerprint,
        parser_version: CODEX_APP_METADATA_PARSER_VERSION,
        name: meta.name,
        created_at_ms: meta.created_at_ms,
        updated_at_ms: meta.updated_at_ms,
        model: meta.model,
        input_tokens: meta.input_tokens,
        output_tokens: meta.output_tokens,
        repo_path: meta.repo_path,
        branch: None,
        impact: meta.impact,
        listable: true,
        source_metadata_json: None,
        parent_session_id: meta.parent_session_id,
    }
}

fn parent_thread_id_from_session_meta_payload(
    payload: &Value,
    current_thread_id: Option<&str>,
) -> Option<String> {
    let is_subagent = payload.get("thread_source").and_then(Value::as_str) == Some("subagent")
        || payload.pointer("/source/subagent").is_some();
    if !is_subagent {
        return None;
    }

    let direct_candidates = [
        payload.get("parent_thread_id"),
        payload.pointer("/source/subagent/thread_spawn/parent_thread_id"),
        payload.get("forked_from_id"),
        payload.get("session_id"),
    ];

    for candidate in direct_candidates {
        if let Some(parent_thread_id) = candidate
            .and_then(Value::as_str)
            .and_then(|value| normalize_parent_thread_id_candidate(value, current_thread_id))
        {
            return Some(parent_thread_id);
        }
    }
    None
}

fn normalize_parent_thread_id_candidate(
    value: &str,
    current_thread_id: Option<&str>,
) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || Some(trimmed) == current_thread_id {
        return None;
    }
    Some(trimmed.to_string())
}

fn codex_parent_session_id_for_record(
    record: &ImportedHistoryDiscoveredRecord,
    parent_thread_id: &str,
) -> Option<String> {
    resolve_codex_transcript_for_thread_id_near_path(&record.source_path, parent_thread_id)
        .ok()
        .flatten()
        .map(|locator| locator.session_id)
}

/// Resolve a Codex thread UUID to the concrete rollout file that ORGII can
/// replay. Lifecycle hooks identify the parent with a stable thread UUID, but
/// their common `transcript_path` may point at the active child rollout.
pub fn resolve_codex_transcript_for_thread_id_near_path(
    reference_path: &Path,
    thread_id: &str,
) -> Result<Option<CodexTranscriptLocator>, String> {
    let Some(sessions_dir) = codex_sessions_dir_for_session_path(reference_path) else {
        return Ok(None);
    };
    let find_locator = |mut files: Vec<PathBuf>| {
        files.sort();
        files.into_iter().find_map(|path| {
            let file_stem = path
                .file_stem()
                .and_then(|value| value.to_str())?
                .to_string();
            (codex_thread_id_from_file_stem(&file_stem) == Some(thread_id)).then(|| {
                CodexTranscriptLocator {
                    session_id: super::canonical_session_id(&file_stem),
                    source_session_id: file_stem,
                    source_path: path,
                }
            })
        })
    };

    // Parent and child rollouts from one subagent run normally share the same
    // dated directory. Search that tiny locality before falling back to the
    // full CODEX_HOME session tree, which can contain years of history.
    if let Some(nearby_dir) = reference_path.parent() {
        let mut nearby_files = Vec::new();
        collect_codex_session_files(nearby_dir, &mut nearby_files)?;
        if let Some(locator) = find_locator(nearby_files) {
            return Ok(Some(locator));
        }
    }

    let mut files = Vec::new();
    collect_codex_session_files(&sessions_dir, &mut files)?;
    Ok(find_locator(files))
}

/// Tally impact from a `patch_apply_end` event — Codex's authoritative record
/// of a successfully applied patch. `changes` maps each touched path to a
/// `{ type, unified_diff }` object; the diff's `+`/`-` lines give exact
/// add/remove counts regardless of how the edit was requested.
fn collect_codex_impact_from_patch_apply_end(
    payload: &Value,
    impact: &mut ImportedHistoryImpactStats,
    touched_files: &mut BTreeSet<String>,
) {
    if payload.get("type").and_then(Value::as_str) != Some("patch_apply_end") {
        return;
    }
    // A failed apply changed nothing; don't attribute its diff.
    if payload.get("success").and_then(Value::as_bool) == Some(false) {
        return;
    }
    let Some(changes) = payload.get("changes").and_then(Value::as_object) else {
        return;
    };
    for (path, change) in changes {
        let path = path.trim();
        if path.is_empty() {
            continue;
        }
        touched_files.insert(path.to_string());
        if let Some(diff) = change.get("unified_diff").and_then(Value::as_str) {
            for line in diff.lines() {
                if line.starts_with('+') && !line.starts_with("+++") {
                    impact.lines_added += 1;
                } else if line.starts_with('-') && !line.starts_with("---") {
                    impact.lines_removed += 1;
                }
            }
        }
    }
}

fn collect_codex_impact_from_payload(
    payload: &Value,
    impact: &mut ImportedHistoryImpactStats,
    touched_files: &mut BTreeSet<String>,
) {
    let Some(payload_type) = payload.get("type").and_then(Value::as_str) else {
        return;
    };
    let patch = match payload_type {
        "function_call" if payload.get("name").and_then(Value::as_str) == Some("apply_patch") => {
            payload
                .get("arguments")
                .and_then(Value::as_str)
                .map(imported_history::parse_inner_json)
                .and_then(|args| patch_from_codex_args(&args))
        }
        "custom_tool_call"
            if payload.get("name").and_then(Value::as_str) == Some("apply_patch") =>
        {
            payload
                .get("input")
                .and_then(Value::as_str)
                .map(str::to_string)
        }
        _ => None,
    };
    if let Some(patch) = patch {
        accumulate_patch_impact(&patch, impact, touched_files);
    }
}

fn patch_from_codex_args(args: &Value) -> Option<String> {
    args.get("patch")
        .and_then(Value::as_str)
        .or_else(|| args.get("input").and_then(Value::as_str))
        .map(str::to_string)
}

fn accumulate_patch_impact(
    patch: &str,
    impact: &mut ImportedHistoryImpactStats,
    touched_files: &mut BTreeSet<String>,
) {
    for line in patch.lines() {
        if let Some(path) = patch_file_path_from_line(line) {
            touched_files.insert(path);
        }
        if line.starts_with('+') && !line.starts_with("+++") {
            impact.lines_added += 1;
        } else if line.starts_with('-') && !line.starts_with("---") {
            impact.lines_removed += 1;
        }
    }
}

fn patch_file_path_from_line(line: &str) -> Option<String> {
    for prefix in [
        "*** Add File:",
        "*** Update File:",
        "*** Modify File:",
        "*** Delete File:",
    ] {
        if let Some(path) = line.strip_prefix(prefix) {
            let path = path.trim();
            if !path.is_empty() {
                return Some(path.to_string());
            }
        }
    }
    if let Some(rest) = line.strip_prefix("diff --git ") {
        let mut parts = rest.split_whitespace();
        let _old_path = parts.next();
        return parts.next().and_then(normalize_patch_path);
    }
    line.strip_prefix("+++ ")
        .and_then(normalize_patch_path)
        .filter(|path| path != "/dev/null")
}

fn normalize_patch_path(path: &str) -> Option<String> {
    let normalized = path
        .strip_prefix("b/")
        .or_else(|| path.strip_prefix("a/"))
        .unwrap_or(path)
        .trim();
    if normalized.is_empty() {
        None
    } else {
        Some(normalized.to_string())
    }
}

pub fn load_codex_app_from_path(
    session_id: &str,
    path: &Path,
) -> Result<Vec<ActivityChunk>, String> {
    let file = fs::File::open(path)
        .map_err(|err| format!("Failed to open Codex history {}: {err}", path.display()))?;
    let reader = BufReader::new(file);

    let mut chunks = Vec::new();
    let mut pending_tool_calls: HashMap<String, Vec<ImportedToolCall>> = HashMap::new();
    let mut background_tool_calls: HashMap<String, PendingBackgroundToolCall> = HashMap::new();
    let mut sequence = 0usize;

    for line in reader.lines() {
        let line = line.map_err(|err| format!("Failed to read Codex history line: {err}"))?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let parsed: CodexJsonlLine = match serde_json::from_str(trimmed) {
            Ok(parsed) => parsed,
            Err(_) => continue,
        };
        let created_at = parsed
            .timestamp
            .as_deref()
            .map(imported_history::normalize_created_at)
            .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
        let Some(payload_type) = parsed.payload.get("type").and_then(Value::as_str) else {
            continue;
        };

        match payload_type {
            "user_message" => {
                if let Some(message) = user_message_from_payload(&parsed.payload) {
                    chunks.push(imported_history::user_message_chunk(
                        session_id,
                        CODEX_PROVIDER_SLUG,
                        sequence,
                        &created_at,
                        &message,
                    ));
                    sequence += 1;
                }
            }
            "agent_message" => {
                if let Some(message) = parsed.payload.get("message").and_then(Value::as_str) {
                    chunks.push(imported_history::assistant_message_chunk(
                        session_id,
                        CODEX_PROVIDER_SLUG,
                        sequence,
                        &created_at,
                        message,
                    ));
                    sequence += 1;
                }
            }
            "message" => {
                if parsed.payload.get("role").and_then(Value::as_str) == Some("assistant") {
                    if let Some(text) = content_text_from_payload(&parsed.payload) {
                        chunks.push(imported_history::assistant_message_chunk(
                            session_id,
                            CODEX_PROVIDER_SLUG,
                            sequence,
                            &created_at,
                            &text,
                        ));
                        sequence += 1;
                    }
                }
            }
            "reasoning" | "agent_reasoning" => {
                if let Some(text) = reasoning_text_from_payload(&parsed.payload) {
                    chunks.push(imported_history::thinking_chunk(
                        session_id,
                        CODEX_PROVIDER_SLUG,
                        sequence,
                        &created_at,
                        &text,
                    ));
                    sequence += 1;
                }
            }
            "function_call" => {
                if let Some((call_id, calls)) =
                    pending_tool_calls_from_payload(&parsed.payload, &created_at)
                {
                    pending_tool_calls.insert(call_id, calls);
                }
            }
            "custom_tool_call" => {
                if let Some((call_id, calls)) =
                    pending_custom_tool_calls_from_payload(&parsed.payload, &created_at)
                {
                    pending_tool_calls.insert(call_id, calls);
                }
            }
            "web_search_call" => {
                if let Some(call) = web_search_call_from_payload(&parsed.payload, &created_at) {
                    chunks.push(codex_tool_call_chunk(session_id, sequence, &call, ""));
                    sequence += 1;
                }
            }
            "function_call_output" | "custom_tool_call_output" => {
                let call_id = parsed.payload.get("call_id").and_then(Value::as_str);
                if let Some(call_id) = call_id {
                    if let Some(calls) = pending_tool_calls.remove(call_id) {
                        let output = codex_tool_output_text(parsed.payload.get("output"));
                        if let Some(cell_id) = wait_cell_id(&calls) {
                            if let Some(mut background) = background_tool_calls.remove(cell_id) {
                                if let Some(next_cell_id) = background_cell_id(&output) {
                                    background.latest_output = output;
                                    background_tool_calls.insert(next_cell_id, background);
                                } else {
                                    let final_output = if output.trim().is_empty() {
                                        background.latest_output
                                    } else {
                                        output
                                    };
                                    let outputs = output_parts_for_tool_calls(
                                        &background.calls,
                                        &final_output,
                                    );
                                    for (call, output) in
                                        background.calls.iter().zip(outputs.iter())
                                    {
                                        chunks.push(codex_tool_call_chunk(
                                            session_id, sequence, call, output,
                                        ));
                                        sequence += 1;
                                    }
                                }
                                continue;
                            }
                        }
                        if let Some(cell_id) = background_cell_id(&output) {
                            background_tool_calls.insert(
                                cell_id,
                                PendingBackgroundToolCall {
                                    calls,
                                    latest_output: output,
                                },
                            );
                            continue;
                        }
                        let outputs = output_parts_for_tool_calls(&calls, &output);
                        for (call, output) in calls.iter().zip(outputs.iter()) {
                            chunks.push(codex_tool_call_chunk(session_id, sequence, call, output));
                            sequence += 1;
                        }
                    }
                }
            }
            _ => {}
        }
    }

    for calls in pending_tool_calls.into_values() {
        for call in calls {
            chunks.push(codex_tool_call_chunk(session_id, sequence, &call, ""));
            sequence += 1;
        }
    }
    for background in background_tool_calls.into_values() {
        let outputs = output_parts_for_tool_calls(&background.calls, &background.latest_output);
        for (call, output) in background.calls.iter().zip(outputs.iter()) {
            chunks.push(codex_tool_call_chunk(session_id, sequence, call, output));
            sequence += 1;
        }
    }

    Ok(chunks)
}

fn background_cell_id(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        line.trim()
            .strip_prefix("Script running with cell ID ")
            .map(str::trim)
            .filter(|cell_id| !cell_id.is_empty())
            .map(str::to_string)
    })
}

fn wait_cell_id(calls: &[ImportedToolCall]) -> Option<&str> {
    let [call] = calls else {
        return None;
    };
    if normalize_tool_name_key(&call.raw_name) != "wait" {
        return None;
    }
    call.args.get("cell_id").and_then(Value::as_str)
}

fn codex_tool_call_chunk(
    session_id: &str,
    sequence: usize,
    call: &ImportedToolCall,
    output: &str,
) -> ActivityChunk {
    let mut chunk =
        imported_history::tool_call_chunk(session_id, CODEX_PROVIDER_SLUG, sequence, call, output);
    if call.canonical_name == imported_history::FUNCTION_CODE_SEARCH {
        if let Some(result) = chunk.result.as_object_mut() {
            result.insert("content".to_string(), Value::String(output.to_string()));
            let matches = parse_rg_output_matches(output)
                .into_iter()
                .map(|(file, line, content)| {
                    json!({
                        "file": file,
                        "line": line,
                        "content": content,
                    })
                })
                .collect::<Vec<_>>();
            result.insert("matches".to_string(), Value::Array(matches));
        }
    }
    let exit_code = codex_tool_exit_code(output);
    let failed = codex_tool_output_failed(output, exit_code);
    if let Some(result) = chunk.result.as_object_mut() {
        if let Some(exit_code) = exit_code {
            result.insert("exit_code".to_string(), json!(exit_code));
        }
        if failed {
            result.insert("success".to_string(), Value::Bool(false));
            result.insert("status".to_string(), Value::String("failed".to_string()));
            result.insert("is_error".to_string(), Value::Bool(true));
            result.insert(
                "failure".to_string(),
                json!({
                    "command": call.args.get("command").and_then(Value::as_str).unwrap_or_default(),
                    "stdout": "",
                    "stderr": output,
                    "exitCode": exit_code,
                }),
            );
        }
    }
    chunk
}

fn output_parts_for_tool_calls(calls: &[ImportedToolCall], output: &str) -> Vec<String> {
    if calls.len() <= 1 {
        return vec![output.to_string()];
    }

    // A multiline Desktop shell script may normalize to several reads followed
    // by a different final operation (for example three `sed` reads then
    // `rg`). Each bounded read consumes its known number of lines; the final
    // tool receives the remainder.
    let bounded_prefix_limits = calls[..calls.len() - 1]
        .iter()
        .map(read_line_limit_from_call)
        .collect::<Option<Vec<_>>>();
    let Some(limits) = bounded_prefix_limits else {
        return vec![output.to_string(); calls.len()];
    };

    let lines = output.split_inclusive('\n').collect::<Vec<_>>();
    let mut cursor = 0usize;
    calls
        .iter()
        .enumerate()
        .map(|(index, _)| {
            let remaining = lines.len().saturating_sub(cursor);
            let take = if index + 1 == calls.len() {
                remaining
            } else {
                limits[index].min(remaining)
            };
            let part = lines[cursor..cursor.saturating_add(take)].concat();
            cursor = cursor.saturating_add(take);
            part
        })
        .collect()
}

fn read_line_limit_from_call(call: &ImportedToolCall) -> Option<usize> {
    if call.canonical_name != imported_history::FUNCTION_READ_FILE {
        return None;
    }
    call.args
        .get("limit")
        .and_then(Value::as_i64)
        .and_then(|value| usize::try_from(value).ok())
}

fn pending_tool_calls_from_payload(
    payload: &Value,
    created_at: &str,
) -> Option<(String, Vec<ImportedToolCall>)> {
    let call_id = payload.get("call_id")?.as_str()?.to_string();
    let raw_name = payload.get("name")?.as_str()?.to_string();
    let arguments = payload
        .get("arguments")
        .and_then(Value::as_str)
        .map(imported_history::parse_inner_json)
        .unwrap_or_else(|| json!({}));
    let normalized_calls = normalize_codex_tool_calls(&raw_name, arguments);
    let call_count = normalized_calls.len();
    if call_count == 0 {
        return None;
    }
    let calls = normalized_calls
        .into_iter()
        .enumerate()
        .map(|(index, (canonical_name, args))| ImportedToolCall {
            call_id: split_call_id(&call_id, index, call_count),
            raw_name: raw_name.clone(),
            canonical_name,
            args,
            created_at: created_at.to_string(),
        })
        .collect();
    Some((call_id, calls))
}

fn pending_custom_tool_calls_from_payload(
    payload: &Value,
    created_at: &str,
) -> Option<(String, Vec<ImportedToolCall>)> {
    let call_id = payload.get("call_id")?.as_str()?.to_string();
    let raw_name = payload.get("name")?.as_str()?.to_string();
    let input = payload
        .get("input")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let normalized_calls = if normalize_tool_name_key(&raw_name) == "exec" {
        normalize_codex_exec_tool_calls(input)
    } else {
        let args = if raw_name == "apply_patch" {
            json!({ "patch": input })
        } else {
            json!({ "input": input })
        };
        normalize_codex_tool_calls(&raw_name, args)
    };
    let call_count = normalized_calls.len();
    if call_count == 0 {
        return None;
    }
    let calls = normalized_calls
        .into_iter()
        .enumerate()
        .map(|(index, (canonical_name, args))| ImportedToolCall {
            call_id: split_call_id(&call_id, index, call_count),
            raw_name: raw_name.clone(),
            canonical_name,
            args,
            created_at: created_at.to_string(),
        })
        .collect();
    Some((call_id, calls))
}

fn web_search_call_from_payload(payload: &Value, created_at: &str) -> Option<ImportedToolCall> {
    let call_id = payload.get("id")?.as_str()?.to_string();
    let action = payload.get("action").cloned().unwrap_or_else(|| json!({}));
    Some(ImportedToolCall {
        call_id,
        raw_name: "web_search_call".to_string(),
        canonical_name: "web_search".to_string(),
        args: normalize_web_search_args(action),
        created_at: created_at.to_string(),
    })
}

fn split_call_id(call_id: &str, index: usize, total: usize) -> String {
    if total <= 1 {
        call_id.to_string()
    } else {
        format!("{call_id}:part-{index}")
    }
}

pub(crate) fn normalize_codex_tool_calls(raw_name: &str, args: Value) -> Vec<(String, Value)> {
    let key = normalize_tool_name_key(raw_name);
    match key.as_str() {
        "shell" | "shell_command" | "exec_command" | "bash" | "terminal" | "terminal_command"
        | "run_shell" | "run_command" | "execute" | "exec" => {
            let shell_args = normalize_shell_args(args);
            if let Some(read_args) = read_file_arg_values_from_shell_args(&shell_args) {
                read_args
                    .into_iter()
                    .map(|args| (imported_history::FUNCTION_READ_FILE.to_string(), args))
                    .collect()
            } else if let Some(calls) = exploration_tool_calls_from_shell_args(&shell_args) {
                calls
            } else {
                vec![(
                    imported_history::FUNCTION_RUN_COMMAND_LINE.to_string(),
                    shell_args,
                )]
            }
        }
        "rg" | "ripgrep" | "grep" | "search" | "code_search" | "search_code"
        | "search_codebase" => vec![(
            imported_history::FUNCTION_CODE_SEARCH.to_string(),
            normalize_search_args(args),
        )],
        "web__run" | "web_run" | "web_search" => {
            vec![("web_search".to_string(), normalize_web_search_args(args))]
        }
        "cat" | "sed" | "head" | "tail" => {
            let shell_args = normalize_shell_args(args);
            if let Some(read_args) = read_file_args_from_shell_args(&shell_args) {
                vec![(imported_history::FUNCTION_READ_FILE.to_string(), read_args)]
            } else {
                vec![(
                    imported_history::FUNCTION_RUN_COMMAND_LINE.to_string(),
                    shell_args,
                )]
            }
        }
        "apply_patch" => vec![(
            imported_history::FUNCTION_EDIT_FILE.to_string(),
            normalize_apply_patch_args(args),
        )],
        "edit" | "edit_file" | "write" | "write_file" | "create_file" => vec![(
            imported_history::FUNCTION_EDIT_FILE.to_string(),
            normalize_edit_args(raw_name, args),
        )],
        _ => vec![(raw_name.to_string(), args)],
    }
}

fn normalize_shell_args(args: Value) -> Value {
    let command = args
        .get("command")
        .and_then(Value::as_str)
        .or_else(|| args.get("cmd").and_then(Value::as_str))
        .or_else(|| args.get("input").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string();
    let cwd = args
        .get("cwd")
        .and_then(Value::as_str)
        .or_else(|| args.get("workdir").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string();
    json!({
        "command": command.clone(),
        "cmd": command,
        "cwd": cwd.clone(),
        "workdir": cwd,
        "payload": args,
    })
}

fn normalize_apply_patch_args(args: Value) -> Value {
    let patch = args
        .get("patch")
        .and_then(Value::as_str)
        .or_else(|| args.get("patch_text").and_then(Value::as_str))
        .or_else(|| args.get("input").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string();
    let file_path = first_apply_patch_file_path(&patch).unwrap_or_default();
    json!({
        "action": "apply_patch",
        "patch": patch.clone(),
        "patch_text": patch,
        "file_path": file_path.clone(),
        "target_file": file_path,
        "payload": args,
    })
}

fn normalize_edit_args(raw_name: &str, args: Value) -> Value {
    if args
        .get("patch")
        .and_then(Value::as_str)
        .or_else(|| args.get("patch_text").and_then(Value::as_str))
        .is_some()
    {
        return normalize_apply_patch_args(args);
    }

    let file_path = args
        .get("file_path")
        .and_then(Value::as_str)
        .or_else(|| args.get("path").and_then(Value::as_str))
        .or_else(|| args.get("target_file").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string();
    let old_content = args
        .get("old_content")
        .and_then(Value::as_str)
        .or_else(|| args.get("old_str").and_then(Value::as_str))
        .or_else(|| args.get("old_string").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string();
    let new_content = args
        .get("new_content")
        .and_then(Value::as_str)
        .or_else(|| args.get("new_str").and_then(Value::as_str))
        .or_else(|| args.get("new_string").and_then(Value::as_str))
        .or_else(|| args.get("content").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string();

    json!({
        "action": raw_name,
        "file_path": file_path.clone(),
        "target_file": file_path,
        "old_content": old_content.clone(),
        "new_content": new_content.clone(),
        "content": new_content,
        "payload": args,
    })
}

fn normalize_search_args(args: Value) -> Value {
    let query = args
        .get("query")
        .and_then(Value::as_str)
        .or_else(|| args.get("pattern").and_then(Value::as_str))
        .or_else(|| args.get("search_query").and_then(Value::as_str))
        .or_else(|| args.get("regex").and_then(Value::as_str))
        .or_else(|| args.get("input").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string();
    json!({
        "action": "grep",
        "query": query.clone(),
        "pattern": query,
        "payload": args,
    })
}

fn normalize_web_search_args(args: Value) -> Value {
    let action = args
        .get("action")
        .and_then(Value::as_str)
        .or_else(|| args.get("type").and_then(Value::as_str))
        .unwrap_or("search")
        .to_string();
    let url = args
        .get("url")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let pattern = args
        .get("pattern")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let query = args
        .get("query")
        .and_then(Value::as_str)
        .or_else(|| args.get("search_query").and_then(Value::as_str))
        .or_else(|| args.get("input").and_then(Value::as_str))
        .or_else(|| (!url.is_empty()).then_some(url.as_str()))
        .or_else(|| (!pattern.is_empty()).then_some(pattern.as_str()))
        .unwrap_or_default()
        .to_string();
    let queries = args.get("queries").cloned().unwrap_or_else(|| json!([]));
    json!({
        "action": action,
        "query": query,
        "queries": queries,
        "url": url,
        "pattern": pattern,
        "payload": args,
    })
}

fn read_file_args_from_shell_args(shell_args: &Value) -> Option<Value> {
    read_file_arg_values_from_shell_args(shell_args)?
        .into_iter()
        .next()
}

fn read_file_arg_values_from_shell_args(shell_args: &Value) -> Option<Vec<Value>> {
    let command = shell_args.get("command").and_then(Value::as_str)?.trim();
    if command.is_empty() {
        return None;
    }

    let cwd = shell_args
        .get("cwd")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let commands = split_shell_read_command_chain(command)?;
    let command_count = commands.len();
    let mut read_args_values = Vec::with_capacity(command_count);

    for (index, command_part) in commands.iter().enumerate() {
        let tokens = shell_tokens(command_part);
        let read_args = read_file_args_from_tokens(&tokens)?;
        if command_count > 1 && read_args.limit.is_none() {
            return None;
        }
        let mut value = shell_read_args_to_value(
            read_args,
            command_part,
            &cwd,
            shell_args,
            command,
            index,
            command_count,
        );
        if command_count == 1 {
            if let Some(obj) = value.as_object_mut() {
                obj.remove("source_command");
                obj.remove("command_index");
                obj.remove("command_count");
            }
        }
        read_args_values.push(value);
    }

    if read_args_values.is_empty() {
        None
    } else {
        Some(read_args_values)
    }
}

fn shell_read_args_to_value(
    read_args: ShellReadArgs,
    command: &str,
    cwd: &str,
    shell_args: &Value,
    source_command: &str,
    command_index: usize,
    command_count: usize,
) -> Value {
    json!({
        "path": read_args.path.clone(),
        "file_path": read_args.path.clone(),
        "target_file": read_args.path,
        "offset": read_args.offset,
        "limit": read_args.limit,
        "command": command,
        "source_command": source_command,
        "command_index": command_index,
        "command_count": command_count,
        "cwd": cwd,
        "payload": shell_args.clone(),
    })
}

struct ShellReadArgs {
    path: String,
    offset: Option<i64>,
    limit: Option<i64>,
}

fn split_shell_read_command_chain(command: &str) -> Option<Vec<String>> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut chars = command.chars().peekable();

    while let Some(ch) = chars.next() {
        if let Some(active_quote) = quote {
            current.push(ch);
            if ch == active_quote {
                quote = None;
            } else if ch == '\\' && active_quote == '"' {
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            }
            continue;
        }

        match ch {
            '\'' | '"' => {
                quote = Some(ch);
                current.push(ch);
            }
            '&' if chars.peek() == Some(&'&') => {
                chars.next();
                push_shell_command_part(&mut parts, &mut current)?;
            }
            '|' if chars.peek() == Some(&'|') => return None,
            ';' => {
                push_shell_command_part(&mut parts, &mut current)?;
            }
            _ => current.push(ch),
        }
    }

    if quote.is_some() {
        return None;
    }
    push_shell_command_part(&mut parts, &mut current)?;
    if parts.is_empty() {
        None
    } else {
        Some(parts)
    }
}

fn push_shell_command_part(parts: &mut Vec<String>, current: &mut String) -> Option<()> {
    let part = current.trim();
    if part.is_empty() {
        return None;
    }
    parts.push(part.to_string());
    current.clear();
    Some(())
}

fn read_file_args_from_tokens(tokens: &[String]) -> Option<ShellReadArgs> {
    if tokens.is_empty() {
        return None;
    }
    if let Some(read_args) = read_file_args_from_nl_sed_pipeline(tokens) {
        return Some(read_args);
    }
    if tokens.iter().any(|token| is_shell_separator(token)) {
        return None;
    }

    let executable = tokens[0].rsplit('/').next().unwrap_or(tokens[0].as_str());
    match executable {
        "cat" => read_file_args_from_cat(&tokens[1..]),
        "sed" => read_file_args_from_sed(&tokens[1..]),
        "head" => read_file_args_from_head_tail(&tokens[1..], true),
        "tail" => read_file_args_from_head_tail(&tokens[1..], false),
        _ => None,
    }
}

fn read_file_args_from_nl_sed_pipeline(tokens: &[String]) -> Option<ShellReadArgs> {
    if tokens
        .iter()
        .any(|token| matches!(token.as_str(), "&&" | "||" | ";"))
    {
        return None;
    }

    let mut pipe_indices = tokens
        .iter()
        .enumerate()
        .filter_map(|(index, token)| (token == "|").then_some(index));
    let pipe_index = pipe_indices.next()?;
    if pipe_indices.next().is_some() || pipe_index == 0 || pipe_index + 1 >= tokens.len() {
        return None;
    }

    let path = read_file_path_from_nl(&tokens[..pipe_index])?;
    let (offset, limit) = read_range_from_pipeline_sed(&tokens[(pipe_index + 1)..])?;
    Some(ShellReadArgs {
        path,
        offset,
        limit,
    })
}

fn read_file_path_from_nl(tokens: &[String]) -> Option<String> {
    if tokens.is_empty() {
        return None;
    }
    let executable = tokens[0].rsplit('/').next().unwrap_or(tokens[0].as_str());
    if executable != "nl" {
        return None;
    }

    let mut paths = Vec::new();
    let mut index = 1usize;
    while index < tokens.len() {
        let token = tokens[index].as_str();
        if token == "--" {
            paths.extend(tokens[(index + 1)..].iter().cloned());
            break;
        }
        if token.starts_with('-') {
            index += if nl_option_consumes_next(token) { 2 } else { 1 };
            continue;
        }
        paths.push(token.to_string());
        index += 1;
    }

    single_shell_path_arg(&paths)
}

fn nl_option_consumes_next(token: &str) -> bool {
    matches!(
        token,
        "-b" | "-d" | "-f" | "-h" | "-i" | "-l" | "-n" | "-s" | "-v" | "-w"
    ) || matches!(
        token,
        "--body-numbering"
            | "--section-delimiter"
            | "--footer-numbering"
            | "--header-numbering"
            | "--line-increment"
            | "--join-blank-lines"
            | "--number-format"
            | "--number-separator"
            | "--starting-line-number"
            | "--number-width"
    )
}

fn read_range_from_pipeline_sed(tokens: &[String]) -> Option<(Option<i64>, Option<i64>)> {
    if tokens.is_empty() {
        return None;
    }
    let executable = tokens[0].rsplit('/').next().unwrap_or(tokens[0].as_str());
    if executable != "sed" {
        return None;
    }

    let mut index = 1usize;
    let mut has_quiet = false;
    let mut range_expr: Option<&str> = None;
    while index < tokens.len() {
        let token = tokens[index].as_str();
        match token {
            "-n" | "--quiet" | "--silent" => {
                has_quiet = true;
                index += 1;
            }
            "-e" | "--expression" => {
                range_expr = tokens.get(index + 1).map(String::as_str);
                index += 2;
            }
            _ if token.starts_with('-') => return None,
            _ if range_expr.is_none() => {
                range_expr = Some(token);
                index += 1;
            }
            _ => return None,
        }
    }

    if !has_quiet {
        return None;
    }
    sed_range_to_offset_limit(range_expr?)
}

fn read_file_args_from_cat(tokens: &[String]) -> Option<ShellReadArgs> {
    let paths = shell_path_args(
        tokens,
        &["-n", "-b", "-s", "-v", "-e", "-t", "-A", "--number"],
    )?;
    let path = single_shell_path_arg(&paths)?;
    Some(ShellReadArgs {
        path,
        offset: None,
        limit: None,
    })
}

fn read_file_args_from_sed(tokens: &[String]) -> Option<ShellReadArgs> {
    let mut index = 0usize;
    let mut has_quiet = false;
    let mut range_expr: Option<&str> = None;
    let mut paths: Vec<String> = Vec::new();

    while index < tokens.len() {
        let token = tokens[index].as_str();
        match token {
            "-n" | "--quiet" | "--silent" => {
                has_quiet = true;
                index += 1;
            }
            "-e" | "--expression" => {
                range_expr = tokens.get(index + 1).map(String::as_str);
                index += 2;
            }
            "--" => {
                paths.extend(tokens[(index + 1)..].iter().cloned());
                break;
            }
            _ if token.starts_with('-') => return None,
            _ if range_expr.is_none() => {
                range_expr = Some(token);
                index += 1;
            }
            _ => {
                paths.push(token.to_string());
                index += 1;
            }
        }
    }

    if !has_quiet {
        return None;
    }
    let (offset, limit) = sed_range_to_offset_limit(range_expr?)?;
    let path = single_shell_path_arg(&paths)?;
    Some(ShellReadArgs {
        path,
        offset,
        limit,
    })
}

fn read_file_args_from_head_tail(tokens: &[String], is_head: bool) -> Option<ShellReadArgs> {
    let mut index = 0usize;
    let mut line_count: Option<i64> = None;
    let mut paths = Vec::new();

    while index < tokens.len() {
        let token = tokens[index].as_str();
        match token {
            "-n" | "--lines" => {
                line_count = tokens
                    .get(index + 1)
                    .and_then(|value| value.trim_start_matches('+').parse::<i64>().ok());
                index += 2;
            }
            "--" => {
                paths.extend(tokens[(index + 1)..].iter().cloned());
                break;
            }
            _ if token.starts_with("-n") && token.len() > 2 => {
                line_count = token[2..].trim_start_matches('+').parse::<i64>().ok();
                index += 1;
            }
            _ if token.starts_with("--lines=") => {
                line_count = token
                    .trim_start_matches("--lines=")
                    .trim_start_matches('+')
                    .parse::<i64>()
                    .ok();
                index += 1;
            }
            _ if token.starts_with('-') => return None,
            _ => {
                paths.push(token.to_string());
                index += 1;
            }
        }
    }

    let path = single_shell_path_arg(&paths)?;
    Some(ShellReadArgs {
        path,
        offset: if is_head { Some(0) } else { None },
        limit: line_count,
    })
}

fn shell_path_args(tokens: &[String], flag_allowlist: &[&str]) -> Option<Vec<String>> {
    let mut paths = Vec::new();
    let mut index = 0usize;
    while index < tokens.len() {
        let token = tokens[index].as_str();
        if token == "--" {
            paths.extend(tokens[(index + 1)..].iter().cloned());
            break;
        }
        if token.starts_with('-') {
            if flag_allowlist.contains(&token) {
                index += 1;
                continue;
            }
            return None;
        }
        paths.push(token.to_string());
        index += 1;
    }
    Some(paths)
}

fn single_shell_path_arg(paths: &[String]) -> Option<String> {
    if paths.len() != 1 {
        return None;
    }
    let path = paths[0].trim();
    if path.is_empty() || path == "-" {
        return None;
    }
    Some(path.to_string())
}

fn sed_range_to_offset_limit(expr: &str) -> Option<(Option<i64>, Option<i64>)> {
    let expr = expr.trim().trim_end_matches(';');
    if expr.contains('/') || expr.contains('s') {
        return None;
    }
    let mut parts = expr
        .split(';')
        .map(str::trim)
        .filter(|part| !part.is_empty());
    let first_part = parts.next()?;
    let (offset, limit) = sed_single_range_to_offset_limit(first_part)?;
    for part in parts {
        sed_single_range_to_offset_limit(part)?;
    }
    if expr.contains(';') {
        return Some((offset, None));
    }
    Some((offset, limit))
}

fn sed_single_range_to_offset_limit(expr: &str) -> Option<(Option<i64>, Option<i64>)> {
    if !expr.ends_with('p') {
        return None;
    }
    let range = expr.trim_end_matches('p').trim();
    if let Some((start_raw, end_raw)) = range.split_once(',') {
        let start = start_raw.trim().parse::<i64>().ok()?;
        let end = end_raw.trim().parse::<i64>().ok()?;
        if start < 1 || end < start {
            return None;
        }
        return Some((Some(start - 1), Some(end - start + 1)));
    }
    let line = range.parse::<i64>().ok()?;
    if line < 1 {
        return None;
    }
    Some((Some(line - 1), Some(1)))
}

fn normalize_tool_name_key(raw_name: &str) -> String {
    raw_name
        .trim()
        .strip_prefix("mcp_orgii_")
        .unwrap_or_else(|| raw_name.trim())
        .chars()
        .map(|ch| match ch {
            '-' | ' ' | '.' => '_',
            _ => ch.to_ascii_lowercase(),
        })
        .collect()
}

fn rg_search_args_from_shell_args(shell_args: &Value) -> Option<Value> {
    let command = shell_args.get("command").and_then(Value::as_str)?.trim();
    if command.is_empty() {
        return None;
    }

    let tokens = shell_tokens(command);
    // The caller splits safe exploration chains first. This parser still
    // requires the individual segment itself to begin with `rg`.
    if !tokens.first().is_some_and(|token| is_rg_executable(token)) {
        return None;
    }
    let rg_index = 0usize;

    let query =
        rg_pattern_from_tokens(&tokens[(rg_index + 1)..]).unwrap_or_else(|| command.to_string());
    let cwd = shell_args
        .get("cwd")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    Some(json!({
        "action": "grep",
        "query": query.clone(),
        "pattern": query,
        "command": command,
        "cwd": cwd,
        "payload": shell_args.clone(),
    }))
}

/// Decompose a shell chain only when every segment is a known read-only
/// exploration operation. Context probes (`pwd`, `wc -l`) are omitted; their
/// meaningful read/search successor represents the action in chat. Any
/// unknown or potentially mutating segment keeps the entire call in Terminal.
fn exploration_tool_calls_from_shell_args(shell_args: &Value) -> Option<Vec<(String, Value)>> {
    let source_command = shell_args.get("command").and_then(Value::as_str)?.trim();
    if source_command.is_empty() {
        return None;
    }

    let command_parts = split_shell_read_command_chain(source_command)?;
    let command_count = command_parts.len();
    let mut calls = Vec::new();

    for (command_index, command) in command_parts.iter().enumerate() {
        let part_args = shell_args_for_command_part(shell_args, command);
        let tokens = shell_tokens(command);
        if is_exploration_context_probe(&tokens) {
            continue;
        }

        let (canonical_name, mut args) =
            if let Some(read_args) = read_file_args_from_shell_args(&part_args) {
                (imported_history::FUNCTION_READ_FILE.to_string(), read_args)
            } else if let Some(glob_args) = rg_files_args_from_shell_args(&part_args) {
                (
                    imported_history::FUNCTION_GLOB_FILE_SEARCH.to_string(),
                    glob_args,
                )
            } else if let Some(search_args) = rg_search_args_from_shell_args(&part_args) {
                (
                    imported_history::FUNCTION_CODE_SEARCH.to_string(),
                    search_args,
                )
            } else if let Some(glob_args) = find_args_from_shell_args(&part_args) {
                (
                    imported_history::FUNCTION_GLOB_FILE_SEARCH.to_string(),
                    glob_args,
                )
            } else {
                return None;
            };

        if command_count > 1 {
            if let Some(object) = args.as_object_mut() {
                object.insert(
                    "source_command".to_string(),
                    Value::String(source_command.to_string()),
                );
                object.insert("command_index".to_string(), json!(command_index));
                object.insert("command_count".to_string(), json!(command_count));
            }
        }
        calls.push((canonical_name, args));
    }

    (!calls.is_empty()).then_some(calls)
}

fn shell_args_for_command_part(shell_args: &Value, command: &str) -> Value {
    let mut part_args = shell_args.clone();
    if let Some(object) = part_args.as_object_mut() {
        object.insert("command".to_string(), Value::String(command.to_string()));
        object.insert("cmd".to_string(), Value::String(command.to_string()));
    }
    part_args
}

fn is_exploration_context_probe(tokens: &[String]) -> bool {
    let Some(executable) = tokens
        .first()
        .map(|token| token.rsplit('/').next().unwrap_or(token))
    else {
        return false;
    };
    match executable {
        "pwd" => tokens.len() == 1,
        "wc" => {
            tokens.len() == 3
                && matches!(tokens[1].as_str(), "-l" | "--lines")
                && !tokens[2].starts_with('-')
        }
        _ => false,
    }
}

fn rg_files_args_from_shell_args(shell_args: &Value) -> Option<Value> {
    let command = shell_args.get("command").and_then(Value::as_str)?.trim();
    let tokens = shell_tokens(command);
    if !tokens.first().is_some_and(|token| is_rg_executable(token))
        || !tokens.iter().any(|token| token == "--files")
        || !has_only_output_limiter_pipeline(&tokens)
    {
        return None;
    }

    let patterns = option_values(&tokens, "-g", "--glob")
        .into_iter()
        .filter(|pattern| !pattern.starts_with('!'))
        .collect::<Vec<_>>();
    let pattern = if patterns.is_empty() {
        "*".to_string()
    } else {
        patterns.join(", ")
    };
    let cwd = shell_args
        .get("cwd")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    Some(json!({
        "action": "find_files",
        "pattern": pattern.clone(),
        "glob": pattern,
        "path": cwd,
        "command": command,
        "cwd": shell_args.get("cwd").cloned().unwrap_or_else(|| json!("")),
        "payload": shell_args.clone(),
    }))
}

fn find_args_from_shell_args(shell_args: &Value) -> Option<Value> {
    let command = shell_args.get("command").and_then(Value::as_str)?.trim();
    let tokens = shell_tokens(command);
    let executable = tokens
        .first()?
        .rsplit('/')
        .next()
        .unwrap_or(tokens.first()?.as_str());
    if executable != "find"
        || tokens.iter().any(|token| {
            matches!(
                token.as_str(),
                "-delete" | "-exec" | "-execdir" | "-ok" | "-okdir" | "-fprint" | "-fprintf"
            )
        })
        || !has_only_output_limiter_pipeline(&tokens)
    {
        return None;
    }

    let pattern = option_values(&tokens, "-name", "-path")
        .into_iter()
        .next()
        .unwrap_or_else(|| "*".to_string());
    let path = tokens
        .get(1)
        .filter(|token| !token.starts_with('-'))
        .cloned()
        .unwrap_or_else(|| ".".to_string());
    let cwd = shell_args
        .get("cwd")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    Some(json!({
        "action": "find_files",
        "pattern": pattern.clone(),
        "glob": pattern,
        "path": path,
        "command": command,
        "cwd": cwd,
        "payload": shell_args.clone(),
    }))
}

fn option_values(tokens: &[String], short: &str, long: &str) -> Vec<String> {
    let mut values = Vec::new();
    let mut index = 0usize;
    while index + 1 < tokens.len() {
        if tokens[index] == short || tokens[index] == long {
            values.push(tokens[index + 1].clone());
            index += 2;
        } else {
            index += 1;
        }
    }
    values
}

fn has_only_output_limiter_pipeline(tokens: &[String]) -> bool {
    let separators = tokens
        .iter()
        .enumerate()
        .filter(|(_, token)| is_shell_separator(token))
        .collect::<Vec<_>>();
    match separators.as_slice() {
        [] => true,
        [(index, separator)] if separator.as_str() == "|" => tokens
            .get(index + 1)
            .is_some_and(|token| matches!(token.as_str(), "head" | "tail" | "sed")),
        _ => false,
    }
}

fn shell_tokens(command: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut chars = command.chars().peekable();

    while let Some(ch) = chars.next() {
        if let Some(active_quote) = quote {
            if ch == active_quote {
                quote = None;
            } else if ch == '\\' && active_quote == '"' {
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            } else {
                current.push(ch);
            }
            continue;
        }

        match ch {
            '\'' | '"' => quote = Some(ch),
            '&' if chars.peek() == Some(&'&') => {
                chars.next();
                push_shell_token(&mut tokens, &mut current);
                tokens.push("&&".to_string());
            }
            '|' if chars.peek() == Some(&'|') => {
                chars.next();
                push_shell_token(&mut tokens, &mut current);
                tokens.push("||".to_string());
            }
            ';' | '|' => {
                push_shell_token(&mut tokens, &mut current);
                tokens.push(ch.to_string());
            }
            ch if ch.is_whitespace() => push_shell_token(&mut tokens, &mut current),
            '\\' => {
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            }
            _ => current.push(ch),
        }
    }

    push_shell_token(&mut tokens, &mut current);
    tokens
}

fn push_shell_token(tokens: &mut Vec<String>, current: &mut String) {
    if current.is_empty() {
        return;
    }
    tokens.push(std::mem::take(current));
}

fn is_shell_separator(token: &str) -> bool {
    matches!(token, "&&" | "||" | ";" | "|")
}

fn is_rg_executable(token: &str) -> bool {
    let executable = token.rsplit('/').next().unwrap_or(token);
    matches!(executable, "rg" | "ripgrep" | "grep")
}

fn rg_pattern_from_tokens(tokens: &[String]) -> Option<String> {
    let mut index = 0usize;
    while index < tokens.len() {
        let token = tokens[index].as_str();
        if is_shell_separator(token) {
            return None;
        }
        if token == "--" {
            return tokens.get(index + 1).cloned();
        }
        if token == "-e" || token == "--regexp" {
            return tokens.get(index + 1).cloned();
        }
        if let Some(rest) = token.strip_prefix("-e") {
            if !rest.is_empty() {
                return Some(rest.to_string());
            }
        }
        if rg_flag_consumes_next(token) {
            index += 2;
            continue;
        }
        if token.starts_with('-') {
            index += 1;
            continue;
        }
        return Some(token.to_string());
    }
    None
}

fn rg_flag_consumes_next(token: &str) -> bool {
    matches!(
        token,
        "-g" | "--glob"
            | "-t"
            | "--type"
            | "-T"
            | "--type-not"
            | "-C"
            | "--context"
            | "-A"
            | "--after-context"
            | "-B"
            | "--before-context"
            | "-m"
            | "--max-count"
            | "--sort"
            | "--sort-files"
    )
}

fn first_apply_patch_file_path(patch: &str) -> Option<String> {
    for line in patch.lines() {
        if let Some(path) = patch_file_path_from_line(line) {
            if path != "/dev/null" {
                return Some(path);
            }
        }
    }
    None
}

fn parse_rg_output_matches(output: &str) -> Vec<(String, i64, String)> {
    output
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(3, ':');
            let file = parts.next()?.trim();
            let line_number = parts.next()?.parse::<i64>().ok()?;
            let content = parts.next().unwrap_or_default();
            if file.is_empty() {
                return None;
            }
            Some((file.to_string(), line_number, content.to_string()))
        })
        .collect()
}

fn user_message_from_payload(payload: &Value) -> Option<String> {
    let raw = payload.get("message").and_then(Value::as_str)?;
    let stripped = strip_orgii_exec_mode_bridge(raw);
    // Bridge-only messages carry no user-authored text: skip them entirely
    // (no replay bubble, no title candidate).
    if stripped.trim().is_empty() {
        return None;
    }
    Some(stripped.to_string())
}

fn session_title_from_payload(payload: &Value) -> Option<String> {
    [
        "title",
        "name",
        "threadName",
        "thread_name",
        "conversationTitle",
        "conversation_title",
    ]
    .iter()
    .filter_map(|key| payload.get(*key).and_then(Value::as_str))
    .map(str::trim)
    .find(|value| !value.is_empty())
    .map(ToString::to_string)
}

fn content_text_from_payload(payload: &Value) -> Option<String> {
    let content = payload.get("content")?;
    match content {
        Value::String(text) => Some(text.clone()),
        Value::Array(items) => {
            let parts = items
                .iter()
                .filter_map(content_part_text)
                .collect::<Vec<_>>();
            if parts.is_empty() {
                None
            } else {
                Some(parts.join("\n"))
            }
        }
        _ => None,
    }
}

fn content_part_text(part: &Value) -> Option<String> {
    part.get("text")
        .and_then(Value::as_str)
        .or_else(|| part.get("content").and_then(Value::as_str))
        .map(ToString::to_string)
}

fn reasoning_text_from_payload(payload: &Value) -> Option<String> {
    if let Some(text) = payload.get("content").and_then(Value::as_str) {
        if !text.trim().is_empty() {
            return Some(text.to_string());
        }
    }
    let summary = payload.get("summary")?.as_array()?;
    let parts = summary
        .iter()
        .filter_map(content_part_text)
        .collect::<Vec<_>>();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}

fn codex_file_stem_from_session_id(session_id: &str) -> Result<&str, String> {
    let Some(file_stem) = session_id.strip_prefix(CODEX_APP_SESSION_PREFIX) else {
        return Err(format!("Invalid Codex app session id: {session_id}"));
    };
    if file_stem.is_empty() {
        return Err("Codex app session id is missing file stem".to_string());
    }
    Ok(file_stem)
}

fn resolve_codex_session_path(conn: &Connection, file_stem: &str) -> Result<PathBuf, String> {
    let transcript_session_id = super::canonical_session_id(file_stem);
    let store = SqliteRecordStore::new(conn);
    if let Some(path) = store
        .get_session_actor_by_transcript_session_id(SOURCE_CODEX_APP, &transcript_session_id)?
        .and_then(|actor| actor.transcript_path)
    {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
    }

    // The lifecycle record stores the stable parent thread UUID plus the
    // child's concrete transcript path. That is enough to rediscover the
    // parent's rollout even when CODEX_HOME is outside the standard roots.
    for actor in store.list_session_actors(SOURCE_CODEX_APP, &transcript_session_id)? {
        let Some(reference_path) = actor.transcript_path.as_deref() else {
            continue;
        };
        let Some(locator) = resolve_codex_transcript_for_thread_id_near_path(
            Path::new(reference_path),
            &actor.source_session_id,
        )?
        else {
            continue;
        };
        if locator.session_id == transcript_session_id && locator.source_path.is_file() {
            return Ok(locator.source_path);
        }
    }

    // Suffix form: runner bindings carry the bare thread uuid while rollout
    // stems are `rollout-<timestamp>-<thread-uuid>`.
    if let Some(path) = imported_cache::get_cached_source_path_by_suffix_from_conn(
        conn,
        SOURCE_CODEX_APP,
        file_stem,
    )? {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
    }

    let mut files = Vec::new();
    for sessions_dir in codex_sessions_dirs()? {
        if sessions_dir.is_dir() {
            collect_codex_session_files(&sessions_dir, &mut files)?;
        }
    }
    let stem_matches = |stem: &str| {
        stem == file_stem
            || (stem.len() > file_stem.len() + 1
                && stem.ends_with(file_stem)
                && stem.as_bytes()[stem.len() - file_stem.len() - 1] == b'-')
    };
    files
        .into_iter()
        .filter(|path| {
            path.file_stem()
                .and_then(|value| value.to_str())
                .is_some_and(stem_matches)
        })
        // Newest rollout wins when several share a thread (resume forks).
        .max_by_key(|path| {
            std::fs::metadata(path)
                .and_then(|meta| meta.modified())
                .ok()
        })
        .ok_or_else(|| format!("Codex app file not found for session: {file_stem}"))
}

fn codex_sessions_dirs() -> Result<Vec<PathBuf>, String> {
    let home = dirs::home_dir().ok_or_else(|| "Home directory not found".to_string())?;
    let mut dirs = codex_sessions_dir_candidates(&home);
    // ORGII-managed own-key Codex runs redirect CODEX_HOME into per-account
    // profile dirs; native-transcript mode reads those rollouts back here.
    // (Hosted-key Codex keeps the system CODEX_HOME and is covered above.)
    dirs.extend(
        crate::sources::imported_history::managed_roots::profile_root_children(
            &app_paths::codex_cli_profile_root(),
            &["sessions"],
        ),
    );
    Ok(dirs)
}

fn codex_sessions_dir_candidates(home: &Path) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    roots.push(home.join(".codex"));

    #[cfg(target_os = "macos")]
    {
        roots.push(
            home.join("Library")
                .join("Application Support")
                .join("Codex"),
        );
        roots.push(
            home.join("Library")
                .join("Application Support")
                .join("codex"),
        );
    }

    #[cfg(target_os = "windows")]
    {
        roots.push(home.join("AppData").join("Roaming").join("Codex"));
        roots.push(home.join("AppData").join("Roaming").join("codex"));
        roots.push(home.join("AppData").join("Local").join("Codex"));
        roots.push(home.join("AppData").join("Local").join("codex"));
    }

    #[cfg(target_os = "linux")]
    {
        roots.push(home.join(".config").join("codex"));
        roots.push(home.join(".local").join("share").join("codex"));
    }

    let mut seen = HashSet::new();
    roots
        .into_iter()
        .filter(|root| seen.insert(root.clone()))
        .map(|root| root.join("sessions"))
        .collect()
}

#[cfg(test)]
#[path = "app_tests.rs"]
mod tests;

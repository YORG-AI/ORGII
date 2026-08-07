//! Claude Code imported history reader
//!
//! Reads Claude Code JSONL transcripts from `~/.claude/projects/*/*.jsonl` and
//! converts them into ORGII's canonical `ActivityChunk` shape for read-only
//! replay.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use core_types::activity::ActivityChunk;
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::sources::imported_history::{
    self, cache as imported_cache, managed_mirror,
    metadata::{
        ImportedHistoryCacheInput, ImportedHistoryDiscoveredRecord, ImportedHistoryImpactStats,
        SOURCE_CLAUDE_CODE,
    },
    paths as imported_paths, ImportedHistoryRecentPath, ImportedHistorySessionPage,
    ImportedHistorySessionRow, ImportedToolCall,
};

use super::SESSION_PREFIX as CLAUDE_CODE_SESSION_PREFIX;
const CLAUDE_CODE_PROVIDER_SLUG: &str = "claudecode";
// v4: read ai-title/custom-title records for the name, and derive diff stats
// from tool_use_result.structuredPatch instead of the old_string/new_string heuristic.
// v6: capture first-user-message uuid as the continuation dedupe group key.
const CLAUDE_CODE_METADATA_PARSER_VERSION: i64 = 6;

pub type ClaudeCodeHistorySessionRow = ImportedHistorySessionRow;
pub type ClaudeCodeHistorySessionPage = ImportedHistorySessionPage;
pub type ClaudeCodeRecentPath = ImportedHistoryRecentPath;

#[derive(Debug, Clone)]
struct ClaudeCodeHistoryMeta {
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
    branch: Option<String>,
    input_tokens: i64,
    output_tokens: i64,
    impact: ImportedHistoryImpactStats,
    /// Set for Task-tool subagent transcripts: the parent session's frontend
    /// id (`claudecodeapp-<parent-uuid>`). `None` for ordinary top-level
    /// sessions. Non-empty values are subsumed out of the sidebar/kanban.
    parent_session_id: Option<String>,
    /// `uuid` of the first `type == "user"` line. Context-window continuation
    /// rewrites copy the conversation into a NEW session file with no link
    /// field, but message uuids are preserved — so this is a stable group key
    /// uniting a conversation's continuation siblings for dedupe.
    first_user_uuid: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeJsonlLine {
    #[serde(default)]
    r#type: String,
    #[serde(default)]
    summary: String,
    /// `ai-title` records: the auto-generated title shown in the Claude Code app.
    #[serde(default)]
    ai_title: String,
    /// `custom-title` records: a user-set title that overrides the AI title.
    #[serde(default)]
    custom_title: String,
    #[serde(default)]
    timestamp: Option<String>,
    #[serde(default)]
    cwd: String,
    #[serde(default)]
    git_branch: String,
    #[serde(default)]
    message: Option<ClaudeMessage>,
    /// Sidecar payload on tool-result lines. For edit tools it carries a
    /// `structuredPatch` with exact `+`/`-` diff lines.
    #[serde(default)]
    tool_use_result: Option<Value>,
    /// `true` on every line of a Task-tool subagent transcript
    /// (`<parent-uuid>/subagents/agent-*.jsonl`). Marks the whole file as a
    /// child session that must be subsumed under its parent.
    #[serde(default)]
    is_sidechain: bool,
    /// The parent session's UUID. On a subagent transcript every line carries
    /// the spawning session's id here (not the subagent's own `agent-*` stem),
    /// which is exactly the parent linkage we need.
    #[serde(default)]
    session_id: String,
    /// Per-message uuid, preserved verbatim across continuation rewrites.
    #[serde(default)]
    uuid: String,
}

#[derive(Debug, Deserialize)]
struct ClaudeMessage {
    #[serde(default)]
    model: String,
    #[serde(default)]
    content: Value,
    #[serde(default)]
    usage: Option<ClaudeUsage>,
}

#[derive(Debug, Deserialize)]
struct ClaudeUsage {
    #[serde(default)]
    input_tokens: i64,
    #[serde(default)]
    output_tokens: i64,
    #[serde(default)]
    cache_read_input_tokens: i64,
    #[serde(default)]
    cache_creation_input_tokens: i64,
}

#[derive(Debug, Clone)]
struct ClaudeSessionTitle {
    name: String,
    name_source: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeSessionMetadataFile {
    #[serde(default)]
    session_id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    name_source: Option<String>,
}

#[derive(Debug, Clone)]
struct ClaudeCodeSessionFile {
    file_stem: String,
    path: PathBuf,
}

pub fn list_claude_code_history_sessions_paginated(
    conn: &mut Connection,
    limit: usize,
    offset: usize,
) -> Result<ClaudeCodeHistorySessionPage, String> {
    sync_claude_code_history_cache(conn)?;
    imported_cache::query_imported_session_page_from_conn(conn, SOURCE_CLAUDE_CODE, limit, offset)
}

pub fn list_claude_code_recent_paths(
    conn: &mut Connection,
    limit: usize,
) -> Result<Vec<ClaudeCodeRecentPath>, String> {
    sync_claude_code_history_cache(conn)?;
    imported_cache::query_imported_recent_paths_from_conn(conn, SOURCE_CLAUDE_CODE, limit)
}

pub fn load_claude_code_history_for_session(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<ActivityChunk>, String> {
    let file_stem = claude_file_stem_from_session_id(session_id)?;
    let path = resolve_claude_session_path(conn, file_stem)?;
    load_claude_code_history_from_path(session_id, &path)
}

/// Cheap freshness probe for one session's transcript: `(mtime_ms, size_bytes)`.
/// Auto-refresh callers compare it against the previous probe and skip the
/// full read/parse/merge pipeline when the source file has not changed —
/// which is every tick for a finished session. Returns `Ok(None)` when the
/// transcript file is missing (caller falls back to a full refresh attempt).
pub fn stat_claude_code_history_for_session(
    conn: &Connection,
    session_id: &str,
) -> Result<Option<(i64, u64)>, String> {
    let file_stem = claude_file_stem_from_session_id(session_id)?;
    let path = resolve_claude_session_path(conn, file_stem)?;
    match fs::metadata(&path) {
        Ok(metadata) => {
            let mtime_ms = metadata
                .modified()
                .ok()
                .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as i64)
                .unwrap_or(0);
            Ok(Some((mtime_ms, metadata.len())))
        }
        Err(_) => Ok(None),
    }
}

fn sync_claude_code_history_cache(conn: &mut Connection) -> Result<(), String> {
    let mut discovered = discover_claude_code_history_records()?;
    // Managed (GUI-launched) sessions surface through their code_sessions
    // row; the imported twin goes unlistable. Folding the verdict into the
    // fingerprint re-parses a session whose managed status flips.
    let managed_ids = managed_mirror::managed_source_session_ids_from_conn(
        conn,
        SOURCE_CLAUDE_CODE,
        SOURCE_CLAUDE_CODE,
    )?;
    for record in &mut discovered {
        managed_mirror::append_managed_fingerprint(
            &mut record.source_fingerprint,
            managed_ids.contains(&record.source_session_id),
        );
    }
    let signatures = discovered
        .iter()
        .map(ImportedHistoryDiscoveredRecord::signature)
        .collect::<Vec<_>>();
    let changed = imported_cache::changed_records_from_conn(
        conn,
        SOURCE_CLAUDE_CODE,
        &discovered,
        |record| record.signature(),
    )?;
    let mut inputs = Vec::new();
    for record in changed {
        if let Some(meta) = parse_claude_session_meta(record)? {
            let is_managed_history_mirror = managed_ids.contains(&meta.source_session_id);
            let mut input = session_meta_to_cache_input(meta);
            input.listable = input.listable && !is_managed_history_mirror;
            inputs.push(input);
        }
    }
    imported_cache::sync_source_cache_from_conn(
        conn,
        SOURCE_CLAUDE_CODE,
        imported_cache::live_ids_from_signatures(&signatures),
        inputs,
    )?;
    // Context-window continuations rewrite the conversation into a new
    // session file with the same first-user-message uuid; keep only the
    // newest sibling of each family listable.
    imported_cache::demote_superseded_continuations_from_conn(conn, SOURCE_CLAUDE_CODE)?;
    Ok(())
}

fn discover_claude_code_history_records() -> Result<Vec<ImportedHistoryDiscoveredRecord>, String> {
    let mut records = Vec::new();
    for projects_dir in claude_projects_dirs()? {
        if projects_dir.is_dir() {
            let title_index = load_claude_session_titles_for_projects_dir(&projects_dir)?;
            let mut files = Vec::new();
            collect_claude_session_files(&projects_dir, &mut files)?;
            for file in files {
                let (source_mtime_ms, source_size_bytes) =
                    imported_paths::file_metadata_signature(&file.path, "Claude")?;
                records.push(ImportedHistoryDiscoveredRecord {
                    source_session_id: file.file_stem.clone(),
                    source_path: file.path,
                    source_record_key: file.file_stem.clone(),
                    source_mtime_ms,
                    source_size_bytes,
                    source_fingerprint: claude_source_fingerprint(&file.file_stem, &title_index),
                    parser_version: CLAUDE_CODE_METADATA_PARSER_VERSION,
                });
            }
        }
    }
    Ok(records)
}

fn collect_claude_session_files(
    dir: &Path,
    out: &mut Vec<ClaudeCodeSessionFile>,
) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|err| format!("Failed to read Claude dir: {err}"))? {
        let entry = entry.map_err(|err| format!("Failed to read Claude dir entry: {err}"))?;
        let path = entry.path();
        if path.is_dir() {
            collect_claude_session_files(&path, out)?;
        } else if path
            .extension()
            .is_some_and(|extension| extension == "jsonl")
        {
            let Some(file_stem) = path.file_stem().and_then(|value| value.to_str()) else {
                continue;
            };
            out.push(ClaudeCodeSessionFile {
                file_stem: file_stem.to_string(),
                path,
            });
        }
    }
    Ok(())
}

fn load_claude_session_titles_for_projects_dir(
    projects_dir: &Path,
) -> Result<HashMap<String, ClaudeSessionTitle>, String> {
    let Some(root) = projects_dir.parent() else {
        return Ok(HashMap::new());
    };
    load_claude_session_titles(&root.join("sessions"))
}

fn load_claude_session_titles(
    sessions_dir: &Path,
) -> Result<HashMap<String, ClaudeSessionTitle>, String> {
    let mut entries = HashMap::new();
    if !sessions_dir.is_dir() {
        return Ok(entries);
    }

    for entry in fs::read_dir(sessions_dir)
        .map_err(|err| format!("Failed to read Claude sessions dir: {err}"))?
    {
        let entry = entry.map_err(|err| format!("Failed to read Claude session entry: {err}"))?;
        let path = entry.path();
        if !path
            .extension()
            .is_some_and(|extension| extension == "json")
        {
            continue;
        }
        let contents = fs::read_to_string(&path).map_err(|err| {
            format!(
                "Failed to read Claude session metadata {}: {err}",
                path.display()
            )
        })?;
        let parsed: ClaudeSessionMetadataFile = match serde_json::from_str(&contents) {
            Ok(parsed) => parsed,
            Err(_) => continue,
        };
        let session_id = parsed.session_id.trim();
        let name = parsed.name.trim();
        if session_id.is_empty() || name.is_empty() {
            continue;
        }
        entries.insert(
            session_id.to_string(),
            ClaudeSessionTitle {
                name: name.to_string(),
                name_source: parsed.name_source,
            },
        );
    }

    Ok(entries)
}

fn claude_source_fingerprint(
    file_stem: &str,
    title_index: &HashMap<String, ClaudeSessionTitle>,
) -> String {
    title_index
        .get(file_stem)
        .map(|title| {
            format!(
                "session-meta:{}:{}",
                title.name_source.as_deref().unwrap_or_default(),
                title.name
            )
        })
        .unwrap_or_default()
}

fn claude_session_title_for_record(
    record: &ImportedHistoryDiscoveredRecord,
) -> Result<String, String> {
    let Some(sessions_dir) = claude_sessions_dir_for_session_path(&record.source_path) else {
        return Ok(String::new());
    };
    let title_index = load_claude_session_titles(&sessions_dir)?;
    Ok(title_index
        .get(&record.source_record_key)
        .map(|title| imported_history::truncate_name(&title.name, 200))
        .unwrap_or_default())
}

fn claude_sessions_dir_for_session_path(session_path: &Path) -> Option<PathBuf> {
    session_path.ancestors().find_map(|ancestor| {
        if ancestor.file_name().and_then(|name| name.to_str()) == Some("projects") {
            return ancestor.parent().map(|root| root.join("sessions"));
        }
        None
    })
}

fn parse_claude_session_meta(
    record: &ImportedHistoryDiscoveredRecord,
) -> Result<Option<ClaudeCodeHistoryMeta>, String> {
    let file = fs::File::open(&record.source_path).map_err(|err| {
        format!(
            "Failed to open Claude history {}: {err}",
            record.source_path.display()
        )
    })?;
    let reader = BufReader::new(file);

    let mut created_at_ms = 0;
    let mut updated_at_ms = 0;
    let mut external_title = claude_session_title_for_record(record)?;
    let mut ai_title = String::new();
    let mut custom_title = String::new();
    let mut first_prompt = String::new();
    let mut model: Option<String> = None;
    let mut repo_path: Option<String> = None;
    let mut branch: Option<String> = None;
    let mut input_tokens = 0;
    let mut output_tokens = 0;
    // Primary impact source: exact counts from tool_use_result.structuredPatch.
    let mut impact = ImportedHistoryImpactStats::default();
    let mut touched_files = BTreeSet::new();
    // Fallback for transcripts old enough to lack structuredPatch: the coarse
    // old_string/new_string line count. Only used when no patch data is found.
    let mut fallback_impact = ImportedHistoryImpactStats::default();
    let mut fallback_touched = BTreeSet::new();
    // Subagent transcripts (`<parent-uuid>/subagents/agent-*.jsonl`) tag every
    // line `isSidechain: true` and carry the spawning session's UUID in
    // `sessionId`. Capturing it lets us subsume the child under its parent the
    // same way Codex does, instead of listing it as a top-level session.
    let mut parent_source_session_id: Option<String> = None;
    let mut first_user_uuid: Option<String> = None;

    for line in reader.lines() {
        let line = line.map_err(|err| format!("Failed to read Claude history line: {err}"))?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let parsed: ClaudeJsonlLine = match serde_json::from_str(trimmed) {
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
        if repo_path.is_none() && !parsed.cwd.trim().is_empty() {
            repo_path = Some(parsed.cwd.clone());
        }
        if branch.is_none() && !parsed.git_branch.trim().is_empty() {
            branch = Some(parsed.git_branch.clone());
        }
        // A sidechain line whose `sessionId` differs from this file's own stem
        // is a subagent pointing at its spawning session. Guard against a self
        // reference so a malformed line can never make a session its own parent.
        if parent_source_session_id.is_none() && parsed.is_sidechain {
            let candidate = parsed.session_id.trim();
            if !candidate.is_empty() && candidate != record.source_session_id {
                parent_source_session_id = Some(candidate.to_string());
            }
        }
        // Claude Code persists the session title inside the transcript. Titles are
        // re-emitted as the conversation evolves, so the last write wins.
        match parsed.r#type.as_str() {
            "summary" if external_title.is_empty() => {
                let summary = parsed.summary.trim();
                if !summary.is_empty() {
                    external_title = imported_history::truncate_name(summary, 200);
                }
            }
            "ai-title" => {
                let title = parsed.ai_title.trim();
                if !title.is_empty() {
                    ai_title = imported_history::truncate_name(title, 200);
                }
            }
            "custom-title" => {
                let title = parsed.custom_title.trim();
                if !title.is_empty() {
                    custom_title = imported_history::truncate_name(title, 200);
                }
            }
            _ => {}
        }
        // Exact diff stats come from the tool-result's structuredPatch.
        if let Some(result) = parsed.tool_use_result.as_ref() {
            collect_claude_impact_from_tool_result(result, &mut impact, &mut touched_files);
        }
        if first_user_uuid.is_none() && parsed.r#type == "user" && !parsed.uuid.trim().is_empty() {
            first_user_uuid = Some(parsed.uuid.trim().to_string());
        }
        if let Some(message) = parsed.message {
            if first_prompt.is_empty() && parsed.r#type == "user" {
                if let Some(text) = claude_content_text(&message.content) {
                    // GUI-launched runs prefix the first prompt with the
                    // exec-mode briefing; bridge-only text is no title
                    // candidate at all.
                    let text = imported_history::strip_orgii_exec_mode_bridge(&text);
                    if !text.trim().is_empty() {
                        first_prompt = imported_history::truncate_name(text, 200);
                    }
                }
            }
            if model.is_none()
                && !message.model.trim().is_empty()
                && !message.model.starts_with('<')
            {
                model = Some(message.model.clone());
            }
            if parsed.r#type == "assistant" {
                for item in claude_content_items(&message.content) {
                    collect_claude_impact_from_item(
                        item,
                        &mut fallback_impact,
                        &mut fallback_touched,
                    );
                }
            }
            if let Some(usage) = message.usage {
                input_tokens += usage.input_tokens
                    + usage.cache_read_input_tokens
                    + usage.cache_creation_input_tokens;
                output_tokens += usage.output_tokens;
            }
        }
    }

    // Prefer the precise structuredPatch counts; fall back to the coarse
    // old_string/new_string heuristic only when no patch data was present.
    if touched_files.is_empty() && impact.lines_added == 0 && impact.lines_removed == 0 {
        impact = fallback_impact;
        touched_files = fallback_touched;
    }

    impact.touched_files = touched_files.into_iter().collect();
    impact.files_changed = impact.touched_files.len() as i64;

    if created_at_ms == 0 && record.source_mtime_ms == 0 {
        return Ok(None);
    }

    Ok(Some(ClaudeCodeHistoryMeta {
        source_session_id: record.source_session_id.clone(),
        session_id: super::canonical_session_id(&record.source_session_id),
        source_path: record.source_path.to_string_lossy().to_string(),
        source_record_key: record.source_record_key.clone(),
        source_mtime_ms: record.source_mtime_ms,
        source_size_bytes: record.source_size_bytes,
        source_fingerprint: record.source_fingerprint.clone(),
        // Mirror the Claude Code app's own precedence: a user-set custom title
        // wins, then the AI-generated title, then the derived/summary title,
        // then the first prompt, and finally the raw session id.
        name: if !custom_title.is_empty() {
            custom_title
        } else if !ai_title.is_empty() {
            ai_title
        } else if !external_title.is_empty() {
            external_title
        } else if !first_prompt.is_empty() {
            first_prompt
        } else {
            record.source_record_key.clone()
        },
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
        branch,
        input_tokens,
        output_tokens,
        impact,
        parent_session_id: parent_source_session_id
            .map(|uuid| format!("{CLAUDE_CODE_SESSION_PREFIX}{uuid}")),
        first_user_uuid,
    }))
}

fn session_meta_to_cache_input(meta: ClaudeCodeHistoryMeta) -> ImportedHistoryCacheInput {
    ImportedHistoryCacheInput {
        source: SOURCE_CLAUDE_CODE,
        source_session_id: meta.source_session_id,
        session_id: meta.session_id,
        source_path: meta.source_path,
        source_record_key: meta.source_record_key,
        source_mtime_ms: meta.source_mtime_ms,
        source_size_bytes: meta.source_size_bytes,
        source_fingerprint: meta.source_fingerprint,
        parser_version: CLAUDE_CODE_METADATA_PARSER_VERSION,
        name: meta.name,
        created_at_ms: meta.created_at_ms,
        updated_at_ms: meta.updated_at_ms,
        model: meta.model,
        input_tokens: meta.input_tokens,
        output_tokens: meta.output_tokens,
        repo_path: meta.repo_path,
        branch: meta.branch,
        impact: meta.impact,
        listable: true,
        source_metadata_json: imported_cache::continuation_group_metadata_json(
            meta.first_user_uuid.as_deref(),
        ),
        parent_session_id: meta.parent_session_id,
    }
}

/// Accumulate exact diff stats from a tool result's `structuredPatch`.
///
/// Claude Code attaches a `toolUseResult` sidecar to Edit/MultiEdit/Write tool
/// results containing a unified-diff-style `structuredPatch`. Each hunk's `lines`
/// are prefixed with `+` (added), `-` (removed), or ` ` (context), so this yields
/// the same counts a `git diff` would — unlike the old_string/new_string heuristic.
fn collect_claude_impact_from_tool_result(
    result: &Value,
    impact: &mut ImportedHistoryImpactStats,
    touched_files: &mut BTreeSet<String>,
) {
    let Some(hunks) = result.get("structuredPatch").and_then(Value::as_array) else {
        return;
    };
    if let Some(file_path) = result
        .get("filePath")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        touched_files.insert(file_path.to_string());
    }
    for hunk in hunks {
        let Some(lines) = hunk.get("lines").and_then(Value::as_array) else {
            continue;
        };
        for line in lines {
            match line.as_str().and_then(|text| text.as_bytes().first()) {
                Some(b'+') => impact.lines_added += 1,
                Some(b'-') => impact.lines_removed += 1,
                _ => {}
            }
        }
    }
}

fn collect_claude_impact_from_item(
    item: &Value,
    impact: &mut ImportedHistoryImpactStats,
    touched_files: &mut BTreeSet<String>,
) {
    if item.get("type").and_then(Value::as_str) != Some("tool_use") {
        return;
    }
    let Some(tool_name) = item.get("name").and_then(Value::as_str) else {
        return;
    };
    if !matches!(tool_name, "Edit" | "MultiEdit" | "Write") {
        return;
    }
    let Some(input) = item.get("input") else {
        return;
    };
    let Some(file_path) = input
        .get("file_path")
        .and_then(Value::as_str)
        .or_else(|| input.get("path").and_then(Value::as_str))
        .map(str::trim)
        .filter(|path| !path.is_empty())
    else {
        return;
    };
    touched_files.insert(file_path.to_string());
    match tool_name {
        "Write" => {
            if let Some(content) = input.get("content").and_then(Value::as_str) {
                impact.lines_added += count_text_lines(content);
            }
        }
        "Edit" => {
            accumulate_claude_edit_input(input, impact);
        }
        "MultiEdit" => {
            if let Some(edits) = input.get("edits").and_then(Value::as_array) {
                for edit in edits {
                    accumulate_claude_edit_input(edit, impact);
                }
            }
        }
        _ => {}
    }
}

fn accumulate_claude_edit_input(input: &Value, impact: &mut ImportedHistoryImpactStats) {
    if let Some(old_string) = input.get("old_string").and_then(Value::as_str) {
        impact.lines_removed += count_text_lines(old_string);
    }
    if let Some(new_string) = input.get("new_string").and_then(Value::as_str) {
        impact.lines_added += count_text_lines(new_string);
    }
}

fn count_text_lines(text: &str) -> i64 {
    if text.is_empty() {
        0
    } else {
        text.lines().count() as i64
    }
}

fn load_claude_code_history_from_path(
    session_id: &str,
    path: &Path,
) -> Result<Vec<ActivityChunk>, String> {
    let file = fs::File::open(path)
        .map_err(|err| format!("Failed to open Claude history {}: {err}", path.display()))?;
    let reader = BufReader::new(file);

    let mut chunks = Vec::new();
    let mut pending_tool_calls: HashMap<String, ImportedToolCall> = HashMap::new();
    let mut sequence = 0usize;

    for line in reader.lines() {
        let line = line.map_err(|err| format!("Failed to read Claude history line: {err}"))?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let parsed: ClaudeJsonlLine = match serde_json::from_str(trimmed) {
            Ok(parsed) => parsed,
            Err(_) => continue,
        };
        let created_at = parsed
            .timestamp
            .as_deref()
            .map(imported_history::normalize_created_at)
            .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
        let Some(message) = parsed.message else {
            continue;
        };

        match parsed.r#type.as_str() {
            "user" => {
                if let Some(tool_result_output) = claude_tool_result_text(&message.content) {
                    if let Some((call_id, output)) = tool_result_output {
                        if let Some(call) = pending_tool_calls.remove(&call_id) {
                            let mut chunk = imported_history::tool_call_chunk(
                                session_id,
                                CLAUDE_CODE_PROVIDER_SLUG,
                                sequence,
                                &call,
                                &output,
                            );
                            // Edit/MultiEdit/Write results carry a
                            // `structuredPatch`; attach it as the exact diff so
                            // the edit card renders the real change.
                            apply_claude_edit_diff(&mut chunk, parsed.tool_use_result.as_ref());
                            chunks.push(chunk);
                            sequence += 1;
                        }
                    }
                } else if let Some(text) = claude_content_text(&message.content) {
                    // Strip the GUI exec-mode briefing; a bridge-only message
                    // carries no user-authored text, so emit no bubble.
                    let text = imported_history::strip_orgii_exec_mode_bridge(&text);
                    if !text.trim().is_empty() {
                        chunks.push(imported_history::user_message_chunk(
                            session_id,
                            CLAUDE_CODE_PROVIDER_SLUG,
                            sequence,
                            &created_at,
                            text,
                        ));
                        sequence += 1;
                    }
                }
            }
            "assistant" => {
                for item in claude_content_items(&message.content) {
                    let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
                    match item_type {
                        "text" => {
                            if let Some(text) = item.get("text").and_then(Value::as_str) {
                                chunks.push(imported_history::assistant_message_chunk(
                                    session_id,
                                    CLAUDE_CODE_PROVIDER_SLUG,
                                    sequence,
                                    &created_at,
                                    text,
                                ));
                                sequence += 1;
                            }
                        }
                        "thinking" => {
                            if let Some(text) = item.get("thinking").and_then(Value::as_str) {
                                chunks.push(imported_history::thinking_chunk(
                                    session_id,
                                    CLAUDE_CODE_PROVIDER_SLUG,
                                    sequence,
                                    &created_at,
                                    text,
                                ));
                                sequence += 1;
                            }
                        }
                        "tool_use" => {
                            if let Some(call) = claude_tool_call_from_item(item, &created_at) {
                                pending_tool_calls.insert(call.call_id.clone(), call);
                            }
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }

    for call in pending_tool_calls.into_values() {
        chunks.push(imported_history::tool_call_chunk(
            session_id,
            CLAUDE_CODE_PROVIDER_SLUG,
            sequence,
            &call,
            "",
        ));
        sequence += 1;
    }

    Ok(chunks)
}

fn claude_tool_call_from_item(item: &Value, created_at: &str) -> Option<ImportedToolCall> {
    let call_id = item.get("id")?.as_str()?.to_string();
    let raw_name = item.get("name")?.as_str()?.to_string();
    let args = item.get("input").cloned().unwrap_or_else(|| json!({}));
    let (canonical_name, args) = normalize_claude_tool_call(&raw_name, args);
    Some(ImportedToolCall {
        call_id,
        raw_name,
        canonical_name,
        args,
        created_at: created_at.to_string(),
    })
}

fn normalize_claude_tool_call(raw_name: &str, args: Value) -> (String, Value) {
    match raw_name {
        "Bash" => (
            imported_history::FUNCTION_RUN_COMMAND_LINE.to_string(),
            normalize_shell_args(args),
        ),
        "Edit" | "MultiEdit" | "Write" => (
            imported_history::FUNCTION_EDIT_FILE.to_string(),
            normalize_edit_args(raw_name, args),
        ),
        _ => (raw_name.to_string(), args),
    }
}

fn normalize_shell_args(args: Value) -> Value {
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

fn normalize_edit_args(raw_name: &str, args: Value) -> Value {
    let file_path = args
        .get("file_path")
        .and_then(Value::as_str)
        .or_else(|| args.get("path").and_then(Value::as_str))
        .unwrap_or_default();
    // `create` for new-file Writes (so the diff card can tag it as new), `edit`
    // otherwise. Old/new text is intentionally NOT carried on the args: the exact
    // diff is threaded onto the result from the tool's `structuredPatch` at
    // result-pairing time (see `apply_claude_edit_diff`), and keeping old/new off
    // the args lets the frontend render that context-rich diff rather than a bare
    // old_string→new_string snippet.
    let action = if raw_name == "Write" {
        "create"
    } else {
        "edit"
    };
    json!({
        "action": action,
        "file_path": file_path,
    })
}

/// Attach the exact edit diff to a tool-result chunk.
///
/// Edit/MultiEdit/Write results carry a `toolUseResult.structuredPatch`; convert
/// it to a unified diff (with surrounding context) and store it on the chunk
/// result as `diff` plus exact `linesAdded`/`linesRemoved`, so the frontend diff
/// card renders the real change. When no patch is present (rare/older
/// transcripts) fall back to the authoritative `oldString`/`newString` (or a
/// Write's `content`) so at least a snippet still renders.
fn apply_claude_edit_diff(chunk: &mut ActivityChunk, tool_use_result: Option<&Value>) {
    let Some(result) = tool_use_result else {
        return;
    };

    if let Some((diff, added, removed)) = claude_unified_diff_from_patch(result) {
        if let Some(obj) = chunk.result.as_object_mut() {
            obj.insert("diff".to_string(), Value::String(diff));
            obj.insert("linesAdded".to_string(), json!(added));
            obj.insert("linesRemoved".to_string(), json!(removed));
        }
        return;
    }

    let old_string = result
        .get("oldString")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let new_string = result
        .get("newString")
        .or_else(|| result.get("content"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    if old_string.is_empty() && new_string.is_empty() {
        return;
    }
    if let Some(obj) = chunk.args.as_object_mut() {
        obj.insert("old_string".to_string(), json!(old_string));
        obj.insert("new_string".to_string(), json!(new_string));
    }
}

/// Convert a `toolUseResult.structuredPatch` into a unified diff string plus its
/// added/removed line counts. Returns `None` when no (non-empty) patch is present.
///
/// Each hunk's `lines` are already prefixed with `+`/`-`/` `, so this yields a
/// standard unified diff that the frontend diff extractor parses directly.
fn claude_unified_diff_from_patch(result: &Value) -> Option<(String, i64, i64)> {
    let hunks = result.get("structuredPatch").and_then(Value::as_array)?;
    if hunks.is_empty() {
        return None;
    }
    let path = result.get("filePath").and_then(Value::as_str).unwrap_or("");
    let mut diff = format!("--- {path}\n+++ {path}\n");
    let mut added = 0i64;
    let mut removed = 0i64;
    for hunk in hunks {
        let old_start = hunk.get("oldStart").and_then(Value::as_i64).unwrap_or(0);
        let old_lines = hunk.get("oldLines").and_then(Value::as_i64).unwrap_or(0);
        let new_start = hunk.get("newStart").and_then(Value::as_i64).unwrap_or(0);
        let new_lines = hunk.get("newLines").and_then(Value::as_i64).unwrap_or(0);
        diff.push_str(&format!(
            "@@ -{old_start},{old_lines} +{new_start},{new_lines} @@\n"
        ));
        let Some(lines) = hunk.get("lines").and_then(Value::as_array) else {
            continue;
        };
        for line in lines {
            let Some(text) = line.as_str() else {
                continue;
            };
            match text.as_bytes().first() {
                Some(b'+') => added += 1,
                Some(b'-') => removed += 1,
                _ => {}
            }
            diff.push_str(text);
            diff.push('\n');
        }
    }
    Some((diff, added, removed))
}

fn claude_content_items(content: &Value) -> Vec<&Value> {
    match content {
        Value::Array(items) => items.iter().collect(),
        _ => Vec::new(),
    }
}

fn claude_content_text(content: &Value) -> Option<String> {
    match content {
        Value::String(text) => Some(text.clone()),
        Value::Array(items) => {
            let parts = items
                .iter()
                .filter_map(|item| item.get("text").and_then(Value::as_str))
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

fn claude_tool_result_text(content: &Value) -> Option<Option<(String, String)>> {
    let Value::Array(items) = content else {
        return None;
    };
    let result_item = items
        .iter()
        .find(|item| item.get("type").and_then(Value::as_str) == Some("tool_result"))?;
    let call_id = result_item.get("tool_use_id")?.as_str()?.to_string();
    let output = match result_item.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        Some(other) => other.to_string(),
        None => String::new(),
    };
    Some(Some((call_id, output)))
}

fn claude_file_stem_from_session_id(session_id: &str) -> Result<&str, String> {
    let Some(file_stem) = session_id.strip_prefix(CLAUDE_CODE_SESSION_PREFIX) else {
        return Err(format!(
            "Invalid Claude Code history session id: {session_id}"
        ));
    };
    if file_stem.is_empty() {
        return Err("Claude Code history session id is missing file stem".to_string());
    }
    Ok(file_stem)
}

fn resolve_claude_session_path(conn: &Connection, file_stem: &str) -> Result<PathBuf, String> {
    if let Some(path) =
        imported_cache::get_cached_source_path_from_conn(conn, SOURCE_CLAUDE_CODE, file_stem)?
    {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
    }

    let mut files = Vec::new();
    for projects_dir in claude_projects_dirs()? {
        if projects_dir.is_dir() {
            collect_claude_session_files(&projects_dir, &mut files)?;
        }
    }
    files
        .into_iter()
        .find(|file| file.file_stem == file_stem)
        .map(|file| file.path)
        .ok_or_else(|| format!("Claude Code history file not found for session: {file_stem}"))
}

fn claude_projects_dirs() -> Result<Vec<PathBuf>, String> {
    let home = dirs::home_dir().ok_or_else(|| "Home directory not found".to_string())?;
    let mut dirs = claude_projects_dir_candidates(&home);
    // ORGII-managed sessions run with CLAUDE_CONFIG_DIR redirected into
    // per-account (own-key) or per-session (hosted-key) profile dirs; in
    // native-transcript mode those stores are the transcript of record.
    dirs.extend(
        crate::sources::imported_history::managed_roots::profile_root_children(
            &app_paths::claude_code_cli_profile_root(),
            &["projects"],
        ),
    );
    Ok(dirs)
}

fn claude_projects_dir_candidates(home: &Path) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    roots.push(home.join(".claude"));

    #[cfg(target_os = "macos")]
    {
        roots.push(
            home.join("Library")
                .join("Application Support")
                .join("Claude Code"),
        );
        roots.push(
            home.join("Library")
                .join("Application Support")
                .join("claude-code"),
        );
        roots.push(
            home.join("Library")
                .join("Application Support")
                .join("Claude"),
        );
    }

    #[cfg(target_os = "windows")]
    {
        roots.push(home.join("AppData").join("Roaming").join("Claude Code"));
        roots.push(home.join("AppData").join("Roaming").join("claude-code"));
        roots.push(home.join("AppData").join("Roaming").join("Claude"));
        roots.push(home.join("AppData").join("Local").join("Claude Code"));
        roots.push(home.join("AppData").join("Local").join("claude-code"));
        roots.push(home.join("AppData").join("Local").join("Claude"));
    }

    #[cfg(target_os = "linux")]
    {
        roots.push(home.join(".config").join("claude-code"));
        roots.push(home.join(".local").join("share").join("claude-code"));
    }

    let mut seen = HashSet::new();
    roots
        .into_iter()
        .filter(|root| seen.insert(root.clone()))
        .map(|root| root.join("projects"))
        .collect()
}

#[cfg(test)]
#[path = "history_tests.rs"]
mod tests;

//! Windsurf imported history reader
//!
//! Reads Windsurf's VS Code-family `state.vscdb` chat storage and converts
//! composer bubbles into ORGII's canonical `ActivityChunk` shape for read-only
//! replay.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use core_types::activity::ActivityChunk;
use rusqlite::{params_from_iter, Connection, OpenFlags, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::sources::imported_history::{
    self, cache as imported_cache,
    metadata::{ImportedHistoryCacheInput, ImportedHistoryImpactStats, SOURCE_WINDSURF},
    paths as imported_paths, ImportedHistoryRecentPath, ImportedHistorySessionPage,
    ImportedHistorySessionRow, ImportedToolCall,
};

pub const WINDSURF_SESSION_PREFIX: &str = "windsurfapp-";
const WINDSURF_PROVIDER_SLUG: &str = "windsurf";
const SQLITE_IN_QUERY_CHUNK_SIZE: usize = 500;
const BUBBLE_TYPE_USER: i64 = 1;
const BUBBLE_TYPE_ASSISTANT: i64 = 2;
// Version 3 adds per-composer impact and explicit subagent parent mapping.
const WINDSURF_METADATA_PARSER_VERSION: i64 = 3;

pub type WindsurfHistorySessionRow = ImportedHistorySessionRow;
pub type WindsurfHistorySessionPage = ImportedHistorySessionPage;
pub type WindsurfRecentPath = ImportedHistoryRecentPath;

#[derive(Debug, Clone)]
struct OrderedBubble {
    bubble_id: String,
    bubble_type: i64,
    raw: RawBubble,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct RawBubble {
    #[serde(rename = "type")]
    bubble_type: i64,
    bubble_id: String,
    created_at: String,
    text: String,
    tool_former_data: Option<RawToolFormerData>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct RawToolFormerData {
    name: String,
    tool_call_id: String,
    status: String,
    params: String,
    result: String,
    additional_data: Value,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct RawComposerHeader {
    bubble_id: String,
    #[serde(rename = "type")]
    bubble_type: i64,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct RawComposerData {
    composer_id: String,
    name: String,
    created_at: i64,
    last_updated_at: i64,
    status: String,
    model_config: Option<ModelConfig>,
    context_tokens_used: f64,
    full_conversation_headers_only: Vec<RawComposerHeader>,
    tracked_git_repos: Vec<RawTrackedGitRepo>,
    workspace_identifier: Option<RawWorkspaceIdentifier>,
    subagent_info: Option<RawSubagentInfo>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct RawSubagentInfo {
    parent_composer_id: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct ModelConfig {
    model_name: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct RawTrackedGitRepo {
    repo_path: String,
    branches: Vec<RawTrackedGitBranch>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct RawTrackedGitBranch {
    branch_name: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct RawWorkspaceIdentifier {
    uri: Option<RawWorkspaceUri>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct RawWorkspaceUri {
    fs_path: String,
    path: String,
}

#[derive(Debug, Clone, Default)]
struct WorkspaceMetadata {
    repo_path: Option<String>,
    branch: Option<String>,
}

#[derive(Debug, Clone)]
struct WindsurfComposerMeta {
    source_session_id: String,
    source_path: String,
    source_record_key: String,
    source_mtime_ms: i64,
    source_size_bytes: i64,
    source_fingerprint: String,
    composer: RawComposerData,
    listable: bool,
    impact: ImportedHistoryImpactStats,
}

pub fn list_windsurf_history_sessions_paginated(
    conn: &mut Connection,
    limit: usize,
    offset: usize,
) -> Result<WindsurfHistorySessionPage, String> {
    sync_windsurf_history_cache(conn)?;
    imported_cache::query_imported_session_page_from_conn(conn, SOURCE_WINDSURF, limit, offset)
}

pub fn list_windsurf_recent_paths(
    conn: &mut Connection,
    limit: usize,
) -> Result<Vec<WindsurfRecentPath>, String> {
    sync_windsurf_history_cache(conn)?;
    imported_cache::query_imported_recent_paths_from_conn(conn, SOURCE_WINDSURF, limit)
}

pub fn load_windsurf_history_for_session(session_id: &str) -> Result<Vec<ActivityChunk>, String> {
    let composer_id = windsurf_composer_id_from_session_id(session_id)?;
    let Some((conn, _db_path)) = open_windsurf_db() else {
        return Ok(Vec::new());
    };
    load_windsurf_history_from_conn(&conn, session_id, composer_id)
}

pub(crate) fn refresh_catalog(cache_conn: &mut Connection) -> Result<(), String> {
    sync_windsurf_history_cache_inner(cache_conn, false)
}

fn sync_windsurf_history_cache(cache_conn: &mut Connection) -> Result<(), String> {
    sync_windsurf_history_cache_inner(cache_conn, true)
}

fn sync_windsurf_history_cache_inner(
    cache_conn: &mut Connection,
    include_legacy_impact: bool,
) -> Result<(), String> {
    let Some((conn, db_path)) = open_windsurf_db() else {
        imported_cache::sync_source_cache_from_conn(
            cache_conn,
            SOURCE_WINDSURF,
            Vec::new(),
            Vec::new(),
        )?;
        return Ok(());
    };
    let (source_mtime_ms, source_size_bytes) =
        imported_paths::file_metadata_signature(&db_path, "Windsurf")?;
    let mut metas = list_windsurf_composer_meta_from_conn_inner(
        &conn,
        &db_path,
        source_mtime_ms,
        source_size_bytes,
        include_legacy_impact,
    )?;
    if !include_legacy_impact {
        for meta in &mut metas {
            if let Some(cached) = imported_cache::query_cached_session_from_conn(
                cache_conn,
                SOURCE_WINDSURF,
                &meta.source_session_id,
            )? {
                meta.impact = cached.impact;
            }
        }
    }
    let live_ids = metas
        .iter()
        .map(|meta| meta.source_session_id.clone())
        .collect::<Vec<_>>();
    let inputs = metas
        .into_iter()
        .map(composer_meta_to_cache_input)
        .collect::<Vec<_>>();
    imported_cache::sync_source_cache_from_conn(cache_conn, SOURCE_WINDSURF, live_ids, inputs)
}

#[cfg(test)]
fn list_windsurf_composer_meta_from_conn(
    conn: &Connection,
    db_path: &Path,
    source_mtime_ms: i64,
    source_size_bytes: i64,
) -> Result<Vec<WindsurfComposerMeta>, String> {
    list_windsurf_composer_meta_from_conn_inner(
        conn,
        db_path,
        source_mtime_ms,
        source_size_bytes,
        true,
    )
}

fn list_windsurf_composer_meta_from_conn_inner(
    conn: &Connection,
    db_path: &Path,
    source_mtime_ms: i64,
    source_size_bytes: i64,
    include_legacy_impact: bool,
) -> Result<Vec<WindsurfComposerMeta>, String> {
    let mut stmt = conn
        .prepare("SELECT value FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
        .map_err(|err| format!("Failed to prepare Windsurf composer query: {err}"))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, Option<String>>(0))
        .map_err(|err| format!("Failed to query Windsurf composers: {err}"))?;

    // A single `state.vscdb` backs every composer, so fold its WAL/`-shm`
    // sidecars into each composer's fingerprint once.
    let sidecar_signature = imported_paths::sqlite_sidecar_signature(db_path);
    let mut metas = Vec::new();
    for row in rows {
        let Some(value) =
            row.map_err(|err| format!("Failed to read Windsurf composer row: {err}"))?
        else {
            continue;
        };
        let Ok(composer) = serde_json::from_str::<RawComposerData>(&value) else {
            continue;
        };
        if composer.composer_id.trim().is_empty() {
            continue;
        }
        let listable = is_listable_composer(&composer);
        let impact = if include_legacy_impact {
            composer_impact(conn, &composer)?
        } else {
            ImportedHistoryImpactStats::default()
        };
        let source_fingerprint = windsurf_source_fingerprint(&composer, &sidecar_signature);
        metas.push(WindsurfComposerMeta {
            source_session_id: composer.composer_id.clone(),
            source_path: db_path.to_string_lossy().to_string(),
            source_record_key: composer.composer_id.clone(),
            source_mtime_ms,
            source_size_bytes,
            source_fingerprint,
            composer,
            listable,
            impact,
        });
    }
    Ok(metas)
}

/// Content-aware change fingerprint for a Windsurf composer.
///
/// The `state.vscdb` mtime alone can stay flat across a same-mtime rewrite, so
/// this folds the composer's own identity/status/timestamp/token/turn-count
/// fields together with the shared WAL/`-shm` sidecar signature.
fn windsurf_source_fingerprint(composer: &RawComposerData, sidecar_signature: &str) -> String {
    [
        composer.composer_id.as_str(),
        composer.name.as_str(),
        composer.status.as_str(),
        &composer.created_at.to_string(),
        &composer.last_updated_at.to_string(),
        &composer.context_tokens_used.to_string(),
        &composer.full_conversation_headers_only.len().to_string(),
        composer
            .subagent_info
            .as_ref()
            .map(|info| info.parent_composer_id.as_str())
            .unwrap_or_default(),
        sidecar_signature,
    ]
    .join("|")
}

fn is_listable_composer(composer: &RawComposerData) -> bool {
    if composer.composer_id.trim().is_empty() || composer.name.trim().is_empty() {
        return false;
    }
    if composer.subagent_info.is_some() || composer.full_conversation_headers_only.is_empty() {
        return false;
    }
    true
}

fn composer_impact(
    conn: &Connection,
    composer: &RawComposerData,
) -> Result<ImportedHistoryImpactStats, String> {
    let key_prefix = format!("bubbleId:{}:", composer.composer_id);
    let mut stmt = conn
        .prepare(
            "SELECT
                json_extract(value, '$.toolFormerData.name'),
                json_extract(value, '$.toolFormerData.params')
             FROM cursorDiskKV
             WHERE substr(key, 1, length(?1)) = ?1
               AND json_valid(value)
               AND lower(COALESCE(json_extract(value, '$.toolFormerData.name'), ''))
                   IN ('edit_file', 'edit_file_v2', 'write_file', 'apply_patch')",
        )
        .map_err(|err| format!("Failed to prepare Windsurf compact impact query: {err}"))?;
    let mut rows = stmt
        .query([key_prefix])
        .map_err(|err| format!("Failed to query Windsurf compact edit rows: {err}"))?;
    let mut touched_files = std::collections::BTreeSet::new();
    let mut impact = ImportedHistoryImpactStats::default();
    while let Some(row) = rows
        .next()
        .map_err(|err| format!("Failed to read Windsurf compact edit row: {err}"))?
    {
        let raw_name = row
            .get::<_, Option<String>>(0)
            .map_err(|err| format!("Failed to read Windsurf compact tool name: {err}"))?
            .unwrap_or_default();
        let raw_args = row
            .get::<_, Option<String>>(1)
            .map_err(|err| format!("Failed to read Windsurf compact tool args: {err}"))?
            .unwrap_or_default();
        let (canonical_name, args) =
            normalize_windsurf_tool_call(&raw_name, imported_history::parse_inner_json(&raw_args));
        let call = ImportedToolCall {
            call_id: String::new(),
            raw_name,
            canonical_name,
            args,
            created_at: String::new(),
        };
        let chunk = imported_history::tool_call_chunk(
            "windsurfapp-catalog",
            WINDSURF_PROVIDER_SLUG,
            0,
            &call,
            "",
        );
        let one = imported_history::impact_from_edit_chunks(&[chunk]);
        impact.lines_added = impact.lines_added.saturating_add(one.lines_added);
        impact.lines_removed = impact.lines_removed.saturating_add(one.lines_removed);
        touched_files.extend(one.touched_files);
    }
    impact.touched_files = touched_files.into_iter().collect();
    impact.files_changed = impact.touched_files.len() as i64;
    Ok(impact)
}

fn composer_meta_to_cache_input(meta: WindsurfComposerMeta) -> ImportedHistoryCacheInput {
    let metadata = workspace_metadata_from_composer(&meta.composer);
    let model = meta
        .composer
        .model_config
        .and_then(|config| (!config.model_name.trim().is_empty()).then_some(config.model_name));
    let updated_at_ms = if meta.composer.last_updated_at > 0 {
        meta.composer.last_updated_at
    } else {
        meta.composer.created_at
    };
    let parent_session_id = meta
        .composer
        .subagent_info
        .as_ref()
        .map(|info| info.parent_composer_id.trim())
        .filter(|parent_id| !parent_id.is_empty() && *parent_id != meta.source_session_id)
        .map(|parent_id| format!("{WINDSURF_SESSION_PREFIX}{parent_id}"));
    let name = if meta.composer.name.trim().is_empty() && parent_session_id.is_some() {
        "Subagent".to_string()
    } else {
        imported_history::truncate_name(&meta.composer.name, 200)
    };
    ImportedHistoryCacheInput {
        source: SOURCE_WINDSURF,
        source_session_id: meta.source_session_id.clone(),
        session_id: format!("{WINDSURF_SESSION_PREFIX}{}", meta.source_session_id),
        source_path: meta.source_path,
        source_record_key: meta.source_record_key,
        source_mtime_ms: meta.source_mtime_ms,
        source_size_bytes: meta.source_size_bytes,
        source_fingerprint: meta.source_fingerprint,
        parser_version: WINDSURF_METADATA_PARSER_VERSION,
        name,
        created_at_ms: meta.composer.created_at,
        updated_at_ms,
        model,
        input_tokens: meta.composer.context_tokens_used.round() as i64,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        repo_path: metadata.repo_path,
        branch: metadata.branch,
        impact: meta.impact,
        listable: meta.listable,
        source_metadata_json: None,
        parent_session_id,
    }
}

fn workspace_metadata_from_composer(composer: &RawComposerData) -> WorkspaceMetadata {
    let tracked_repo = composer.tracked_git_repos.first();
    let repo_path = tracked_repo
        .map(|repo| repo.repo_path.trim())
        .filter(|path| !path.is_empty())
        .map(str::to_string)
        .or_else(|| {
            composer
                .workspace_identifier
                .as_ref()
                .and_then(|workspace| workspace.uri.as_ref())
                .and_then(|uri| {
                    let fs_path = uri.fs_path.trim();
                    if !fs_path.is_empty() {
                        Some(fs_path.to_string())
                    } else {
                        let path = uri.path.trim();
                        (!path.is_empty()).then(|| path.to_string())
                    }
                })
        });
    let branch = tracked_repo
        .and_then(|repo| repo.branches.first())
        .map(|branch| branch.branch_name.trim())
        .filter(|branch| !branch.is_empty())
        .map(str::to_string);

    WorkspaceMetadata { repo_path, branch }
}

fn load_windsurf_history_from_conn(
    conn: &Connection,
    session_id: &str,
    composer_id: &str,
) -> Result<Vec<ActivityChunk>, String> {
    let composer = load_composer(conn, composer_id)?;
    if composer.full_conversation_headers_only.is_empty() {
        return Ok(Vec::new());
    }
    let bubbles = load_bubbles_by_id(conn, composer_id, &composer.full_conversation_headers_only)?;
    Ok(bubbles_to_chunks(conn, session_id, &bubbles))
}

fn load_composer(conn: &Connection, composer_id: &str) -> Result<RawComposerData, String> {
    let key = format!("composerData:{composer_id}");
    let Some(json_str) = conn
        .query_row(
            "SELECT value FROM cursorDiskKV WHERE key = ?1",
            [&key],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|err| format!("Failed to read Windsurf composer {composer_id}: {err}"))?
        .flatten()
    else {
        return Ok(RawComposerData::default());
    };
    if json_str.is_empty() {
        return Ok(RawComposerData::default());
    }
    serde_json::from_str(&json_str)
        .map_err(|err| format!("Failed to parse Windsurf composer {composer_id}: {err}"))
}

fn load_bubbles_by_id(
    conn: &Connection,
    composer_id: &str,
    order: &[RawComposerHeader],
) -> Result<Vec<OrderedBubble>, String> {
    let keyed_headers: Vec<(&RawComposerHeader, String)> = order
        .iter()
        .filter(|header| !header.bubble_id.is_empty())
        .map(|header| {
            (
                header,
                format!("bubbleId:{composer_id}:{}", header.bubble_id),
            )
        })
        .collect();
    if keyed_headers.is_empty() {
        return Ok(Vec::new());
    }

    let mut values_by_key = HashMap::with_capacity(keyed_headers.len());
    for chunk in keyed_headers.chunks(SQLITE_IN_QUERY_CHUNK_SIZE) {
        let placeholders = vec!["?"; chunk.len()].join(",");
        let sql = format!("SELECT key, value FROM cursorDiskKV WHERE key IN ({placeholders})");
        let keys = chunk
            .iter()
            .map(|(_, key)| key.as_str())
            .collect::<Vec<_>>();
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|err| format!("Failed to prepare Windsurf bubble query: {err}"))?;
        let rows = stmt
            .query_map(params_from_iter(keys), |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
            })
            .map_err(|err| format!("Failed to read Windsurf bubbles: {err}"))?;

        for row in rows {
            let (key, Some(value)) =
                row.map_err(|err| format!("Failed to read Windsurf bubble row: {err}"))?
            else {
                continue;
            };
            values_by_key.insert(key, value);
        }
    }

    let mut out = Vec::with_capacity(keyed_headers.len());
    for (header, key) in keyed_headers {
        let Some(json_str) = values_by_key.get(&key) else {
            continue;
        };
        if let Ok(raw) = serde_json::from_str::<RawBubble>(json_str) {
            out.push(OrderedBubble {
                bubble_id: header.bubble_id.clone(),
                bubble_type: header.bubble_type,
                raw,
            });
        }
    }

    Ok(out)
}

fn bubbles_to_chunks(
    conn: &Connection,
    session_id: &str,
    bubbles: &[OrderedBubble],
) -> Vec<ActivityChunk> {
    let mut chunks = Vec::with_capacity(bubbles.len());
    for (sequence, bubble) in bubbles.iter().enumerate() {
        let bubble_type = if bubble.raw.bubble_type != 0 {
            bubble.raw.bubble_type
        } else {
            bubble.bubble_type
        };
        match bubble_type {
            BUBBLE_TYPE_USER => {
                if let Some(chunk) = user_bubble_to_chunk(session_id, sequence, bubble) {
                    chunks.push(chunk);
                }
            }
            BUBBLE_TYPE_ASSISTANT => {
                if let Some(chunk) =
                    assistant_tool_bubble_to_chunk(conn, session_id, sequence, bubble)
                {
                    chunks.push(chunk);
                } else if let Some(chunk) =
                    assistant_text_bubble_to_chunk(session_id, sequence, bubble)
                {
                    chunks.push(chunk);
                }
            }
            _ => {}
        }
    }
    chunks
}

/// Normalize a single Windsurf KV bubble without hydrating the composer.
/// Bounded replay passes rows here only after their stable-key hash changes.
pub(crate) fn replay_chunk_from_bubble_json(
    conn: &Connection,
    session_id: &str,
    _sequence: usize,
    bubble_id: &str,
    header_type: i64,
    raw_json: &str,
) -> Result<Option<ActivityChunk>, String> {
    let raw = serde_json::from_str::<RawBubble>(raw_json)
        .map_err(|err| format!("Failed to parse Windsurf replay bubble {bubble_id}: {err}"))?;
    let bubble = OrderedBubble {
        bubble_id: bubble_id.to_string(),
        bubble_type: header_type,
        raw,
    };
    Ok(bubbles_to_chunks(conn, session_id, &[bubble])
        .into_iter()
        .next())
}

fn user_bubble_to_chunk(
    session_id: &str,
    sequence: usize,
    bubble: &OrderedBubble,
) -> Option<ActivityChunk> {
    let text = bubble.raw.text.trim();
    if text.is_empty() {
        return None;
    }
    Some(imported_history::user_message_chunk(
        session_id,
        WINDSURF_PROVIDER_SLUG,
        sequence,
        &imported_history::normalize_created_at(&bubble.raw.created_at),
        text,
    ))
}

fn assistant_text_bubble_to_chunk(
    session_id: &str,
    sequence: usize,
    bubble: &OrderedBubble,
) -> Option<ActivityChunk> {
    let text = bubble.raw.text.trim();
    if text.is_empty() {
        return None;
    }
    Some(imported_history::assistant_message_chunk(
        session_id,
        WINDSURF_PROVIDER_SLUG,
        sequence,
        &imported_history::normalize_created_at(&bubble.raw.created_at),
        text,
    ))
}

fn assistant_tool_bubble_to_chunk(
    conn: &Connection,
    session_id: &str,
    sequence: usize,
    bubble: &OrderedBubble,
) -> Option<ActivityChunk> {
    let tool_data = bubble.raw.tool_former_data.as_ref()?;
    if tool_data.name.trim().is_empty() {
        return None;
    }
    let args = imported_history::parse_inner_json(&tool_data.params);
    let mut result = imported_history::parse_inner_json(&tool_data.result);
    merge_additional_data(&mut result, &tool_data.additional_data);
    resolve_content_ids(conn, &mut result);
    let (canonical_name, args) = normalize_windsurf_tool_call(&tool_data.name, args);
    let call_id = if tool_data.tool_call_id.trim().is_empty() {
        bubble.bubble_id.clone()
    } else {
        tool_data.tool_call_id.clone()
    };
    let output = tool_output_text(&result);
    let call = ImportedToolCall {
        call_id,
        raw_name: tool_data.name.clone(),
        canonical_name,
        args,
        created_at: imported_history::normalize_created_at(&bubble.raw.created_at),
    };
    let mut chunk = imported_history::tool_call_chunk(
        session_id,
        WINDSURF_PROVIDER_SLUG,
        sequence,
        &call,
        &output,
    );
    if let Some(result_obj) = chunk.result.as_object_mut() {
        if !tool_data.status.trim().is_empty() {
            result_obj.insert(
                "status".to_string(),
                Value::String(tool_data.status.clone()),
            );
        }
        if let Some(source_result) = result.as_object() {
            for key in ["old_content", "new_content"] {
                if let Some(value) = source_result.get(key) {
                    result_obj.insert(key.to_string(), value.clone());
                }
            }
        }
    }
    Some(chunk)
}

fn normalize_windsurf_tool_call(raw_name: &str, args: Value) -> (String, Value) {
    match raw_name {
        "shell" | "run_command" | "terminal" | "terminal_command" => (
            imported_history::FUNCTION_RUN_COMMAND_LINE.to_string(),
            normalize_shell_args(args),
        ),
        "edit_file" | "edit_file_v2" | "write_file" | "apply_patch" => (
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
        .or_else(|| args.get("targetFile").and_then(Value::as_str))
        .or_else(|| args.get("relativeWorkspacePath").and_then(Value::as_str))
        .unwrap_or_default();
    json!({
        "action": raw_name,
        "file_path": file_path,
        "payload": args,
    })
}

fn merge_additional_data(result: &mut Value, additional_data: &Value) {
    let (Some(result_obj), Some(additional_obj)) =
        (result.as_object_mut(), additional_data.as_object())
    else {
        return;
    };
    for (key, value) in additional_obj {
        result_obj
            .entry(key.clone())
            .or_insert_with(|| value.clone());
    }
}

fn resolve_content_ids(conn: &Connection, result: &mut Value) {
    let Some(obj) = result.as_object_mut() else {
        return;
    };
    if let Some(text) = obj
        .get("beforeContentId")
        .and_then(Value::as_str)
        .and_then(|content_id| load_content_blob(conn, content_id))
    {
        obj.insert("old_content".to_string(), Value::String(text));
    }
    if let Some(text) = obj
        .get("afterContentId")
        .and_then(Value::as_str)
        .and_then(|content_id| load_content_blob(conn, content_id))
    {
        obj.insert("new_content".to_string(), Value::String(text));
    }
}

fn load_content_blob(conn: &Connection, content_id: &str) -> Option<String> {
    if content_id.trim().is_empty() {
        return None;
    }
    conn.query_row(
        "SELECT value FROM cursorDiskKV WHERE key = ?1",
        [content_id],
        |row| row.get::<_, Option<String>>(0),
    )
    .optional()
    .ok()
    .flatten()
    .flatten()
}

fn tool_output_text(result: &Value) -> String {
    result
        .get("output")
        .and_then(Value::as_str)
        .or_else(|| result.get("observation").and_then(Value::as_str))
        .or_else(|| result.get("content").and_then(Value::as_str))
        .map(str::to_string)
        .unwrap_or_else(|| result.to_string())
}

fn windsurf_composer_id_from_session_id(session_id: &str) -> Result<&str, String> {
    let Some(composer_id) = session_id.strip_prefix(WINDSURF_SESSION_PREFIX) else {
        return Err(format!("Invalid Windsurf history session id: {session_id}"));
    };
    if composer_id.is_empty() {
        return Err("Windsurf history session id is missing composer id".to_string());
    }
    Ok(composer_id)
}

fn open_windsurf_db() -> Option<(Connection, PathBuf)> {
    let path = windsurf_db_path()?;
    let conn = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    Some((conn, path))
}

fn windsurf_db_path() -> Option<PathBuf> {
    windsurf_db_candidate_paths()
        .into_iter()
        .find(|path| path.exists())
}

fn windsurf_db_candidate_paths() -> Vec<PathBuf> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };

    let mut paths = Vec::new();

    #[cfg(target_os = "macos")]
    {
        let app_support = home.join("Library").join("Application Support");
        paths.push(windsurf_profile_db_path(app_support.join("Windsurf")));
    }

    #[cfg(target_os = "linux")]
    {
        let config = home.join(".config");
        paths.push(windsurf_profile_db_path(config.join("Windsurf")));
    }

    #[cfg(target_os = "windows")]
    {
        let appdata = home.join("AppData").join("Roaming");
        paths.push(windsurf_profile_db_path(appdata.join("Windsurf")));
    }

    paths.push(windsurf_profile_db_path(home.join(".windsurf")));
    imported_paths::dedupe_paths(paths)
}

fn windsurf_profile_db_path(root: PathBuf) -> PathBuf {
    root.join("User").join("globalStorage").join("state.vscdb")
}

#[cfg(test)]
#[path = "history_tests.rs"]
mod tests;

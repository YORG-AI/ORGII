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
use serde_json::Value;

use crate::sources::imported_history::{
    self, cache as imported_cache,
    metadata::{ImportedHistoryCacheInput, ImportedHistoryImpactStats, SOURCE_WINDSURF},
    paths as imported_paths, ImportedHistoryRecentPath, ImportedHistorySessionPage,
    ImportedHistorySessionRow, ImportedToolCall,
};

mod discovery;
mod parts;
mod sync;

use discovery::*;
use parts::*;
use sync::*;

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

#[cfg(test)]
#[path = "../history_tests.rs"]
mod tests;

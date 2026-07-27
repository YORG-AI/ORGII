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

mod discovery;
mod helpers;
mod transcript;

use discovery::*;
use helpers::*;
use transcript::*;

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

#[cfg(test)]
#[path = "../history_tests.rs"]
mod tests;

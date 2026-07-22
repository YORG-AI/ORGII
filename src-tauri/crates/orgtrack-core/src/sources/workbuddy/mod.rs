//! WorkBuddy imported history reader
//!
//! Reads WorkBuddy/CodeBuddy JSONL transcripts from `~/.workbuddy/projects/**`,
//! `~/.codebuddy/projects/**`, and history files, then converts them into ORGII's canonical
//! `ActivityChunk` shape for read-only replay through the existing
//! external-history pipeline.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

use core_types::activity::ActivityChunk;
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::sources::imported_history::{
    self, cache as imported_cache,
    metadata::{
        ImportedHistoryCacheInput, ImportedHistoryDiscoveredRecord, ImportedHistoryImpactStats,
        SOURCE_WORKBUDDY,
    },
    paths as imported_paths, ImportedHistoryRecentPath, ImportedHistorySessionPage,
    ImportedHistorySessionRow, ImportedToolCall,
};

mod content;
mod discovery;
mod impact;
mod paths;
mod transcript;

use content::*;
use discovery::*;
use impact::*;
use paths::*;
use transcript::*;

pub const WORKBUDDY_SESSION_PREFIX: &str = "workbuddyapp-";
const WORKBUDDY_PROVIDER_SLUG: &str = "workbuddy";
const CATALOG_PREFIX_BYTES: u64 = 1024 * 1024;
// Version 2 imports `subagents/agent-*.jsonl` and links them to their parent session.
const WORKBUDDY_METADATA_PARSER_VERSION: i64 = 2;

pub type WorkBuddyHistorySessionRow = ImportedHistorySessionRow;
pub type WorkBuddyHistorySessionPage = ImportedHistorySessionPage;
pub type WorkBuddyRecentPath = ImportedHistoryRecentPath;

#[derive(Debug, Clone)]
struct WorkBuddyHistoryMeta {
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
    parent_session_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct WorkBuddyJsonlLine {
    r#type: String,
    timestamp: Option<Value>,
    created_at: Option<Value>,
    cwd: String,
    project: String,
    git_branch: String,
    session_id: String,
    role: String,
    content: Value,
    raw_content: Value,
    provider_data: Value,
    ai_title: String,
    call_id: String,
    name: String,
    arguments: Value,
    output: Value,
    status: String,
    message: Option<WorkBuddyMessage>,
    function_call: Option<WorkBuddyFunctionCall>,
    function_call_result: Option<WorkBuddyFunctionCallResult>,
    display: String,
}

impl Default for WorkBuddyJsonlLine {
    fn default() -> Self {
        Self {
            r#type: String::new(),
            timestamp: None,
            created_at: None,
            cwd: String::new(),
            project: String::new(),
            git_branch: String::new(),
            session_id: String::new(),
            role: String::new(),
            content: Value::Null,
            raw_content: Value::Null,
            provider_data: Value::Null,
            ai_title: String::new(),
            call_id: String::new(),
            name: String::new(),
            arguments: Value::Null,
            output: Value::Null,
            status: String::new(),
            message: None,
            function_call: None,
            function_call_result: None,
            display: String::new(),
        }
    }
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
struct WorkBuddyMessage {
    role: String,
    model: String,
    content: Value,
    usage: Option<WorkBuddyUsage>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
struct WorkBuddyUsage {
    input_tokens: i64,
    output_tokens: i64,
    prompt_tokens: i64,
    completion_tokens: i64,
    cache_read_input_tokens: i64,
    cache_creation_input_tokens: i64,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct WorkBuddyFunctionCall {
    call_id: String,
    id: String,
    name: String,
    arguments: Value,
    input: Value,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct WorkBuddyFunctionCallResult {
    call_id: String,
    id: String,
    output: Value,
    result: Value,
    content: Value,
    status: String,
}

#[derive(Debug, Clone)]
struct WorkBuddySessionFile {
    file_stem: String,
    path: PathBuf,
}

pub fn list_workbuddy_history_sessions_paginated(
    conn: &mut Connection,
    limit: usize,
    offset: usize,
) -> Result<WorkBuddyHistorySessionPage, String> {
    sync_workbuddy_history_cache(conn)?;
    imported_cache::query_imported_session_page_from_conn(conn, SOURCE_WORKBUDDY, limit, offset)
}

pub fn list_workbuddy_recent_paths(
    conn: &mut Connection,
    limit: usize,
) -> Result<Vec<WorkBuddyRecentPath>, String> {
    sync_workbuddy_history_cache(conn)?;
    imported_cache::query_imported_recent_paths_from_conn(conn, SOURCE_WORKBUDDY, limit)
}

pub fn load_workbuddy_history_for_session(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<ActivityChunk>, String> {
    let source_session_id = workbuddy_file_stem_from_session_id(session_id)?;
    let path = resolve_workbuddy_session_path(conn, source_session_id)?;
    load_workbuddy_history_from_path(session_id, &path)
}

pub(crate) fn refresh_catalog(conn: &mut Connection) -> Result<(), String> {
    refresh_workbuddy_catalog(conn)
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;

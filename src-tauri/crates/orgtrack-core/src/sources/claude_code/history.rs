//! Claude Code imported history reader
//!
//! Reads Claude Code JSONL transcripts from `~/.claude/projects/*/*.jsonl` and
//! converts them into ORGII's canonical `ActivityChunk` shape for read-only
//! replay.

mod cache_sync;
mod discovery;
mod metadata;
mod replay;
mod tools;
mod types;
mod windows;

use super::SESSION_PREFIX as CLAUDE_CODE_SESSION_PREFIX;

const CLAUDE_CODE_PROVIDER_SLUG: &str = "claudecode";
// v4: read ai-title/custom-title records for the name, and derive diff stats
// from tool_use_result.structuredPatch instead of the old_string/new_string heuristic.
// v6: capture first-user-message uuid as the continuation dedupe group key.
// v7: capture cache_read/cache_write tokens separately (input stays cache-inclusive).
// v8: emit per-round usage rows (imported_history_round_usage).
// v9: dedup usage by message.id (one API response spans repeated JSONL lines).
// v10: harness-injected user lines (isMeta, task-notification origin) no
// longer open rounds or feed the first-prompt title; user image blocks
// surface as data-URL attachments on the user bubble.
// v11: capture compact-boundary ancestry markers so continuation families
// survive Claude Code rewriting the first user message during compaction.
// v12: name subagent rows from their small `.meta.json` sidecar instead of
// the shared beginning of each child prompt.
const CLAUDE_CODE_METADATA_PARSER_VERSION: i64 = 12;
const MAX_COMPACT_BOUNDARY_MARKERS: usize =
    crate::sources::imported_history::cache::MAX_CONTINUATION_MARKERS - 1;

pub type ClaudeCodeHistorySessionRow = crate::sources::imported_history::ImportedHistorySessionRow;
pub type ClaudeCodeHistorySessionPage =
    crate::sources::imported_history::ImportedHistorySessionPage;
pub type ClaudeCodeRecentPath = crate::sources::imported_history::ImportedHistoryRecentPath;

pub use cache_sync::{list_claude_code_history_sessions_paginated, list_claude_code_recent_paths};
pub use replay::load_claude_code_history_for_session;
pub use windows::{
    load_claude_code_cloud_turn_windows_for_session, load_claude_code_initial_window_for_session,
    load_claude_code_turn_ids_for_session, load_claude_code_turn_index_for_session,
    load_claude_code_turn_windows_for_session, stat_claude_code_history_for_session,
};

#[cfg(test)]
use std::{collections::HashMap, path::Path};

#[cfg(test)]
use rusqlite::Connection;
#[cfg(test)]
use serde_json::Value;

#[cfg(test)]
use crate::projectors::turn_metadata::project_activity_chunks;
#[cfg(test)]
use crate::sources::imported_history::{
    self, cache as imported_cache,
    metadata::{ImportedHistoryDiscoveredRecord, SOURCE_CLAUDE_CODE},
    paths as imported_paths,
    watermark::ImportedParseWatermark,
};

#[cfg(test)]
use discovery::{
    claude_projects_dir_candidates, claude_projects_dirs, collect_claude_session_files,
    discover_claude_code_history_records, is_claude_workflow_journal_path,
};
#[cfg(test)]
use metadata::{
    parse_claude_session_meta, parse_claude_session_meta_incremental,
    parse_claude_session_meta_with_title, session_meta_to_cache_input,
};
#[cfg(test)]
use replay::load_claude_code_history_from_path;
#[cfg(test)]
use windows::{
    claude_window_turn_id, index_claude_user_turns, load_claude_code_cloud_turn_windows_from_path,
    load_claude_code_initial_window_from_path, load_claude_turn_range, overlay_indexed_body_counts,
    CLAUDE_WINDOW_TURN_ID_PREFIX,
};

#[cfg(test)]
#[path = "history_tests.rs"]
mod tests;

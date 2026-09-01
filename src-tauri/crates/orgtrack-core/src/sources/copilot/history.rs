//! GitHub Copilot CLI imported-history reader.
//!
//! Copilot CLI (verified against 0.0.421 and 1.0.69–1.0.75 stores) writes one
//! directory per session under `~/.copilot/session-state/<uuid>/`:
//!   - `events.jsonl`    — the full event stream, one JSON object per line:
//!     `{"type", "data", "id", "timestamp", "parentId"}`. Replay uses
//!     `user.message`, `assistant.message` (text + `toolRequests`), and the
//!     `tool.execution_start` / `tool.execution_complete` pair; lifecycle and
//!     hook events (`session.*`, `hook.*`, `assistant.turn_*`,
//!     `system.message`) are skipped, and unknown types are ignored so newer
//!     CLIs cannot break the parser.
//!   - `workspace.yaml`  — flat metadata sidecar (`id`, `cwd`, `name`,
//!     `created_at`, `updated_at`, …), hand-parsed here to avoid a YAML
//!     dependency.
//!
//! A sibling `~/.copilot/session-store.db` (SQLite, WAL, possibly held open
//! by a live CLI) enriches rows with `sessions.branch`/`repository` and
//! per-request token usage from `assistant_usage_events`. The db is strictly
//! best-effort: locked/missing/partial stores preserve cached enrichment when
//! available (or degrade to zero tokens and no branch on a cold import) rather
//! than failing the transcript scan.
//!
//! Token semantics, verified empirically against the real store (session
//! `e40a5c3d…`, CLI printout "↑ 26.0k (3.8k cached) ↓ 449 (320 reasoning)"):
//!   - `assistant_usage_events.input_tokens` is already CACHE-INCLUSIVE:
//!     `token_details_json` showed fresh input 10601 + cache_read 2176 =
//!     column value 12777 (and 11579 + 1664 = 13243 on the second request;
//!     12777 + 13243 = 26020 = the printed "↑ 26.0k"). So the column is used
//!     as-is for [`ImportedHistoryCacheInput::input_tokens`] (which must be
//!     cache-inclusive) with `cache_read/write_tokens` reported separately.
//!   - `output_tokens` already INCLUDES `reasoning_tokens`: rows summed to
//!     449 output / 320 reasoning, matching the printed "↓ 449 (320
//!     reasoning)", so reasoning is NOT added on top.

mod bounded;
mod cache_sync;
mod discovery;
mod enrichment;
mod meta_state;
mod metadata;
mod paths;
mod replay;
mod tools;
mod types;
mod workspace;

use crate::sources::imported_history::{
    ImportedHistoryRecentPath, ImportedHistorySessionPage, ImportedHistorySessionRow,
};

use super::SESSION_PREFIX as COPILOT_SESSION_PREFIX;

const COPILOT_PROVIDER_SLUG: &str = "copilot";
/// `code_sessions.cli_agent_type` for managed (GUI-launched) Copilot runs.
const COPILOT_AGENT_TYPE: &str = "copilot";
const COPILOT_METADATA_PARSER_VERSION: i64 = 2;
const EVENTS_FILENAME: &str = "events.jsonl";
const WORKSPACE_FILENAME: &str = "workspace.yaml";
const MAX_WORKSPACE_BYTES: u64 = 64 * 1024;
const MAX_EVENTS_FILE_BYTES: i64 = 64 * 1024 * 1024;
const MAX_CHANGED_SESSIONS_PER_SYNC: usize = 256;
const MAX_PARSE_SOURCE_BYTES_PER_SYNC: i64 = 64 * 1024 * 1024;
const MAX_RECENT_DB_CANDIDATES: usize = 64;
const MAX_DB_CANDIDATES: usize = MAX_CHANGED_SESSIONS_PER_SYNC + MAX_RECENT_DB_CANDIDATES;
const MAX_DB_USAGE_ROWS: usize = 20_000;
const MAX_PARSE_STATE_BYTES: usize = 4 * 1024 * 1024;
const MAX_PENDING_TOOL_CALLS: usize = 4_096;
const MAX_TOOL_REQUESTS_PER_EVENT: usize = 1_024;
const MAX_TOUCHED_FILES: usize = 256;
const MAX_DISCOVERED_SESSIONS: usize = 20_000;
const MAX_ID_BYTES: usize = 1_024;
const MAX_MODEL_BYTES: usize = 1_024;
const MAX_PATH_BYTES: usize = 4_096;
const MAX_REPLAY_CHUNKS: usize = 20_000;
const MAX_REPLAY_TEXT_BYTES: usize = 8 * 1024 * 1024;
const MAX_REPLAY_MESSAGE_CHARS: usize = 50_000;
const MAX_REPLAY_TOOL_RECORDS: usize = 20_000;
/// Cap a single tool-result body so a runaway command output can't bloat the
/// cache/replay payload (same cap as the Cline reader).
const MAX_TOOL_OUTPUT_CHARS: usize = 50_000;

pub type CopilotHistorySessionRow = ImportedHistorySessionRow;
pub type CopilotHistorySessionPage = ImportedHistorySessionPage;
pub type CopilotRecentPath = ImportedHistoryRecentPath;

pub use cache_sync::{list_copilot_history_sessions_paginated, list_copilot_recent_paths};
pub use replay::load_copilot_history_for_session;

#[cfg(test)]
use std::fs;
#[cfg(test)]
use std::path::{Path, PathBuf};

#[cfg(test)]
use rusqlite::Connection;

#[cfg(test)]
use crate::sources::imported_history::{
    self, cache as imported_cache, managed_mirror, metadata::SOURCE_COPILOT,
};

#[cfg(test)]
use cache_sync::sync_copilot_history_cache_in_roots;
#[cfg(test)]
use discovery::{discover_copilot_history_records, is_plain_session_dir_name};
#[cfg(test)]
use enrichment::{
    read_cached_copilot_fingerprints, read_copilot_store_enrichment, strip_managed_fingerprint,
};
#[cfg(test)]
use paths::{
    copilot_session_state_dir_candidates, copilot_session_state_dirs, copilot_session_store_db_path,
    copilot_source_id_from_session_id, ensure_exact_copilot_events_file,
};
#[cfg(test)]
use replay::{events_to_chunks, load_copilot_history_from_path};
#[cfg(test)]
use types::CopilotEventLine;
#[cfg(test)]
use workspace::{parse_workspace_yaml, unquote_yaml_scalar};

#[cfg(test)]
#[path = "history_tests.rs"]
mod tests;

//! Codex app event reader
//!
//! Reads Codex rollout JSONL files from `~/.codex/sessions/YYYY/MM/DD/` and
//! converts them into ORGII's canonical `ActivityChunk` shape. These rows are
//! imported history only: ORGII does not own the Codex process or write back to
//! Codex's local files.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::sources::imported_history::{
    metadata::{ImportedHistoryImpactStats, RoundUsage},
    ImportedHistoryRecentPath, ImportedHistorySessionPage, ImportedHistorySessionRow,
};

mod desktop_exec;
mod impact;
mod index;
mod meta;
mod normalize;
mod transcript;

// Public API — preserved at `...::sources::codex::app::*`.
pub use index::{
    codex_thread_id_from_file_stem, list_codex_app_recent_paths,
    list_codex_app_reconciliation_sessions, list_codex_app_sessions_paginated,
    load_codex_app_cloud_turn_for_session, load_codex_app_for_session,
    load_codex_app_initial_window_for_session, load_codex_app_turn_for_session,
    load_codex_app_turn_ids_for_session,
};
pub use meta::{resolve_codex_transcript_for_thread_id_near_path, CodexTranscriptLocator};
pub(crate) use normalize::normalize_codex_tool_calls;
pub use transcript::{
    load_codex_app_from_path, load_codex_app_initial_window_from_path,
    load_codex_app_turn_from_path, CodexAppInitialWindow, CodexAppTurnWindow,
};

// Internal re-exports so the sibling `app_tests.rs` (`use super::*`) resolves.
#[cfg(test)]
pub(crate) use crate::sources::imported_history::{
    self, metadata::ImportedHistoryDiscoveredRecord, paths as imported_paths,
    strip_orgii_exec_mode_bridge,
};
#[cfg(test)]
pub(crate) use index::{codex_managed_sessions_dirs, codex_sessions_dir_candidates};
#[cfg(test)]
pub(crate) use meta::{parse_codex_session_meta, parse_codex_session_meta_incremental};
#[cfg(test)]
pub(crate) use serde_json::json;
#[cfg(test)]
pub(crate) use transcript::{
    legacy_user_message_text_from_payload, output_parts_for_tool_calls,
    pending_custom_tool_calls_from_payload, strip_ignored_embedded_images,
};

// v9: derive impact from authoritative `patch_apply_end` events (structured
// `changes` map with unified diffs) instead of only scanning `apply_patch`
// tool calls, so `exec`-wrapped and other edit paths are counted too.
// v10: read info.total_token_usage (was top-level), capture cache split +
// per-round deltas.
// v11: retain Codex subagent spawn metadata and the child rollout's plaintext
// first prompt so encrypted collaboration arguments can be reconstructed.
// v12: recognize paginated item_completed/UserMessage records as the canonical
// user-turn boundary while retaining legacy event_msg/user_message support.
// v14: re-derive `repo_path` so the desktop app's own
// `~/Documents/Codex/<date>/<slug>` (and ChatGPT app) scratch dirs are stored
// as no workspace.
const CODEX_APP_METADATA_PARSER_VERSION: i64 = 14;

pub type CodexAppSessionRow = ImportedHistorySessionRow;
pub type CodexAppSessionPage = ImportedHistorySessionPage;
pub type CodexAppRecentPath = ImportedHistoryRecentPath;

#[derive(Debug, Deserialize)]
struct CodexJsonlLine {
    #[serde(default)]
    timestamp: Option<String>,
    #[serde(default, rename = "type")]
    line_type: String,
    #[serde(default)]
    payload: Value,
}

#[derive(Debug, Clone)]
pub(crate) struct CodexAppSessionMeta {
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
    cache_read_tokens: i64,
    cache_write_tokens: i64,
    impact: ImportedHistoryImpactStats,
    rounds: Vec<RoundUsage>,
    source_metadata: CodexAppSourceMetadata,
    /// Raw `session_meta.payload.originator`, naming the client that wrote
    /// this rollout. Empty when the rollout predates the field.
    originator: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexAppSourceMetadata {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    first_prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent_nickname: Option<String>,
}

#[cfg(test)]
#[path = "../app_tests.rs"]
mod tests;

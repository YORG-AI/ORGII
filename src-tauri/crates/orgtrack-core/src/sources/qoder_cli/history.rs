use std::path::PathBuf;

use core_types::activity::ActivityChunk;
use rusqlite::Connection;

use crate::sources::anthropic_jsonl::{self, AnthropicJsonlSource};
use crate::sources::imported_history::{
    metadata::SOURCE_QODER_CLI, ImportedHistoryRecentPath, ImportedHistorySessionPage,
};

pub const QODER_CLI_SESSION_PREFIX: &str = "qodercliapp-";
pub type QoderCliRecentPath = ImportedHistoryRecentPath;

fn config() -> AnthropicJsonlSource {
    AnthropicJsonlSource {
        source: SOURCE_QODER_CLI,
        session_prefix: QODER_CLI_SESSION_PREFIX,
        provider_slug: "qoder_cli",
        display_name: "Qoder CLI",
        parser_version: 2,
        candidate_roots: qoder_cli_history_candidate_paths(),
        // Qoder keeps delegated-agent transcripts below each primary session.
        // They are replay internals, not standalone sessions in the sidebar.
        exclude_subagent_dirs: true,
        max_discovery_depth: None,
        incremental_metadata: false,
        session_id_from_header: false,
    }
}

pub fn list_qoder_cli_history_sessions_paginated(
    conn: &mut Connection,
    limit: usize,
    offset: usize,
) -> Result<ImportedHistorySessionPage, String> {
    anthropic_jsonl::list_sessions_paginated(&config(), conn, limit, offset)
}

pub fn list_qoder_cli_recent_paths(
    conn: &mut Connection,
    limit: usize,
) -> Result<Vec<QoderCliRecentPath>, String> {
    anthropic_jsonl::list_recent_paths(&config(), conn, limit)
}

pub fn load_qoder_cli_history_for_session(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<ActivityChunk>, String> {
    anthropic_jsonl::load_session(&config(), conn, session_id)
}

pub fn qoder_cli_history_candidate_paths() -> Vec<PathBuf> {
    vec![app_paths::external_history_home_dir().join(".qoder/projects")]
}

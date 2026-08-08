use std::path::PathBuf;

use core_types::activity::ActivityChunk;
use rusqlite::Connection;

use crate::sources::anthropic_jsonl::{self, AnthropicJsonlSource};
use crate::sources::imported_history::{
    metadata::SOURCE_OMP, ImportedHistoryRecentPath, ImportedHistorySessionPage,
};

pub const OMP_SESSION_PREFIX: &str = "ompapp-";
pub type OmpRecentPath = ImportedHistoryRecentPath;

fn config() -> AnthropicJsonlSource {
    AnthropicJsonlSource {
        source: SOURCE_OMP,
        session_prefix: OMP_SESSION_PREFIX,
        provider_slug: "omp",
        display_name: "OMP",
        parser_version: 2,
        candidate_roots: omp_history_candidate_paths(),
        exclude_subagent_dirs: false,
        max_discovery_depth: None,
        incremental_metadata: false,
        session_id_from_header: false,
    }
}

pub fn list_omp_history_sessions_paginated(
    conn: &mut Connection,
    limit: usize,
    offset: usize,
) -> Result<ImportedHistorySessionPage, String> {
    anthropic_jsonl::list_sessions_paginated(&config(), conn, limit, offset)
}

pub fn list_omp_recent_paths(
    conn: &mut Connection,
    limit: usize,
) -> Result<Vec<OmpRecentPath>, String> {
    anthropic_jsonl::list_recent_paths(&config(), conn, limit)
}

pub fn load_omp_history_for_session(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<ActivityChunk>, String> {
    anthropic_jsonl::load_session(&config(), conn, session_id)
}

pub fn omp_history_candidate_paths() -> Vec<PathBuf> {
    let home = app_paths::external_history_home_dir();
    vec![
        home.join(".omp/agent/sessions"),
        home.join(".oh-omp/agent/sessions"),
    ]
}

use std::path::PathBuf;

use core_types::activity::ActivityChunk;
use rusqlite::Connection;

use crate::sources::anthropic_jsonl::{self, AnthropicJsonlSource};
use crate::sources::imported_history::{
    metadata::SOURCE_PI, ImportedHistoryRecentPath, ImportedHistorySessionPage,
};

pub const PI_SESSION_PREFIX: &str = "piapp-";
pub type PiRecentPath = ImportedHistoryRecentPath;

fn config() -> AnthropicJsonlSource {
    AnthropicJsonlSource {
        source: SOURCE_PI,
        session_prefix: PI_SESSION_PREFIX,
        provider_slug: "pi",
        display_name: "Pi",
        parser_version: 1,
        candidate_roots: pi_history_candidate_paths(),
        exclude_subagent_dirs: false,
        // Pi's documented layout is exactly
        // sessions/<encoded-cwd>/*.jsonl. Do not turn this into an unbounded
        // home/workspace sweep.
        max_discovery_depth: Some(1),
        incremental_metadata: true,
        session_id_from_header: true,
    }
}

pub fn list_pi_history_sessions_paginated(
    conn: &mut Connection,
    limit: usize,
    offset: usize,
) -> Result<ImportedHistorySessionPage, String> {
    anthropic_jsonl::list_sessions_paginated(&config(), conn, limit, offset)
}

pub fn list_pi_recent_paths(
    conn: &mut Connection,
    limit: usize,
) -> Result<Vec<PiRecentPath>, String> {
    anthropic_jsonl::list_recent_paths(&config(), conn, limit)
}

pub fn load_pi_history_for_session(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<ActivityChunk>, String> {
    anthropic_jsonl::load_session(&config(), conn, session_id)
}

pub fn pi_history_candidate_paths() -> Vec<PathBuf> {
    vec![app_paths::external_history_home_dir().join(".pi/agent/sessions")]
}

#[cfg(test)]
#[path = "history_tests.rs"]
mod tests;

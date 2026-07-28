//! Orgtrack exporter: materializes the on-disk `.orgtrack` layout (records,
//! per-file timelines, session files, the derived index, and the manifest) from
//! the app database.
//!
//! The pipeline is split by concern:
//! - [`export`] drives the scan-to-manifest orchestration;
//! - [`scan`] owns resumable progress and checkpoint state;
//! - [`loaders`] reads the SQLite source rows and inspects schema;
//! - [`file_paths`] pulls edited file paths out of raw tool payloads;
//! - [`identity`] infers agent identity and parsed categories;
//! - [`git`] resolves branch context and commit reachability;
//! - [`summary`] writes records/timelines and builds the index summary.

mod export;
mod file_paths;
mod git;
mod identity;
mod loaders;
mod scan;
mod summary;

pub use export::{export_orgtrack, initialize_orgtrack};
pub use summary::timeline_entry_from_provenance_record;

use std::path::Path;

use super::types::{OrgtrackScanCheckpoint, OrgtrackScanProgress};

#[derive(Debug, Clone)]
struct SessionRow {
    session_id: String,
    label: String,
    agent_kind: Option<String>,
    model: Option<String>,
    key_source: Option<String>,
    agent_exec_mode: Option<String>,
    created_at: Option<String>,
    updated_at: Option<String>,
    summary: Option<String>,
}

#[derive(Debug, Clone)]
struct ProvenanceRow {
    id: i64,
    session_id: String,
    file_path: String,
    function_name: Option<String>,
    node_type: Option<String>,
    start_line: u32,
    end_line: u32,
    created_at: i64,
}

#[derive(Debug, Clone)]
struct LocalEditRow {
    event_id: String,
    session_id: String,
    file_path: String,
    function_name: Option<String>,
    created_at: i64,
}

struct ScanContext<'a> {
    repo_path: &'a Path,
    progress: OrgtrackScanProgress,
    checkpoint: OrgtrackScanCheckpoint,
}

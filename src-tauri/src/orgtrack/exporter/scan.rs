//! Resumable scan bookkeeping: progress snapshots, checkpoints, and the
//! committed-coverage counters surfaced in the derived index.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use chrono::Utc;

use super::ScanContext;
use crate::orgtrack::paths;
use crate::orgtrack::types::{
    OrgtrackScanCheckpoint, OrgtrackScanCounts, OrgtrackScanPhase, OrgtrackScanProgress,
    OrgtrackScanStatus, OrgtrackTier, ORGTRACK_SCHEMA_VERSION,
};

pub(super) fn initial_scan_progress(
    repo_path: &Path,
    tier: OrgtrackTier,
    status: OrgtrackScanStatus,
) -> OrgtrackScanProgress {
    let now = Utc::now().to_rfc3339();
    OrgtrackScanProgress {
        schema_version: ORGTRACK_SCHEMA_VERSION,
        repo_path: repo_path.to_string_lossy().to_string(),
        tier,
        status,
        phase: OrgtrackScanPhase::Discover,
        processed: 0,
        total: 0,
        counts: OrgtrackScanCounts::default(),
        last_error: None,
        resumable: false,
        cancel_requested: false,
        started_at: now.clone(),
        updated_at: now,
        completed_at: None,
    }
}

pub(super) fn read_scan_checkpoint(
    repo_path: &Path,
) -> Result<Option<OrgtrackScanCheckpoint>, String> {
    let path = paths::scan_checkpoint_path(repo_path);
    if !path.exists() {
        return Ok(None);
    }
    paths::read_json(&path).map(Some)
}

fn write_scan_progress(repo_path: &Path, progress: &OrgtrackScanProgress) -> Result<(), String> {
    paths::write_json_pretty(&paths::scan_progress_path(repo_path), progress)
}

pub(super) fn write_scan_state(scan: &mut ScanContext<'_>) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    scan.progress.updated_at = now.clone();
    scan.checkpoint.schema_version = ORGTRACK_SCHEMA_VERSION;
    scan.checkpoint.tier = Some(scan.progress.tier);
    scan.checkpoint.phase = Some(scan.progress.phase);
    scan.checkpoint.processed = scan.progress.processed;
    scan.checkpoint.updated_at = Some(now);
    write_scan_progress(scan.repo_path, &scan.progress)?;
    paths::write_json_pretty(
        &paths::scan_checkpoint_path(scan.repo_path),
        &scan.checkpoint,
    )
}

pub(super) fn committed_files_count(
    files: &BTreeSet<String>,
    file_to_commits: &BTreeMap<String, BTreeSet<String>>,
) -> usize {
    files
        .iter()
        .filter(|file_path| {
            file_to_commits
                .get(*file_path)
                .is_some_and(|commits| !commits.is_empty())
        })
        .count()
}

pub(super) fn committed_rate_percent(files_count: usize, committed_files_count: usize) -> usize {
    if files_count == 0 {
        return 0;
    }
    (committed_files_count * 100).div_ceil(files_count)
}

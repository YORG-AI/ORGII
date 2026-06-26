pub mod analysis_backfill;
pub mod exporter;
pub mod extraction_scheduler;
pub mod history_commands;
pub mod impact_indexer;
pub mod importer;
pub mod paths;
pub mod types;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use database::db::get_connection;
use orgtrack_core::canonical::{
    AgentMetadata, CommitLinkRecord, SessionCheckpointFileStateRecord, SessionCheckpointRecord,
    SessionDiffChunkRecord, SessionEditArtifactRecord, SessionFinalDiffRecord, SessionRecord,
    SOURCE_ORGII_RUST_AGENTS,
};
use orgtrack_core::edit_extraction::final_diff_from_chunks;
use orgtrack_core::policy::{source_tier_policy, SourceTierPolicy};
use orgtrack_core::privacy::ORGTRACK_SCHEMA_VERSION;
use orgtrack_core::projectors::stats::{session_summaries, CoreSessionSummary};
use orgtrack_core::repo_sync::paths::record_id;
use orgtrack_core::store::{sqlite::SqliteRecordStore, RecordStore};
use serde::Serialize;
use types::OrgtrackTier;

const ORGTRACK_CALL_LOG_WINDOW: Duration = Duration::from_secs(30);
const ORGTRACK_CALL_LOG_THRESHOLD: u64 = 10;

#[derive(Debug)]
struct CommandCallStats {
    window_started_at: Instant,
    count: u64,
}

static ORGTRACK_CALL_STATS: OnceLock<Mutex<HashMap<&'static str, CommandCallStats>>> =
    OnceLock::new();

fn record_orgtrack_command_call(command: &'static str) {
    let stats = ORGTRACK_CALL_STATS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = match stats.lock() {
        Ok(guard) => guard,
        Err(err) => {
            tracing::warn!(
                command,
                error = %err,
                "[orgtrack] command frequency tracker mutex poisoned"
            );
            return;
        }
    };

    let now = Instant::now();
    let entry = guard.entry(command).or_insert_with(|| CommandCallStats {
        window_started_at: now,
        count: 0,
    });

    if entry.window_started_at.elapsed() >= ORGTRACK_CALL_LOG_WINDOW {
        if entry.count >= ORGTRACK_CALL_LOG_THRESHOLD {
            tracing::warn!(
                command,
                calls = entry.count,
                window_secs = ORGTRACK_CALL_LOG_WINDOW.as_secs(),
                "[orgtrack] high command invocation rate"
            );
        }
        entry.window_started_at = now;
        entry.count = 0;
    }

    entry.count = entry.count.saturating_add(1);
}

#[tauri::command]
pub async fn orgtrack_initialize(
    repo_path: String,
    tier: Option<String>,
    allow_raw_trajectory: Option<bool>,
) -> Result<types::OrgtrackExportResult, String> {
    record_orgtrack_command_call("orgtrack_initialize");
    let tier = validate_tier(tier.as_deref(), allow_raw_trajectory)?;
    tokio::task::spawn_blocking(move || {
        exporter::initialize_orgtrack(&PathBuf::from(repo_path), tier)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn orgtrack_scan_start(
    repo_path: String,
    tier: Option<String>,
    allow_raw_trajectory: Option<bool>,
    resume: Option<bool>,
    rebuild: Option<bool>,
) -> Result<types::OrgtrackScanProgress, String> {
    record_orgtrack_command_call("orgtrack_scan_start");
    let tier = validate_tier(tier.as_deref(), allow_raw_trajectory)?;
    exporter::start_orgtrack_scan(types::OrgtrackScanOptions {
        repo_path,
        tier,
        allow_raw_trajectory: allow_raw_trajectory.unwrap_or(false),
        resume: resume.unwrap_or(true),
        rebuild: rebuild.unwrap_or(false),
    })
}

#[tauri::command]
pub async fn orgtrack_scan_status(
    repo_path: String,
) -> Result<Option<types::OrgtrackScanProgress>, String> {
    record_orgtrack_command_call("orgtrack_scan_status");
    tokio::task::spawn_blocking(move || exporter::read_scan_progress(&PathBuf::from(repo_path)))
        .await
        .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn orgtrack_scan_cancel(
    repo_path: String,
) -> Result<types::OrgtrackScanProgress, String> {
    record_orgtrack_command_call("orgtrack_scan_cancel");
    tokio::task::spawn_blocking(move || exporter::cancel_orgtrack_scan(&PathBuf::from(repo_path)))
        .await
        .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn orgtrack_export(
    repo_path: String,
    tier: Option<String>,
    allow_raw_trajectory: Option<bool>,
) -> Result<types::OrgtrackExportResult, String> {
    record_orgtrack_command_call("orgtrack_export");
    let tier = validate_tier(tier.as_deref(), allow_raw_trajectory)?;
    tokio::task::spawn_blocking(move || exporter::export_orgtrack(&PathBuf::from(repo_path), tier))
        .await
        .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn orgtrack_sync_core_repo(repo_path: String) -> Result<types::OrgtrackIndex, String> {
    record_orgtrack_command_call("orgtrack_sync_core_repo");
    tokio::task::spawn_blocking(move || {
        let conn = get_connection().map_err(|err| err.to_string())?;
        let store = SqliteRecordStore::new(&conn);
        orgtrack_core::repo_sync::sync_repo_from_store(&store, &PathBuf::from(repo_path))
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn orgtrack_get_index(repo_path: String) -> Result<Option<types::OrgtrackIndex>, String> {
    record_orgtrack_command_call("orgtrack_get_index");
    tokio::task::spawn_blocking(move || importer::read_index(&PathBuf::from(repo_path)))
        .await
        .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn orgtrack_get_file_timeline(
    repo_path: String,
    file_path: String,
) -> Result<Option<types::OrgtrackFileTimeline>, String> {
    record_orgtrack_command_call("orgtrack_get_file_timeline");
    tokio::task::spawn_blocking(move || {
        importer::read_file_timeline(&PathBuf::from(repo_path), &file_path)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn orgtrack_get_session_summaries(
    workspace_path: Option<String>,
) -> Result<Vec<CoreSessionSummary>, String> {
    record_orgtrack_command_call("orgtrack_get_session_summaries");
    tokio::task::spawn_blocking(move || {
        let conn = get_connection().map_err(|err| err.to_string())?;
        let store = SqliteRecordStore::new(&conn);
        let sessions = store.list_sessions(workspace_path.as_deref())?;
        let final_diffs = store.list_final_diffs(None, None)?;
        let commit_links = store.list_commit_links()?;
        let mut summaries = session_summaries(sessions, final_diffs, commit_links);
        apply_runtime_impact_overrides(&mut summaries)?;
        Ok(summaries)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn orgtrack_get_session_summary(
    session_id: String,
) -> Result<Option<CoreSessionSummary>, String> {
    record_orgtrack_command_call("orgtrack_get_session_summary");
    tokio::task::spawn_blocking(move || {
        let conn = get_connection().map_err(|err| err.to_string())?;
        let store = SqliteRecordStore::new(&conn);
        let sessions: Vec<_> = store
            .list_sessions(None)?
            .into_iter()
            .filter(|session| session.session_id == session_id)
            .collect();
        if sessions.is_empty() {
            return Ok(None);
        }
        let final_diffs = store.list_final_diffs(None, Some(&session_id))?;
        let commit_links = store.list_commit_links_for_session(&session_id)?;
        let mut summaries = session_summaries(sessions, final_diffs, commit_links);
        apply_runtime_impact_overrides(&mut summaries)?;
        Ok(summaries.pop())
    })
    .await
    .map_err(|err| err.to_string())?
}

fn apply_runtime_impact_overrides(summaries: &mut [CoreSessionSummary]) -> Result<(), String> {
    for summary in summaries {
        if summary.source != SOURCE_ORGII_RUST_AGENTS {
            continue;
        }
        if let Some(impact) = impact_indexer::get_session_impact(&summary.session_id)? {
            summary.files_changed = impact.files_changed.max(0) as usize;
            summary.lines_added = impact.lines_added.max(0) as i32;
            summary.lines_removed = impact.lines_removed.max(0) as i32;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn orgtrack_analyze_sessions(
    workspace_path: Option<String>,
    session_id: Option<String>,
    rebuild: Option<bool>,
) -> Result<analysis_backfill::AnalysisBackfillStats, String> {
    record_orgtrack_command_call("orgtrack_analyze_sessions");
    tokio::task::spawn_blocking(move || {
        analysis_backfill::analyze_requested(
            workspace_path.as_deref(),
            session_id.as_deref(),
            rebuild.unwrap_or(false),
        )
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn orgtrack_lookup_file_sessions(
    repo_path: String,
    file_path: String,
) -> Result<Option<types::OrgtrackFileSessionLookup>, String> {
    record_orgtrack_command_call("orgtrack_lookup_file_sessions");
    tokio::task::spawn_blocking(move || {
        importer::read_file_session_lookup(&PathBuf::from(repo_path), &file_path)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn orgtrack_get_source_tier_policy(source: String) -> Result<SourceTierPolicy, String> {
    record_orgtrack_command_call("orgtrack_get_source_tier_policy");
    Ok(source_tier_policy(&source))
}

#[tauri::command]
pub async fn orgtrack_get_extraction_memory_gate(
) -> Result<extraction_scheduler::ExtractionMemoryGateState, String> {
    record_orgtrack_command_call("orgtrack_get_extraction_memory_gate");
    Ok(extraction_scheduler::evaluate_memory_gate(
        &extraction_scheduler::ExtractionMemoryGateConfig::default(),
    ))
}

#[tauri::command]
pub async fn orgtrack_get_session_edit_artifacts(
    source: Option<String>,
    session_id: Option<String>,
) -> Result<Vec<SessionEditArtifactRecord>, String> {
    record_orgtrack_command_call("orgtrack_get_session_edit_artifacts");
    tokio::task::spawn_blocking(move || {
        let conn = get_connection().map_err(|err| err.to_string())?;
        let store = SqliteRecordStore::new(&conn);
        store.list_edit_artifacts(source.as_deref(), session_id.as_deref())
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn orgtrack_get_session_diff_chunks(
    source: Option<String>,
    session_id: Option<String>,
) -> Result<Vec<SessionDiffChunkRecord>, String> {
    record_orgtrack_command_call("orgtrack_get_session_diff_chunks");
    tokio::task::spawn_blocking(move || {
        let conn = get_connection().map_err(|err| err.to_string())?;
        let store = SqliteRecordStore::new(&conn);
        store.list_diff_chunks(source.as_deref(), session_id.as_deref())
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn orgtrack_get_session_final_diffs(
    source: Option<String>,
    session_id: Option<String>,
) -> Result<Vec<SessionFinalDiffRecord>, String> {
    record_orgtrack_command_call("orgtrack_get_session_final_diffs");
    tokio::task::spawn_blocking(move || {
        let conn = get_connection().map_err(|err| err.to_string())?;
        let store = SqliteRecordStore::new(&conn);
        let final_diffs = store.list_final_diffs(source.as_deref(), session_id.as_deref())?;
        let final_diffs = if let Some(session_id) = session_id.as_deref() {
            let chunks = store.list_diff_chunks(source.as_deref(), Some(session_id))?;
            repair_collapsed_final_diffs(final_diffs, &chunks)
        } else {
            final_diffs
        };
        Ok(final_diffs
            .into_iter()
            .filter(|diff| !is_temporary_diff_path(&diff.file_path))
            .collect())
    })
    .await
    .map_err(|err| err.to_string())?
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgtrackDiffReplayPreview {
    pub final_diffs: Vec<SessionFinalDiffRecord>,
    pub submission_commits: Vec<OrgtrackSubmissionCommit>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgtrackSubmissionCommit {
    pub sha: String,
    #[serde(rename = "short_sha")]
    pub short_sha: String,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<serde_json::Value>,
    #[serde(rename = "repoId", skip_serializing_if = "Option::is_none")]
    pub repo_id: Option<String>,
    #[serde(rename = "repoPath", skip_serializing_if = "Option::is_none")]
    pub repo_path: Option<String>,
    pub origin: String,
}

fn commit_link_to_submission_commit(
    link: CommitLinkRecord,
    repo_id: &Option<String>,
    repo_path: &Option<String>,
) -> OrgtrackSubmissionCommit {
    let short_sha = link.commit_sha.chars().take(7).collect::<String>();
    OrgtrackSubmissionCommit {
        sha: link.commit_sha,
        short_sha: short_sha.clone(),
        summary: short_sha,
        author: None,
        repo_id: repo_id.clone(),
        repo_path: repo_path.clone(),
        origin: "created".to_string(),
    }
}

fn is_temporary_diff_path(file_path: &str) -> bool {
    let path = Path::new(file_path);
    path.starts_with("/tmp")
        || path
            .components()
            .any(|component| component.as_os_str() == "scratchpad")
}

fn repair_collapsed_final_diffs(
    final_diffs: Vec<SessionFinalDiffRecord>,
    chunks: &[SessionDiffChunkRecord],
) -> Vec<SessionFinalDiffRecord> {
    let mut chunk_stats_by_file: HashMap<&str, (usize, i32, i32)> = HashMap::new();
    let mut chunks_by_file: HashMap<&str, Vec<SessionDiffChunkRecord>> = HashMap::new();
    for chunk in chunks {
        let stats = chunk_stats_by_file
            .entry(chunk.file_path.as_str())
            .or_insert((0, 0, 0));
        stats.0 += 1;
        stats.1 += chunk.lines_added;
        stats.2 += chunk.lines_removed;
        chunks_by_file
            .entry(chunk.file_path.as_str())
            .or_default()
            .push(chunk.clone());
    }

    final_diffs
        .into_iter()
        .map(|diff| {
            let Some((chunk_count, chunk_lines_added, chunk_lines_removed)) =
                chunk_stats_by_file.get(diff.file_path.as_str())
            else {
                return diff;
            };
            let is_collapsed = *chunk_count > 1
                && (diff.lines_added + diff.lines_removed)
                    < (*chunk_lines_added + *chunk_lines_removed)
                && (diff.lines_added < *chunk_lines_added
                    || diff.lines_removed < *chunk_lines_removed);
            if !is_collapsed {
                return diff;
            }
            chunks_by_file
                .get(diff.file_path.as_str())
                .and_then(|file_chunks| {
                    final_diff_from_chunks(
                        &diff.source,
                        &diff.session_id,
                        &diff.file_path,
                        file_chunks,
                    )
                })
                .unwrap_or(diff)
        })
        .collect()
}

#[tauri::command]
pub async fn orgtrack_get_diff_replay_preview(
    source: Option<String>,
    session_id: Option<String>,
    repo_id: Option<String>,
    repo_path: Option<String>,
) -> Result<OrgtrackDiffReplayPreview, String> {
    record_orgtrack_command_call("orgtrack_get_diff_replay_preview");
    tokio::task::spawn_blocking(move || {
        let conn = get_connection().map_err(|err| err.to_string())?;
        let store = SqliteRecordStore::new(&conn);
        let mut final_diffs = store.list_final_diffs(source.as_deref(), session_id.as_deref())?;
        if let Some(session_id) = session_id.as_deref() {
            let chunks = store.list_diff_chunks(source.as_deref(), Some(session_id))?;
            final_diffs = repair_collapsed_final_diffs(final_diffs, &chunks);
        }
        let final_diffs = final_diffs
            .into_iter()
            .filter(|diff| !is_temporary_diff_path(&diff.file_path))
            .collect();
        let commit_links = store.list_commit_links()?;
        let commit_links = match session_id {
            Some(session_id) => commit_links
                .into_iter()
                .filter(|link| {
                    link.session_ids
                        .iter()
                        .any(|linked_id| linked_id == &session_id)
                })
                .collect(),
            None => commit_links,
        };
        let submission_commits = commit_links
            .into_iter()
            .map(|link| commit_link_to_submission_commit(link, &repo_id, &repo_path))
            .collect();

        Ok(OrgtrackDiffReplayPreview {
            final_diffs,
            submission_commits,
        })
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn orgtrack_get_session_commit_links(
    session_id: Option<String>,
) -> Result<Vec<CommitLinkRecord>, String> {
    record_orgtrack_command_call("orgtrack_get_session_commit_links");
    tokio::task::spawn_blocking(move || {
        let conn = get_connection().map_err(|err| err.to_string())?;
        let store = SqliteRecordStore::new(&conn);
        let commit_links = store.list_commit_links()?;
        Ok(match session_id {
            Some(session_id) => commit_links
                .into_iter()
                .filter(|link| {
                    link.session_ids
                        .iter()
                        .any(|linked_id| linked_id == &session_id)
                })
                .collect(),
            None => commit_links,
        })
    })
    .await
    .map_err(|err| err.to_string())?
}

/// Debug-only: seed an orgtrack commit link for WDIO Submissions-tab specs.
///
/// Production commit links are written by `analysis_backfill` after the
/// extraction scheduler parses a `git commit` / `git push` shell event. That
/// path is async and depends on a real provider run, so WDIO specs cannot
/// reach it. This wire writes the same `CommitLinkRecord` shape the backfill
/// produces (camelCase JSON, `observed_in_terminal_output` reachability) so
/// `orgtrack_get_session_commit_links` returns it and the Submissions tab
/// renders the commit exactly like a live push. Returns Err in release builds.
#[tauri::command]
pub async fn debug_seed_commit_link(session_id: String, commit_sha: String) -> Result<(), String> {
    if !cfg!(debug_assertions) {
        return Err("debug_seed_commit_link is only available in debug builds".into());
    }
    if session_id.is_empty() || commit_sha.is_empty() {
        return Err("debug_seed_commit_link: `session_id` and `commit_sha` are required".into());
    }
    tokio::task::spawn_blocking(move || {
        let conn = get_connection().map_err(|err| err.to_string())?;
        let store = SqliteRecordStore::new(&conn);
        let record_id = record_id(&["debug_seed_commit_link", &session_id, &commit_sha]);
        store.upsert_commit_link(&CommitLinkRecord {
            schema_version: ORGTRACK_SCHEMA_VERSION,
            record_id,
            commit_sha,
            file_paths: Vec::new(),
            session_ids: vec![session_id],
            reachability_state: "observed_in_terminal_output".to_string(),
            linked_at: chrono::Utc::now().to_rfc3339(),
        })
    })
    .await
    .map_err(|err| err.to_string())?
}

/// Debug-only: seed an orgtrack final-diff record for WDIO Diff-tab-content specs.
///
/// The extraction scheduler produces `SessionFinalDiffRecord` entries from
/// real edit events; because that path requires a live agent run, WDIO specs
/// cannot seed diff-tab content through it. This wire writes a record with
/// the same shape, but only a `diff` unified-diff string (no old_content /
/// new_content), replicating the bug shape where orgtrack consolidation stores
/// only the unified diff. Returns Err in release builds.
#[tauri::command]
pub async fn debug_seed_final_diff(
    session_id: String,
    source: String,
    file_path: String,
    diff: String,
) -> Result<(), String> {
    if !cfg!(debug_assertions) {
        return Err("debug_seed_final_diff is only available in debug builds".into());
    }
    if session_id.is_empty() || source.is_empty() || file_path.is_empty() || diff.is_empty() {
        return Err("debug_seed_final_diff: all fields are required".into());
    }
    tokio::task::spawn_blocking(move || {
        let conn = get_connection().map_err(|err| err.to_string())?;
        let store = SqliteRecordStore::new(&conn);
        // Seed a minimal session record so on-demand reanalysis
        // (`analyze_requested`) can find this session in `list_sessions` and
        // act on it. Without a session row the reanalyze loop skips it and the
        // seeded residue would never reconcile — which is exactly the path the
        // restore-checkpoint Diff-reconcile spec exercises.
        store.upsert_session(&SessionRecord {
            schema_version: ORGTRACK_SCHEMA_VERSION,
            source: source.clone(),
            source_session_id: session_id.clone(),
            session_id: session_id.clone(),
            title: String::new(),
            status: None,
            created_at: Some(chrono::Utc::now().to_rfc3339()),
            updated_at: Some(chrono::Utc::now().to_rfc3339()),
            completed_at: None,
            workspace_path: None,
            branch: None,
            parent_session_id: None,
            org_member_id: None,
            metadata: AgentMetadata::default(),
        })?;
        let record_id = record_id(&["debug_seed_final_diff", &session_id, &file_path]);
        let words: Vec<&str> = diff.lines().collect();
        let lines_added = words
            .iter()
            .filter(|l| l.starts_with('+') && !l.starts_with("+++"))
            .count() as i32;
        let lines_removed = words
            .iter()
            .filter(|l| l.starts_with('-') && !l.starts_with("---"))
            .count() as i32;
        store.upsert_final_diff(&SessionFinalDiffRecord {
            schema_version: ORGTRACK_SCHEMA_VERSION,
            record_id,
            source,
            session_id,
            file_path,
            baseline_event_id: None,
            final_event_id: None,
            old_content: None,
            new_content: None,
            diff: Some(diff),
            lines_added,
            lines_removed,
            is_deleted: false,
            quality: orgtrack_core::canonical::ArtifactQuality::PatchReversible,
            differs_from_summed_chunks: false,
            computed_at: chrono::Utc::now().to_rfc3339(),
        })
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn orgtrack_get_session_checkpoints(
    source: Option<String>,
    session_id: Option<String>,
) -> Result<Vec<SessionCheckpointRecord>, String> {
    record_orgtrack_command_call("orgtrack_get_session_checkpoints");
    tokio::task::spawn_blocking(move || {
        let conn = get_connection().map_err(|err| err.to_string())?;
        let store = SqliteRecordStore::new(&conn);
        store.list_session_checkpoints(source.as_deref(), session_id.as_deref())
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn orgtrack_get_checkpoint_file_states(
    checkpoint_id: String,
) -> Result<Vec<SessionCheckpointFileStateRecord>, String> {
    record_orgtrack_command_call("orgtrack_get_checkpoint_file_states");
    tokio::task::spawn_blocking(move || {
        let conn = get_connection().map_err(|err| err.to_string())?;
        let store = SqliteRecordStore::new(&conn);
        store.list_checkpoint_file_states(&checkpoint_id)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[cfg(test)]
mod tests {
    use super::is_temporary_diff_path;

    #[test]
    fn hides_tmp_and_scratchpad_diff_paths() {
        assert!(is_temporary_diff_path("/tmp/stale_probe.txt"));
        assert!(is_temporary_diff_path(
            "/private/var/folders/sj/orgii-501/project/sdeagent-id/scratchpad/stale_probe.txt"
        ));
        assert!(!is_temporary_diff_path(
            "/Users/vinceorz/Projects/ORG2/src/main.ts"
        ));
        assert!(!is_temporary_diff_path(
            "/Users/vinceorz/Downloads/notes.txt"
        ));
    }
}

fn validate_tier(
    tier: Option<&str>,
    allow_raw_trajectory: Option<bool>,
) -> Result<OrgtrackTier, String> {
    let tier = OrgtrackTier::from_optional_str(tier)?;
    if tier.includes_trajectory() && allow_raw_trajectory != Some(true) {
        return Err(
            "Trajectory export can include prompts, tool payloads, file contents, and secrets. Pass allowRawTrajectory=true to opt in."
                .to_string(),
        );
    }
    Ok(tier)
}

//! Diff / checkpoint / commit-link Tauri commands.
//!
//! Read-only wrappers over `RecordStore`'s diff-chunk, final-diff, edit
//! artifact, checkpoint, and commit-link tables, plus two debug-only seams
//! (`debug_seed_commit_link`, `debug_seed_final_diff`) that let WDIO specs
//! populate these tables without a live agent run.

use std::collections::HashMap;
use std::path::Path;

use database::db::get_connection;
use orgtrack_core::canonical::{
    AgentMetadata, CommitLinkRecord, SessionCheckpointFileStateRecord, SessionCheckpointRecord,
    SessionDiffChunkRecord, SessionEditArtifactRecord, SessionFinalDiffRecord, SessionRecord,
    SOURCE_ORGII_RUST_AGENTS,
};
use orgtrack_core::edit_extraction::final_diff_from_chunks;
use orgtrack_core::privacy::ORGTRACK_SCHEMA_VERSION;
use orgtrack_core::repo_sync::paths::record_id;
use orgtrack_core::store::{sqlite::SqliteRecordStore, RecordStore};
use serde::Serialize;

use super::command_stats::record_orgtrack_command_call;

/// Delete a session's derived orgtrack artifacts (final diffs, edit artifacts,
/// diff chunks, file changes, checkpoints, commit links) WITHOUT recomputing.
///
/// Used by checkpoint-restore to drop diff rows that no longer match the rewound
/// event stream. This is a pure invalidation, not an analysis pass: the Diff (N)
/// panel reads live from these tables, so clearing them makes it show the clean
/// post-checkpoint state. Subsequent real edits repopulate the tables via the
/// live runtime path.
#[tauri::command]
pub async fn orgtrack_delete_session_artifacts(session_id: String) -> Result<(), String> {
    record_orgtrack_command_call("orgtrack_delete_session_artifacts");
    tokio::task::spawn_blocking(move || {
        let conn = get_connection().map_err(|err| err.to_string())?;
        let store = SqliteRecordStore::new(&conn);
        store.delete_session_artifacts(SOURCE_ORGII_RUST_AGENTS, &session_id)
    })
    .await
    .map_err(|err| err.to_string())?
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

pub(super) fn is_temporary_diff_path(file_path: &str) -> bool {
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
/// Commit links are normally derived from a real provider run parsing a
/// `git commit` / `git push` shell event — an async path WDIO specs cannot
/// reach. This wire writes a `CommitLinkRecord` directly (camelCase JSON,
/// `observed_in_terminal_output` reachability) so
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
            collaboration_origin: None,
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

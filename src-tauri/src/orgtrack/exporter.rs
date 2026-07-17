use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use chrono::{DateTime, Utc};
use core_types::tool_names;
use database::db::get_connection;
use git::util::run_git;
use rusqlite::params;

use super::paths;
use super::types::{
    OrgtrackAgentIdentity, OrgtrackBranchContext, OrgtrackChangedFile, OrgtrackCommitRecord,
    OrgtrackExportResult, OrgtrackFileTimelineEntry, OrgtrackIndex, OrgtrackIndexCommit,
    OrgtrackIndexFile, OrgtrackIndexSession, OrgtrackManifest, OrgtrackParsedCategory,
    OrgtrackProvenanceRecord, OrgtrackRawEvent, OrgtrackRawEventSource, OrgtrackReachability,
    OrgtrackReachabilityState, OrgtrackScanCheckpoint, OrgtrackScanCounts, OrgtrackScanPhase,
    OrgtrackScanProgress, OrgtrackScanStatus, OrgtrackSessionDetails, OrgtrackSessionMeta,
    OrgtrackSessionTrajectory, OrgtrackSummaryBucket, OrgtrackSymbolEntry, OrgtrackTier,
    OrgtrackTimelineEntryType, OrgtrackTimelineRecord, ORGTRACK_SCHEMA_VERSION,
};

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

pub fn initialize_orgtrack(
    repo_path: &Path,
    tier: OrgtrackTier,
) -> Result<OrgtrackExportResult, String> {
    export_orgtrack(repo_path, tier)
}

pub fn export_orgtrack(
    repo_path: &Path,
    tier: OrgtrackTier,
) -> Result<OrgtrackExportResult, String> {
    paths::ensure_orgtrack_dirs(repo_path)?;
    let mut config = paths::load_config(repo_path)?;
    if !config.tracked_tiers.contains(&tier) {
        config.tracked_tiers.push(tier);
    }
    paths::write_json_pretty(&paths::config_path(repo_path), &config)?;

    let conn = get_connection().map_err(|err| format!("DB error: {}", err))?;
    let provenance = load_provenance_rows(&conn, repo_path)?;
    let local_edits = load_local_edit_rows(&conn, repo_path)?;
    let session_ids: BTreeSet<String> = provenance
        .iter()
        .map(|row| row.session_id.clone())
        .chain(local_edits.iter().map(|row| row.session_id.clone()))
        .collect();
    let sessions = load_session_rows(&conn, &session_ids)?;
    let commit_links = load_commit_links(&conn)?;
    let branch_context = branch_context_for(repo_path);
    let mut scan = ScanContext {
        repo_path,
        progress: initial_scan_progress(repo_path, tier, OrgtrackScanStatus::Running),
        checkpoint: read_scan_checkpoint(repo_path)?.unwrap_or_default(),
    };
    scan.progress.phase = OrgtrackScanPhase::Discover;
    scan.progress.total =
        provenance.len() + local_edits.len() + session_ids.len() + commit_links.len() + 1;
    scan.progress.resumable = true;
    write_scan_state(&mut scan)?;

    let mut provenance_records = Vec::new();
    let mut session_to_files: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut session_to_commits: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut session_symbols: BTreeMap<String, Vec<OrgtrackSymbolEntry>> = BTreeMap::new();
    let mut file_to_sessions: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut file_to_commits: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut file_entry_count: BTreeMap<String, usize> = BTreeMap::new();
    let mut commit_to_files: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut commit_to_sessions: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();

    scan.progress.phase = OrgtrackScanPhase::Provenance;
    write_scan_state(&mut scan)?;
    for row in &provenance {
        let already_checkpointed = scan
            .checkpoint
            .last_provenance_id
            .is_some_and(|last_id| row.id <= last_id);
        let file_path = paths::repo_relative_path(repo_path, &row.file_path);
        let linked_commits = commit_links.get(&row.id).cloned().unwrap_or_default();
        let session = sessions.get(&row.session_id);
        let agent_identity = agent_identity_for(&row.session_id, session);
        let reachability = reachability_for(repo_path, linked_commits.first().map(String::as_str));
        let record_id = paths::record_id(&[
            "provenance",
            &row.id.to_string(),
            &row.session_id,
            &file_path,
            &row.start_line.to_string(),
            &row.end_line.to_string(),
        ]);
        let record = OrgtrackProvenanceRecord {
            schema_version: ORGTRACK_SCHEMA_VERSION,
            record_id,
            provenance_id: row.id,
            session_id: row.session_id.clone(),
            file_path: file_path.clone(),
            path_hash: paths::path_hash(&file_path),
            function_name: row.function_name.clone(),
            node_type: row.node_type.clone(),
            start_line: row.start_line,
            end_line: row.end_line,
            created_at: row.created_at,
            tier,
            branch_context: branch_context.clone(),
            agent_identity: agent_identity.clone(),
            linked_commits: linked_commits.clone(),
            reachability: reachability.clone(),
        };
        write_record_if_missing(
            &paths::provenance_record_path(repo_path, &record.record_id),
            &record,
        )?;

        let timeline_record = OrgtrackTimelineRecord {
            schema_version: ORGTRACK_SCHEMA_VERSION,
            record_id: record.record_id.clone(),
            file_path: file_path.clone(),
            path_hash: record.path_hash.clone(),
            entry: timeline_entry_from_provenance_record(&record, format!("prov-{}", row.id)),
        };
        append_timeline_record_if_missing(repo_path, &file_path, &timeline_record)?;

        for commit_sha in &linked_commits {
            let commit_entry = OrgtrackTimelineRecord {
                schema_version: ORGTRACK_SCHEMA_VERSION,
                record_id: paths::record_id(&["commit_link", commit_sha, &row.id.to_string()]),
                file_path: file_path.clone(),
                path_hash: paths::path_hash(&file_path),
                entry: OrgtrackFileTimelineEntry {
                    entry_type: OrgtrackTimelineEntryType::CommitLink,
                    id: format!("commit-{}-{}", commit_sha, row.id),
                    file_path: file_path.clone(),
                    session_id: Some(row.session_id.clone()),
                    session_label: session.map(|session| session.label.clone()),
                    agent_identity: Some(agent_identity.clone()),
                    branch_context: branch_context.clone(),
                    commit_sha: Some(commit_sha.clone()),
                    reachability: reachability_for(repo_path, Some(commit_sha)),
                    timestamp: row.created_at,
                    summary: Some(format!("Included in commit {}", short_sha(commit_sha))),
                    function_name: row.function_name.clone(),
                    node_type: row.node_type.clone(),
                    start_line: Some(row.start_line),
                    end_line: Some(row.end_line),
                    tier,
                },
            };
            append_timeline_record_if_missing(repo_path, &file_path, &commit_entry)?;
        }

        session_to_files
            .entry(row.session_id.clone())
            .or_default()
            .insert(file_path.clone());
        file_to_sessions
            .entry(file_path.clone())
            .or_default()
            .insert(row.session_id.clone());
        *file_entry_count.entry(file_path.clone()).or_default() += 1 + linked_commits.len();

        for commit_sha in &linked_commits {
            session_to_commits
                .entry(row.session_id.clone())
                .or_default()
                .insert(commit_sha.clone());
            file_to_commits
                .entry(file_path.clone())
                .or_default()
                .insert(commit_sha.clone());
            commit_to_files
                .entry(commit_sha.clone())
                .or_default()
                .insert(file_path.clone());
            commit_to_sessions
                .entry(commit_sha.clone())
                .or_default()
                .insert(row.session_id.clone());
        }

        session_symbols
            .entry(row.session_id.clone())
            .or_default()
            .push(OrgtrackSymbolEntry {
                file_path,
                function_name: row.function_name.clone(),
                node_type: row.node_type.clone(),
                start_line: row.start_line,
                end_line: row.end_line,
                commit_sha: linked_commits.first().cloned(),
                reachability,
                created_at: row.created_at,
            });
        provenance_records.push(record);
        if !already_checkpointed {
            scan.checkpoint.last_provenance_id = Some(row.id);
            scan.progress.processed += 1;
            scan.progress.counts.sessions = session_to_files.len();
            scan.progress.counts.files = file_to_sessions.len();
            scan.progress.counts.commits = commit_to_files.len();
            scan.progress.counts.entries = file_entry_count.values().sum();
            scan.progress.counts.records = provenance_records.len();
            write_scan_state(&mut scan)?;
        }
    }

    let covered_session_files: BTreeSet<(String, String)> = provenance_records
        .iter()
        .map(|record| (record.session_id.clone(), record.file_path.clone()))
        .collect();

    scan.progress.phase = OrgtrackScanPhase::LocalEdits;
    write_scan_state(&mut scan)?;
    for row in &local_edits {
        let already_checkpointed = scan
            .checkpoint
            .last_local_edit_event_id
            .as_ref()
            .is_some_and(|last_id| row.event_id <= *last_id);
        let file_path = paths::repo_relative_path(repo_path, &row.file_path);
        if covered_session_files.contains(&(row.session_id.clone(), file_path.clone())) {
            continue;
        }

        let session = sessions.get(&row.session_id);
        let agent_identity = agent_identity_for(&row.session_id, session);
        let reachability = reachability_for(repo_path, None);
        let record_id = paths::record_id(&[
            "local_edit",
            &row.event_id,
            &row.session_id,
            &file_path,
            &row.created_at.to_string(),
        ]);
        let record = OrgtrackProvenanceRecord {
            schema_version: ORGTRACK_SCHEMA_VERSION,
            record_id,
            provenance_id: -1,
            session_id: row.session_id.clone(),
            file_path: file_path.clone(),
            path_hash: paths::path_hash(&file_path),
            function_name: row.function_name.clone(),
            node_type: Some("file".to_string()),
            start_line: 1,
            end_line: 1,
            created_at: row.created_at,
            tier,
            branch_context: branch_context.clone(),
            agent_identity: agent_identity.clone(),
            linked_commits: Vec::new(),
            reachability: reachability.clone(),
        };
        write_record_if_missing(
            &paths::provenance_record_path(repo_path, &record.record_id),
            &record,
        )?;

        let timeline_record = OrgtrackTimelineRecord {
            schema_version: ORGTRACK_SCHEMA_VERSION,
            record_id: record.record_id.clone(),
            file_path: file_path.clone(),
            path_hash: record.path_hash.clone(),
            entry: timeline_entry_from_provenance_record(
                &record,
                format!("local-{}", row.event_id),
            ),
        };
        append_timeline_record_if_missing(repo_path, &file_path, &timeline_record)?;

        session_to_files
            .entry(row.session_id.clone())
            .or_default()
            .insert(file_path.clone());
        file_to_sessions
            .entry(file_path.clone())
            .or_default()
            .insert(row.session_id.clone());
        *file_entry_count.entry(file_path.clone()).or_default() += 1;
        session_symbols
            .entry(row.session_id.clone())
            .or_default()
            .push(OrgtrackSymbolEntry {
                file_path,
                function_name: row.function_name.clone(),
                node_type: Some("file".to_string()),
                start_line: 1,
                end_line: 1,
                commit_sha: None,
                reachability,
                created_at: row.created_at,
            });
        provenance_records.push(record);
        if !already_checkpointed {
            scan.checkpoint.last_local_edit_event_id = Some(row.event_id.clone());
            scan.progress.processed += 1;
            scan.progress.counts.sessions = session_to_files.len();
            scan.progress.counts.files = file_to_sessions.len();
            scan.progress.counts.commits = commit_to_files.len();
            scan.progress.counts.entries = file_entry_count.values().sum();
            scan.progress.counts.records = provenance_records.len();
            write_scan_state(&mut scan)?;
        }
    }

    scan.progress.phase = OrgtrackScanPhase::Sessions;
    write_scan_state(&mut scan)?;
    let mut sessions_written = 0usize;
    for session_id in &session_ids {
        let already_checkpointed = scan
            .checkpoint
            .last_session_id
            .as_ref()
            .is_some_and(|last_id| session_id <= last_id);
        let Some(session) = sessions.get(session_id) else {
            continue;
        };
        let files: Vec<String> = session_to_files
            .get(session_id)
            .map(|files| files.iter().cloned().collect())
            .unwrap_or_default();
        let commits: Vec<String> = session_to_commits
            .get(session_id)
            .map(|commits| commits.iter().cloned().collect())
            .unwrap_or_default();
        let agent_identity = agent_identity_for(session_id, Some(session));
        let meta = OrgtrackSessionMeta {
            schema_version: ORGTRACK_SCHEMA_VERSION,
            tier,
            session_id: session_id.clone(),
            label: session.label.clone(),
            agent_identity: agent_identity.clone(),
            created_at: session.created_at.clone(),
            updated_at: session.updated_at.clone(),
            branch_context: branch_context.clone(),
            files: files.clone(),
            commits: commits.clone(),
            summary: session.summary.clone(),
        };
        paths::write_json_pretty(&paths::session_meta_path(repo_path, session_id), &meta)?;

        if tier.includes_details() {
            let changed_files = files
                .iter()
                .map(|file_path| OrgtrackChangedFile {
                    path: file_path.clone(),
                    edit_count: provenance_records
                        .iter()
                        .filter(|record| {
                            record.session_id == *session_id && record.file_path == *file_path
                        })
                        .count(),
                    commits: commits.clone(),
                })
                .collect();
            let details = OrgtrackSessionDetails {
                schema_version: ORGTRACK_SCHEMA_VERSION,
                tier,
                session_id: session_id.clone(),
                changed_files,
                symbols: session_symbols.get(session_id).cloned().unwrap_or_default(),
                parsed_categories: agent_identity.parsed_categories.clone(),
            };
            paths::write_json_pretty(
                &paths::session_details_path(repo_path, session_id),
                &details,
            )?;
        }

        if tier.includes_trajectory() {
            let trajectory = OrgtrackSessionTrajectory {
                schema_version: ORGTRACK_SCHEMA_VERSION,
                tier,
                session_id: session_id.clone(),
                raw_events: load_raw_events(&conn, session_id)?,
            };
            paths::write_json_pretty(
                &paths::session_trajectory_path(repo_path, session_id),
                &trajectory,
            )?;
        }

        sessions_written += 1;
        if !already_checkpointed {
            scan.checkpoint.last_session_id = Some(session_id.clone());
            scan.progress.processed += 1;
            scan.progress.counts.sessions = sessions_written;
            write_scan_state(&mut scan)?;
        }
    }

    scan.progress.phase = OrgtrackScanPhase::Commits;
    write_scan_state(&mut scan)?;
    let mut commit_records = Vec::new();
    for (commit_sha, files) in &commit_to_files {
        let already_checkpointed = scan
            .checkpoint
            .last_commit_sha
            .as_ref()
            .is_some_and(|last_sha| commit_sha <= last_sha);
        let record = OrgtrackCommitRecord {
            schema_version: ORGTRACK_SCHEMA_VERSION,
            record_id: paths::record_id(&["commit", commit_sha]),
            commit_sha: commit_sha.clone(),
            files: files.iter().cloned().collect(),
            sessions: commit_to_sessions
                .get(commit_sha)
                .map(|sessions| sessions.iter().cloned().collect())
                .unwrap_or_default(),
            branch_context: branch_context.clone(),
            reachability: reachability_for(repo_path, Some(commit_sha)),
            linked_at: Utc::now().to_rfc3339(),
        };
        write_record_if_missing(
            &paths::commit_record_path(repo_path, &record.record_id),
            &record,
        )?;
        paths::write_json_pretty(&paths::commit_path(repo_path, commit_sha), &record)?;
        commit_records.push(record);
        if !already_checkpointed {
            scan.checkpoint.last_commit_sha = Some(commit_sha.clone());
            scan.progress.processed += 1;
            scan.progress.counts.commits = commit_records.len();
            write_scan_state(&mut scan)?;
        }
    }

    scan.progress.phase = OrgtrackScanPhase::Index;
    write_scan_state(&mut scan)?;

    let entries_written = file_entry_count.values().sum::<usize>();
    let manifest_version = entries_written as u64;
    let index = OrgtrackIndex {
        schema_version: ORGTRACK_SCHEMA_VERSION,
        generated_at: Utc::now().to_rfc3339(),
        exported_tier: tier,
        derived_version: manifest_version,
        summary: build_index_summary(
            session_ids.iter(),
            &sessions,
            file_to_sessions.len(),
            commit_records.len(),
            entries_written,
        ),
        sessions: session_ids
            .iter()
            .filter_map(|session_id| {
                let session = sessions.get(session_id)?;
                let symbols = session_symbols.get(session_id).cloned().unwrap_or_default();
                let files = session_to_files
                    .get(session_id)
                    .cloned()
                    .unwrap_or_default();
                let files_count = files.len();
                let committed_files_count = committed_files_count(&files, &file_to_commits);
                Some(OrgtrackIndexSession {
                    session_id: session_id.clone(),
                    label: session.label.clone(),
                    files_count,
                    commits_count: session_to_commits
                        .get(session_id)
                        .map(BTreeSet::len)
                        .unwrap_or(0),
                    committed_files_count,
                    committed_rate_percent: committed_rate_percent(
                        files_count,
                        committed_files_count,
                    ),
                    first_edit_at: symbols.iter().map(|symbol| symbol.created_at).min(),
                    last_edit_at: symbols.iter().map(|symbol| symbol.created_at).max(),
                    agent_identity: agent_identity_for(session_id, Some(session)),
                })
            })
            .collect(),
        files: file_to_sessions
            .iter()
            .map(|(file_path, sessions)| OrgtrackIndexFile {
                path: file_path.clone(),
                path_hash: paths::path_hash(file_path),
                sessions_count: sessions.len(),
                commits_count: file_to_commits
                    .get(file_path)
                    .map(BTreeSet::len)
                    .unwrap_or(0),
                entries_count: file_entry_count.get(file_path).copied().unwrap_or(0),
            })
            .collect(),
        commits: commit_records
            .iter()
            .map(|record| OrgtrackIndexCommit {
                commit_sha: record.commit_sha.clone(),
                files_count: record.files.len(),
                sessions_count: record.sessions.len(),
                reachability_state: record.reachability.state.clone(),
            })
            .collect(),
    };
    paths::write_json_pretty(&paths::index_path(repo_path), &index)?;
    scan.progress.counts = OrgtrackScanCounts {
        sessions: sessions_written,
        files: file_to_sessions.len(),
        commits: commit_records.len(),
        entries: entries_written,
        records: provenance_records.len() + commit_records.len(),
    };

    paths::write_json_pretty(
        &paths::manifest_path(repo_path),
        &OrgtrackManifest {
            schema_version: ORGTRACK_SCHEMA_VERSION,
            generated_at: Utc::now().to_rfc3339(),
            source_records_root: Some("metadata/records".to_string()),
            derived_index_root: Some("metadata/derived".to_string()),
            last_provenance_id: provenance_records
                .iter()
                .filter_map(|record| (record.provenance_id >= 0).then_some(record.provenance_id))
                .max(),
            last_commit_lineage_id: None,
            record_count: provenance_records.len() + commit_records.len(),
            timeline_record_count: entries_written,
            derived_version: manifest_version,
        },
    )?;

    scan.progress.phase = OrgtrackScanPhase::Done;
    scan.progress.status = OrgtrackScanStatus::Completed;
    scan.progress.processed = scan.progress.total;
    scan.progress.resumable = false;
    scan.progress.cancel_requested = false;
    scan.progress.updated_at = Utc::now().to_rfc3339();
    scan.progress.completed_at = Some(scan.progress.updated_at.clone());
    write_scan_state(&mut scan)?;
    Ok(OrgtrackExportResult {
        repo_path: repo_path.to_string_lossy().to_string(),
        orgtrack_path: paths::orgtrack_root(repo_path)
            .to_string_lossy()
            .to_string(),
        exported_tier: tier,
        sessions_written,
        files_written: file_to_sessions.len(),
        commits_written: commit_records.len(),
        entries_written,
        records_written: provenance_records.len() + commit_records.len(),
        manifest_version,
    })
}

fn initial_scan_progress(
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

fn read_scan_checkpoint(repo_path: &Path) -> Result<Option<OrgtrackScanCheckpoint>, String> {
    let path = paths::scan_checkpoint_path(repo_path);
    if !path.exists() {
        return Ok(None);
    }
    paths::read_json(&path).map(Some)
}

fn write_scan_progress(repo_path: &Path, progress: &OrgtrackScanProgress) -> Result<(), String> {
    paths::write_json_pretty(&paths::scan_progress_path(repo_path), progress)
}

fn write_scan_state(scan: &mut ScanContext<'_>) -> Result<(), String> {
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

fn committed_files_count(
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

fn committed_rate_percent(files_count: usize, committed_files_count: usize) -> usize {
    if files_count == 0 {
        return 0;
    }
    (committed_files_count * 100).div_ceil(files_count)
}

fn build_index_summary<'a>(
    session_ids: impl Iterator<Item = &'a String>,
    sessions: &BTreeMap<String, SessionRow>,
    total_files: usize,
    total_commits: usize,
    total_entries: usize,
) -> super::types::OrgtrackIndexSummary {
    let mut app_type_counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut model_counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut total_sessions = 0usize;

    for session_id in session_ids {
        let identity = agent_identity_for(session_id, sessions.get(session_id));
        total_sessions += 1;
        let app_type = identity
            .dispatch_category
            .or(identity.cli_agent_type)
            .or(identity.rust_agent_type)
            .or(identity.origin)
            .unwrap_or_else(|| "unknown".to_string());
        *app_type_counts.entry(app_type).or_default() += 1;

        let model = identity.model.unwrap_or_else(|| "unknown".to_string());
        *model_counts.entry(model).or_default() += 1;
    }

    super::types::OrgtrackIndexSummary {
        sessions_by_app_type: summary_buckets(app_type_counts),
        models_used: summary_buckets(model_counts),
        total_sessions,
        total_files,
        total_commits,
        total_entries,
    }
}

fn summary_buckets(counts: BTreeMap<String, usize>) -> Vec<OrgtrackSummaryBucket> {
    let mut buckets: Vec<OrgtrackSummaryBucket> = counts
        .into_iter()
        .map(|(key, count)| OrgtrackSummaryBucket {
            label: key.replace('_', " "),
            key,
            count,
        })
        .collect();
    buckets.sort_by(|left, right| right.count.cmp(&left.count).then(left.key.cmp(&right.key)));
    buckets
}

fn write_record_if_missing<T: serde::Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }
    paths::write_json_pretty(path, value)
}

fn append_timeline_record_if_missing(
    repo_path: &Path,
    file_path: &str,
    timeline_record: &OrgtrackTimelineRecord,
) -> Result<(), String> {
    let index_path = paths::file_timeline_index_path(repo_path, file_path);
    if index_path.exists() {
        let existing = fs::read_to_string(&index_path)
            .map_err(|err| format!("Failed to read {}: {}", index_path.display(), err))?;
        let needle = format!("\"recordId\":\"{}\"", timeline_record.record_id);
        if existing.contains(&needle) {
            return Ok(());
        }
    }
    let offset = paths::append_json_line(
        &paths::file_timeline_path(repo_path, file_path),
        timeline_record,
    )?;
    paths::append_json_line(
        &index_path,
        &serde_json::json!({
            "recordId": timeline_record.record_id,
            "offset": offset,
            "timestamp": timeline_record.entry.timestamp,
            "sessionId": timeline_record.entry.session_id,
            "commitSha": timeline_record.entry.commit_sha,
            "startLine": timeline_record.entry.start_line,
            "endLine": timeline_record.entry.end_line
        }),
    )?;
    Ok(())
}

pub fn timeline_entry_from_provenance_record(
    record: &OrgtrackProvenanceRecord,
    entry_id: String,
) -> OrgtrackFileTimelineEntry {
    OrgtrackFileTimelineEntry {
        entry_type: OrgtrackTimelineEntryType::SessionEdit,
        id: entry_id,
        file_path: record.file_path.clone(),
        session_id: Some(record.session_id.clone()),
        session_label: record.agent_identity.display_name.clone(),
        agent_identity: Some(record.agent_identity.clone()),
        branch_context: record.branch_context.clone(),
        commit_sha: record.linked_commits.first().cloned(),
        reachability: record.reachability.clone(),
        timestamp: record.created_at,
        summary: record
            .function_name
            .as_ref()
            .map(|name| format!("Edited {}", name))
            .or_else(|| Some("Edited file region".to_string())),
        function_name: record.function_name.clone(),
        node_type: record.node_type.clone(),
        start_line: Some(record.start_line),
        end_line: Some(record.end_line),
        tier: record.tier,
    }
}

fn branch_context_for(repo_path: &Path) -> OrgtrackBranchContext {
    OrgtrackBranchContext {
        authoring_branch: git_output(repo_path, &["rev-parse", "--abbrev-ref", "HEAD"]),
        authoring_head_sha: git_output(repo_path, &["rev-parse", "HEAD"]),
        authoring_base_branch: default_branch(repo_path),
        authoring_base_sha: default_branch(repo_path)
            .and_then(|branch| git_output(repo_path, &["merge-base", "HEAD", &branch])),
        default_branch: default_branch(repo_path),
        worktree_path_hash: Some(paths::path_hash(&repo_path.to_string_lossy())),
    }
}

fn reachability_for(repo_path: &Path, commit_sha: Option<&str>) -> OrgtrackReachability {
    let checked_at_head = git_output(repo_path, &["rev-parse", "HEAD"]);
    let Some(commit_sha) = commit_sha.filter(|value| !value.trim().is_empty()) else {
        return OrgtrackReachability {
            state: OrgtrackReachabilityState::Uncommitted,
            checked_at_head,
            is_reachable_from_current_head: Some(false),
            is_reachable_from_default_branch: None,
            first_reachable_commit_sha: None,
            current_file_contains_attributed_range: Some("unknown".to_string()),
        };
    };
    let reachable_from_head = git_success(
        repo_path,
        &["merge-base", "--is-ancestor", commit_sha, "HEAD"],
    );
    let reachable_from_default = default_branch(repo_path).as_deref().map(|branch| {
        git_success(
            repo_path,
            &["merge-base", "--is-ancestor", commit_sha, branch],
        )
    });

    OrgtrackReachability {
        state: if reachable_from_head {
            OrgtrackReachabilityState::ReachableExact
        } else {
            OrgtrackReachabilityState::LinkedUnreachable
        },
        checked_at_head,
        is_reachable_from_current_head: Some(reachable_from_head),
        is_reachable_from_default_branch: reachable_from_default,
        first_reachable_commit_sha: reachable_from_head.then(|| commit_sha.to_string()),
        current_file_contains_attributed_range: Some("unknown".to_string()),
    }
}

fn agent_identity_for(session_id: &str, session: Option<&SessionRow>) -> OrgtrackAgentIdentity {
    let label = session
        .map(|session| session.label.clone())
        .unwrap_or_else(|| session_id.to_string());
    let agent_kind = session.and_then(|session| session.agent_kind.clone());
    let model = session.and_then(|session| session.model.clone());
    let key_source = session.and_then(|session| session.key_source.clone());
    let agent_exec_mode = session.and_then(|session| session.agent_exec_mode.clone());
    let dispatch_category = infer_dispatch_category(session_id, agent_kind.as_deref());
    let rust_agent_type = infer_rust_agent_type(session_id, agent_kind.as_deref());
    let cli_agent_type = infer_cli_agent_type(session_id, agent_kind.as_deref());
    let origin = match dispatch_category.as_deref() {
        Some("rust_agent") => Some("orgii".to_string()),
        Some("cli_agent") => Some("external_cli".to_string()),
        Some("cursor_ide") => Some("cursor_ide".to_string()),
        _ => None,
    };

    let mut parsed_categories = Vec::new();
    push_category(
        &mut parsed_categories,
        "sessionIdPrefix",
        session_id_prefix(session_id),
        "session_id",
    );
    push_category_opt(
        &mut parsed_categories,
        "agentKind",
        agent_kind.as_deref(),
        "agent_sessions.session_type",
    );
    push_category_opt(
        &mut parsed_categories,
        "dispatchCategory",
        dispatch_category.as_deref(),
        "inferred",
    );
    push_category_opt(
        &mut parsed_categories,
        "rustAgentType",
        rust_agent_type.as_deref(),
        "inferred",
    );
    push_category_opt(
        &mut parsed_categories,
        "cliAgentType",
        cli_agent_type.as_deref(),
        "inferred",
    );
    push_category_opt(
        &mut parsed_categories,
        "agentExecMode",
        agent_exec_mode.as_deref(),
        "agent_sessions.agent_exec_mode",
    );
    push_category_opt(
        &mut parsed_categories,
        "model",
        model.as_deref(),
        "agent_sessions.model",
    );
    push_category_opt(
        &mut parsed_categories,
        "keySource",
        key_source.as_deref(),
        "agent_sessions.key_source",
    );
    push_category_opt(
        &mut parsed_categories,
        "origin",
        origin.as_deref(),
        "inferred",
    );

    OrgtrackAgentIdentity {
        dispatch_category,
        rust_agent_type,
        cli_agent_type,
        agent_exec_mode,
        session_id: session_id.to_string(),
        display_name: Some(label),
        provider_model_type: model.as_deref().and_then(infer_provider_from_model),
        model,
        key_source,
        origin,
        parsed_categories,
    }
}

fn infer_dispatch_category(session_id: &str, agent_kind: Option<&str>) -> Option<String> {
    if session_id.starts_with("cursoride-") || matches!(agent_kind, Some("cursor_ide")) {
        Some("cursor_ide".to_string())
    } else if matches!(agent_kind, Some("cli" | "cli_agent" | "code"))
        || infer_cli_agent_type(session_id, agent_kind).is_some()
    {
        Some("cli_agent".to_string())
    } else {
        Some("rust_agent".to_string())
    }
}

fn infer_rust_agent_type(session_id: &str, agent_kind: Option<&str>) -> Option<String> {
    if session_id.starts_with("osagent-") || matches!(agent_kind, Some("os")) {
        Some("os".to_string())
    } else if session_id.starts_with("sdeagent-") || matches!(agent_kind, Some("sde")) {
        Some("sde".to_string())
    } else if session_id.starts_with("gateway-") || matches!(agent_kind, Some("gateway")) {
        Some("gateway".to_string())
    } else if matches!(agent_kind, Some("agent" | "rust_agent")) {
        Some("custom".to_string())
    } else {
        None
    }
}

fn infer_cli_agent_type(session_id: &str, agent_kind: Option<&str>) -> Option<String> {
    let searchable = format!("{}:{}", session_id, agent_kind.unwrap_or_default()).to_lowercase();
    for candidate in [
        "claude_code",
        "cursor_cli",
        "codex",
        "copilot",
        "kiro",
        "opencode",
    ] {
        if searchable.contains(candidate) || searchable.contains(&candidate.replace('_', "-")) {
            return Some(candidate.to_string());
        }
    }
    None
}

fn infer_provider_from_model(model: &str) -> Option<String> {
    let lower = model.to_lowercase();
    let provider = if lower.contains("claude") {
        "anthropic"
    } else if lower.contains("gpt") || lower.contains("o3") || lower.contains("o4") {
        "openai"
    } else if lower.contains("gemini") {
        "google"
    } else if lower.contains("orgii") {
        "orgii_orchestrator"
    } else {
        return None;
    };
    Some(provider.to_string())
}

fn session_id_prefix(session_id: &str) -> &str {
    session_id.split(['-', '_']).next().unwrap_or(session_id)
}

fn push_category(
    categories: &mut Vec<OrgtrackParsedCategory>,
    key: &str,
    value: &str,
    source: &str,
) {
    if value.trim().is_empty() {
        return;
    }
    categories.push(OrgtrackParsedCategory {
        key: key.to_string(),
        value: value.to_string(),
        source: source.to_string(),
    });
}

fn push_category_opt(
    categories: &mut Vec<OrgtrackParsedCategory>,
    key: &str,
    value: Option<&str>,
    source: &str,
) {
    if let Some(value) = value {
        push_category(categories, key, value, source);
    }
}

fn default_branch(repo_path: &Path) -> Option<String> {
    git_output(repo_path, &["symbolic-ref", "refs/remotes/origin/HEAD"])
        .and_then(|value| {
            value
                .strip_prefix("refs/remotes/origin/")
                .map(str::to_string)
        })
        .or_else(|| Some("main".to_string()))
}

fn git_output(repo_path: &Path, args: &[&str]) -> Option<String> {
    let output = run_git(repo_path, args).ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!value.is_empty()).then_some(value)
}

fn git_success(repo_path: &Path, args: &[&str]) -> bool {
    run_git(repo_path, args)
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn load_local_edit_rows(
    conn: &rusqlite::Connection,
    repo_path: &Path,
) -> Result<Vec<LocalEditRow>, String> {
    let mut rows = Vec::new();
    if table_exists(conn, "events")? {
        let mut stmt = conn
            .prepare(
                "SELECT id, session_id, function_name, args_json, result_json, created_at
                 FROM events
                 ORDER BY created_at ASC",
            )
            .map_err(|err| format!("Prepare failed: {}", err))?;
        let mapped = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                ))
            })
            .map_err(|err| format!("Query failed: {}", err))?;
        for row in mapped {
            let (event_id, session_id, function_name, args_json, result_json, created_at) =
                row.map_err(|err| format!("Row decode failed: {}", err))?;
            let Some(function_name_value) = function_name.as_deref() else {
                continue;
            };
            if !is_file_edit_function(function_name_value) {
                continue;
            }
            for file_path in
                extract_file_paths_from_json(function_name_value, &args_json, &result_json)
            {
                if path_belongs_to_repo(conn, repo_path, &session_id, &file_path)? {
                    rows.push(LocalEditRow {
                        event_id: event_id.clone(),
                        session_id: session_id.clone(),
                        file_path,
                        function_name: function_name.clone(),
                        created_at: parse_timestamp(&created_at),
                    });
                }
            }
        }
    }

    if table_exists(conn, "code_session_chunks")? {
        let mut stmt = conn
            .prepare(
                "SELECT chunk_id, session_id, function, args_json, result_json, created_at
                 FROM code_session_chunks
                 ORDER BY sequence ASC",
            )
            .map_err(|err| format!("Prepare failed: {}", err))?;
        let mapped = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                ))
            })
            .map_err(|err| format!("Query failed: {}", err))?;
        for row in mapped {
            let (event_id, session_id, function_name, args_json, result_json, created_at) =
                row.map_err(|err| format!("Row decode failed: {}", err))?;
            if !is_file_edit_function(&function_name) {
                continue;
            }
            for file_path in extract_file_paths_from_json(&function_name, &args_json, &result_json)
            {
                if path_belongs_to_repo(conn, repo_path, &session_id, &file_path)? {
                    rows.push(LocalEditRow {
                        event_id: event_id.clone(),
                        session_id: session_id.clone(),
                        file_path,
                        function_name: Some(function_name.clone()),
                        created_at: parse_timestamp(&created_at),
                    });
                }
            }
        }
    }

    rows.sort_by(|left, right| {
        left.created_at
            .cmp(&right.created_at)
            .then_with(|| left.event_id.cmp(&right.event_id))
    });
    Ok(rows)
}

fn load_provenance_rows(
    conn: &rusqlite::Connection,
    repo_path: &Path,
) -> Result<Vec<ProvenanceRow>, String> {
    let repo_prefix = repo_path.to_string_lossy().to_string();
    let mut stmt = conn
        .prepare(
            "SELECT id, session_id, file, function_name, node_type, start_line, end_line, created_at
             FROM node_provenance
             WHERE file LIKE ?1 OR file NOT LIKE '/%'
             ORDER BY created_at ASC",
        )
        .map_err(|err| format!("Prepare failed: {}", err))?;
    let rows = stmt
        .query_map(params![format!("{}%", repo_prefix)], |row| {
            Ok(ProvenanceRow {
                id: row.get(0)?,
                session_id: row.get(1)?,
                file_path: row.get(2)?,
                function_name: row.get(3)?,
                node_type: row.get(4)?,
                start_line: row.get::<_, i64>(5)?.max(1) as u32,
                end_line: row.get::<_, i64>(6)?.max(1) as u32,
                created_at: row.get(7)?,
            })
        })
        .map_err(|err| format!("Query failed: {}", err))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|err| format!("Row decode failed: {}", err))
}

fn is_file_edit_function(function_name: &str) -> bool {
    matches!(
        function_name,
        tool_names::EDIT_FILE
            | tool_names::APPLY_PATCH
            | tool_names::STORAGE_WRITE_FILE
            | tool_names::STORAGE_CREATE_FILE
            | tool_names::STORAGE_EDIT_FILE_BY_REPLACE
            | tool_names::STORAGE_APPEND_FILE
            | tool_names::STORAGE_FILE_RANGE_EDIT
            | tool_names::STORAGE_INSERT_CONTENT_AT_LINE
            | tool_names::CLI_DISPLAY_EDIT
            | tool_names::CLI_DISPLAY_WRITE
            | tool_names::CLI_DISPLAY_CREATE
            | tool_names::CLI_DISPLAY_PATCH
            | "file_diff"
    )
}

fn extract_file_paths_from_json(
    function_name: &str,
    args_json: &str,
    result_json: &str,
) -> Vec<String> {
    let args =
        serde_json::from_str::<serde_json::Value>(args_json).unwrap_or(serde_json::Value::Null);
    let result =
        serde_json::from_str::<serde_json::Value>(result_json).unwrap_or(serde_json::Value::Null);
    let mut paths = Vec::new();

    if matches!(
        function_name,
        tool_names::APPLY_PATCH | tool_names::CLI_DISPLAY_PATCH
    ) {
        if let Some(patch_text) = args.get("patch_text").and_then(|value| value.as_str()) {
            paths.extend(extract_paths_from_patch_text(patch_text));
        }
        if let Some(patch_text) = args.get("patch").and_then(|value| value.as_str()) {
            paths.extend(extract_paths_from_patch_text(patch_text));
        }
    }

    let success = result.get("success").unwrap_or(&serde_json::Value::Null);
    for candidate in [
        args.get("file_path"),
        args.get("file_name"),
        args.get("path"),
        result.get("file_path"),
        result.get("path"),
        success.get("file_path"),
        success.get("path"),
    ] {
        if let Some(path) = candidate
            .and_then(|value| value.as_str())
            .filter(|path| !path.trim().is_empty())
        {
            paths.push(path.to_string());
        }
    }

    paths.sort();
    paths.dedup();
    paths
}

fn extract_paths_from_patch_text(patch_text: &str) -> Vec<String> {
    let mut paths = Vec::new();
    for line in patch_text.lines() {
        let trimmed = line.trim();
        let path = trimmed
            .strip_prefix("*** Add File:")
            .or_else(|| trimmed.strip_prefix("*** Update File:"))
            .or_else(|| trimmed.strip_prefix("*** Delete File:"))
            .or_else(|| trimmed.strip_prefix("+++ b/"))
            .or_else(|| trimmed.strip_prefix("--- a/"));
        if let Some(path) = path
            .map(str::trim)
            .filter(|path| !path.is_empty() && *path != "/dev/null")
        {
            paths.push(path.to_string());
        }
    }
    paths
}

fn path_belongs_to_repo(
    conn: &rusqlite::Connection,
    repo_path: &Path,
    session_id: &str,
    file_path: &str,
) -> Result<bool, String> {
    let path = Path::new(file_path);
    if path.is_absolute() {
        return Ok(path.starts_with(repo_path));
    }
    if file_path.starts_with("../") || file_path.contains("/../") {
        return Ok(false);
    }
    let Some(session_workspace) = session_workspace_path(conn, session_id)? else {
        return Ok(true);
    };
    Ok(Path::new(&session_workspace) == repo_path)
}

fn session_workspace_path(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> Result<Option<String>, String> {
    if table_exists(conn, "agent_sessions")? {
        let columns = table_columns(conn, "agent_sessions")?;
        if columns.contains_key("workspace_path") {
            let value = match conn.query_row(
                "SELECT workspace_path FROM agent_sessions WHERE session_id = ?1",
                [session_id],
                |row| row.get::<_, Option<String>>(0),
            ) {
                Ok(value) => value,
                Err(rusqlite::Error::QueryReturnedNoRows) => None,
                Err(err) => return Err(format!("Failed to read agent session workspace: {}", err)),
            };
            if value
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
            {
                return Ok(value);
            }
        }
    }
    if table_exists(conn, "code_sessions")? {
        let columns = table_columns(conn, "code_sessions")?;
        if columns.contains_key("repo_path") {
            let value = match conn.query_row(
                "SELECT repo_path FROM code_sessions WHERE session_id = ?1",
                [session_id],
                |row| row.get::<_, Option<String>>(0),
            ) {
                Ok(value) => value,
                Err(rusqlite::Error::QueryReturnedNoRows) => None,
                Err(err) => return Err(format!("Failed to read code session repo: {}", err)),
            };
            if value
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
            {
                return Ok(value);
            }
        }
    }
    Ok(None)
}

fn parse_timestamp(value: &str) -> i64 {
    DateTime::parse_from_rfc3339(value)
        .map(|timestamp| timestamp.timestamp())
        .unwrap_or_else(|_| Utc::now().timestamp())
}

fn load_session_rows(
    conn: &rusqlite::Connection,
    session_ids: &BTreeSet<String>,
) -> Result<BTreeMap<String, SessionRow>, String> {
    let mut sessions = BTreeMap::new();
    let columns = table_columns(conn, "agent_sessions")?;
    if columns.is_empty() {
        for session_id in session_ids {
            sessions.insert(session_id.clone(), fallback_session_row(session_id));
        }
        return Ok(sessions);
    }

    for session_id in session_ids {
        let mut stmt = conn
            .prepare("SELECT * FROM agent_sessions WHERE session_id = ?1")
            .map_err(|err| format!("Prepare failed: {}", err))?;
        let row = stmt.query_row([session_id], |row| {
            let name = get_optional_column(row, &columns, "name")?.unwrap_or_default();
            let user_input = get_optional_column(row, &columns, "user_input")?;
            Ok(SessionRow {
                session_id: get_optional_column(row, &columns, "session_id")?
                    .unwrap_or_else(|| session_id.clone()),
                label: if name.trim().is_empty() {
                    user_input
                        .as_deref()
                        .unwrap_or(session_id)
                        .chars()
                        .take(80)
                        .collect()
                } else {
                    name
                },
                agent_kind: get_optional_column(row, &columns, "session_type")?,
                model: get_optional_column(row, &columns, "model")?,
                key_source: get_optional_column(row, &columns, "key_source")?,
                agent_exec_mode: get_optional_column(row, &columns, "agent_exec_mode")?,
                created_at: get_optional_column(row, &columns, "created_at")?,
                updated_at: get_optional_column(row, &columns, "updated_at")?,
                summary: user_input.map(|value| value.chars().take(240).collect()),
            })
        });
        match row {
            Ok(session) => {
                sessions.insert(session.session_id.clone(), session);
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => {
                if let Some(session) = load_code_session_row(conn, session_id)? {
                    sessions.insert(session.session_id.clone(), session);
                } else {
                    sessions.insert(session_id.clone(), fallback_session_row(session_id));
                }
            }
            Err(err) => return Err(format!("Session query failed: {}", err)),
        }
    }
    Ok(sessions)
}

fn load_code_session_row(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> Result<Option<SessionRow>, String> {
    if !table_exists(conn, "code_sessions")? {
        return Ok(None);
    }
    let columns = table_columns(conn, "code_sessions")?;
    let mut stmt = conn
        .prepare("SELECT * FROM code_sessions WHERE session_id = ?1")
        .map_err(|err| format!("Prepare failed: {}", err))?;
    let row = stmt.query_row([session_id], |row| {
        let name = get_optional_column(row, &columns, "name")?.unwrap_or_default();
        let user_input = get_optional_column(row, &columns, "user_input")?;
        let cli_agent_type = get_optional_column(row, &columns, "cli_agent_type")?.or_else(|| {
            get_optional_column(row, &columns, "platform")
                .ok()
                .flatten()
        });
        Ok(SessionRow {
            session_id: get_optional_column(row, &columns, "session_id")?
                .unwrap_or_else(|| session_id.to_string()),
            label: if name.trim().is_empty() {
                user_input
                    .as_deref()
                    .unwrap_or(session_id)
                    .chars()
                    .take(80)
                    .collect()
            } else {
                name
            },
            agent_kind: cli_agent_type.or_else(|| Some("cli_agent".to_string())),
            model: get_optional_column(row, &columns, "model")?,
            key_source: get_optional_column(row, &columns, "key_source")?,
            agent_exec_mode: get_optional_column(row, &columns, "agent_exec_mode")?,
            created_at: get_optional_column(row, &columns, "created_at")?,
            updated_at: get_optional_column(row, &columns, "updated_at")?,
            summary: user_input.map(|value| value.chars().take(240).collect()),
        })
    });
    match row {
        Ok(session) => Ok(Some(session)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(err) => Err(format!("Code session query failed: {}", err)),
    }
}

fn fallback_session_row(session_id: &str) -> SessionRow {
    SessionRow {
        session_id: session_id.to_string(),
        label: session_id.to_string(),
        agent_kind: None,
        model: None,
        key_source: None,
        agent_exec_mode: None,
        created_at: None,
        updated_at: None,
        summary: None,
    }
}

fn load_commit_links(conn: &rusqlite::Connection) -> Result<BTreeMap<i64, Vec<String>>, String> {
    if !table_exists(conn, "commit_lineage")? {
        return Ok(BTreeMap::new());
    }
    let mut stmt = conn
        .prepare("SELECT provenance_id, commit_id FROM commit_lineage ORDER BY created_at ASC")
        .map_err(|err| format!("Prepare failed: {}", err))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|err| format!("Query failed: {}", err))?;
    let mut links: BTreeMap<i64, Vec<String>> = BTreeMap::new();
    for row in rows {
        let (provenance_id, commit_sha) =
            row.map_err(|err| format!("Row decode failed: {}", err))?;
        links.entry(provenance_id).or_default().push(commit_sha);
    }
    Ok(links)
}

fn load_raw_events(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> Result<Vec<OrgtrackRawEvent>, String> {
    let mut raw_events = Vec::new();
    if table_exists(conn, "events")? {
        let mut stmt = conn
            .prepare(
                "SELECT function_name, args_json, result_json, history_sequence, created_at
                 FROM events
                 WHERE session_id = ?1
                 ORDER BY COALESCE(history_sequence, 0) ASC, created_at ASC",
            )
            .map_err(|err| format!("Prepare failed: {}", err))?;
        let rows = stmt
            .query_map([session_id], |row| {
                Ok(OrgtrackRawEvent {
                    source: OrgtrackRawEventSource::Event,
                    name: row.get(0)?,
                    args_json: row.get(1)?,
                    result_json: row.get(2)?,
                    sequence: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })
            .map_err(|err| format!("Query failed: {}", err))?;
        for row in rows {
            raw_events.push(row.map_err(|err| format!("Row decode failed: {}", err))?);
        }
    }
    if table_exists(conn, "code_session_chunks")? {
        let mut stmt = conn
            .prepare(
                "SELECT function, args_json, result_json, sequence, created_at
                 FROM code_session_chunks
                 WHERE session_id = ?1
                 ORDER BY sequence ASC",
            )
            .map_err(|err| format!("Prepare failed: {}", err))?;
        let rows = stmt
            .query_map([session_id], |row| {
                Ok(OrgtrackRawEvent {
                    source: OrgtrackRawEventSource::CodeSessionChunk,
                    name: row.get(0)?,
                    args_json: row.get(1)?,
                    result_json: row.get(2)?,
                    sequence: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })
            .map_err(|err| format!("Query failed: {}", err))?;
        for row in rows {
            raw_events.push(row.map_err(|err| format!("Row decode failed: {}", err))?);
        }
    }
    Ok(raw_events)
}

fn table_exists(conn: &rusqlite::Connection, table: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
        [table],
        |row| row.get::<_, i64>(0),
    )
    .map(|value| value == 1)
    .map_err(|err| format!("Failed to inspect table {}: {}", table, err))
}

fn table_columns(
    conn: &rusqlite::Connection,
    table: &str,
) -> Result<BTreeMap<String, usize>, String> {
    if !table_exists(conn, table)? {
        return Ok(BTreeMap::new());
    }
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({})", table))
        .map_err(|err| format!("Failed to inspect {}: {}", table, err))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(1)?, row.get::<_, usize>(0)?))
        })
        .map_err(|err| format!("Failed to inspect {}: {}", table, err))?;
    let mut columns = BTreeMap::new();
    for row in rows {
        let (name, index) = row.map_err(|err| format!("Failed to inspect {}: {}", table, err))?;
        columns.insert(name, index);
    }
    Ok(columns)
}

fn get_optional_column(
    row: &rusqlite::Row<'_>,
    columns: &BTreeMap<String, usize>,
    column: &str,
) -> rusqlite::Result<Option<String>> {
    let Some(index) = columns.get(column) else {
        return Ok(None);
    };
    row.get(*index)
}

fn short_sha(commit_sha: &str) -> String {
    commit_sha.chars().take(8).collect()
}

//! Full export orchestration: walks provenance, local edits, sessions, and
//! commits, then materializes records, timelines, the index, and the manifest.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use chrono::Utc;
use database::db::get_connection;

use super::git::{branch_context_for, reachability_for, short_sha};
use super::identity::agent_identity_for;
use super::loaders::{
    load_commit_links, load_local_edit_rows, load_provenance_rows, load_raw_events,
    load_session_rows,
};
use super::scan::{
    committed_files_count, committed_rate_percent, initial_scan_progress, read_scan_checkpoint,
    write_scan_state,
};
use super::summary::{
    append_timeline_record_if_missing, build_index_summary, timeline_entry_from_provenance_record,
    write_record_if_missing,
};
use super::ScanContext;
use crate::orgtrack::paths;
use crate::orgtrack::types::{
    OrgtrackChangedFile, OrgtrackCommitRecord, OrgtrackExportResult, OrgtrackFileTimelineEntry,
    OrgtrackIndex, OrgtrackIndexCommit, OrgtrackIndexFile, OrgtrackIndexSession, OrgtrackManifest,
    OrgtrackProvenanceRecord, OrgtrackScanCounts, OrgtrackScanPhase, OrgtrackScanStatus,
    OrgtrackSessionDetails, OrgtrackSessionMeta, OrgtrackSessionTrajectory, OrgtrackSymbolEntry,
    OrgtrackTier, OrgtrackTimelineEntryType, OrgtrackTimelineRecord, ORGTRACK_SCHEMA_VERSION,
};

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

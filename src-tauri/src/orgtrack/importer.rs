use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use chrono::Utc;

use super::paths;
use super::types::{
    OrgtrackCommitRecord, OrgtrackFileTimeline, OrgtrackIndex, OrgtrackIndexCommit,
    OrgtrackIndexFile, OrgtrackIndexSession, OrgtrackIndexSummary, OrgtrackManifest,
    OrgtrackProvenanceRecord, OrgtrackRepairResult, OrgtrackSummaryBucket, OrgtrackTimelineRecord,
    ORGTRACK_SCHEMA_VERSION,
};

pub fn read_manifest(repo_path: &Path) -> Result<Option<OrgtrackManifest>, String> {
    let path = paths::manifest_path(repo_path);
    if !path.exists() {
        return Ok(None);
    }
    paths::read_json(&path).map(Some)
}

pub fn read_file_timeline(
    repo_path: &Path,
    file_path: &str,
) -> Result<Option<OrgtrackFileTimeline>, String> {
    let relative_path = paths::repo_relative_path(repo_path, file_path);
    let path = paths::file_timeline_path(repo_path, &relative_path);
    if path.exists() {
        let mut timeline_records: Vec<OrgtrackTimelineRecord> = paths::read_json_lines(&path)?;
        timeline_records.sort_by(|first, second| {
            first
                .entry
                .timestamp
                .cmp(&second.entry.timestamp)
                .then(first.record_id.cmp(&second.record_id))
        });
        return Ok(Some(OrgtrackFileTimeline {
            schema_version: ORGTRACK_SCHEMA_VERSION,
            file_path: relative_path,
            path_hash: paths::path_hash(file_path),
            entries: timeline_records
                .into_iter()
                .map(|record| record.entry)
                .collect(),
        }));
    }

    let legacy_path = paths::file_timeline_legacy_path(repo_path, &relative_path);
    if !legacy_path.exists() {
        return Ok(None);
    }
    let mut timeline: OrgtrackFileTimeline = paths::read_json(&legacy_path)?;
    timeline
        .entries
        .sort_by(|first, second| first.timestamp.cmp(&second.timestamp));
    Ok(Some(timeline))
}

pub fn repair_orgtrack(repo_path: &Path) -> Result<OrgtrackRepairResult, String> {
    paths::ensure_orgtrack_dirs(repo_path)?;
    let provenance_records = read_all_provenance_records(repo_path)?;
    let commit_records = read_all_commit_records(repo_path)?;
    rebuild_derived(repo_path, provenance_records, commit_records)
}

pub fn rebuild_derived(
    repo_path: &Path,
    provenance_records: Vec<OrgtrackProvenanceRecord>,
    commit_records: Vec<OrgtrackCommitRecord>,
) -> Result<OrgtrackRepairResult, String> {
    let derived = paths::derived_dir(repo_path);
    if derived.exists() {
        fs::remove_dir_all(&derived)
            .map_err(|err| format!("Failed to remove {}: {}", derived.display(), err))?;
    }
    paths::ensure_orgtrack_dirs(repo_path)?;

    let mut seen_timeline_records = BTreeSet::new();
    let mut duplicate_count = 0usize;
    let mut timeline_count = 0usize;
    let mut session_to_files: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut session_to_commits: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut session_to_identity = BTreeMap::new();
    let mut session_to_label = BTreeMap::new();
    let mut session_to_times: BTreeMap<String, Vec<i64>> = BTreeMap::new();
    let mut file_to_sessions: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut file_to_commits: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut file_entry_count: BTreeMap<String, usize> = BTreeMap::new();

    for record in &provenance_records {
        let entry_id = format!("prov-{}", record.provenance_id);
        let entry = super::exporter::timeline_entry_from_provenance_record(record, entry_id);
        let timeline_record = OrgtrackTimelineRecord {
            schema_version: ORGTRACK_SCHEMA_VERSION,
            record_id: record.record_id.clone(),
            file_path: record.file_path.clone(),
            path_hash: record.path_hash.clone(),
            entry,
        };
        if !seen_timeline_records.insert(timeline_record.record_id.clone()) {
            duplicate_count += 1;
            continue;
        }
        let timeline_path = paths::file_timeline_path(repo_path, &record.file_path);
        let offset = paths::append_json_line(&timeline_path, &timeline_record)?;
        paths::append_json_line(
            &paths::file_timeline_index_path(repo_path, &record.file_path),
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
        timeline_count += 1;
        session_to_files
            .entry(record.session_id.clone())
            .or_default()
            .insert(record.file_path.clone());
        for commit_sha in &record.linked_commits {
            session_to_commits
                .entry(record.session_id.clone())
                .or_default()
                .insert(commit_sha.clone());
            file_to_commits
                .entry(record.file_path.clone())
                .or_default()
                .insert(commit_sha.clone());
        }
        session_to_identity.insert(record.session_id.clone(), record.agent_identity.clone());
        session_to_label.insert(
            record.session_id.clone(),
            record
                .agent_identity
                .display_name
                .clone()
                .unwrap_or_else(|| record.session_id.clone()),
        );
        session_to_times
            .entry(record.session_id.clone())
            .or_default()
            .push(record.created_at);
        file_to_sessions
            .entry(record.file_path.clone())
            .or_default()
            .insert(record.session_id.clone());
        *file_entry_count
            .entry(record.file_path.clone())
            .or_default() += 1;
    }

    for commit_record in &commit_records {
        paths::write_json_pretty(
            &paths::commit_path(repo_path, &commit_record.commit_sha),
            commit_record,
        )?;
        for file in &commit_record.files {
            file_to_commits
                .entry(file.clone())
                .or_default()
                .insert(commit_record.commit_sha.clone());
        }
        for session in &commit_record.sessions {
            session_to_commits
                .entry(session.clone())
                .or_default()
                .insert(commit_record.commit_sha.clone());
        }
    }

    let manifest_version = timeline_count as u64;
    let index = OrgtrackIndex {
        schema_version: ORGTRACK_SCHEMA_VERSION,
        generated_at: Utc::now().to_rfc3339(),
        exported_tier: super::types::OrgtrackTier::Meta,
        derived_version: manifest_version,
        summary: build_index_summary(
            &session_to_files,
            &session_to_identity,
            file_to_sessions.len(),
            commit_records.len(),
            timeline_count,
        ),
        sessions: session_to_files
            .iter()
            .map(|(session_id, files)| {
                let times = session_to_times
                    .get(session_id)
                    .cloned()
                    .unwrap_or_default();
                let files_count = files.len();
                let committed_files_count = committed_files_count(files, &file_to_commits);
                OrgtrackIndexSession {
                    session_id: session_id.clone(),
                    label: session_to_label
                        .get(session_id)
                        .cloned()
                        .unwrap_or_else(|| session_id.clone()),
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
                    first_edit_at: times.iter().min().copied(),
                    last_edit_at: times.iter().max().copied(),
                    agent_identity: session_to_identity
                        .get(session_id)
                        .cloned()
                        .unwrap_or_default(),
                }
            })
            .collect(),
        files: file_to_sessions
            .iter()
            .map(|(path, sessions)| OrgtrackIndexFile {
                path: path.clone(),
                path_hash: paths::path_hash(path),
                sessions_count: sessions.len(),
                commits_count: file_to_commits.get(path).map(BTreeSet::len).unwrap_or(0),
                entries_count: file_entry_count.get(path).copied().unwrap_or(0),
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
    paths::write_json_pretty(
        &paths::manifest_path(repo_path),
        &OrgtrackManifest {
            schema_version: ORGTRACK_SCHEMA_VERSION,
            generated_at: Utc::now().to_rfc3339(),
            source_records_root: Some("records".to_string()),
            derived_index_root: Some("derived".to_string()),
            last_provenance_id: provenance_records
                .iter()
                .map(|record| record.provenance_id)
                .max(),
            last_commit_lineage_id: None,
            record_count: provenance_records.len() + commit_records.len(),
            timeline_record_count: timeline_count,
            derived_version: manifest_version,
        },
    )?;

    Ok(OrgtrackRepairResult {
        repo_path: repo_path.to_string_lossy().to_string(),
        records_read: provenance_records.len() + commit_records.len(),
        duplicates_skipped: duplicate_count,
        timelines_written: timeline_count,
        commits_written: commit_records.len(),
        sessions_written: session_to_files.len(),
        manifest_version,
    })
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

fn build_index_summary(
    session_to_files: &BTreeMap<String, BTreeSet<String>>,
    session_to_identity: &BTreeMap<String, super::types::OrgtrackAgentIdentity>,
    total_files: usize,
    total_commits: usize,
    total_entries: usize,
) -> OrgtrackIndexSummary {
    let mut app_type_counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut model_counts: BTreeMap<String, usize> = BTreeMap::new();

    for session_id in session_to_files.keys() {
        let identity = session_to_identity.get(session_id);
        let app_type = identity
            .and_then(|value| value.dispatch_category.clone())
            .or_else(|| identity.and_then(|value| value.cli_agent_type.clone()))
            .or_else(|| identity.and_then(|value| value.rust_agent_type.clone()))
            .or_else(|| identity.and_then(|value| value.origin.clone()))
            .unwrap_or_else(|| "unknown".to_string());
        *app_type_counts.entry(app_type).or_default() += 1;

        let model = identity
            .and_then(|value| value.model.clone())
            .unwrap_or_else(|| "unknown".to_string());
        *model_counts.entry(model).or_default() += 1;
    }

    OrgtrackIndexSummary {
        sessions_by_app_type: summary_buckets(app_type_counts),
        models_used: summary_buckets(model_counts),
        total_sessions: session_to_files.len(),
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

pub fn read_all_provenance_records(
    repo_path: &Path,
) -> Result<Vec<OrgtrackProvenanceRecord>, String> {
    read_sharded_json_records(&paths::source_provenance_dir(repo_path))
}

pub fn read_all_commit_records(repo_path: &Path) -> Result<Vec<OrgtrackCommitRecord>, String> {
    read_sharded_json_records(&paths::source_commit_links_dir(repo_path))
}

fn read_sharded_json_records<T: serde::de::DeserializeOwned>(
    root: &Path,
) -> Result<Vec<T>, String> {
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    read_sharded_json_records_into(root, &mut out)?;
    Ok(out)
}

fn read_sharded_json_records_into<T: serde::de::DeserializeOwned>(
    root: &Path,
    out: &mut Vec<T>,
) -> Result<(), String> {
    for entry in
        fs::read_dir(root).map_err(|err| format!("Failed to read {}: {}", root.display(), err))?
    {
        let entry =
            entry.map_err(|err| format!("Failed to read {} entry: {}", root.display(), err))?;
        let path = entry.path();
        if path.is_dir() {
            read_sharded_json_records_into(&path, out)?;
        } else if path.extension().and_then(|extension| extension.to_str()) == Some("json") {
            out.push(paths::read_json(&path)?);
        }
    }
    Ok(())
}

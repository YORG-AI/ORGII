//! Derived index summary buckets plus the idempotent record and timeline
//! writers shared by the export pipeline.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use super::identity::agent_identity_for;
use super::SessionRow;
use crate::orgtrack::paths;
use crate::orgtrack::types::{
    OrgtrackFileTimelineEntry, OrgtrackIndexSummary, OrgtrackProvenanceRecord,
    OrgtrackSummaryBucket, OrgtrackTimelineEntryType, OrgtrackTimelineRecord,
};

pub(super) fn build_index_summary<'a>(
    session_ids: impl Iterator<Item = &'a String>,
    sessions: &BTreeMap<String, SessionRow>,
    total_files: usize,
    total_commits: usize,
    total_entries: usize,
) -> OrgtrackIndexSummary {
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

    OrgtrackIndexSummary {
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

pub(super) fn write_record_if_missing<T: serde::Serialize>(
    path: &Path,
    value: &T,
) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }
    paths::write_json_pretty(path, value)
}

pub(super) fn append_timeline_record_if_missing(
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

use std::collections::{BTreeMap, BTreeSet};

use orgtrack_sync::{
    content_record_id, ApprovalState, CommitNoteRecord, FileNoteRecord, SessionEvidenceRecord,
    SyncRecord, SyncRecordPayload, TrustLevel,
};
use serde_json::json;

use crate::{CommitLinkRecord, SessionFinalDiffRecord, SessionRecord};

pub const SESSION_EVIDENCE_SCHEMA: &str = "orgtrack.sessionEvidence.v1";
pub const COMMIT_NOTE_SCHEMA: &str = "orgtrack.commitNote.v1";
pub const FILE_NOTE_SCHEMA: &str = "orgtrack.fileNote.v1";

pub fn session_evidence_sync_record(
    session: &SessionRecord,
    final_diffs: &[SessionFinalDiffRecord],
    commit_links: &[CommitLinkRecord],
) -> Result<SyncRecord, String> {
    let linked_commit_shas = commit_links
        .iter()
        .map(|link| link.commit_sha.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let final_file_count = final_diffs
        .iter()
        .map(|diff| diff.file_path.clone())
        .collect::<BTreeSet<_>>()
        .len();
    let final_lines_added = final_diffs
        .iter()
        .map(|diff| i64::from(diff.lines_added))
        .sum();
    let final_lines_removed = final_diffs
        .iter()
        .map(|diff| i64::from(diff.lines_removed))
        .sum();
    let payload = SessionEvidenceRecord {
        session_id: session.session_id.clone(),
        project_id: None,
        work_item_id: None,
        agent_kind: agent_kind(session),
        started_at: session.created_at.clone(),
        ended_at: session
            .completed_at
            .clone()
            .or_else(|| session.updated_at.clone()),
        final_lines_added,
        final_lines_removed,
        final_file_count,
        linked_commit_shas,
        metadata: json!({
            "source": session.source,
            "sourceSessionId": session.source_session_id,
            "title": session.title,
            "status": session.status,
            "workspacePath": session.workspace_path,
            "branch": session.branch,
            "orgMemberId": session.org_member_id,
            "agentMetadata": session.metadata,
        }),
    };
    sync_record(
        SESSION_EVIDENCE_SCHEMA,
        Some(session.session_id.clone()),
        session
            .updated_at
            .clone()
            .or_else(|| session.created_at.clone()),
        SyncRecordPayload::SessionEvidence(payload),
    )
}

pub fn commit_note_sync_records(
    commit_links: &[CommitLinkRecord],
) -> Result<Vec<SyncRecord>, String> {
    let mut grouped: BTreeMap<String, CommitNoteAccumulator> = BTreeMap::new();
    for link in commit_links {
        let entry = grouped.entry(link.commit_sha.clone()).or_default();
        entry.file_paths.extend(link.file_paths.iter().cloned());
        entry.session_ids.extend(link.session_ids.iter().cloned());
        entry
            .reachability_states
            .insert(link.reachability_state.clone());
        entry.linked_at_values.insert(link.linked_at.clone());
    }

    grouped
        .into_iter()
        .map(|(commit_sha, accumulator)| {
            let payload = CommitNoteRecord {
                commit_sha: commit_sha.clone(),
                repo_url: None,
                summary: None,
                linked_session_ids: accumulator.session_ids.into_iter().collect(),
                linked_work_item_ids: Vec::new(),
                file_paths: accumulator.file_paths.into_iter().collect(),
                metadata: json!({
                    "reachabilityStates": accumulator.reachability_states.into_iter().collect::<Vec<_>>(),
                    "linkedAt": accumulator.linked_at_values.into_iter().collect::<Vec<_>>(),
                }),
            };
            sync_record(
                COMMIT_NOTE_SCHEMA,
                Some(commit_sha),
                None,
                SyncRecordPayload::CommitNote(payload),
            )
        })
        .collect()
}

pub fn file_note_sync_records(
    final_diffs: &[SessionFinalDiffRecord],
) -> Result<Vec<SyncRecord>, String> {
    final_diffs
        .iter()
        .map(|diff| {
            let payload = FileNoteRecord {
                repo_url: None,
                file_path: diff.file_path.clone(),
                commit_sha: None,
                summary: None,
                linked_session_ids: vec![diff.session_id.clone()],
                linked_work_item_ids: Vec::new(),
                metadata: json!({
                    "source": diff.source,
                    "baselineEventId": diff.baseline_event_id,
                    "finalEventId": diff.final_event_id,
                    "linesAdded": diff.lines_added,
                    "linesRemoved": diff.lines_removed,
                    "isDeleted": diff.is_deleted,
                    "quality": diff.quality,
                    "differsFromSummedChunks": diff.differs_from_summed_chunks,
                    "computedAt": diff.computed_at,
                }),
            };
            sync_record(
                FILE_NOTE_SCHEMA,
                Some(format!("{}:{}", diff.session_id, diff.file_path)),
                Some(diff.computed_at.clone()),
                SyncRecordPayload::FileNote(payload),
            )
        })
        .collect()
}

pub fn session_ai_blame_sync_records(
    session: &SessionRecord,
    final_diffs: &[SessionFinalDiffRecord],
    commit_links: &[CommitLinkRecord],
) -> Result<Vec<SyncRecord>, String> {
    let mut records = vec![session_evidence_sync_record(
        session,
        final_diffs,
        commit_links,
    )?];
    records.extend(commit_note_sync_records(commit_links)?);
    records.extend(file_note_sync_records(final_diffs)?);
    Ok(records)
}

#[derive(Default)]
struct CommitNoteAccumulator {
    file_paths: BTreeSet<String>,
    session_ids: BTreeSet<String>,
    reachability_states: BTreeSet<String>,
    linked_at_values: BTreeSet<String>,
}

fn sync_record(
    schema: &str,
    entity_id: Option<String>,
    created_at: Option<String>,
    payload: SyncRecordPayload,
) -> Result<SyncRecord, String> {
    let record_id = content_record_id(schema, &payload)
        .map_err(|err| format!("create orgtrack sync record id: {err}"))?;
    Ok(SyncRecord {
        schema: schema.to_string(),
        record_id,
        entity_id,
        approval_state: ApprovalState::ApprovalPending,
        trust_level: TrustLevel::LocalDraft,
        actor_id: None,
        source_ref: None,
        created_at: created_at.unwrap_or_default(),
        payload,
    })
}

fn agent_kind(session: &SessionRecord) -> String {
    session
        .metadata
        .dispatch_category
        .clone()
        .or_else(|| session.metadata.origin.clone())
        .unwrap_or_else(|| session.source.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AgentMetadata, ArtifactQuality};

    #[test]
    fn exports_session_evidence_with_net_final_diff_totals() {
        let session = SessionRecord {
            schema_version: 1,
            source: "cursor_ide".to_string(),
            source_session_id: "source-session".to_string(),
            session_id: "session-1".to_string(),
            title: "Test".to_string(),
            status: Some("completed".to_string()),
            created_at: Some("2026-06-15T00:00:00Z".to_string()),
            updated_at: Some("2026-06-15T01:00:00Z".to_string()),
            completed_at: None,
            workspace_path: Some("/repo".to_string()),
            branch: Some("Dev".to_string()),
            parent_session_id: None,
            org_member_id: None,
            collaboration_origin: None,
            metadata: AgentMetadata::default(),
        };
        let final_diffs = vec![SessionFinalDiffRecord {
            schema_version: 1,
            record_id: "diff-1".to_string(),
            source: "cursor_ide".to_string(),
            session_id: "session-1".to_string(),
            file_path: "src/lib.rs".to_string(),
            baseline_event_id: None,
            final_event_id: None,
            old_content: None,
            new_content: None,
            diff: None,
            lines_added: 12,
            lines_removed: 3,
            is_deleted: false,
            quality: ArtifactQuality::Exact,
            differs_from_summed_chunks: false,
            computed_at: "2026-06-15T01:00:00Z".to_string(),
        }];
        let commit_links = vec![CommitLinkRecord {
            schema_version: 1,
            record_id: "link-1".to_string(),
            commit_sha: "abc".to_string(),
            file_paths: vec!["src/lib.rs".to_string()],
            session_ids: vec!["session-1".to_string()],
            reachability_state: "reachable".to_string(),
            linked_at: "2026-06-15T01:00:00Z".to_string(),
        }];

        let records = session_ai_blame_sync_records(&session, &final_diffs, &commit_links)
            .expect("export sync records");

        assert_eq!(records.len(), 3);
        match &records[0].payload {
            SyncRecordPayload::SessionEvidence(payload) => {
                assert_eq!(payload.final_lines_added, 12);
                assert_eq!(payload.final_lines_removed, 3);
                assert_eq!(payload.final_file_count, 1);
                assert_eq!(payload.linked_commit_shas, vec!["abc"]);
            }
            other => panic!("unexpected payload: {other:?}"),
        }
    }
}

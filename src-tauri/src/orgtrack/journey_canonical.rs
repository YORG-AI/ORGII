//! Canonical Journey graph construction from orgtrack canonical records.
//!
//! This is the real data path behind `journey_graph_query`: it reads the
//! persisted canonical stores (sessions / edit artifacts / commit links),
//! filters them to the requested scope, runs the canonical projector
//! (`orgtrack_graph::journey::project_canonical_journey`) and fails closed
//! when the independent audit reports uncovered canonical units.
//!
//! The persisted canonical graph is not optional: absent scope data is an
//! error, never a synthesized partial response.

use std::collections::{HashMap, HashSet};

use agent_core::core::journey_lifecycle::SqliteJourneyRepository;
use orgtrack_core::canonical::SessionEditKind;
use orgtrack_core::store::sqlite::SqliteRecordStore;
use orgtrack_core::store::RecordStore;
use orgtrack_graph::audit::audit_canonical_journey;
use orgtrack_graph::journey::{
    ArtifactRelation, CanonicalArtifact, CanonicalCommit, CanonicalJourneyInput, CanonicalProject,
    CanonicalSession, CanonicalTurn, CoverageStatus, JourneyGraph,
};
use orgtrack_graph::JourneyScope;
use rusqlite::Connection;

/// Build the canonical Journey graph for a scope.
///
/// Scope semantics (no guessing, no synthesized data):
/// - `project/{id}` selects only sessions whose durable canonical
///   `journey.project_id` exactly matches the requested id.
/// - `session/{id}` selects the session plus its full parent lineage chain
///   (`parent_session_id` recursion), so fork edges stay verifiable.
pub fn build_journey_graph(
    store: &SqliteRecordStore,
    conn: &Connection,
    scope: &JourneyScope,
) -> Result<JourneyGraph, String> {
    let mut sessions = store.list_sessions(None)?;
    let mut artifacts = store.list_edit_artifacts(None, None)?;
    let mut commits = store.list_commit_links()?;

    // Store queries may have timestamp/sequence ties. Canonical graph array
    // order must depend only on durable identities, never SQLite tie order.
    sessions.sort_by(|left, right| left.session_id.cmp(&right.session_id));
    artifacts.sort_by(|left, right| {
        (&left.session_id, left.sequence_index, &left.record_id).cmp(&(
            &right.session_id,
            right.sequence_index,
            &right.record_id,
        ))
    });
    commits.sort_by(|left, right| {
        (&left.commit_sha, &left.record_id).cmp(&(&right.commit_sha, &right.record_id))
    });

    let selected = select_sessions(&sessions, scope)?;
    if selected.is_empty() {
        return Err(format!(
            "canonical Journey graph store is not initialized for this project; \
             no canonical sessions for scope {}",
            scope_label(scope)
        ));
    }

    let mut input = CanonicalJourneyInput::default();
    let mut seen_projects: HashSet<String> = HashSet::new();
    let mut work_item_projects: HashMap<String, String> = HashMap::new();
    for session in &sessions {
        if !selected.contains(&session.session_id) {
            continue;
        }
        let project_id = session
            .journey
            .project_id
            .as_ref()
            .filter(|id| !id.trim().is_empty())
            .cloned()
            .ok_or_else(|| {
                format!(
                    "会话 {} 缺少显式 Journey project_id，拒绝推断项目归属",
                    session.session_id
                )
            })?;
        if seen_projects.insert(project_id.clone()) {
            input.projects.push(CanonicalProject {
                id: project_id.clone(),
                source_ref: format!("orgtrack:project:{project_id}"),
            });
        }
        if let Some(work_item_id) = session
            .journey
            .work_item_id
            .as_ref()
            .filter(|id| !id.trim().is_empty())
        {
            match work_item_projects.get(work_item_id) {
                Some(existing_project_id) if existing_project_id != &project_id => {
                    return Err(format!(
                        "Journey work item {} 同时关联项目 {} 与 {}，拒绝构建跨项目关系",
                        work_item_id, existing_project_id, project_id
                    ));
                }
                Some(_) => {}
                None => {
                    work_item_projects.insert(work_item_id.clone(), project_id.clone());
                    input.work_items.push(orgtrack_graph::CanonicalWorkItem {
                        id: work_item_id.clone(),
                        project_id: project_id.clone(),
                        source_ref: format!("orgtrack:session-work-item:{}", session.session_id),
                    });
                }
            }
        }
        input.sessions.push(CanonicalSession {
            id: session.session_id.clone(),
            project_id,
            work_item_id: session
                .journey
                .work_item_id
                .clone()
                .filter(|id| !id.trim().is_empty()),
            resumed_from: session
                .parent_session_id
                .clone()
                .filter(|parent| selected.contains(parent)),
            compacted_to: None,
            forked_from: None,
            source_ref: format!("orgtrack:session:{}", session.session_id),
            display_timestamp: session.created_at.clone(),
        });
    }

    // Canonical edit sequence is the exact durable turn boundary. Negative
    // values are invalid storage state and must not be clamped or inferred.
    let mut seen_turns: HashSet<(String, u64)> = HashSet::new();
    for artifact in &artifacts {
        if !selected.contains(&artifact.session_id) {
            continue;
        }
        let sequence = u64::try_from(artifact.sequence_index).map_err(|_| {
            format!(
                "会话 {} 的编辑制品 {} 包含无效负数 sequence_index={}，拒绝构建 Journey 图",
                artifact.session_id, artifact.record_id, artifact.sequence_index
            )
        })?;
        if seen_turns.insert((artifact.session_id.clone(), sequence)) {
            input.turns.push(CanonicalTurn {
                session_id: artifact.session_id.clone(),
                sequence,
                source_ref: format!("orgtrack:artifact:{}", artifact.record_id),
                display_timestamp: artifact.timestamp.clone(),
            });
        }
    }

    for artifact in &artifacts {
        if !selected.contains(&artifact.session_id) {
            continue;
        }
        let relation = match artifact.edit_kind {
            SessionEditKind::Write => ArtifactRelation::Produced,
            SessionEditKind::Patch | SessionEditKind::Delete => ArtifactRelation::Modified,
            _ => continue,
        };
        input.artifacts.push(CanonicalArtifact {
            source: artifact.source.clone(),
            id: artifact.record_id.clone(),
            session_id: artifact.session_id.clone(),
            file_repo: artifact.workspace_path.clone(),
            file_path: Some(artifact.file_path.clone()),
            relation,
            source_ref: format!("orgtrack:artifact:{}", artifact.record_id),
        });
    }

    for commit in &commits {
        let linked_session = commit
            .session_ids
            .iter()
            .filter(|session_id| selected.contains(*session_id))
            .min();
        if let Some(session_id) = linked_session {
            input.commits.push(CanonicalCommit {
                repo: "unknown".to_string(),
                sha: commit.commit_sha.clone(),
                session_id: Some(session_id.clone()),
                work_item_id: None,
                source_ref: format!("orgtrack:commit:{}", commit.commit_sha),
            });
        }
    }

    let mut graph = orgtrack_graph::journey::project_canonical_journey(&input)?;
    append_session_journey_lifecycle(conn, &mut graph, &selected)?;
    let report = audit_canonical_journey(&input, &graph);
    if !report.trustworthy {
        let uncovered: Vec<_> = report
            .coverage
            .iter()
            .filter(|entry| matches!(entry.status, CoverageStatus::Uncovered))
            .map(|entry| entry.source_ref.clone())
            .collect();
        return Err(format!(
            "canonical Journey graph store is incomplete for this project; \
             refusing partial data, uncovered canonical units: {}",
            uncovered.join(", ")
        ));
    }
    Ok(graph)
}

/// Append durable Session Journey lifecycle entities for the exact canonical
/// sessions already selected for this graph. A lifecycle record without its
/// canonical session is rejected; message anchors are verified by
/// `session_id + message_id + sequence` in the same sessions database.
fn append_session_journey_lifecycle(
    conn: &Connection,
    graph: &mut JourneyGraph,
    selected: &HashSet<String>,
) -> Result<(), String> {
    let mut session_ids: Vec<_> = selected.iter().collect();
    session_ids.sort_unstable();
    for session_id in session_ids {
        if let Some(journey) = SqliteJourneyRepository::load_existing(conn, session_id)
            .map_err(|error| format!("无法读取会话旅程 {session_id}：{error}"))?
        {
            if journey.session_id != *session_id {
                return Err(format!(
                    "会话旅程存储身份不一致：row_session={session_id}, state_session={}",
                    journey.session_id
                ));
            }
            super::journey_lifecycle_graph::append(conn, graph, &journey)?;
        }
    }
    Ok(())
}

fn select_sessions(
    sessions: &[orgtrack_core::canonical::SessionRecord],
    scope: &JourneyScope,
) -> Result<HashSet<String>, String> {
    let mut selected = HashSet::new();
    match scope {
        JourneyScope::Project(id) => {
            for session in sessions {
                if session.journey.project_id.as_deref() == Some(id) {
                    selected.insert(session.session_id.clone());
                }
            }
        }
        JourneyScope::Session(id) => {
            let by_id: HashMap<&str, &orgtrack_core::canonical::SessionRecord> = sessions
                .iter()
                .map(|session| (session.session_id.as_str(), session))
                .collect();
            if !by_id.contains_key(id.as_str()) {
                return Err(format!(
                    "canonical Journey graph store is not initialized for this project; \
                     no canonical session for scope {}",
                    scope_label(scope)
                ));
            }
            let mut cursor = Some(id.as_str());
            while let Some(session_id) = cursor {
                if !selected.insert(session_id.to_string()) {
                    break;
                }
                cursor = by_id
                    .get(session_id)
                    .and_then(|session| session.parent_session_id.as_deref());
            }
        }
    }
    Ok(selected)
}

fn scope_label(scope: &JourneyScope) -> String {
    match scope {
        JourneyScope::Project(id) => format!("project/{id}"),
        JourneyScope::Session(id) => format!("session/{id}"),
    }
}

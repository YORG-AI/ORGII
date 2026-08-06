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

use orgtrack_core::canonical::SessionEditKind;
use orgtrack_core::store::sqlite::SqliteRecordStore;
use orgtrack_core::store::RecordStore;
use orgtrack_graph::audit::audit_canonical_journey;
use orgtrack_graph::journey::{
    ArtifactRelation, CanonicalArtifact, CanonicalCommit, CanonicalJourneyInput, CanonicalProject,
    CanonicalSession, CanonicalTurn, CoverageStatus, JourneyGraph,
};
use orgtrack_graph::JourneyScope;

/// Build the canonical Journey graph for a scope.
///
/// Scope semantics (no guessing, no synthesized data):
/// - `project/{id}` selects only sessions whose durable canonical
///   `journey.project_id` exactly matches the requested id.
/// - `session/{id}` selects the session plus its full parent lineage chain
///   (`parent_session_id` recursion), so fork edges stay verifiable.
pub fn build_journey_graph(
    store: &SqliteRecordStore,
    scope: &JourneyScope,
) -> Result<JourneyGraph, String> {
    let sessions = store.list_sessions(None)?;
    let artifacts = store.list_edit_artifacts(None, None)?;
    let commits = store.list_commit_links()?;

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
    let mut seen_work_items: HashSet<String> = HashSet::new();
    for session in &sessions {
        if !selected.contains(&session.session_id) {
            continue;
        }
        let project_id = session.journey.project_id.clone();
        if let Some(project_id) = project_id
            .as_ref()
            .filter(|id| seen_projects.insert((*id).clone()))
        {
            input.projects.push(CanonicalProject {
                id: project_id.clone(),
                source_ref: format!("orgtrack:project:{project_id}"),
            });
        }
        if let Some(work_item_id) = session.journey.work_item_id.as_ref() {
            if seen_work_items.insert(work_item_id.clone()) {
                input.work_items.push(orgtrack_graph::CanonicalWorkItem {
                    id: work_item_id.clone(),
                    project_id: project_id.clone(),
                    source_ref: format!("orgtrack:session-work-item:{}", session.session_id),
                });
            }
        }
        input.sessions.push(CanonicalSession {
            id: session.session_id.clone(),
            project_id,
            work_item_id: session.journey.work_item_id.clone(),
            resumed_from: session
                .parent_session_id
                .clone()
                .filter(|parent| selected.contains(parent)),
            compacted_to: None,
            forked_from: None,
            source_ref: format!("orgtrack:session:{}", session.session_id),
            display_timestamp: session.created_at.clone(),
            agent_identity: session.journey.agent_identity.clone(),
            agent_band: session.journey.agent_band.clone(),
            topic_tags: session.journey.topic_tags.clone(),
        });
    }

    // A Journey turn exists only when the producing event supplied its exact
    // execution turn id. Sequence indices are storage ordering, not identity.
    let mut seen_turns: HashSet<(String, String)> = HashSet::new();
    for artifact in &artifacts {
        if !selected.contains(&artifact.session_id) {
            continue;
        }
        if let Some(turn_id) = artifact.execution_turn_id.as_ref() {
            if seen_turns.insert((artifact.session_id.clone(), turn_id.clone())) {
                input.turns.push(CanonicalTurn {
                    session_id: artifact.session_id.clone(),
                    id: turn_id.clone(),
                    source_ref: format!("orgtrack:artifact:{}", artifact.record_id),
                    display_timestamp: artifact.timestamp.clone(),
                });
            }
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
            .find(|session_id| selected.contains(*session_id));
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

    let graph = orgtrack_graph::journey::project_canonical_journey(&input)?;
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

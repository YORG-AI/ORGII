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

use database::db::get_projects_connection;
use orgtrack_core::canonical::SessionEditKind;
use rusqlite::OptionalExtension;
use orgtrack_core::store::sqlite::SqliteRecordStore;
use orgtrack_core::store::RecordStore;
use orgtrack_graph::audit::audit_canonical_journey;
use orgtrack_graph::journey::{
    ArtifactRelation, CanonicalArtifact, CanonicalCommit, CanonicalJourneyInput,
    CanonicalProject, CanonicalSession, CanonicalTurn, CoverageStatus, JourneyGraph,
    SessionParent,
};
use orgtrack_graph::JourneyScope;

/// Build the canonical Journey graph for a scope.
///
/// Scope semantics (no guessing, no synthesized data):
/// - `project/{id}` resolves the canonical project id through its linked
///   workspaces (`linked_repos_json` in projects.db) and selects every
///   canonical session whose `workspace_path` is inside one of them. A
///   project without explicit linked workspaces is an error.
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
    for session in &sessions {
        if !selected.contains(&session.session_id) {
            continue;
        }
        let project_id = session
            .workspace_path
            .clone()
            .unwrap_or_else(|| "unassigned".to_string());
        if seen_projects.insert(project_id.clone()) {
            input.projects.push(CanonicalProject {
                id: project_id.clone(),
                source_ref: format!("orgtrack:project:{project_id}"),
            });
        }
        // Fork edges are only emitted when the parent session is inside the
        // selected scope; a cross-scope parent is not guessed into the view.
        let forked_from = session
            .parent_session_id
            .as_ref()
            .filter(|parent| selected.contains(parent.as_str()))
            .map(|parent| SessionParent {
                session_id: parent.clone(),
                parent_revision: format!("orgtrack:parent:{}", session.session_id),
            });
        input.sessions.push(CanonicalSession {
            id: session.session_id.clone(),
            project_id,
            work_item_id: None,
            resumed_from: None,
            compacted_to: None,
            forked_from,
            source_ref: format!("orgtrack:session:{}", session.session_id),
            display_timestamp: session.created_at.clone(),
        });
    }

    // Turns come from canonical edit artifacts; each distinct (session,
    // sequence_index) is one turn. `list_edit_artifacts` returns rows ordered
    // by sequence_index ASC, so per-session ordering stays strictly increasing
    // after deduplication (projector enforces it as a hard invariant).
    let mut seen_turns: HashSet<(String, u64)> = HashSet::new();
    for artifact in &artifacts {
        if !selected.contains(&artifact.session_id) {
            continue;
        }
        let sequence = artifact.sequence_index.max(0) as u64;
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
            // Read / CommitBoundary / Unknown carry no produced/modified
            // evidence edge; they must not appear as canonical file lineage.
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
                // CommitLinkRecord carries no repo field; keep the honest
                // placeholder rather than deriving a repo from file paths.
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
            // Resolve the canonical project identity to its linked
            // workspaces (`linked_repos_json` in projects.db). The mapping
            // must exist explicitly: a project without linked workspaces is
            // an error, never a guessed path.
            let workspaces = resolve_project_workspaces(id)?;
            for session in sessions {
                let in_project = session
                    .workspace_path
                    .as_deref()
                    .map(|path| {
                        workspaces.iter().any(|workspace| {
                            path == workspace
                                || path.starts_with(&format!("{workspace}/"))
                        })
                    })
                    .unwrap_or(false);
                if in_project {
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

/// Read the canonical project row from `projects.db` and return its linked
/// workspace paths (`linked_repos_json`). Fail-closed: an unknown project id
/// or an empty linked-repos list is an error, because there is no honest
/// workspace to scope the journey to.
fn resolve_project_workspaces(project_id: &str) -> Result<Vec<String>, String> {
    let conn = get_projects_connection().map_err(|err| {
        format!("cannot open project store while resolving {project_id}: {err}")
    })?;
    let linked_repos_json: Option<String> = conn
        .query_row(
            "SELECT linked_repos_json FROM projects WHERE id = ?1",
            [project_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| {
            format!("cannot read linked repos for {project_id}: {err}")
        })?;
    let Some(raw) = linked_repos_json else {
        return Err(format!(
            "canonical Journey graph store is not initialized for this project;              project {project_id} does not exist in the project store"
        ));
    };
    let workspaces: Vec<String> = serde_json::from_str(&raw).map_err(|err| {
        format!("project {project_id} linked_repos_json is invalid: {err}")
    })?;
    if workspaces.is_empty() {
        return Err(format!(
            "canonical Journey graph store is not initialized for this project;              project {project_id} has no linked workspaces (linked_repos_json is empty)"
        ));
    }
    Ok(workspaces)
}

fn scope_label(scope: &JourneyScope) -> String {
    match scope {
        JourneyScope::Project(id) => format!("project/{id}"),
        JourneyScope::Session(id) => format!("session/{id}"),
    }
}

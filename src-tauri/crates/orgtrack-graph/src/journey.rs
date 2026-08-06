//! Read-only canonical Journey graph contracts and projector.
//!
//! This module deliberately receives canonical records as input. It never uses
//! timestamps to infer relationships: timestamps are retained only as display metadata.

use std::collections::{BTreeSet, HashSet};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EvidenceClass {
    Canonical,
    DerivedRule,
    AiAnnotation,
    UserOverlay,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum JourneyNodeKind {
    Project,
    WorkItem,
    Session,
    Turn,
    Checkpoint,
    Artifact,
    File,
    Commit,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum JourneyEdgeKind {
    Contains,
    RunOf,
    NextTurn,
    ForkedFrom,
    ResumedFrom,
    CompactedTo,
    Produced,
    Modified,
    ValidatedBy,
    CommittedIn,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JourneyNode {
    pub id: String,
    pub kind: JourneyNodeKind,
    pub evidence_class: EvidenceClass,
    pub source_ref: String,
    pub display_timestamp: Option<String>,
    #[serde(default)]
    pub metadata: JourneyNodeMetadata,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JourneyNodeMetadata {
    pub agent_identity: Option<String>,
    pub agent_band: Option<String>,
    #[serde(default)]
    pub topic_tags: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JourneyEdge {
    pub from: String,
    pub to: String,
    pub kind: JourneyEdgeKind,
    pub evidence_class: EvidenceClass,
    pub source_ref: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CoverageStatus {
    Represented,
    MergedInto { target: String },
    Excluded { reason: String },
    Uncovered,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverageEntry {
    pub source_ref: String,
    pub status: CoverageStatus,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JourneyGraph {
    pub nodes: Vec<JourneyNode>,
    pub edges: Vec<JourneyEdge>,
    pub coverage: Vec<CoverageEntry>,
}

#[derive(Debug, Clone, Default)]
pub struct CanonicalJourneyInput {
    pub projects: Vec<CanonicalProject>,
    pub work_items: Vec<CanonicalWorkItem>,
    pub sessions: Vec<CanonicalSession>,
    pub turns: Vec<CanonicalTurn>,
    pub artifacts: Vec<CanonicalArtifact>,
    pub commits: Vec<CanonicalCommit>,
}
#[derive(Debug, Clone)]
pub struct CanonicalProject {
    pub id: String,
    pub source_ref: String,
}
#[derive(Debug, Clone)]
pub struct CanonicalWorkItem {
    pub id: String,
    pub project_id: Option<String>,
    pub source_ref: String,
}
#[derive(Debug, Clone)]
pub struct CanonicalSession {
    pub id: String,
    pub project_id: Option<String>,
    pub work_item_id: Option<String>,
    pub resumed_from: Option<String>,
    pub compacted_to: Option<String>,
    pub forked_from: Option<SessionParent>,
    pub source_ref: String,
    pub display_timestamp: Option<String>,
    pub agent_identity: Option<String>,
    pub agent_band: Option<String>,
    pub topic_tags: Vec<String>,
}
#[derive(Debug, Clone)]
pub struct SessionParent {
    pub session_id: String,
    pub parent_revision: String,
}
#[derive(Debug, Clone)]
pub struct CanonicalTurn {
    pub session_id: String,
    pub id: String,
    pub source_ref: String,
    pub display_timestamp: Option<String>,
}
#[derive(Debug, Clone)]
pub struct CanonicalArtifact {
    pub source: String,
    pub id: String,
    pub session_id: String,
    pub file_repo: Option<String>,
    pub file_path: Option<String>,
    pub relation: ArtifactRelation,
    pub source_ref: String,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArtifactRelation {
    Produced,
    Modified,
    ValidatedBy,
}
#[derive(Debug, Clone)]
pub struct CanonicalCommit {
    pub repo: String,
    pub sha: String,
    pub session_id: Option<String>,
    pub work_item_id: Option<String>,
    pub source_ref: String,
}

fn node(
    id: String,
    kind: JourneyNodeKind,
    source_ref: String,
    display_timestamp: Option<String>,
) -> JourneyNode {
    JourneyNode {
        id,
        kind,
        evidence_class: EvidenceClass::Canonical,
        source_ref,
        display_timestamp,
        metadata: JourneyNodeMetadata::default(),
    }
}
fn edge(from: String, to: String, kind: JourneyEdgeKind, source_ref: String) -> JourneyEdge {
    JourneyEdge {
        from,
        to,
        kind,
        evidence_class: EvidenceClass::Canonical,
        source_ref,
    }
}
fn require_id(value: &str, label: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        Err(format!("missing {label}"))
    } else {
        Ok(())
    }
}
fn add_node(
    graph: &mut JourneyGraph,
    ids: &mut HashSet<String>,
    coverage: &mut BTreeSet<String>,
    item: JourneyNode,
) -> Result<(), String> {
    require_id(&item.source_ref, "canonical source reference")?;
    if !ids.insert(item.id.clone()) {
        return Err(format!("duplicate canonical node {}", item.id));
    }
    coverage.insert(item.source_ref.clone());
    graph.nodes.push(item);
    Ok(())
}

pub fn project_canonical_journey(input: &CanonicalJourneyInput) -> Result<JourneyGraph, String> {
    let mut graph = JourneyGraph::default();
    let mut ids = HashSet::new();
    let mut coverage = BTreeSet::new();
    for p in &input.projects {
        require_id(&p.id, "project id")?;
        add_node(
            &mut graph,
            &mut ids,
            &mut coverage,
            node(
                format!("project/{}", p.id),
                JourneyNodeKind::Project,
                p.source_ref.clone(),
                None,
            ),
        )?;
    }
    for w in &input.work_items {
        require_id(&w.id, "work item id")?;
        let wid = format!("work_item/{}", w.id);
        add_node(
            &mut graph,
            &mut ids,
            &mut coverage,
            node(
                wid.clone(),
                JourneyNodeKind::WorkItem,
                w.source_ref.clone(),
                None,
            ),
        )?;
        if let Some(project_id) = &w.project_id {
            let pid = format!("project/{project_id}");
            if !ids.contains(&pid) {
                return Err(format!("work item {} has unknown project", w.id));
            }
            graph.edges.push(edge(
                pid,
                wid,
                JourneyEdgeKind::Contains,
                w.source_ref.clone(),
            ));
        }
    }
    let session_ids: HashSet<_> = input.sessions.iter().map(|s| s.id.as_str()).collect();
    for s in &input.sessions {
        require_id(&s.id, "session id")?;
        if let Some(w) = &s.work_item_id {
            if !ids.contains(&format!("work_item/{w}")) {
                return Err(format!("session {} has unknown work item", s.id));
            }
        }
        if let Some(parent) = &s.forked_from {
            require_id(&parent.parent_revision, "parent revision")?;
            if !session_ids.contains(parent.session_id.as_str()) {
                return Err(format!("session {} has unknown fork parent", s.id));
            }
        }
        for parent in [&s.resumed_from, &s.compacted_to].into_iter().flatten() {
            if !session_ids.contains(parent.as_str()) {
                return Err(format!("session {} has unknown lineage parent", s.id));
            }
        }
        let sid = format!("session/{}", s.id);
        let mut session_node = node(
            sid.clone(),
            JourneyNodeKind::Session,
            s.source_ref.clone(),
            s.display_timestamp.clone(),
        );
        session_node.metadata = JourneyNodeMetadata {
            agent_identity: s.agent_identity.clone(),
            agent_band: s.agent_band.clone(),
            topic_tags: s.topic_tags.clone(),
        };
        add_node(&mut graph, &mut ids, &mut coverage, session_node)?;
        if let Some(project_id) = &s.project_id {
            if !ids.contains(&format!("project/{project_id}")) {
                return Err(format!("session {} has unknown project", s.id));
            }
            graph.edges.push(edge(
                format!("project/{project_id}"),
                sid.clone(),
                JourneyEdgeKind::Contains,
                s.source_ref.clone(),
            ));
        }
        if let Some(w) = &s.work_item_id {
            graph.edges.push(edge(
                format!("work_item/{w}"),
                sid.clone(),
                JourneyEdgeKind::RunOf,
                s.source_ref.clone(),
            ));
        }
        if let Some(p) = &s.resumed_from {
            graph.edges.push(edge(
                sid.clone(),
                format!("session/{p}"),
                JourneyEdgeKind::ResumedFrom,
                s.source_ref.clone(),
            ));
        }
        if let Some(p) = &s.compacted_to {
            graph.edges.push(edge(
                sid.clone(),
                format!("session/{p}"),
                JourneyEdgeKind::CompactedTo,
                s.source_ref.clone(),
            ));
        }
        if let Some(p) = &s.forked_from {
            graph.edges.push(edge(
                sid,
                format!("session/{}", p.session_id),
                JourneyEdgeKind::ForkedFrom,
                format!("{}#{}", s.source_ref, p.parent_revision),
            ));
        }
    }
    for t in &input.turns {
        if !session_ids.contains(t.session_id.as_str()) {
            return Err(format!("turn has unknown session {}", t.session_id));
        }
        require_id(&t.source_ref, "turn source reference")?;
        require_id(&t.id, "execution turn id")?;
        let tid = format!("turn/{}/{}", t.session_id, t.id);
        add_node(
            &mut graph,
            &mut ids,
            &mut coverage,
            node(
                tid.clone(),
                JourneyNodeKind::Turn,
                t.source_ref.clone(),
                t.display_timestamp.clone(),
            ),
        )?;
        let sid = format!("session/{}", t.session_id);
        graph.edges.push(edge(
            sid,
            tid.clone(),
            JourneyEdgeKind::Contains,
            t.source_ref.clone(),
        ));
    }
    for a in &input.artifacts {
        if !session_ids.contains(a.session_id.as_str()) {
            return Err(format!("artifact {} has unknown session", a.id));
        }
        let aid = format!("artifact/{}/{}", a.source, a.id);
        add_node(
            &mut graph,
            &mut ids,
            &mut coverage,
            node(
                aid.clone(),
                JourneyNodeKind::Artifact,
                a.source_ref.clone(),
                None,
            ),
        )?;
        graph.edges.push(edge(
            format!("session/{}", a.session_id),
            aid.clone(),
            JourneyEdgeKind::Produced,
            a.source_ref.clone(),
        ));
        if let (Some(repo), Some(path)) = (&a.file_repo, &a.file_path) {
            let fid = format!("file/{repo}/{path}");
            if !ids.contains(&fid) {
                add_node(
                    &mut graph,
                    &mut ids,
                    &mut coverage,
                    node(
                        fid.clone(),
                        JourneyNodeKind::File,
                        a.source_ref.clone(),
                        None,
                    ),
                )?;
            }
            graph.edges.push(edge(
                aid,
                fid,
                match a.relation {
                    ArtifactRelation::Produced => JourneyEdgeKind::Produced,
                    ArtifactRelation::Modified => JourneyEdgeKind::Modified,
                    ArtifactRelation::ValidatedBy => JourneyEdgeKind::ValidatedBy,
                },
                a.source_ref.clone(),
            ));
        }
    }
    for c in &input.commits {
        let cid = format!("commit/{}/{}", c.repo, c.sha);
        add_node(
            &mut graph,
            &mut ids,
            &mut coverage,
            node(
                cid.clone(),
                JourneyNodeKind::Commit,
                c.source_ref.clone(),
                None,
            ),
        )?;
        if let Some(s) = &c.session_id {
            if !session_ids.contains(s.as_str()) {
                return Err(format!("commit {} has unknown session", c.sha));
            }
            graph.edges.push(edge(
                format!("session/{s}"),
                cid.clone(),
                JourneyEdgeKind::CommittedIn,
                c.source_ref.clone(),
            ));
        }
        if let Some(w) = &c.work_item_id {
            if !ids.contains(&format!("work_item/{w}")) {
                return Err(format!("commit {} has unknown work item", c.sha));
            }
            graph.edges.push(edge(
                format!("work_item/{w}"),
                cid,
                JourneyEdgeKind::CommittedIn,
                c.source_ref.clone(),
            ));
        }
    }
    graph.coverage = coverage
        .into_iter()
        .map(|source_ref| CoverageEntry {
            source_ref,
            status: CoverageStatus::Represented,
        })
        .collect();
    Ok(graph)
}

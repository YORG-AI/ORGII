use crate::{
    audit_canonical_journey, project_canonical_journey, ArtifactRelation, CanonicalArtifact,
    CanonicalJourneyInput, CanonicalProject, CanonicalSession, CanonicalTurn, CanonicalWorkItem,
    CoverageStatus, JourneyEdgeKind, JourneyScope, SessionParent,
};

fn input() -> CanonicalJourneyInput {
    CanonicalJourneyInput {
        projects: vec![CanonicalProject {
            id: "p".into(),
            source_ref: "project-record".into(),
        }],
        work_items: vec![CanonicalWorkItem {
            id: "w".into(),
            project_id: Some("p".into()),
            source_ref: "wi-record".into(),
        }],
        sessions: vec![
            CanonicalSession {
                id: "parent".into(),
                project_id: Some("p".into()),
                work_item_id: Some("w".into()),
                resumed_from: None,
                compacted_to: None,
                forked_from: None,
                source_ref: "session-parent".into(),
                display_timestamp: Some("2026-01-01".into()),
                agent_identity: Some("agent-a".into()),
                agent_band: Some("review".into()),
                topic_tags: vec!["explicit-topic".into()],
            },
            CanonicalSession {
                id: "child".into(),
                project_id: Some("p".into()),
                work_item_id: Some("w".into()),
                resumed_from: Some("parent".into()),
                compacted_to: None,
                forked_from: Some(SessionParent {
                    session_id: "parent".into(),
                    parent_revision: "revision-7".into(),
                }),
                source_ref: "session-child".into(),
                display_timestamp: Some("2099-01-01".into()),
                agent_identity: None,
                agent_band: None,
                topic_tags: vec![],
            },
        ],
        turns: vec![
            CanonicalTurn {
                session_id: "child".into(),
                id: "execution-1".into(),
                source_ref: "turn-1".into(),
                display_timestamp: None,
            },
            CanonicalTurn {
                session_id: "child".into(),
                id: "execution-2".into(),
                source_ref: "turn-2".into(),
                display_timestamp: None,
            },
        ],
        artifacts: vec![CanonicalArtifact {
            source: "orgtrack".into(),
            id: "a".into(),
            session_id: "child".into(),
            file_repo: Some("repo".into()),
            file_path: Some("src/a.rs".into()),
            relation: ArtifactRelation::Modified,
            source_ref: "artifact-1".into(),
        }],
        commits: vec![],
    }
}

#[test]
fn projector_uses_exact_lineage_anchors_not_timestamps() {
    let graph = project_canonical_journey(&input()).unwrap();
    let fork = graph
        .edges
        .iter()
        .find(|edge| edge.kind == JourneyEdgeKind::ForkedFrom)
        .unwrap();
    assert_eq!(fork.from, "session/child");
    assert_eq!(fork.to, "session/parent");
    assert!(fork.source_ref.ends_with("#revision-7"));
    assert!(!fork.source_ref.contains("2099"));
    let parent = graph
        .nodes
        .iter()
        .find(|node| node.id == "session/parent")
        .unwrap();
    assert_eq!(parent.metadata.agent_band.as_deref(), Some("review"));
    assert_eq!(parent.metadata.topic_tags, ["explicit-topic"]);
}
#[test]
fn projector_rejects_missing_parent_revision_and_first_session_ownership() {
    let mut bad = input();
    bad.sessions[1]
        .forked_from
        .as_mut()
        .unwrap()
        .parent_revision
        .clear();
    assert!(project_canonical_journey(&bad).is_err());
    let graph = project_canonical_journey(&input()).unwrap();
    assert!(graph
        .edges
        .iter()
        .all(|edge| !(edge.from == "session/parent" && edge.to == "file/repo/src/a.rs")));
    assert!(graph
        .edges
        .iter()
        .any(|edge| edge.kind == JourneyEdgeKind::Modified && edge.from == "artifact/orgtrack/a"));
}
#[test]
fn audit_fails_closed_when_a_canonical_unit_is_uncovered() {
    let input = input();
    let mut graph = project_canonical_journey(&input).unwrap();
    graph.nodes.retain(|node| node.source_ref != "turn-2");
    graph.edges.retain(|edge| edge.source_ref != "turn-2");
    let audit = audit_canonical_journey(&input, &graph);
    assert!(!audit.trustworthy);
    assert!(audit
        .coverage
        .iter()
        .any(|entry| entry.source_ref == "turn-2"
            && matches!(entry.status, CoverageStatus::Uncovered)));
}
#[test]
fn evidence_and_source_are_mandatory() {
    let mut bad = input();
    bad.turns[0].source_ref.clear();
    assert!(project_canonical_journey(&bad).is_err());
    let graph = project_canonical_journey(&input()).unwrap();
    assert!(graph.nodes.iter().all(|node| !node.source_ref.is_empty()));
    assert!(graph.edges.iter().all(|edge| !edge.source_ref.is_empty()));
}

#[test]
fn absent_metadata_stays_unassociated_and_turns_never_follow_sequence() {
    let mut canonical = input();
    canonical.sessions[0].project_id = None;
    canonical.sessions[0].work_item_id = None;
    canonical.sessions[0].agent_identity = None;
    canonical.sessions[0].agent_band = None;
    canonical.sessions[0].topic_tags.clear();
    canonical.turns[0].id.clear();

    assert!(project_canonical_journey(&canonical).is_err());

    canonical.turns.remove(0);
    let graph = project_canonical_journey(&canonical).unwrap();
    let session = graph
        .nodes
        .iter()
        .find(|node| node.id == "session/parent")
        .unwrap();
    assert_eq!(session.metadata.agent_identity, None);
    assert_eq!(session.metadata.agent_band, None);
    assert!(session.metadata.topic_tags.is_empty());
    assert!(!graph
        .edges
        .iter()
        .any(|edge| edge.from == "project/p" && edge.to == "session/parent"));
    assert!(!graph
        .edges
        .iter()
        .any(|edge| edge.kind == JourneyEdgeKind::NextTurn));
}

#[test]
fn query_scope_rejects_everything_except_project_or_session() {
    assert!(matches!(
        JourneyScope::parse("project/p"),
        Ok(JourneyScope::Project(_))
    ));
    assert!(matches!(
        JourneyScope::parse("session/s"),
        Ok(JourneyScope::Session(_))
    ));
    assert!(JourneyScope::parse("project/").is_err());
    assert!(JourneyScope::parse("project/p/child").is_err());
    assert!(JourneyScope::parse("file/a").is_err());
}

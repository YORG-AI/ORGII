use crate::journey::{CanonicalJourneyInput, CoverageEntry, CoverageStatus, JourneyGraph};
use std::collections::HashSet;

#[derive(Debug, Clone)]
pub struct JourneyAuditReport {
    pub coverage: Vec<CoverageEntry>,
    pub trustworthy: bool,
}

/// Re-enumerates canonical input units; projector coverage labels are intentionally ignored.
pub fn audit_canonical_journey(
    input: &CanonicalJourneyInput,
    graph: &JourneyGraph,
) -> JourneyAuditReport {
    let represented: HashSet<_> = graph
        .nodes
        .iter()
        .map(|n| n.source_ref.as_str())
        .chain(graph.edges.iter().map(|e| e.source_ref.as_str()))
        .collect();
    let sources = input
        .projects
        .iter()
        .map(|x| x.source_ref.as_str())
        .chain(input.work_items.iter().map(|x| x.source_ref.as_str()))
        .chain(input.sessions.iter().map(|x| x.source_ref.as_str()))
        .chain(input.turns.iter().map(|x| x.source_ref.as_str()))
        .chain(input.artifacts.iter().map(|x| x.source_ref.as_str()))
        .chain(input.commits.iter().map(|x| x.source_ref.as_str()));
    let coverage: Vec<_> = sources
        .map(|source_ref| CoverageEntry {
            source_ref: source_ref.to_owned(),
            status: if represented.contains(source_ref) {
                CoverageStatus::Represented
            } else {
                CoverageStatus::Uncovered
            },
        })
        .collect();
    let trustworthy = coverage
        .iter()
        .all(|entry| !matches!(entry.status, CoverageStatus::Uncovered));
    JourneyAuditReport {
        coverage,
        trustworthy,
    }
}

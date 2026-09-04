//! Task-graph dependency integrity: dangling `blocked_by`/`blocks` edges and
//! persisted cycles, reported as coordinator repair reasons plus facts.

use super::super::*;
use super::facts::RecoveryRepairFact;

pub(super) fn append_dependency_integrity_repairs(
    tasks: &[Task],
    reasons: &mut Vec<String>,
    facts: &mut Vec<RecoveryRepairFact>,
) {
    let known_ids = tasks
        .iter()
        .map(|task| task.id.as_str())
        .collect::<HashSet<_>>();
    let mut missing_edges = Vec::<(String, String, String)>::new();
    for task in tasks {
        for blocker_id in &task.blocked_by {
            if !known_ids.contains(blocker_id.as_str()) {
                missing_edges.push((
                    "blocked_by".to_string(),
                    task.id.clone(),
                    blocker_id.clone(),
                ));
            }
        }
        for downstream_id in &task.blocks {
            if !known_ids.contains(downstream_id.as_str()) {
                missing_edges.push(("blocks".to_string(), task.id.clone(), downstream_id.clone()));
            }
        }
    }
    missing_edges.sort();
    missing_edges.dedup();
    if !missing_edges.is_empty() {
        let mut hasher = blake3::Hasher::new();
        hasher.update(b"agent-org-missing-dependency-edges-v1");
        for (relation, task_id, missing_id) in &missing_edges {
            for field in [relation, task_id, missing_id] {
                hasher.update(&(field.len() as u64).to_le_bytes());
                hasher.update(field.as_bytes());
            }
        }
        facts.push(RecoveryRepairFact::new(
            "missing_dependency_edges",
            [
                Some(missing_edges.len().to_string()),
                Some(hasher.finalize().to_hex().to_string()),
            ],
        ));
        let preview = missing_edges
            .iter()
            .take(8)
            .map(|(relation, task_id, missing_id)| {
                format!("{task_id}.{relation} -> missing task {missing_id}")
            })
            .collect::<Vec<_>>()
            .join("; ");
        let remainder = missing_edges.len().saturating_sub(8);
        reasons.push(format!(
            "the task graph contains {} dependency reference(s) to task ids that do not exist: {}{}. Repair those persisted edges before continuing; the watchdog will not guess which task was intended.",
            missing_edges.len(),
            preview,
            if remainder > 0 {
                format!("; +{remainder} more (use task_list/task_get)")
            } else {
                String::new()
            }
        ));
    }

    let Some(run_id) = tasks.first().map(|task| task.org_run_id.as_str()) else {
        return;
    };
    if let Err(error) = agent_org_tasks::validate_dependency_graph(tasks, run_id) {
        let mut edges = tasks
            .iter()
            .flat_map(|task| {
                task.blocked_by
                    .iter()
                    .map(move |blocker| (task.id.clone(), blocker.clone()))
            })
            .collect::<Vec<_>>();
        edges.sort();
        edges.dedup();
        let mut hasher = blake3::Hasher::new();
        hasher.update(b"agent-org-dependency-cycle-v1");
        for (task_id, blocker_id) in &edges {
            for field in [task_id, blocker_id] {
                hasher.update(&(field.len() as u64).to_le_bytes());
                hasher.update(field.as_bytes());
            }
        }
        facts.push(RecoveryRepairFact::new(
            "dependency_cycle",
            [Some(hasher.finalize().to_hex().to_string())],
        ));
        reasons.push(format!(
            "the persisted task dependency graph contains a cycle ({}). Break the cycle explicitly before continuing; cyclic tasks can never become ready.",
            crate::utils::safe_truncate_chars_to_string(&error, 2_000)
        ));
    }
}

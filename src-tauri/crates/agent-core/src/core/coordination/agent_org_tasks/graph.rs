use std::collections::{HashMap, HashSet};

use super::{Task, TASK_DEPENDENCY_CYCLE_ERROR};

/// One canonical dependency projection for an already-loaded task board.
///
/// `blocked_by` is the authoritative direction. Historical rows may contain
/// only the reciprocal `blocks` field, so construction folds those legacy
/// edges into `blocked_by` once and derives `blocks` from the result. All
/// readiness consumers should share this index instead of re-scanning the
/// full board with subtly different predicates.
#[derive(Debug, Clone)]
pub struct TaskGraphIndex {
    blocked_by: HashMap<String, Vec<String>>,
    blocks: HashMap<String, Vec<String>>,
    resolved_ids: HashSet<String>,
    known_ids: HashSet<String>,
}

impl TaskGraphIndex {
    pub fn new(tasks: &[Task]) -> Self {
        let known_ids = tasks
            .iter()
            .map(|task| task.id.clone())
            .collect::<HashSet<_>>();
        let resolved_ids = tasks
            .iter()
            .filter(|task| task.status.is_resolved())
            .map(|task| task.id.clone())
            .collect::<HashSet<_>>();
        let mut blocked_by = tasks
            .iter()
            .map(|task| (task.id.clone(), dedupe_ids(&task.blocked_by)))
            .collect::<HashMap<_, _>>();

        // Compatibility for historical rows that persisted only the reverse
        // edge. Unknown downstream ids remain a graph validation concern; a
        // projection cannot attach them to a task row that does not exist.
        for task in tasks {
            for downstream_id in &task.blocks {
                if known_ids.contains(downstream_id) {
                    push_unique(
                        blocked_by.entry(downstream_id.clone()).or_default(),
                        task.id.clone(),
                    );
                }
            }
        }

        let mut blocks = known_ids
            .iter()
            .map(|task_id| (task_id.clone(), Vec::new()))
            .collect::<HashMap<_, _>>();
        for (downstream_id, blocker_ids) in &blocked_by {
            for blocker_id in blocker_ids {
                if known_ids.contains(blocker_id) {
                    push_unique(
                        blocks.entry(blocker_id.clone()).or_default(),
                        downstream_id.clone(),
                    );
                }
            }
        }

        Self {
            blocked_by,
            blocks,
            resolved_ids,
            known_ids,
        }
    }

    pub fn blocked_by(&self, task_id: &str) -> &[String] {
        self.blocked_by
            .get(task_id)
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }

    pub fn blocks(&self, task_id: &str) -> &[String] {
        self.blocks.get(task_id).map(Vec::as_slice).unwrap_or(&[])
    }

    pub fn unresolved_blockers(&self, task_id: &str) -> Vec<String> {
        self.blocked_by(task_id)
            .iter()
            .filter(|blocker_id| !self.resolved_ids.contains(blocker_id.as_str()))
            .cloned()
            .collect()
    }

    pub fn is_ready(&self, task: &Task) -> bool {
        self.known_ids.contains(&task.id)
            && task.status == super::TaskStatus::Pending
            && self.unresolved_blockers(&task.id).is_empty()
    }

    pub fn apply_projection(&self, tasks: &mut [Task]) {
        for task in tasks {
            task.blocked_by = self.blocked_by(&task.id).to_vec();
            task.blocks = self.blocks(&task.id).to_vec();
        }
    }

    pub fn dependency_closure(&self, task_ids: &[String]) -> HashSet<String> {
        let mut covered = HashSet::new();
        let mut pending = task_ids.to_vec();
        while let Some(task_id) = pending.pop() {
            if !covered.insert(task_id.clone()) {
                continue;
            }
            pending.extend(self.blocked_by(&task_id).iter().cloned());
        }
        covered
    }
}

fn dedupe_ids(values: &[String]) -> Vec<String> {
    let mut out = Vec::with_capacity(values.len());
    for value in values {
        push_unique(&mut out, value.clone());
    }
    out
}

fn push_unique(values: &mut Vec<String>, value: String) {
    if !values.iter().any(|existing| existing == &value) {
        values.push(value);
    }
}

pub(crate) fn validate_dependency_graph(tasks: &[Task], org_run_id: &str) -> Result<(), String> {
    let mut graph: HashMap<String, Vec<String>> = HashMap::new();
    for task in tasks {
        if task.org_run_id != org_run_id {
            continue;
        }
        if task.blocks.iter().any(|id| id == &task.id)
            || task.blocked_by.iter().any(|id| id == &task.id)
        {
            return Err(format!(
                "{TASK_DEPENDENCY_CYCLE_ERROR}: task '{}' cannot depend on itself",
                task.id
            ));
        }
        add_dependency_edges(&mut graph, &task.id, &task.blocks, &task.blocked_by);
    }
    reject_dependency_cycle(&graph)
}

pub(super) fn add_dependency_edges(
    graph: &mut HashMap<String, Vec<String>>,
    task_id: &str,
    blocks: &[String],
    blocked_by: &[String],
) {
    graph.entry(task_id.to_string()).or_default();
    for blocker_id in blocked_by {
        graph
            .entry(task_id.to_string())
            .or_default()
            .push(blocker_id.clone());
        graph.entry(blocker_id.clone()).or_default();
    }
    for downstream_id in blocks {
        graph
            .entry(downstream_id.clone())
            .or_default()
            .push(task_id.to_string());
        graph.entry(task_id.to_string()).or_default();
    }
}

pub(super) fn reject_dependency_cycle(graph: &HashMap<String, Vec<String>>) -> Result<(), String> {
    let mut visiting = HashSet::new();
    let mut visited = HashSet::new();
    let mut stack = Vec::new();
    for node in graph.keys() {
        visit_dependency_node(graph, node, &mut visiting, &mut visited, &mut stack)?;
    }
    Ok(())
}

pub(super) fn visit_dependency_node(
    graph: &HashMap<String, Vec<String>>,
    node: &str,
    visiting: &mut HashSet<String>,
    visited: &mut HashSet<String>,
    stack: &mut Vec<String>,
) -> Result<(), String> {
    if visited.contains(node) {
        return Ok(());
    }
    if visiting.contains(node) {
        let start = stack.iter().position(|item| item == node).unwrap_or(0);
        let mut cycle = stack[start..].to_vec();
        cycle.push(node.to_string());
        return Err(format!(
            "{TASK_DEPENDENCY_CYCLE_ERROR}: {}",
            cycle.join(" -> ")
        ));
    }

    visiting.insert(node.to_string());
    stack.push(node.to_string());
    if let Some(next_nodes) = graph.get(node) {
        for next_node in next_nodes {
            visit_dependency_node(graph, next_node, visiting, visited, stack)?;
        }
    }
    stack.pop();
    visiting.remove(node);
    visited.insert(node.to_string());
    Ok(())
}

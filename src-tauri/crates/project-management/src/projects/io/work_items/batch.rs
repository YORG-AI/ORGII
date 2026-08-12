//! Batch operations for work items: bulk delete + bulk partial update.
//!
//! Both calls fan out to the single-row primitives but hoist the
//! shared lookup work (project name, label/member resolution maps) out
//! of the loop so an N-item batch reads labels/members exactly once
//! instead of N times. The result types are partial — successful items
//! and per-item errors come back together so the frontend can render
//! both halves of an "updated 18 of 20, 2 failed" toast in one IPC
//! roundtrip.
//!
//! Errors are localized: a failure on item K does NOT abort the batch.
//! This is intentional and mirrors the legacy contract; callers that
//! need all-or-nothing semantics should compose the single-item ops
//! inside their own transaction.

use std::collections::HashMap;

use super::atomic::update_work_item_partial;
use super::crud::delete_work_item;
use super::enrichment::enrich_work_item;
use crate::projects::io::labels::read_labels;
use crate::projects::io::members::read_members;
use crate::projects::io::projects::read_project;
use crate::projects::types::{
    BatchDeleteResult, BatchItemError, BatchUpdateResult, EnrichedWorkItem, LabelEntry,
    MemberEntry, WorkItemPartialUpdate,
};

/// Batch-delete N work items by short ID. Each delete runs as its own
/// transaction (no global rollback); successes and per-item errors are
/// returned side by side.
pub fn batch_delete_work_items(
    project_slug: &str,
    short_ids: Vec<String>,
) -> Result<BatchDeleteResult, String> {
    let mut deleted = Vec::with_capacity(short_ids.len());
    let mut errors = Vec::new();

    for short_id in short_ids {
        match delete_work_item(project_slug, &short_id) {
            Ok(()) => deleted.push(short_id),
            Err(error) => errors.push(BatchItemError { short_id, error }),
        }
    }

    Ok(BatchDeleteResult { deleted, errors })
}

/// Batch-apply the same partial patch to N work items, returning the
/// enriched result for every success.
///
/// Lookup maps (labels, members, project name) are loaded once before
/// the loop. Each item still goes through its own atomic RMW
/// transaction — that's a per-item write lock, not a single batch lock,
/// matching legacy semantics. Concurrent batches against disjoint
/// items therefore parallelize at the SQLite layer.
pub fn batch_update_work_items(
    project_slug: &str,
    short_ids: Vec<String>,
    updates: WorkItemPartialUpdate,
) -> Result<BatchUpdateResult, String> {
    let project = read_project(project_slug)?;
    let project_id = project.meta.id.clone();
    let project_name = Some(project.meta.name);

    let labels = read_labels(&project_id)?.labels;
    let members = read_members(&project_id)?.members;
    let label_map: HashMap<String, &LabelEntry> = labels
        .iter()
        .map(|entry| (entry.id.clone(), entry))
        .collect();
    let member_map: HashMap<String, &MemberEntry> = members
        .iter()
        .map(|entry| (entry.id.clone(), entry))
        .collect();

    let mut updated: Vec<EnrichedWorkItem> = Vec::with_capacity(short_ids.len());
    let mut errors = Vec::new();

    for short_id in short_ids {
        match update_work_item_partial(project_slug, &short_id, &updates) {
            Ok(data) => updated.push(enrich_work_item(
                data,
                &label_map,
                &member_map,
                project_slug,
                &project_name,
            )),
            Err(error) => errors.push(BatchItemError { short_id, error }),
        }
    }

    Ok(BatchUpdateResult { updated, errors })
}

#[cfg(test)]
#[allow(clippy::field_reassign_with_default)]
// Batch tests construct sparse updates incrementally for scenario readability.
mod tests {
    use super::*;
    use crate::projects::io::labels::write_labels;
    use crate::projects::io::projects::write_project;
    use crate::projects::io::work_items::write_work_item;
    use crate::projects::types::{LabelsFile, ProjectMeta, WorkItemFrontmatter};
    use test_helpers::test_env;

    fn project_meta() -> ProjectMeta {
        ProjectMeta {
            id: "p1".to_string(),
            name: "Demo".to_string(),
            org_id: "personal-org".to_string(),
            status: "active".to_string(),
            priority: "none".to_string(),
            health: "no_updates".to_string(),
            lead: None,
            members: vec![],
            labels: vec![],
            linked_repos: vec![],
            start_date: None,
            target_date: None,
            created_at: String::new(),
            updated_at: String::new(),
            next_work_item_id: 1,
            work_item_prefix: "AAA".to_string(),
            work_item_prefix_custom: true,
            agent_defaults: None,
        }
    }

    fn work_item(short_id: &str, title: &str) -> WorkItemFrontmatter {
        WorkItemFrontmatter {
            id: format!("w-{}", short_id),
            short_id: short_id.into(),
            title: title.into(),
            project: None,
            status: "backlog".into(),
            priority: "none".into(),
            assignee: None,
            assignee_type: None,
            labels: vec![],
            milestone: None,
            parent: None,
            stage: None,
            start_date: None,
            target_date: None,
            created_by: None,
            created_at: String::new(),
            updated_at: String::new(),
            deleted_at: None,
            starred: false,
            todos: vec![],
            comments: vec![],
            history: vec![],
            delegations: vec![],
            linked_sessions: vec![],
            handoff: None,
            proof_of_work: None,
            orchestrator_config: None,
            orchestrator_state: None,
            follow_up_items: vec![],
            schedule: None,
            routine_source: None,
            execution_lock: None,
            close_out: None,
            work_products: vec![],
        }
    }

    fn seed_three_items() {
        write_project("demo", &project_meta(), "", true).expect("project");
        for short_id in ["AAA-0001", "AAA-0002", "AAA-0003"] {
            write_work_item("demo", short_id, &work_item(short_id, short_id), "")
                .expect("seed item");
        }
    }

    #[test]
    fn batch_delete_returns_per_item_results() {
        let _sandbox = test_env::sandbox();
        seed_three_items();

        let result = batch_delete_work_items(
            "demo",
            vec!["AAA-0001".into(), "AAA-0002".into(), "GHOST-9999".into()],
        )
        .expect("batch");

        assert_eq!(result.deleted.len(), 2);
        assert!(result.deleted.contains(&"AAA-0001".to_string()));
        assert!(result.deleted.contains(&"AAA-0002".to_string()));
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].short_id, "GHOST-9999");
    }

    #[test]
    fn batch_delete_does_not_short_circuit_on_first_error() {
        // First ID is a ghost, but the second + third must still
        // succeed — no all-or-nothing rollback at the batch layer.
        let _sandbox = test_env::sandbox();
        seed_three_items();

        let result = batch_delete_work_items(
            "demo",
            vec!["GHOST-0001".into(), "AAA-0002".into(), "AAA-0003".into()],
        )
        .expect("batch");

        assert_eq!(
            result.deleted,
            vec!["AAA-0002".to_string(), "AAA-0003".into()]
        );
        assert_eq!(result.errors.len(), 1);
    }

    #[test]
    fn batch_update_applies_same_patch_to_all_items_and_enriches() {
        let _sandbox = test_env::sandbox();
        seed_three_items();
        write_labels(
            "p1",
            &LabelsFile {
                labels: vec![LabelEntry {
                    id: "rush".into(),
                    name: "Rush".into(),
                    color: "#ff0".into(),
                }],
            },
        )
        .expect("labels");

        let mut updates = WorkItemPartialUpdate::default();
        updates.status = Some("in_progress".into());
        updates.labels = Some(vec!["rush".into()]);

        let result =
            batch_update_work_items("demo", vec!["AAA-0001".into(), "AAA-0002".into()], updates)
                .expect("batch");

        assert_eq!(result.updated.len(), 2);
        assert!(result.errors.is_empty());
        for item in &result.updated {
            assert_eq!(item.status, "in_progress");
            assert_eq!(item.labels.len(), 1);
            assert_eq!(item.labels[0].name, "Rush");
        }
    }

    #[test]
    fn batch_update_collects_errors_for_unknown_ids() {
        let _sandbox = test_env::sandbox();
        seed_three_items();

        let mut updates = WorkItemPartialUpdate::default();
        updates.starred = Some(true);

        let result = batch_update_work_items(
            "demo",
            vec!["AAA-0001".into(), "GHOST".into(), "AAA-0003".into()],
            updates,
        )
        .expect("batch");

        assert_eq!(result.updated.len(), 2);
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].short_id, "GHOST");
        for item in &result.updated {
            assert!(item.starred);
        }
    }

    #[test]
    fn batch_update_unknown_project_errors_at_top_level() {
        // Top-level project lookup is not a per-item failure — if the
        // project itself is missing we can't even build lookup maps,
        // so the whole call returns Err.
        let _sandbox = test_env::sandbox();
        let mut updates = WorkItemPartialUpdate::default();
        updates.starred = Some(true);

        let err = batch_update_work_items("ghost", vec!["AAA-0001".into()], updates).unwrap_err();
        assert!(err.to_lowercase().contains("ghost"));
    }

    #[test]
    fn batch_update_with_empty_id_list_is_a_noop() {
        let _sandbox = test_env::sandbox();
        seed_three_items();

        let result = batch_update_work_items("demo", vec![], WorkItemPartialUpdate::default())
            .expect("batch");
        assert!(result.updated.is_empty());
        assert!(result.errors.is_empty());
    }
}

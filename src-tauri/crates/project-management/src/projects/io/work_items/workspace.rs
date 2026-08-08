//! Workspace-level work-item aggregation.
//!
//! This is intentionally one blocking backend operation. The previous
//! frontend path launched one Tauri command (and one SQLite connection) per
//! project, plus separate project/org/standalone reads.

use crate::projects::io::{read_all_projects_scoped, read_project_orgs};
use crate::projects::types::{
    WorkItemReadBucket, WorkspaceProjectWorkItems, WorkspaceWorkItemsData,
};

use super::{
    enrichment::enrich_work_items_for_project, read_all_work_items_scoped_filtered,
    read_standalone_work_items_filtered,
};

pub fn read_workspace_work_items_data(
    org_id: Option<&str>,
    read_bucket: Option<WorkItemReadBucket>,
) -> Result<WorkspaceWorkItemsData, String> {
    let projects = read_all_projects_scoped(org_id)?;
    let mut project_entries = Vec::with_capacity(projects.len());

    for project in projects {
        let raw_items = read_all_work_items_scoped_filtered(&project.slug, org_id, read_bucket)?;
        let work_items = enrich_work_items_for_project(&project, raw_items)?;
        project_entries.push(WorkspaceProjectWorkItems {
            project,
            work_items,
        });
    }

    Ok(WorkspaceWorkItemsData {
        project_entries,
        standalone_work_items: read_standalone_work_items_filtered(org_id, read_bucket)?,
        orgs: read_project_orgs()?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::projects::io::projects::write_project;
    use crate::projects::io::work_items::write_work_item;
    use crate::projects::types::{ProjectMeta, WorkItemFrontmatter};
    use test_helpers::test_env;

    fn project_fixture() -> ProjectMeta {
        ProjectMeta {
            id: "workspace-project".into(),
            name: "Workspace".into(),
            org_id: "personal-org".into(),
            status: "active".into(),
            priority: "none".into(),
            health: "no_updates".into(),
            lead: None,
            members: vec![],
            labels: vec![],
            linked_repos: vec![],
            start_date: None,
            target_date: None,
            created_at: String::new(),
            updated_at: String::new(),
            next_work_item_id: 1,
            work_item_prefix: "WSP".into(),
            work_item_prefix_custom: true,
            agent_defaults: None,
        }
    }

    fn work_item_fixture(short_id: &str, status: &str) -> WorkItemFrontmatter {
        WorkItemFrontmatter {
            id: format!("work-{short_id}"),
            short_id: short_id.into(),
            title: short_id.into(),
            project: None,
            status: status.into(),
            priority: "none".into(),
            assignee: None,
            assignee_type: None,
            labels: vec![],
            milestone: None,
            parent: None,
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
            handoff: None,
            linked_sessions: vec![],
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

    #[test]
    fn workspace_read_applies_the_bucket_across_projects() {
        let _sandbox = test_env::sandbox();
        write_project("workspace", &project_fixture(), "", true).expect("project");
        write_work_item(
            "workspace",
            "WSP-0001",
            &work_item_fixture("WSP-0001", "planned"),
            "",
        )
        .expect("active item");
        write_work_item(
            "workspace",
            "WSP-0002",
            &work_item_fixture("WSP-0002", "completed"),
            "",
        )
        .expect("completed item");

        let active = read_workspace_work_items_data(None, Some(WorkItemReadBucket::Active))
            .expect("active workspace data");
        assert_eq!(active.project_entries.len(), 1);
        assert_eq!(active.project_entries[0].work_items.len(), 1);
        assert_eq!(active.project_entries[0].work_items[0].status, "planned");

        let completed = read_workspace_work_items_data(None, Some(WorkItemReadBucket::Completed))
            .expect("completed workspace data");
        assert_eq!(completed.project_entries[0].work_items.len(), 1);
        assert_eq!(
            completed.project_entries[0].work_items[0].status,
            "completed"
        );
    }
}

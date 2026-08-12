use orgtrack_sync::{
    content_record_id, ApprovalState, ProjectRecord, SyncRecord, SyncRecordPayload, TrustLevel,
    WorkItemRecord,
};
use serde_json::json;

use crate::projects::types::{
    ProjectData, WorkItemData, WorkItemWorkProduct, WorkItemWorkProductType,
};

pub const PROJECT_RECORD_SCHEMA: &str = "orgtrack.project.v1";
pub const WORK_ITEM_RECORD_SCHEMA: &str = "orgtrack.workItem.v1";

pub fn project_sync_record(project: &ProjectData) -> Result<SyncRecord, String> {
    let payload = ProjectRecord {
        project_id: project.meta.id.clone(),
        repo_url: project.meta.linked_repos.first().cloned(),
        default_branch: None,
        title: project.meta.name.clone(),
        revision: project.meta.updated_at.clone(),
        base_revision: None,
        metadata: json!({
            "slug": project.slug,
            "description": project.description,
            "orgId": project.meta.org_id,
            "status": project.meta.status,
            "priority": project.meta.priority,
            "health": project.meta.health,
            "lead": project.meta.lead,
            "members": project.meta.members,
            "labels": project.meta.labels,
            "linkedRepos": project.meta.linked_repos,
            "startDate": project.meta.start_date,
            "targetDate": project.meta.target_date,
            "nextWorkItemId": project.meta.next_work_item_id,
            "workItemPrefix": project.meta.work_item_prefix,
            "workItemPrefixCustom": project.meta.work_item_prefix_custom,
            "agentDefaults": project.meta.agent_defaults,
            "createdAt": project.meta.created_at,
            "updatedAt": project.meta.updated_at,
        }),
    };
    sync_record(
        PROJECT_RECORD_SCHEMA,
        Some(project.meta.id.clone()),
        project.meta.updated_at.clone(),
        SyncRecordPayload::Project(payload),
    )
}

pub fn work_item_sync_record(work_item: &WorkItemData) -> Result<SyncRecord, String> {
    let linked_session_ids = work_item
        .frontmatter
        .linked_sessions
        .iter()
        .map(|session| session.session_id.clone())
        .collect();
    let linked_commit_shas = work_item
        .frontmatter
        .work_products
        .iter()
        .filter_map(commit_sha_from_work_product)
        .collect();
    let linked_pull_requests = work_item
        .frontmatter
        .work_products
        .iter()
        .filter_map(pull_request_id_from_work_product)
        .collect();
    let payload = WorkItemRecord {
        work_item_id: work_item.frontmatter.id.clone(),
        project_id: work_item.frontmatter.project.clone(),
        title: work_item.frontmatter.title.clone(),
        status: Some(work_item.frontmatter.status.clone()),
        revision: work_item.frontmatter.updated_at.clone(),
        base_revision: None,
        linked_session_ids,
        linked_commit_shas,
        linked_pull_requests,
        metadata: json!({
            "shortId": work_item.frontmatter.short_id,
            "filename": work_item.filename,
            "body": work_item.body,
            "priority": work_item.frontmatter.priority,
            "assignee": work_item.frontmatter.assignee,
            "assigneeType": work_item.frontmatter.assignee_type,
            "labels": work_item.frontmatter.labels,
            "milestone": work_item.frontmatter.milestone,
            "parent": work_item.frontmatter.parent,
            "startDate": work_item.frontmatter.start_date,
            "targetDate": work_item.frontmatter.target_date,
            "createdBy": work_item.frontmatter.created_by,
            "createdAt": work_item.frontmatter.created_at,
            "updatedAt": work_item.frontmatter.updated_at,
            "deletedAt": work_item.frontmatter.deleted_at,
            "starred": work_item.frontmatter.starred,
            "todos": work_item.frontmatter.todos,
            "comments": work_item.frontmatter.comments,
            "history": work_item.frontmatter.history,
            "delegations": work_item.frontmatter.delegations,
            "proofOfWork": work_item.frontmatter.proof_of_work,
            "orchestratorConfig": work_item.frontmatter.orchestrator_config,
            "orchestratorState": work_item.frontmatter.orchestrator_state,
            "followUpItems": work_item.frontmatter.follow_up_items,
            "schedule": work_item.frontmatter.schedule,
            "routineSource": work_item.frontmatter.routine_source,
            "executionLock": work_item.frontmatter.execution_lock,
            "closeOut": work_item.frontmatter.close_out,
            "workProducts": work_item.frontmatter.work_products,
        }),
    };
    sync_record(
        WORK_ITEM_RECORD_SCHEMA,
        Some(work_item.frontmatter.id.clone()),
        work_item.frontmatter.updated_at.clone(),
        SyncRecordPayload::WorkItem(payload),
    )
}

pub fn project_with_work_items_sync_records(
    project: &ProjectData,
    work_items: &[WorkItemData],
) -> Result<Vec<SyncRecord>, String> {
    let mut records = vec![project_sync_record(project)?];
    for work_item in work_items {
        records.push(work_item_sync_record(work_item)?);
    }
    Ok(records)
}

fn sync_record(
    schema: &str,
    entity_id: Option<String>,
    created_at: String,
    payload: SyncRecordPayload,
) -> Result<SyncRecord, String> {
    let record_id = content_record_id(schema, &payload)
        .map_err(|err| format!("create project sync record id: {err}"))?;
    Ok(SyncRecord {
        schema: schema.to_string(),
        record_id,
        entity_id,
        approval_state: ApprovalState::ApprovalPending,
        trust_level: TrustLevel::LocalDraft,
        actor_id: None,
        source_ref: None,
        created_at,
        payload,
    })
}

fn commit_sha_from_work_product(work_product: &WorkItemWorkProduct) -> Option<String> {
    if !matches!(work_product.product_type, WorkItemWorkProductType::Commit) {
        return None;
    }
    work_product
        .external_id
        .clone()
        .or_else(|| Some(work_product.title.clone()))
}

fn pull_request_id_from_work_product(work_product: &WorkItemWorkProduct) -> Option<String> {
    if !matches!(
        work_product.product_type,
        WorkItemWorkProductType::PullRequest
    ) {
        return None;
    }
    work_product
        .external_id
        .clone()
        .or_else(|| work_product.url.clone())
        .or_else(|| Some(work_product.id.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::projects::types::{ProjectMeta, WorkItemFrontmatter};

    #[test]
    fn exports_project_and_work_item_records() {
        let project = ProjectData {
            meta: ProjectMeta {
                id: "project-1".to_string(),
                name: "Demo".to_string(),
                org_id: "personal-org".to_string(),
                status: "active".to_string(),
                priority: "none".to_string(),
                health: "no_updates".to_string(),
                lead: None,
                members: Vec::new(),
                labels: Vec::new(),
                linked_repos: vec!["https://github.com/org/repo".to_string()],
                start_date: None,
                target_date: None,
                created_at: "2026-06-15T00:00:00Z".to_string(),
                updated_at: "2026-06-15T01:00:00Z".to_string(),
                next_work_item_id: 2,
                work_item_prefix: "DEM".to_string(),
                work_item_prefix_custom: false,
                agent_defaults: None,
            },
            description: "Project body".to_string(),
            slug: "demo".to_string(),
            sync_adapter_id: None,
        };
        let work_item = WorkItemData {
            frontmatter: WorkItemFrontmatter {
                id: "work-item-1".to_string(),
                short_id: "DEM-0001".to_string(),
                title: "Build sync".to_string(),
                project: Some("project-1".to_string()),
                status: "in_progress".to_string(),
                priority: "none".to_string(),
                assignee: None,
                assignee_type: None,
                labels: Vec::new(),
                milestone: None,
                parent: None,
                stage: None,
                start_date: None,
                target_date: None,
                created_by: None,
                created_at: "2026-06-15T00:00:00Z".to_string(),
                updated_at: "2026-06-15T01:00:00Z".to_string(),
                deleted_at: None,
                starred: false,
                todos: Vec::new(),
                comments: Vec::new(),
                history: Vec::new(),
                delegations: Vec::new(),
                linked_sessions: Vec::new(),
                handoff: None,
                proof_of_work: None,
                orchestrator_config: None,
                orchestrator_state: None,
                follow_up_items: Vec::new(),
                schedule: None,
                routine_source: None,
                execution_lock: None,
                close_out: None,
                work_products: Vec::new(),
            },
            body: "Work item body".to_string(),
            filename: "DEM-0001".to_string(),
        };

        let records = project_with_work_items_sync_records(&project, &[work_item])
            .expect("export project records");

        assert_eq!(records.len(), 2);
        assert!(matches!(records[0].payload, SyncRecordPayload::Project(_)));
        assert!(matches!(records[1].payload, SyncRecordPayload::WorkItem(_)));
    }
}

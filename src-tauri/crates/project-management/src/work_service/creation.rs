use crate::projects::io as project_io;
use crate::projects::types::{
    LinkedSession, OrchestratorConfig, TodoEntry, WorkItemData, WorkItemFrontmatter,
    WorkItemHandoff, WorkItemMutationActor, WorkItemOriginSession, WorkItemSchedule,
};

use super::{audit, error};

/// Creation DTO for the canonical `work.create` application operation.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorkItemRequest {
    pub title: String,
    #[serde(default)]
    pub body: String,
    pub project_id: Option<String>,
    pub status: Option<String>,
    pub priority: Option<String>,
    pub assignee: Option<String>,
    pub assignee_type: Option<String>,
    #[serde(default)]
    pub labels: Vec<String>,
    pub milestone: Option<String>,
    pub parent: Option<String>,
    #[serde(default)]
    pub stage: Option<u32>,
    pub start_date: Option<String>,
    pub target_date: Option<String>,
    pub created_by: Option<String>,
    /// Immutable provenance for an agent turn that created this item.
    pub origin_session: Option<WorkItemOriginSession>,
    #[serde(default)]
    pub starred: bool,
    pub schedule: Option<WorkItemSchedule>,
    pub orchestrator_config: Option<OrchestratorConfig>,
    /// Optional parsed checklist written atomically with creation.
    #[serde(default)]
    pub todos: Vec<TodoEntry>,
    /// Optional human handoff written atomically with initial assignment.
    pub handoff: Option<WorkItemHandoff>,
    /// Durable session provenance written in the same operation.
    #[serde(default)]
    pub linked_sessions: Vec<LinkedSession>,
}

pub(crate) fn build_frontmatter_for_graph(
    short_id: &str,
    request: &CreateWorkItemRequest,
) -> WorkItemFrontmatter {
    build_frontmatter(short_id, request)
}

fn build_frontmatter(short_id: &str, request: &CreateWorkItemRequest) -> WorkItemFrontmatter {
    let now = chrono::Utc::now().to_rfc3339();
    WorkItemFrontmatter {
        id: short_id.to_string(),
        short_id: short_id.to_string(),
        title: request.title.clone(),
        project: request.project_id.clone(),
        status: request
            .status
            .clone()
            .unwrap_or_else(|| "backlog".to_string()),
        priority: request
            .priority
            .clone()
            .unwrap_or_else(|| "none".to_string()),
        assignee: request.assignee.clone(),
        assignee_type: request.assignee_type.clone(),
        labels: request.labels.clone(),
        milestone: request.milestone.clone(),
        parent: request.parent.clone(),
        stage: request.stage,
        start_date: request.start_date.clone(),
        target_date: request.target_date.clone(),
        created_by: request.created_by.clone(),
        origin_session: request.origin_session.clone(),
        created_at: now.clone(),
        updated_at: now,
        deleted_at: None,
        starred: request.starred,
        todos: request.todos.clone(),
        comments: vec![],
        history: vec![],
        delegations: vec![],
        linked_sessions: request.linked_sessions.clone(),
        handoff: request.handoff.clone(),
        proof_of_work: None,
        orchestrator_config: request.orchestrator_config.clone(),
        orchestrator_state: None,
        follow_up_items: vec![],
        schedule: request.schedule.clone(),
        routine_source: None,
        execution_lock: None,
        close_out: None,
        work_products: vec![],
    }
}

/// Refuse creation when the globally keyed Work Item id already exists.
pub(crate) fn guard_new_work_item_id_in_tx(
    tx: &rusqlite::Transaction,
    short_id: &str,
) -> Result<(), String> {
    let count: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM workitems WHERE id = ?1",
            rusqlite::params![short_id],
            |row| row.get(0),
        )
        .map_err(|err| format!("work.create existence guard: {err}"))?;
    if count > 0 {
        return Err(error::already_exists(short_id));
    }
    Ok(())
}

pub(super) fn append_create_audit_in_tx(
    tx: &rusqlite::Transaction,
    entity_id: &str,
    project_slug: Option<&str>,
    org_id: Option<&str>,
    actor: Option<&WorkItemMutationActor>,
) -> Result<(), String> {
    let seq = audit::bump_change_seq(tx)?;
    audit::append_audit_event(
        tx,
        &audit::AuditEventRow {
            operation: "work.create",
            entity_type: "work_item",
            entity_id,
            project_slug,
            org_id,
            actor,
            revision: 0,
            seq,
            payload: serde_json::json!({}),
        },
    )
}

/// Canonical `work.create` for a project-scoped item.
pub fn create_project_work_item(
    project_slug: &str,
    short_id: &str,
    request: &CreateWorkItemRequest,
    actor: Option<&WorkItemMutationActor>,
) -> Result<WorkItemData, String> {
    let frontmatter = build_frontmatter(short_id, request);
    let mut connection = project_io::helpers::conn()?;
    let tx = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|err| format!("work.create tx: {err}"))?;
    let (project_id, org_id) = project_io::resolve_project_scope_in_tx(&tx, project_slug)?;
    guard_new_work_item_id_in_tx(&tx, short_id)?;
    project_io::write_work_item_in_tx(
        &tx,
        Some(project_id),
        &org_id,
        short_id,
        &frontmatter,
        &request.body,
        true,
    )?;
    append_create_audit_in_tx(&tx, short_id, Some(project_slug), None, actor)?;
    tx.commit()
        .map_err(|err| format!("work.create commit: {err}"))?;
    crate::projects::events::notify_work_item_schedule_changed();
    crate::sync::collab_bridge::record_work_item_write(
        &org_id,
        Some(project_slug),
        &frontmatter.id,
        false,
    )?;
    project_io::read_work_item(project_slug, short_id)
}

/// Current OCC revision (`local_version`) of a project-scoped item.
pub fn read_project_work_item_revision(project_slug: &str, short_id: &str) -> Result<i64, String> {
    let connection = project_io::helpers::conn()?;
    connection
        .query_row(
            "SELECT w.local_version FROM workitems w
             JOIN projects p ON p.id = w.project_id
             WHERE p.slug = ?1 AND w.short_id = ?2",
            rusqlite::params![project_slug, short_id],
            |row| row.get(0),
        )
        .map_err(|err| match err {
            rusqlite::Error::QueryReturnedNoRows => {
                format!("Work item '{}' not found", short_id)
            }
            other => format!("DB error: {}", other),
        })
}

/// Canonical `work.create` for an org-scoped standalone item.
pub fn create_standalone_work_item(
    org_id: Option<&str>,
    short_id: &str,
    request: &CreateWorkItemRequest,
    actor: Option<&WorkItemMutationActor>,
) -> Result<WorkItemData, String> {
    let resolved_org = org_id.unwrap_or("personal-org").to_string();
    let frontmatter = build_frontmatter(short_id, request);
    let mut connection = project_io::helpers::conn()?;
    let tx = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|err| format!("work.create tx: {err}"))?;
    guard_new_work_item_id_in_tx(&tx, short_id)?;
    project_io::write_work_item_in_tx(
        &tx,
        None,
        &resolved_org,
        short_id,
        &frontmatter,
        &request.body,
        true,
    )?;
    append_create_audit_in_tx(&tx, short_id, None, Some(&resolved_org), actor)?;
    tx.commit()
        .map_err(|err| format!("work.create commit: {err}"))?;
    crate::projects::events::notify_work_item_schedule_changed();
    crate::sync::collab_bridge::record_work_item_write(
        &resolved_org,
        None,
        &frontmatter.id,
        false,
    )?;
    project_io::read_standalone_work_item(org_id, short_id)
}

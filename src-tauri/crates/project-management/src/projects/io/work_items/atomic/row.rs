//! Row projection: the locked `workitems` row, its label set, and the
//! `WorkItemFrontmatter` rebuilt from row + extras.

use rusqlite::params;

use crate::projects::io::helpers::{map_db, to_iso8601};
use crate::projects::io::work_items::extras::ExtrasPayload;
use crate::projects::types::WorkItemFrontmatter;

pub(super) fn human_assignee_id(
    assignee: Option<&str>,
    assignee_type: Option<&str>,
) -> Option<String> {
    let assignee = assignee?.trim();
    if assignee.is_empty() {
        return None;
    }
    let is_human = assignee_type
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.eq_ignore_ascii_case("member") || value.eq_ignore_ascii_case("human"))
        .unwrap_or(true);
    is_human.then(|| assignee.to_string())
}

pub(super) struct AtomicCore {
    pub(super) work_item_id: String,
    pub(super) short_id: String,
    pub(super) title: String,
    pub(super) body: String,
    pub(super) status: String,
    pub(super) priority: String,
    pub(super) assignee: Option<String>,
    pub(super) assignee_type: Option<String>,
    pub(super) milestone: Option<String>,
    pub(super) parent: Option<String>,
    pub(super) start_date: Option<String>,
    pub(super) target_date: Option<String>,
    pub(super) created_at_ms: i64,
    pub(super) updated_at_ms: i64,
    pub(super) deleted_at_ms: Option<i64>,
    pub(super) local_version: i64,
    pub(super) org_id: String,
}

pub(super) fn read_labels_in_tx(
    tx: &rusqlite::Transaction<'_>,
    work_item_id: &str,
) -> Result<Vec<String>, String> {
    let mut stmt = map_db(tx.prepare(
        "SELECT label_id FROM workitem_labels WHERE work_item_id = ?1 ORDER BY label_id",
    ))?;
    let rows = map_db(stmt.query_map(params![work_item_id], |row| row.get::<_, String>(0)))?;
    let mut out = Vec::new();
    for entry in rows {
        out.push(map_db(entry)?);
    }
    Ok(out)
}

pub(super) fn build_frontmatter(
    project_id: Option<String>,
    core: &AtomicCore,
    labels: Vec<String>,
    extras: &ExtrasPayload,
) -> WorkItemFrontmatter {
    WorkItemFrontmatter {
        id: core.work_item_id.clone(),
        short_id: core.short_id.clone(),
        title: core.title.clone(),
        project: project_id,
        status: core.status.clone(),
        priority: core.priority.clone(),
        assignee: core.assignee.clone(),
        assignee_type: core.assignee_type.clone(),
        labels,
        milestone: core.milestone.clone(),
        parent: core.parent.clone(),
        stage: extras.stage,
        start_date: core.start_date.clone(),
        target_date: core.target_date.clone(),
        created_by: extras.created_by.clone(),
        origin_session: extras.origin_session.clone(),
        created_at: to_iso8601(core.created_at_ms),
        updated_at: to_iso8601(core.updated_at_ms),
        deleted_at: core.deleted_at_ms.map(to_iso8601),
        starred: extras.starred,
        todos: extras.todos.clone(),
        comments: extras.comments.clone(),
        history: extras.history.clone(),
        delegations: extras.delegations.clone(),
        handoff: extras.handoff.clone(),
        linked_sessions: extras.linked_sessions.clone(),
        proof_of_work: extras.proof_of_work.clone(),
        orchestrator_config: extras.orchestrator_config.clone(),
        orchestrator_state: extras.orchestrator_state.clone(),
        follow_up_items: extras.follow_up_items.clone(),
        schedule: extras.schedule.clone(),
        routine_source: extras.routine_source.clone(),
        execution_lock: extras.execution_lock.clone(),
        close_out: extras.close_out.clone(),
        work_products: extras.work_products.clone(),
    }
}

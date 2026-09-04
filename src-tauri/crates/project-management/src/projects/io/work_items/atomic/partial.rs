//! The wire-friendly `WorkItemPartialUpdate` patch wrappers: they turn a
//! sparse update struct into a mutator closure and run it through the
//! same atomic engine as the closure-form API.

use std::collections::HashMap;

use super::diff::{changed_fields_payload, touches_payload_tail};
use super::engine::update_work_item_atomic_with_revisions_scoped;
use super::scope::{AtomicServiceOptions, AtomicWorkItemScope};
use crate::projects::io::work_items::extras::FieldRevision;
use crate::projects::types::{WorkItemData, WorkItemPartialUpdate};

/// Apply a partial update and return the new `WorkItemData`.
///
/// Outbox emission: when the project is bound to a sync adapter,
/// every successful update appends one `update` outbox row carrying
/// the changed sync-tracked fields and their new values.
/// The merge cycle bypasses this (it calls
/// [`update_work_item_partial_with_revisions`] directly) so applying a
/// remote-driven change doesn't bounce back to the originating system
/// as a push.
pub fn update_work_item_partial(
    project_slug: &str,
    short_id: &str,
    updates: &WorkItemPartialUpdate,
) -> Result<WorkItemData, String> {
    let (data, changed_fields) =
        update_work_item_partial_with_revisions(project_slug, short_id, HashMap::new(), updates)?;
    if !changed_fields.is_empty() {
        let payload = changed_fields_payload(&data, &changed_fields);
        crate::sync::io::record_local_update(project_slug, short_id, &changed_fields, &payload)?;
    } else if touches_payload_tail(updates) {
        // Payload-tail-only patch (todos / comments / linked sessions /
        // orchestrator state / lock …): not covered by the sync-tracked
        // diff, but collab-synced orgs still need to push the row —
        // those fields travel in the server payload jsonb (design §16.3).
        crate::sync::collab_bridge::record_work_item_payload_touch(project_slug, short_id)?;
    }
    Ok(data)
}

/// Standalone-org counterpart to [`update_work_item_partial`].
///
/// The mutation shares the same `BEGIN IMMEDIATE` boundary, history writer,
/// assignment-receipt reset, and field-revision logic as project-scoped work
/// items. A single collaboration outbox write is emitted after commit so
/// teammates receive status, priority, assignment, todo, and comment changes
/// without a frontend read-modify-write race.
pub fn update_standalone_work_item_partial(
    org_id: Option<&str>,
    short_id: &str,
    updates: &WorkItemPartialUpdate,
) -> Result<WorkItemData, String> {
    let org_id = org_id.unwrap_or("personal-org");
    let (data, changed_fields, payload_tail_changed) = update_work_item_partial_scoped(
        AtomicWorkItemScope::Standalone { org_id },
        short_id,
        HashMap::new(),
        updates,
    )?;
    if !changed_fields.is_empty() || payload_tail_changed {
        crate::sync::collab_bridge::record_work_item_write(
            org_id,
            None,
            &data.frontmatter.id,
            data.frontmatter.deleted_at.is_some(),
        )?;
    }
    Ok(data)
}

/// Variant of [`update_work_item_partial`] that lets the caller supply
/// per-field revision overrides and returns the list of changed
/// sync-tracked fields alongside the updated data.
///
/// User-driven callsites should use [`update_work_item_partial`]; the
/// merge cycle uses this directly, passing
/// `ResolverDecision::new_revisions` so adopted fields are stamped
/// atomically with the field write.
pub fn update_work_item_partial_with_revisions(
    project_slug: &str,
    short_id: &str,
    override_revisions: HashMap<String, FieldRevision>,
    updates: &WorkItemPartialUpdate,
) -> Result<(WorkItemData, Vec<&'static str>), String> {
    let (data, changed_fields, _payload_tail_changed) = update_work_item_partial_scoped(
        AtomicWorkItemScope::Project(project_slug),
        short_id,
        override_revisions,
        updates,
    )?;
    Ok((data, changed_fields))
}

/// Standalone-org merge-cycle counterpart to
/// [`update_work_item_partial_with_revisions`].
///
/// This intentionally emits no outbox row: the caller is applying an inbound
/// remote snapshot and must not echo it back to the collaboration service.
pub(crate) fn update_standalone_work_item_partial_with_revisions(
    org_id: &str,
    short_id: &str,
    override_revisions: HashMap<String, FieldRevision>,
    updates: &WorkItemPartialUpdate,
) -> Result<(WorkItemData, Vec<&'static str>), String> {
    let (data, changed_fields, _payload_tail_changed) = update_work_item_partial_scoped(
        AtomicWorkItemScope::Standalone { org_id },
        short_id,
        override_revisions,
        updates,
    )?;
    Ok((data, changed_fields))
}

fn update_work_item_partial_scoped(
    scope: AtomicWorkItemScope<'_>,
    short_id: &str,
    override_revisions: HashMap<String, FieldRevision>,
    updates: &WorkItemPartialUpdate,
) -> Result<(WorkItemData, Vec<&'static str>, bool), String> {
    update_work_item_atomic_with_revisions_scoped(
        scope,
        short_id,
        override_revisions,
        updates.actor.as_ref(),
        AtomicServiceOptions::default(),
        |fm, body| {
            let now_iso = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();

            if let Some(title) = updates.title.as_ref() {
                fm.title = title.clone();
            }
            if let Some(new_body) = updates.body.as_ref() {
                *body = new_body.clone();
            }
            if let Some(status) = updates.status.as_ref() {
                fm.status = status.clone();
            }
            if let Some(priority) = updates.priority.as_ref() {
                fm.priority = priority.clone();
            }
            if let Some(project) = updates.project.as_ref() {
                fm.project = project.clone();
            }
            if let Some(starred) = updates.starred {
                fm.starred = starred;
            }
            if let Some(assignee) = updates.assignee.as_ref() {
                fm.assignee = assignee.clone();
            }
            if let Some(assignee_type) = updates.assignee_type.as_ref() {
                fm.assignee_type = assignee_type.clone();
            }
            if let Some(labels) = updates.labels.as_ref() {
                fm.labels = labels.clone();
            }
            if let Some(milestone) = updates.milestone.as_ref() {
                fm.milestone = milestone.clone();
            }
            if let Some(stage) = updates.stage.as_ref() {
                fm.stage = *stage;
            }
            if let Some(start_date) = updates.start_date.as_ref() {
                fm.start_date = start_date.clone();
            }
            if let Some(target_date) = updates.target_date.as_ref() {
                fm.target_date = target_date.clone();
            }
            if let Some(created_by) = updates.created_by.as_ref() {
                fm.created_by = Some(created_by.clone());
            }
            if let Some(todos) = updates.todos.as_ref() {
                fm.todos = todos.clone();
            }
            if let Some(comments) = updates.comments.as_ref() {
                fm.comments = comments.clone();
            }
            if let Some(handoff) = updates.handoff.as_ref() {
                fm.handoff = handoff.clone();
            }
            if let Some(linked_sessions) = updates.linked_sessions.as_ref() {
                fm.linked_sessions = linked_sessions.clone();
            }
            if let Some(orchestrator_config) = updates.orchestrator_config.as_ref() {
                fm.orchestrator_config = Some(orchestrator_config.clone());
            }
            if let Some(orchestrator_state) = updates.orchestrator_state.as_ref() {
                fm.orchestrator_state = Some(orchestrator_state.clone());
            }
            if let Some(schedule) = updates.schedule.as_ref() {
                fm.schedule = schedule.clone();
            }
            if let Some(execution_lock) = updates.execution_lock.as_ref() {
                fm.execution_lock = execution_lock.clone();
            }
            if let Some(close_out) = updates.close_out.as_ref() {
                fm.close_out = close_out.clone();
            }
            if let Some(work_products) = updates.work_products.as_ref() {
                fm.work_products = work_products.clone();
            }

            fm.updated_at = now_iso;

            Ok(WorkItemData {
                frontmatter: fm.clone(),
                body: body.clone(),
                filename: short_id.to_string(),
            })
        },
    )
}

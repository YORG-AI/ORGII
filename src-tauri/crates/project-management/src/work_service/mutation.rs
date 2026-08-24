use crate::projects::io as project_io;
use crate::projects::types::{WorkItemData, WorkItemFrontmatter, WorkItemMutationActor};

use super::creation::{append_create_audit_in_tx, guard_new_work_item_id_in_tx};
use super::lifecycle::guard_claim_holder;

/// OCC-capable non-lifecycle patch (`work.update` on the wire): title,
/// body and priority only — state changes stay with transition/claim.
#[allow(clippy::too_many_arguments)]
pub fn patch_project_work_item(
    project_slug: &str,
    short_id: &str,
    title: Option<&str>,
    body: Option<&str>,
    priority: Option<&str>,
    stage: Option<Option<u32>>,
    actor: Option<&WorkItemMutationActor>,
    expected_revision: Option<i64>,
    caller_session: Option<&str>,
) -> Result<WorkItemData, String> {
    let title_owned = title.map(str::to_string);
    let body_owned = body.map(str::to_string);
    let priority_owned = priority.map(str::to_string);
    let caller_owned = caller_session.map(str::to_string);
    project_io::update_work_item_atomic_serviced(
        project_slug,
        short_id,
        actor,
        project_io::AtomicServiceOptions {
            expected_local_version: expected_revision,
            operation: Some("work.update"),
            ..Default::default()
        },
        move |frontmatter, current_body| {
            guard_claim_holder(frontmatter, caller_owned.as_deref())?;
            if let Some(title) = title_owned {
                frontmatter.title = title;
            }
            if let Some(body) = body_owned {
                *current_body = body;
            }
            if let Some(priority) = priority_owned {
                frontmatter.priority = priority;
            }
            if let Some(stage) = stage {
                frontmatter.stage = stage;
            }
            frontmatter.updated_at = chrono::Utc::now().to_rfc3339();
            Ok(())
        },
    )?;
    project_io::read_work_item(project_slug, short_id)
}

/// Standalone counterpart of [`patch_project_work_item`].
#[allow(clippy::too_many_arguments)]
pub fn patch_standalone_work_item(
    org_id: Option<&str>,
    short_id: &str,
    title: Option<&str>,
    body: Option<&str>,
    priority: Option<&str>,
    stage: Option<Option<u32>>,
    actor: Option<&WorkItemMutationActor>,
) -> Result<WorkItemData, String> {
    let title_owned = title.map(str::to_string);
    let body_owned = body.map(str::to_string);
    let priority_owned = priority.map(str::to_string);
    project_io::update_standalone_work_item_atomic_by(
        org_id,
        actor,
        short_id,
        move |frontmatter, current_body| {
            if let Some(title) = title_owned {
                frontmatter.title = title;
            }
            if let Some(body) = body_owned {
                *current_body = body;
            }
            if let Some(priority) = priority_owned {
                frontmatter.priority = priority;
            }
            if let Some(stage) = stage {
                frontmatter.stage = stage;
            }
            frontmatter.updated_at = chrono::Utc::now().to_rfc3339();
            Ok(())
        },
    )?;
    project_io::read_standalone_work_item(org_id, short_id)
}

/// Audited assignment (`work.assign`): ownership only, no run trigger.
pub fn assign_project_work_item(
    project_slug: &str,
    short_id: &str,
    assignee: &str,
    assignee_type: Option<&str>,
    actor: Option<&WorkItemMutationActor>,
    expected_revision: Option<i64>,
) -> Result<WorkItemData, String> {
    let assignee_owned = assignee.to_string();
    let type_owned = assignee_type.map(str::to_string);
    project_io::update_work_item_atomic_serviced(
        project_slug,
        short_id,
        actor,
        project_io::AtomicServiceOptions {
            expected_local_version: expected_revision,
            operation: Some("work.assign"),
            ..Default::default()
        },
        move |frontmatter, _body| {
            frontmatter.assignee = Some(assignee_owned);
            if let Some(kind) = type_owned {
                frontmatter.assignee_type = Some(kind);
            }
            frontmatter.updated_at = chrono::Utc::now().to_rfc3339();
            Ok(())
        },
    )?;
    project_io::read_work_item(project_slug, short_id)
}

/// Audited whole-row overwrite for seed/E2E and remaining full-frontmatter
/// writers.
pub fn overwrite_project_work_item(
    project_slug: &str,
    short_id: &str,
    frontmatter: &WorkItemFrontmatter,
    body: &str,
    actor: Option<&WorkItemMutationActor>,
) -> Result<(), String> {
    if project_io::read_work_item(project_slug, short_id).is_ok() {
        let next_frontmatter = frontmatter.clone();
        let next_body = body.to_string();
        return project_io::update_work_item_atomic_serviced(
            project_slug,
            short_id,
            actor,
            project_io::AtomicServiceOptions {
                operation: Some("work.write"),
                ..Default::default()
            },
            move |current, current_body| {
                *current = next_frontmatter;
                *current_body = next_body;
                Ok(())
            },
        );
    }
    let mut connection = project_io::helpers::conn()?;
    let tx = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|err| format!("work.write tx: {err}"))?;
    let (project_id, org_id) = project_io::resolve_project_scope_in_tx(&tx, project_slug)?;
    guard_new_work_item_id_in_tx(&tx, short_id)?;
    project_io::write_work_item_in_tx(
        &tx,
        Some(project_id),
        &org_id,
        short_id,
        frontmatter,
        body,
        true,
    )?;
    append_create_audit_in_tx(&tx, short_id, Some(project_slug), None, actor)?;
    tx.commit()
        .map_err(|err| format!("work.write commit: {err}"))?;
    crate::projects::events::notify_work_item_schedule_changed();
    crate::sync::collab_bridge::record_work_item_write(
        &org_id,
        Some(project_slug),
        &frontmatter.id,
        frontmatter.deleted_at.is_some(),
    )
}

/// Standalone counterpart of [`overwrite_project_work_item`].
pub fn overwrite_standalone_work_item(
    org_id: Option<&str>,
    short_id: &str,
    frontmatter: &WorkItemFrontmatter,
    body: &str,
    actor: Option<&WorkItemMutationActor>,
) -> Result<(), String> {
    let resolved_org = org_id.unwrap_or("personal-org").to_string();
    if project_io::read_standalone_work_item(org_id, short_id).is_ok() {
        let next_frontmatter = frontmatter.clone();
        let next_body = body.to_string();
        project_io::update_standalone_work_item_atomic(
            org_id,
            short_id,
            move |current, current_body| {
                *current = next_frontmatter;
                *current_body = next_body;
                Ok(())
            },
        )?;
        let _ = actor;
        return Ok(());
    }
    let mut connection = project_io::helpers::conn()?;
    let tx = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|err| format!("work.write tx: {err}"))?;
    guard_new_work_item_id_in_tx(&tx, short_id)?;
    project_io::write_work_item_in_tx(&tx, None, &resolved_org, short_id, frontmatter, body, true)?;
    append_create_audit_in_tx(&tx, short_id, None, Some(&resolved_org), actor)?;
    tx.commit()
        .map_err(|err| format!("work.write commit: {err}"))?;
    crate::projects::events::notify_work_item_schedule_changed();
    crate::sync::collab_bridge::record_work_item_write(
        &resolved_org,
        None,
        &frontmatter.id,
        frontmatter.deleted_at.is_some(),
    )
}

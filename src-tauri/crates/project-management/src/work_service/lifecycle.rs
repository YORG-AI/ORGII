use crate::projects::io as project_io;
use crate::projects::types::{WorkItemData, WorkItemFrontmatter, WorkItemMutationActor};

use super::{error, state, WorkItemState};

/// A work item claimed by one session may not have its lifecycle or content
/// advanced by a different session. Human direct operation is exempt.
pub(super) fn guard_claim_holder(
    frontmatter: &WorkItemFrontmatter,
    caller_session: Option<&str>,
) -> Result<(), String> {
    let Some(caller) = caller_session else {
        return Ok(());
    };
    if let Some(holder) = frontmatter
        .execution_lock
        .as_ref()
        .and_then(|lock| lock.active_session_id.as_deref())
    {
        if holder != caller {
            return Err(format!(
                "Work item '{}' is claimed by another session: {}",
                frontmatter.short_id, holder
            ));
        }
    }
    Ok(())
}

/// Single-transaction `work.release`: only the claim holder may hand back
/// execution; the lock clears and the release edge returns the item to open.
pub fn release_project_work_item(
    project_slug: &str,
    short_id: &str,
    session_id: &str,
    actor: Option<&WorkItemMutationActor>,
) -> Result<WorkItemData, String> {
    let session_owned = session_id.to_string();
    project_io::update_work_item_atomic_serviced(
        project_slug,
        short_id,
        actor,
        project_io::AtomicServiceOptions {
            operation: Some("work.release"),
            reason: Some("released".to_string()),
            ..Default::default()
        },
        move |frontmatter, _body| {
            let holder = frontmatter
                .execution_lock
                .as_ref()
                .and_then(|lock| lock.active_session_id.clone());
            match holder {
                None => {
                    return Err(format!(
                        "Work item '{}' has no active claim to release",
                        frontmatter.short_id
                    ));
                }
                Some(active) if active != session_owned => {
                    return Err(format!(
                        "Work item '{}' is claimed by another session: {}",
                        frontmatter.short_id, active
                    ));
                }
                Some(_) => {}
            }
            frontmatter.execution_lock = None;
            let now = chrono::Utc::now().to_rfc3339();
            for linked in frontmatter.linked_sessions.iter_mut() {
                if linked.session_id == session_owned
                    && linked.status == crate::projects::types::LinkedSessionStatus::Running
                {
                    linked.status = crate::projects::types::LinkedSessionStatus::Cancelled;
                    linked.completed_at = Some(now.clone());
                }
            }
            if matches!(
                state::map_legacy_status(&frontmatter.status),
                Some(WorkItemState::InProgress)
            ) {
                frontmatter.status = "open".to_string();
            }
            frontmatter.updated_at = now;
            Ok(())
        },
    )?;
    project_io::read_work_item(project_slug, short_id)
}

/// Single-transaction `work.claim`: execution-lock acquisition and the
/// strict `open -> in_progress` transition commit together.
pub fn claim_project_work_item(
    project_slug: &str,
    short_id: &str,
    session_id: &str,
    agent_role: Option<&str>,
    reason: crate::projects::types::WorkItemExecutionLockReason,
    actor: Option<&WorkItemMutationActor>,
    expected_revision: Option<i64>,
) -> Result<WorkItemData, String> {
    let short_id_owned = short_id.to_string();
    let session_owned = session_id.to_string();
    let role_owned = agent_role.map(|value| value.to_string());
    project_io::update_work_item_atomic_serviced(
        project_slug,
        short_id,
        actor,
        project_io::AtomicServiceOptions {
            expected_local_version: expected_revision,
            operation: Some("work.claim"),
            strict_fsm: true,
            reason: Some("claimed".to_string()),
        },
        move |frontmatter, _body| {
            project_io::apply_execution_claim(
                frontmatter,
                &short_id_owned,
                &session_owned,
                role_owned.as_deref(),
                reason,
            )?;
            frontmatter.status = "in_progress".to_string();
            Ok(())
        },
    )?;
    project_io::read_work_item(project_slug, short_id)
}

/// Standalone-org counterpart to [`claim_project_work_item`].
#[allow(clippy::too_many_arguments)]
pub fn claim_standalone_work_item(
    org_id: Option<&str>,
    short_id: &str,
    session_id: &str,
    agent_role: Option<&str>,
    reason: crate::projects::types::WorkItemExecutionLockReason,
    actor: Option<&WorkItemMutationActor>,
    expected_revision: Option<i64>,
) -> Result<WorkItemData, String> {
    let short_id_owned = short_id.to_string();
    let session_owned = session_id.to_string();
    let role_owned = agent_role.map(|value| value.to_string());
    project_io::update_standalone_work_item_atomic_serviced(
        org_id,
        actor,
        project_io::AtomicServiceOptions {
            expected_local_version: expected_revision,
            operation: Some("work.claim"),
            strict_fsm: true,
            reason: Some("claimed".to_string()),
        },
        short_id,
        move |frontmatter, _body| {
            project_io::apply_execution_claim(
                frontmatter,
                &short_id_owned,
                &session_owned,
                role_owned.as_deref(),
                reason,
            )?;
            frontmatter.status = "in_progress".to_string();
            Ok(())
        },
    )?;
    project_io::read_standalone_work_item(org_id, short_id)
}

/// Strict, audited status transition for a project-scoped work item.
pub fn transition_project_work_item(
    project_slug: &str,
    short_id: &str,
    to_status: &str,
    reason: Option<&str>,
    actor: Option<&WorkItemMutationActor>,
    expected_revision: Option<i64>,
) -> Result<WorkItemData, String> {
    transition_project_work_item_scoped(
        project_slug,
        short_id,
        to_status,
        reason,
        actor,
        expected_revision,
        None,
    )
}

/// Session-scoped transition: the agent plane passes its session id and the
/// claim-holder guard applies; the human plane passes None.
#[allow(clippy::too_many_arguments)]
pub fn transition_project_work_item_scoped(
    project_slug: &str,
    short_id: &str,
    to_status: &str,
    reason: Option<&str>,
    actor: Option<&WorkItemMutationActor>,
    expected_revision: Option<i64>,
    caller_session: Option<&str>,
) -> Result<WorkItemData, String> {
    let to_status_owned = to_status.to_string();
    let reason_owned = reason.map(|value| value.to_string());
    let caller_owned = caller_session.map(str::to_string);
    project_io::update_work_item_atomic_serviced(
        project_slug,
        short_id,
        actor,
        project_io::AtomicServiceOptions {
            expected_local_version: expected_revision,
            operation: Some("work.transition"),
            strict_fsm: true,
            reason: reason_owned,
        },
        move |frontmatter, _body| {
            guard_claim_holder(frontmatter, caller_owned.as_deref())?;
            if frontmatter.status == to_status_owned {
                return Err(error::invalid_transition(
                    &frontmatter.status,
                    &to_status_owned,
                ));
            }
            let releases_to_open = matches!(
                state::map_legacy_status(&to_status_owned),
                Some(state::WorkItemState::Open)
            );
            frontmatter.status = to_status_owned.clone();
            if releases_to_open {
                frontmatter.execution_lock = None;
            }
            Ok(())
        },
    )?;
    project_io::read_work_item(project_slug, short_id)
}

/// Standalone-org counterpart to [`transition_project_work_item_scoped`].
#[allow(clippy::too_many_arguments)]
pub fn transition_standalone_work_item(
    org_id: Option<&str>,
    short_id: &str,
    to_status: &str,
    reason: Option<&str>,
    actor: Option<&WorkItemMutationActor>,
    expected_revision: Option<i64>,
    caller_session: Option<&str>,
) -> Result<WorkItemData, String> {
    let to_status_owned = to_status.to_string();
    let reason_owned = reason.map(|value| value.to_string());
    let caller_owned = caller_session.map(str::to_string);
    project_io::update_standalone_work_item_atomic_serviced(
        org_id,
        actor,
        project_io::AtomicServiceOptions {
            expected_local_version: expected_revision,
            operation: Some("work.transition"),
            strict_fsm: true,
            reason: reason_owned,
        },
        short_id,
        move |frontmatter, _body| {
            guard_claim_holder(frontmatter, caller_owned.as_deref())?;
            if frontmatter.status == to_status_owned {
                return Err(error::invalid_transition(
                    &frontmatter.status,
                    &to_status_owned,
                ));
            }
            let releases_to_open = matches!(
                state::map_legacy_status(&to_status_owned),
                Some(state::WorkItemState::Open)
            );
            frontmatter.status = to_status_owned.clone();
            if releases_to_open {
                frontmatter.execution_lock = None;
            }
            Ok(())
        },
    )?;
    project_io::read_standalone_work_item(org_id, short_id)
}

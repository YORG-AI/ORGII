//! Linked-session projection of unified session records onto Work Items.
//!
//! A Work Item's `linked_sessions` entries carry a status snapshot of each
//! bound session. Before this module, that snapshot was written only at
//! link time (and lazily swept by `orchestrator_start`), so a session that
//! finished after linking stayed `running` on the item forever. The status
//! mirror below runs at the authoritative session-status write boundary
//! (`update_status` / `finalize_terminal_turn_status`), keeping the item's
//! Execution Log truthful for every linked session — creator-launched
//! fillers, Start Agent runs, and externally linked sessions alike.

use core_types::workflow::{AgentRole, LinkedSession, LinkedSessionStatus, LinkedSessionType};
use project_management::projects::types::WorkItemFrontmatter;
use tracing::{info, warn};

use crate::session::SessionStatus;

use super::{get_session, UnifiedSessionRecord};

pub(crate) fn linked_session_from_record(
    session: &UnifiedSessionRecord,
    agent_role: Option<&str>,
) -> LinkedSession {
    let status = linked_session_status(&session.status);
    let completed_at = matches!(
        status,
        LinkedSessionStatus::Completed
            | LinkedSessionStatus::Failed
            | LinkedSessionStatus::Cancelled
    )
    .then(|| session.updated_at.clone());
    LinkedSession {
        session_id: session.session_id.clone(),
        session_type: linked_session_type(&session.session_type),
        agent_role: parse_agent_role(agent_role.or(session.agent_role.as_deref())),
        started_at: session.created_at.clone(),
        completed_at,
        status,
        cost_usd: 0.0,
        total_tokens: session.total_tokens.max(0) as u64,
        parent_session_id: session.parent_session_id.clone(),
        sub_agent_name: None,
        sub_agent_instance: None,
        result_preview: session
            .name
            .is_empty()
            .then(|| session.user_input.clone())
            .flatten()
            .or_else(|| Some(session.name.clone())),
    }
}

fn linked_session_status(raw: &str) -> LinkedSessionStatus {
    match SessionStatus::parse(raw) {
        Some(SessionStatus::Failed) => LinkedSessionStatus::Failed,
        Some(SessionStatus::Cancelled | SessionStatus::Abandoned | SessionStatus::Timeout) => {
            LinkedSessionStatus::Cancelled
        }
        Some(
            SessionStatus::Running | SessionStatus::WaitingForUser | SessionStatus::WaitingForFunds,
        ) => LinkedSessionStatus::Running,
        _ => LinkedSessionStatus::Completed,
    }
}

fn linked_session_type(session_type: &str) -> LinkedSessionType {
    match session_type {
        super::session_type::CODING
        | super::session_type::GENERIC
        | super::session_type::DESKTOP
        | super::session_type::SUBAGENT
        | super::session_type::ORG_MEMBER => LinkedSessionType::Native,
        _ => LinkedSessionType::Native,
    }
}

pub(crate) fn parse_agent_role(raw: Option<&str>) -> AgentRole {
    match raw.unwrap_or_default() {
        "review" => AgentRole::Review,
        "orchestrator" => AgentRole::Orchestrator,
        "custom" => AgentRole::Custom,
        "sub_agent" => AgentRole::SubAgent,
        _ => AgentRole::Coding,
    }
}

fn apply_linked_session_upsert(
    frontmatter: &mut WorkItemFrontmatter,
    session: &UnifiedSessionRecord,
    agent_role: Option<&str>,
) {
    let linked = linked_session_from_record(session, agent_role);
    match frontmatter
        .linked_sessions
        .iter_mut()
        .find(|candidate| candidate.session_id == session.session_id)
    {
        Some(existing) => {
            existing.session_type = linked.session_type;
            existing.agent_role = linked.agent_role;
            existing.status = linked.status;
            existing.completed_at = linked.completed_at;
            existing.total_tokens = linked.total_tokens;
            if existing.result_preview.is_none() {
                existing.result_preview = linked.result_preview;
            }
        }
        None => frontmatter.linked_sessions.push(linked),
    }

    // Older claim paths could append the same durable Session more than once
    // when a barrier wake resumed it. Keep the first canonical row and drop
    // stale duplicates whenever the authoritative Session record is mirrored.
    let mut found = false;
    frontmatter.linked_sessions.retain(|candidate| {
        if candidate.session_id != session.session_id {
            return true;
        }
        if found {
            return false;
        }
        found = true;
        true
    });

    if linked_session_status(&session.status) != LinkedSessionStatus::Running
        && frontmatter
            .execution_lock
            .as_ref()
            .and_then(|lock| lock.active_session_id.as_deref())
            == Some(session.session_id.as_str())
    {
        frontmatter.execution_lock = None;
    }
    frontmatter.updated_at = chrono::Utc::now().to_rfc3339();
}

pub(crate) fn upsert_linked_session_on_work_item(
    project_slug: &str,
    work_item_id: &str,
    session: &UnifiedSessionRecord,
    agent_role: Option<&str>,
) -> Result<(), String> {
    project_management::projects::io::update_work_item_atomic(
        project_slug,
        work_item_id,
        |frontmatter, _body| {
            apply_linked_session_upsert(frontmatter, session, agent_role);
            Ok(())
        },
    )
    .map(|_| ())
}

pub(crate) fn upsert_linked_session_on_standalone_work_item(
    work_item_id: &str,
    session: &UnifiedSessionRecord,
    agent_role: Option<&str>,
) -> Result<(), String> {
    let org_id =
        project_management::projects::io::resolve_local_org_scope(session.org_id.as_deref());
    project_management::projects::io::update_standalone_work_item_atomic(
        org_id.as_deref(),
        work_item_id,
        |frontmatter, _body| {
            apply_linked_session_upsert(frontmatter, session, agent_role);
            Ok(())
        },
    )
    .map(|_| ())
}

/// Mirror a settled session status onto the bound Work Item's
/// `linked_sessions` entry, then nudge the frontend to re-fetch. No-ops for
/// sessions without a Work Item link; failures are logged, never surfaced —
/// the session-status write this piggybacks on must not fail on PM state.
pub(crate) fn mirror_session_status_to_linked_work_item(session_id: &str) {
    let record = match get_session(session_id) {
        Ok(Some(record)) => record,
        Ok(None) => return,
        Err(error) => {
            warn!(
                session_id,
                error = %error,
                "[linked-session-mirror] failed to load session record"
            );
            return;
        }
    };
    let Some(work_item_id) = record.work_item_id.clone() else {
        return;
    };
    let agent_role = record.agent_role.clone();
    let result = match record.project_slug.as_deref() {
        Some(project_slug) => upsert_linked_session_on_work_item(
            project_slug,
            &work_item_id,
            &record,
            agent_role.as_deref(),
        ),
        None => upsert_linked_session_on_standalone_work_item(
            &work_item_id,
            &record,
            agent_role.as_deref(),
        ),
    };
    match result {
        Ok(()) => {
            info!(
                session_id,
                work_item_id,
                status = %record.status,
                "[linked-session-mirror] mirrored session status onto work item"
            );
            project_management::projects::events::notify_data_changed();
        }
        Err(error) => warn!(
            session_id,
            work_item_id,
            error = %error,
            "[linked-session-mirror] failed to mirror session status"
        ),
    }
}

#[cfg(test)]
mod tests {
    use project_management::projects::types::{
        WorkItemExecutionLock, WorkItemExecutionLockReason, WorkItemFrontmatter,
    };

    use super::*;

    fn work_item() -> WorkItemFrontmatter {
        serde_json::from_value(serde_json::json!({
            "id": "WI-0001",
            "short_id": "WI-0001",
            "title": "Linked session mirror",
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:00:00Z"
        }))
        .expect("minimal work item")
    }

    fn session(status: &str) -> UnifiedSessionRecord {
        UnifiedSessionRecord {
            session_id: "session-1".to_string(),
            name: "Run".to_string(),
            status: status.to_string(),
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-01T00:01:00Z".to_string(),
            session_type: super::super::session_type::GENERIC.to_string(),
            ..UnifiedSessionRecord::default()
        }
    }

    #[test]
    fn terminal_mirror_deduplicates_session_and_releases_its_lock() {
        let mut frontmatter = work_item();
        let running = session("running");
        let linked = linked_session_from_record(&running, Some("custom"));
        frontmatter.linked_sessions = vec![linked.clone(), linked];
        frontmatter.execution_lock = Some(WorkItemExecutionLock {
            active_session_id: Some(running.session_id.clone()),
            active_agent_org_run_id: None,
            execution_target: None,
            locked_at: Some(running.created_at.clone()),
            lock_reason: Some(WorkItemExecutionLockReason::FollowUp),
            locked_by_member_id: None,
        });

        let completed = session("completed");
        apply_linked_session_upsert(&mut frontmatter, &completed, Some("custom"));

        assert_eq!(frontmatter.linked_sessions.len(), 1);
        assert_eq!(
            frontmatter.linked_sessions[0].status,
            LinkedSessionStatus::Completed
        );
        assert!(frontmatter.execution_lock.is_none());
    }
}

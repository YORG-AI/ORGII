//! Execution lock helpers for work items.
//!
//! A work item may have many historical linked sessions, but only one
//! active execution session at a time. These helpers update the lock and
//! linked-session timeline inside the existing atomic work-item transaction.

use crate::projects::types::{
    AgentRole, LinkedSession, LinkedSessionStatus, LinkedSessionType, WorkItemAssigneeTarget,
    WorkItemAssigneeTargetKind, WorkItemExecutionLock, WorkItemExecutionLockReason,
};
use core_types::session::PENDING_SESSION_PLACEHOLDER;

use super::atomic::update_work_item_atomic;

pub fn acquire_execution_lock(
    project_slug: &str,
    short_id: &str,
    session_id: &str,
    agent_role: Option<&str>,
    reason: WorkItemExecutionLockReason,
) -> Result<(), String> {
    update_work_item_atomic(project_slug, short_id, |frontmatter, _body| {
        if let Some(lock) = frontmatter.execution_lock.as_ref() {
            if let Some(active_session_id) = lock.active_session_id.as_deref() {
                if active_session_id != session_id {
                    return Err(format!(
                        "Work item '{}' already has an active execution session: {}",
                        short_id, active_session_id
                    ));
                }
            }
        }

        if let Some(running_session) = frontmatter.linked_sessions.iter().find(|linked| {
            linked.status == LinkedSessionStatus::Running
                && linked.session_id != PENDING_SESSION_PLACEHOLDER
                && linked.session_id != session_id
        }) {
            return Err(format!(
                "Work item '{}' already has a running linked session: {}",
                short_id, running_session.session_id
            ));
        }

        let now = chrono::Utc::now().to_rfc3339();
        let role = parse_agent_role(agent_role);
        match frontmatter.linked_sessions.iter_mut().rev().find(|linked| {
            linked.session_id == PENDING_SESSION_PLACEHOLDER
                && linked.status == LinkedSessionStatus::Running
        }) {
            Some(pending) => {
                pending.session_id = session_id.to_string();
                pending.agent_role = role.clone();
                pending.session_type = LinkedSessionType::Native;
                pending.started_at = now.clone();
            }
            None => {
                frontmatter.linked_sessions.push(LinkedSession {
                    session_id: session_id.to_string(),
                    session_type: LinkedSessionType::Native,
                    agent_role: role.clone(),
                    started_at: now.clone(),
                    completed_at: None,
                    status: LinkedSessionStatus::Running,
                    cost_usd: 0.0,
                    total_tokens: 0,
                    parent_session_id: None,
                    sub_agent_name: None,
                    sub_agent_instance: None,
                    result_preview: None,
                });
            }
        }

        frontmatter.execution_lock = Some(WorkItemExecutionLock {
            active_session_id: Some(session_id.to_string()),
            active_agent_org_run_id: None,
            execution_target: Some(WorkItemAssigneeTarget {
                kind: WorkItemAssigneeTargetKind::Agent,
                target_id: agent_role.unwrap_or("agent").to_string(),
            }),
            locked_at: Some(now.clone()),
            lock_reason: Some(reason),
            // Local (non-collab) acquisition: the collab holder is stamped
            // server-side by orgii_acquire_work_item_lock and synced in.
            locked_by_member_id: None,
        });
        frontmatter.updated_at = now;
        Ok(())
    })
}

pub fn release_execution_lock(
    project_slug: &str,
    short_id: &str,
    session_id: &str,
) -> Result<(), String> {
    update_work_item_atomic(project_slug, short_id, |frontmatter, _body| {
        if frontmatter
            .execution_lock
            .as_ref()
            .and_then(|lock| lock.active_session_id.as_deref())
            == Some(session_id)
        {
            frontmatter.execution_lock = None;
            frontmatter.updated_at = chrono::Utc::now().to_rfc3339();
        }
        Ok(())
    })
}

fn parse_agent_role(raw: Option<&str>) -> AgentRole {
    match raw.unwrap_or_default() {
        "review" => AgentRole::Review,
        "orchestrator" => AgentRole::Orchestrator,
        "custom" => AgentRole::Custom,
        "sub_agent" => AgentRole::SubAgent,
        _ => AgentRole::Coding,
    }
}

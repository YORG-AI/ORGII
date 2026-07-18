use serde::Serialize;

use crate::coordination::agent_member_interventions::AgentMemberInterventionRecord;

/// Result row for [`super::AgentOrgRunStore::find_worker_session_by_member_id`].
#[derive(Debug, Clone)]
pub struct WorkerSessionInfo {
    pub session_id: String,
    pub status: crate::core::session::SessionStatus,
    pub updated_at: String,
}

/// Freshest persisted runtime session for a member inside one Agent Org run.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerSessionRuntime {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_definition_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cli_agent_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub member_id: Option<String>,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_session_id: Option<String>,
    pub status: crate::core::session::SessionStatus,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intervention: Option<AgentMemberInterventionRecord>,
}

/// Whether the freshest persisted session for one Agent Org member can
/// receive a recovery-derived Inbox row and then be woken safely.
///
/// Recovery analyzers work from snapshots. A member can be paused, archived,
/// replaced by an unsupported CLI session, or start another turn before the
/// executor acquires the writer lock. Every recovery outbox producer shares
/// this final transaction-time predicate so stale plans cannot manufacture
/// new orphan Inbox rows.
pub(crate) fn recovery_dispatch_recipient_is_available(
    sessions: &[WorkerSessionRuntime],
    member_id: &str,
    recipient_agent_id: &str,
) -> bool {
    sessions
        .iter()
        .find(|session| session.member_id.as_deref() == Some(member_id))
        .is_some_and(|session| {
            session.cli_agent_type.is_none()
                && session.agent_definition_id.as_deref() == Some(recipient_agent_id)
                && session.status.is_agent_org_wakeable()
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::session::SessionStatus;

    fn runtime(status: SessionStatus) -> WorkerSessionRuntime {
        WorkerSessionRuntime {
            agent_definition_id: Some("agent-a".to_string()),
            cli_agent_type: None,
            member_id: Some("member-a".to_string()),
            session_id: "session-a".to_string(),
            parent_session_id: Some("root".to_string()),
            status,
            updated_at: "2026-07-17T00:00:00Z".to_string(),
            intervention: None,
        }
    }

    #[test]
    fn recovery_recipient_requires_wakeable_rust_session_and_exact_identity() {
        for status in [
            SessionStatus::Idle,
            SessionStatus::Completed,
            SessionStatus::Failed,
            SessionStatus::Cancelled,
            SessionStatus::Abandoned,
            SessionStatus::Timeout,
        ] {
            assert!(recovery_dispatch_recipient_is_available(
                &[runtime(status)],
                "member-a",
                "agent-a"
            ));
        }
        for status in [
            SessionStatus::Pending,
            SessionStatus::Running,
            SessionStatus::WaitingForUser,
            SessionStatus::WaitingForFunds,
            SessionStatus::Paused,
            SessionStatus::Archived,
        ] {
            assert!(!recovery_dispatch_recipient_is_available(
                &[runtime(status)],
                "member-a",
                "agent-a"
            ));
        }

        let mut cli = runtime(SessionStatus::Idle);
        cli.cli_agent_type = Some("claude_code".to_string());
        assert!(!recovery_dispatch_recipient_is_available(
            &[cli],
            "member-a",
            "agent-a"
        ));
        assert!(!recovery_dispatch_recipient_is_available(
            &[runtime(SessionStatus::Idle)],
            "member-a",
            "agent-b"
        ));
        assert!(!recovery_dispatch_recipient_is_available(
            &[runtime(SessionStatus::Idle)],
            "member-b",
            "agent-a"
        ));
    }
}

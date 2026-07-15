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

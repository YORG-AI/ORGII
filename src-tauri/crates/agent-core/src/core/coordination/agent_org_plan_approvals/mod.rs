//! Durable approval state for plans produced by Agent Org planning tasks.
//!
//! This is intentionally separate from `interaction::plan_approval`: the
//! latter belongs to one top-level session and its Build button starts a new
//! turn in that same session. An Agent Org approval instead completes a
//! planning task and unlocks the run's dynamic dependency graph.

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::coordination::agent_org_tasks::TaskMutationOutcome;
use crate::definitions::orgs::PlanApprovalPolicy;

mod artifact;
mod persistence;
mod store;
mod transitions;
mod validation;

pub use store::AgentOrgPlanApprovalStore;

#[cfg(test)]
mod tests;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentOrgPlanApprovalStatus {
    Pending,
    Approved,
    ChangesRequested,
    Superseded,
    Cancelled,
}

impl AgentOrgPlanApprovalStatus {
    fn as_wire(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Approved => "approved",
            Self::ChangesRequested => "changes_requested",
            Self::Superseded => "superseded",
            Self::Cancelled => "cancelled",
        }
    }

    fn from_wire(value: &str) -> Result<Self, String> {
        match value {
            "pending" => Ok(Self::Pending),
            "approved" => Ok(Self::Approved),
            "changes_requested" => Ok(Self::ChangesRequested),
            "superseded" => Ok(Self::Superseded),
            "cancelled" => Ok(Self::Cancelled),
            other => Err(format!("unknown Agent Org plan approval status: {other}")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentOrgPlanDecisionBy {
    User,
    Coordinator,
    System,
}

impl AgentOrgPlanDecisionBy {
    fn as_wire(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Coordinator => "coordinator",
            Self::System => "system",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOrgPlanApproval {
    pub approval_id: String,
    pub plan_revision_id: String,
    pub request_id: String,
    pub org_run_id: String,
    pub source_task_id: String,
    pub source_member_id: String,
    pub source_session_id: String,
    pub root_session_id: String,
    pub policy: PlanApprovalPolicy,
    pub status: AgentOrgPlanApprovalStatus,
    pub plan_title: String,
    pub plan_path: String,
    pub plan_content: String,
    pub decision_by: Option<String>,
    pub feedback: Option<String>,
    pub created_at: String,
    pub resolved_at: Option<String>,
}

/// Lightweight projection used by the frequently-polled Agent Org Run View.
///
/// `plan_revision_id` is the immutable cache key for fetching the full detail.
/// Keeping the Markdown and local path out of this DTO prevents every Run View
/// refresh from copying the complete plan across SQLite, Rust, and Tauri IPC.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOrgPlanApprovalSummary {
    pub approval_id: String,
    pub plan_revision_id: String,
    pub request_id: String,
    pub org_run_id: String,
    pub source_task_id: String,
    pub source_member_id: String,
    pub source_session_id: String,
    pub root_session_id: String,
    pub policy: PlanApprovalPolicy,
    pub status: AgentOrgPlanApprovalStatus,
    pub plan_title: String,
    pub plan_content_bytes: u64,
    pub created_at: String,
}

#[derive(Debug, Clone)]
pub struct CreateAgentOrgPlanApprovalParams {
    pub request_id: String,
    pub org_run_id: String,
    pub source_task_id: String,
    pub source_member_id: String,
    pub source_session_id: String,
    pub root_session_id: String,
    pub policy: PlanApprovalPolicy,
    pub plan_title: String,
    pub plan_path: String,
    pub plan_content: String,
}

#[derive(Debug, Clone)]
pub struct ApprovedAgentOrgPlan {
    pub approval: AgentOrgPlanApproval,
    pub task_outcome: TaskMutationOutcome,
    /// Durable inbox rows are committed in the same transaction as the
    /// approval and planning-task completion. Only these best-effort wake
    /// signals remain for callers to dispatch after commit.
    pub wake_member_ids: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct AgentOrgPlanInboxDelivery {
    pub recipient_agent_id: String,
    pub sender_agent_id: String,
    pub sender_member_id: Option<String>,
}

pub fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_org_plan_approvals (
            approval_id TEXT PRIMARY KEY,
            plan_revision_id TEXT NOT NULL UNIQUE,
            request_id TEXT NOT NULL UNIQUE,
            org_run_id TEXT NOT NULL,
            source_task_id TEXT NOT NULL,
            source_member_id TEXT NOT NULL,
            source_session_id TEXT NOT NULL,
            root_session_id TEXT NOT NULL,
            policy TEXT NOT NULL,
            status TEXT NOT NULL,
            plan_title TEXT NOT NULL,
            plan_path TEXT NOT NULL,
            plan_content TEXT NOT NULL,
            decision_by TEXT,
            feedback TEXT,
            created_at TEXT NOT NULL,
            resolved_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_agent_org_plan_approvals_run_status
            ON agent_org_plan_approvals(org_run_id, status, created_at);
        CREATE INDEX IF NOT EXISTS idx_agent_org_plan_approvals_task
            ON agent_org_plan_approvals(org_run_id, source_task_id, created_at);",
    )?;
    Ok(())
}

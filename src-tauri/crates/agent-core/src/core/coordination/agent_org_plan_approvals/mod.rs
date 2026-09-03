//! Durable immutable revisions and decisions for Agent Org planning tasks.
//!
//! This is intentionally separate from `interaction::plan_approval`: the
//! latter belongs to one top-level session and its Build button starts a new
//! turn in that same session. An Agent Org approval instead completes a
//! planning task and unlocks the run's dynamic dependency graph.

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::coordination::agent_org_tasks::TaskMutationOutcome;
use crate::definitions::orgs::PlanApprovalPolicy;

pub(crate) mod artifact;
mod persistence;
mod store;
mod transitions;
mod validation;

pub use store::AgentOrgPlanRevisionStore;
pub(crate) use store::{ApprovePlanRevisionInTxParams, RequestPlanChangesParams};

#[cfg(test)]
mod tests;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentOrgPlanDecisionStatus {
    Pending,
    Approved,
    ChangesRequested,
    Superseded,
    Cancelled,
}

impl AgentOrgPlanDecisionStatus {
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
            other => Err(format!("unknown Agent Org plan decision status: {other}")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentOrgPlanDecisionBy {
    User,
    Coordinator,
    Automatic,
}

impl AgentOrgPlanDecisionBy {
    fn as_wire(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Coordinator => "coordinator",
            Self::Automatic => "automatic",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOrgPlanTaskOutputRef {
    pub task_id: String,
    pub plan_revision_id: String,
    pub produced_by_member_id: String,
    pub produced_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOrgPlanRevision {
    pub approval_id: String,
    pub plan_revision_id: String,
    pub revision_number: u64,
    pub previous_plan_revision_id: Option<String>,
    pub request_id: String,
    pub org_run_id: String,
    pub source_task_id: String,
    pub source_member_id: String,
    pub source_session_id: String,
    pub source_turn_intent_id: String,
    pub root_session_id: String,
    pub policy: PlanApprovalPolicy,
    pub status: AgentOrgPlanDecisionStatus,
    pub plan_title: String,
    pub plan_path: String,
    pub plan_content: String,
    pub content_digest: String,
    pub decision_by: Option<String>,
    pub feedback: Option<String>,
    pub task_output: Option<AgentOrgPlanTaskOutputRef>,
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
pub struct AgentOrgPlanRevisionSummary {
    pub approval_id: String,
    pub plan_revision_id: String,
    pub revision_number: u64,
    pub previous_plan_revision_id: Option<String>,
    pub request_id: String,
    pub org_run_id: String,
    pub source_task_id: String,
    pub source_member_id: String,
    pub source_session_id: String,
    pub source_turn_intent_id: String,
    pub root_session_id: String,
    pub policy: PlanApprovalPolicy,
    pub status: AgentOrgPlanDecisionStatus,
    pub plan_title: String,
    pub plan_content_bytes: u64,
    pub content_digest: String,
    pub decision_by: Option<String>,
    pub feedback: Option<String>,
    pub task_output: Option<AgentOrgPlanTaskOutputRef>,
    pub created_at: String,
    pub resolved_at: Option<String>,
}

#[derive(Debug, Clone)]
pub struct CreateAgentOrgPlanRevisionParams {
    pub request_id: String,
    pub org_run_id: String,
    pub source_task_id: String,
    pub source_member_id: String,
    pub source_session_id: String,
    pub source_turn_intent_id: String,
    pub root_session_id: String,
    pub policy: PlanApprovalPolicy,
    pub plan_title: String,
    pub plan_path: String,
    pub plan_content: String,
}

#[derive(Debug, Clone)]
pub struct ApprovedAgentOrgPlanRevision {
    pub revision: AgentOrgPlanRevision,
    pub task_outcome: TaskMutationOutcome,
    /// Durable inbox rows are committed in the same transaction as the
    /// approval and planning-task completion. Only these best-effort wake
    /// signals remain for callers to dispatch after commit.
    pub wake_member_ids: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct AgentOrgPlanDecisionDelivery {
    pub recipient_agent_id: String,
    pub sender_agent_id: String,
    pub sender_member_id: Option<String>,
}

pub fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    create_schema(conn)
}

pub(crate) fn create_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_org_runtime_plan_revisions (
            plan_revision_id TEXT PRIMARY KEY,
            org_run_id TEXT NOT NULL,
            source_task_id TEXT NOT NULL,
            source_member_id TEXT NOT NULL,
            source_session_id TEXT NOT NULL,
            source_turn_intent_id TEXT NOT NULL,
            root_session_id TEXT NOT NULL,
            revision_number INTEGER NOT NULL CHECK(revision_number >= 1),
            previous_plan_revision_id TEXT,
            plan_title TEXT NOT NULL,
            plan_path TEXT NOT NULL,
            plan_content TEXT NOT NULL,
            content_digest TEXT NOT NULL CHECK(length(content_digest)=64),
            created_at TEXT NOT NULL,
            UNIQUE(org_run_id, source_task_id, revision_number),
            FOREIGN KEY(org_run_id) REFERENCES agent_org_runtime_runs(id) ON DELETE CASCADE,
            FOREIGN KEY(previous_plan_revision_id)
                REFERENCES agent_org_runtime_plan_revisions(plan_revision_id)
        );
        CREATE TRIGGER IF NOT EXISTS trg_agent_org_runtime_plan_revisions_immutable
        BEFORE UPDATE ON agent_org_runtime_plan_revisions
        BEGIN
            SELECT RAISE(ABORT, 'agent_org_plan_revision_immutable');
        END;
        CREATE INDEX IF NOT EXISTS idx_agent_org_runtime_plan_revisions_run_task
            ON agent_org_runtime_plan_revisions(
                org_run_id, source_task_id, revision_number DESC
            );
        CREATE INDEX IF NOT EXISTS idx_agent_org_runtime_plan_revisions_path
            ON agent_org_runtime_plan_revisions(plan_path, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_agent_org_runtime_plan_revisions_source_session_turn
            ON agent_org_runtime_plan_revisions(
                source_session_id, source_turn_intent_id, created_at
            );

        CREATE TABLE IF NOT EXISTS agent_org_runtime_plan_decisions (
            approval_id TEXT PRIMARY KEY,
            plan_revision_id TEXT NOT NULL UNIQUE,
            request_id TEXT NOT NULL UNIQUE,
            policy TEXT NOT NULL CHECK(policy IN ('coordinator','user','automatic')),
            status TEXT NOT NULL CHECK(status IN (
                'pending','approved','changes_requested','superseded','cancelled'
            )),
            decision_by TEXT CHECK(decision_by IS NULL OR decision_by IN (
                'user','coordinator','automatic'
            )),
            feedback TEXT,
            created_at TEXT NOT NULL,
            resolved_at TEXT,
            FOREIGN KEY(plan_revision_id)
                REFERENCES agent_org_runtime_plan_revisions(plan_revision_id)
                ON DELETE CASCADE,
            CHECK(
                (status='pending' AND decision_by IS NULL AND resolved_at IS NULL)
                OR
                (status!='pending' AND decision_by IS NOT NULL AND resolved_at IS NOT NULL)
            )
        );
        CREATE INDEX IF NOT EXISTS idx_agent_org_runtime_plan_decisions_status
            ON agent_org_runtime_plan_decisions(status, created_at, approval_id);",
    )?;
    Ok(())
}

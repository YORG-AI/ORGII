//! Durable Agent Org run envelopes.
//!
//! A run records that an Agent Org launched through the normal Rust session
//! stack, while the root session remains the transcript source of truth.

mod helpers;
mod store;
mod worker;

#[cfg(test)]
mod tests;

pub use store::AgentOrgRunStore;
pub use worker::{WorkerSessionInfo, WorkerSessionRuntime};

use rusqlite::{Connection, Result as SqliteResult};
use serde::Serialize;

use crate::definitions::orgs::{HierarchyMode, OrgDefinition, PlanApprovalPolicy};

pub const COORDINATOR_MEMBER_ID: &str = "coordinator";
pub(crate) const DEFAULT_COORDINATOR_DISPLAY_NAME: &str = "Coordinator";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentOrgRunEntryMode {
    StandaloneSession,
}

impl AgentOrgRunEntryMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::StandaloneSession => "standalone_session",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "standalone_session" => Some(Self::StandaloneSession),
            _ => None,
        }
    }
}

impl std::fmt::Display for AgentOrgRunEntryMode {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentOrgRunStatus {
    Running,
    /// User-initiated pause. Non-terminal: the run can be resumed via
    /// `AgentOrgRunStore::mark_resumed`. Polling and member switching remain
    /// available while paused; the coordinator and members simply stop
    /// receiving new dispatch until resumed.
    Paused,
    Completed,
    Failed,
    Cancelled,
    Abandoned,
}

impl AgentOrgRunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Paused => "paused",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Abandoned => "abandoned",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "running" => Some(Self::Running),
            "paused" => Some(Self::Paused),
            "completed" => Some(Self::Completed),
            "failed" => Some(Self::Failed),
            "cancelled" => Some(Self::Cancelled),
            "abandoned" => Some(Self::Abandoned),
            _ => None,
        }
    }

    /// Whether this status represents a terminal state (no further transitions
    /// possible). `Paused` is explicitly non-terminal.
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Failed | Self::Cancelled | Self::Abandoned
        )
    }
}

impl std::fmt::Display for AgentOrgRunStatus {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOrgContextMember {
    pub member_id: String,
    pub name: String,
    pub role: String,
    pub agent_id: String,
    /// Participant-specific operating instructions captured from the org
    /// definition at launch time.
    #[serde(skip_serializing)]
    pub instructions: Option<String>,
    /// `id` of the member this one reports to in `OrgDefinition.children`.
    /// `None` means the member sits directly under the coordinator.
    /// Used by the LLM system prompt to render reports-to relationships
    /// (in `Soft`/`Strict` modes) and by the runtime to enforce routing
    /// rules when `HierarchyMode::Strict` is in effect.
    pub parent_member_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOrgParticipant {
    pub member_id: String,
    pub agent_id: String,
    pub parent_member_id: Option<String>,
    pub is_coordinator: bool,
}

/// One transactionally consistent read of every durable signal that can
/// prevent an Agent Org run from being safely announced as complete.
#[derive(Debug, Clone)]
pub struct AgentOrgCompletionSnapshot {
    pub run_status: Option<AgentOrgRunStatus>,
    pub tasks: Vec<crate::coordination::agent_org_tasks::Task>,
    pub active_member_ids: Vec<String>,
    pub active_intervention_member_ids: Vec<String>,
    pub pending_worker_turn_intent_count: usize,
    pub unread_inbox_count: usize,
    pub pending_plan_approval_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOrgRunContext {
    pub run_id: String,
    pub org_id: String,
    pub org_name: String,
    pub org_role: String,
    /// Stable agent_id of the coordinator session. Routing uses
    /// `COORDINATOR_MEMBER_ID`; this field is only the runtime definition id.
    pub coordinator_agent_id: String,
    /// Display name of the coordinator participant. This is intentionally
    /// distinct from `org_name`; chat cards and inbox routing should name the
    /// recipient role, not the Agent Org session title.
    pub coordinator_name: String,
    /// Role label of the coordinator (e.g. "lead engineer"). Mirror of
    /// `OrgDefinition.role`. Informational only — not used for routing.
    pub coordinator_role: String,
    /// Coordinator-specific operating instructions captured in the immutable
    /// launch snapshot.
    #[serde(skip_serializing)]
    pub coordinator_instructions: Option<String>,
    /// Worker roster. Does **not** include the coordinator — addressing
    /// logic explicitly considers `{coordinator} ∪ members` as the
    /// eligible recipient set.
    pub members: Vec<AgentOrgContextMember>,
    /// How the coordinator → members → reports-to relationship should be
    /// surfaced in the LLM system prompt and enforced by
    /// `org_send_message`. Mirror of `OrgDefinition.hierarchy_mode`.
    pub hierarchy_mode: HierarchyMode,
    /// Plan-approval policy captured in the launch snapshot.
    pub plan_approval_policy: PlanApprovalPolicy,
    /// Session ID of the coordinator (root) session for this run. Used by
    /// the frontend to navigate directly to the coordinator's chat history
    /// when the run is paused or the coordinator is not the active session.
    /// `None` only for runs that have not yet materialized a coordinator
    /// session (e.g. created but never started).
    pub root_session_id: Option<String>,
}

/// Outcome of [`AgentOrgRunContext::check_routing`].
///
/// `Allowed` means the send is legitimate under the current
/// `HierarchyMode`. `Blocked` carries an LLM-readable hint that names
/// the legitimate routing options (immediate manager + the coordinator
/// escape hatch) so the model can self-correct without retrying blind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RoutingDecision {
    Allowed,
    Blocked(String),
}

impl AgentOrgRunContext {
    pub fn coordinator_participant(&self) -> AgentOrgParticipant {
        AgentOrgParticipant {
            member_id: COORDINATOR_MEMBER_ID.to_string(),
            agent_id: self.coordinator_agent_id.clone(),
            parent_member_id: None,
            is_coordinator: true,
        }
    }

    pub fn participants(&self) -> Vec<AgentOrgParticipant> {
        let mut participants = Vec::with_capacity(self.members.len() + 1);
        participants.push(self.coordinator_participant());
        participants.extend(self.members.iter().map(|member| AgentOrgParticipant {
            member_id: member.member_id.clone(),
            agent_id: member.agent_id.clone(),
            parent_member_id: member.parent_member_id.clone(),
            is_coordinator: false,
        }));
        participants
    }

    pub fn participant_by_member_id(&self, member_id: &str) -> Option<AgentOrgParticipant> {
        if member_id == COORDINATOR_MEMBER_ID {
            return Some(self.coordinator_participant());
        }
        self.members
            .iter()
            .find(|member| member.member_id == member_id)
            .map(|member| AgentOrgParticipant {
                member_id: member.member_id.clone(),
                agent_id: member.agent_id.clone(),
                parent_member_id: member.parent_member_id.clone(),
                is_coordinator: false,
            })
    }

    pub fn participant_display_name(&self, member_id: &str) -> Option<String> {
        if member_id == COORDINATOR_MEMBER_ID {
            return Some(self.coordinator_name.clone());
        }
        self.members
            .iter()
            .find(|member| member.member_id == member_id)
            .map(|member| member.name.clone())
    }

    pub fn participant_agent_id(&self, member_id: &str) -> Option<String> {
        self.participant_by_member_id(member_id)
            .map(|participant| participant.agent_id)
    }

    pub fn require_participant(&self, member_id: &str) -> Result<AgentOrgParticipant, String> {
        self.participant_by_member_id(member_id).ok_or_else(|| {
            format!("member_id '{member_id}' is not a participant in this Agent Org run")
        })
    }

    pub fn require_participant_display_name(&self, member_id: &str) -> Result<String, String> {
        self.participant_display_name(member_id).ok_or_else(|| {
            format!("member_id '{member_id}' is not a participant in this Agent Org run")
        })
    }

    pub fn require_participant_agent_id(&self, member_id: &str) -> Result<String, String> {
        self.participant_agent_id(member_id).ok_or_else(|| {
            format!("member_id '{member_id}' is not a participant in this Agent Org run")
        })
    }

    pub fn allowed_recipient_member_ids_for(&self, sender_member_id: &str) -> Vec<String> {
        if self.participant_by_member_id(sender_member_id).is_none() {
            return Vec::new();
        }

        let mut allowed = match self.hierarchy_mode {
            HierarchyMode::Flat | HierarchyMode::Soft => self
                .participants()
                .into_iter()
                .map(|participant| participant.member_id)
                .filter(|member_id| member_id != sender_member_id)
                .collect::<Vec<_>>(),
            HierarchyMode::Strict => {
                if sender_member_id == COORDINATOR_MEMBER_ID {
                    self.members
                        .iter()
                        .map(|member| member.member_id.clone())
                        .collect::<Vec<_>>()
                } else {
                    let mut ids = Vec::new();
                    ids.push(COORDINATOR_MEMBER_ID.to_string());
                    if let Some(sender) = self
                        .members
                        .iter()
                        .find(|member| member.member_id == sender_member_id)
                    {
                        if let Some(parent_member_id) = sender.parent_member_id.as_ref() {
                            ids.push(parent_member_id.clone());
                        }
                        ids.extend(
                            self.members
                                .iter()
                                .filter(|member| {
                                    member
                                        .parent_member_id
                                        .as_deref()
                                        .is_some_and(|parent| parent == sender.member_id)
                                })
                                .map(|member| member.member_id.clone()),
                        );
                    }
                    ids.into_iter()
                        .filter(|member_id| member_id != sender_member_id)
                        .collect::<Vec<_>>()
                }
            }
        };
        allowed.sort();
        allowed.dedup();
        allowed
    }

    /// Member ids that `manager_member_id` may directly supervise on the
    /// shared task board. Task authority deliberately differs from message
    /// routing: unrestricted peer discussion in `Soft` mode does not make
    /// every peer every other peer's manager. `Flat` drops the hierarchy, so
    /// only the coordinator has cross-member task authority in that mode.
    pub fn direct_report_member_ids_for(&self, manager_member_id: &str) -> Vec<String> {
        if self.hierarchy_mode == HierarchyMode::Flat
            || manager_member_id == COORDINATOR_MEMBER_ID
            || self.participant_by_member_id(manager_member_id).is_none()
        {
            return Vec::new();
        }

        let mut direct_reports = self
            .members
            .iter()
            .filter(|member| member.parent_member_id.as_deref() == Some(manager_member_id))
            .map(|member| member.member_id.clone())
            .collect::<Vec<_>>();
        direct_reports.sort();
        direct_reports.dedup();
        direct_reports
    }

    /// Task assignees that `caller_member_id` is authorized to manage.
    ///
    /// - coordinator: itself plus every roster member;
    /// - ordinary member: itself;
    /// - manager member in Soft/Strict: itself plus direct reports.
    ///
    /// This is the task-governance source of truth. It must not be replaced by
    /// `allowed_recipient_member_ids_for`: permission to talk to a peer is not
    /// permission to assign that peer work.
    pub fn allowed_task_target_member_ids_for(&self, caller_member_id: &str) -> Vec<String> {
        if self.participant_by_member_id(caller_member_id).is_none() {
            return Vec::new();
        }

        let mut allowed = if caller_member_id == COORDINATOR_MEMBER_ID {
            self.participants()
                .into_iter()
                .map(|participant| participant.member_id)
                .collect::<Vec<_>>()
        } else {
            let mut member_ids = vec![caller_member_id.to_string()];
            member_ids.extend(self.direct_report_member_ids_for(caller_member_id));
            member_ids
        };
        allowed.sort();
        allowed.dedup();
        allowed
    }

    pub fn can_assign_task_to(&self, caller_member_id: &str, target_member_id: &str) -> bool {
        self.allowed_task_target_member_ids_for(caller_member_id)
            .iter()
            .any(|member_id| member_id == target_member_id)
    }

    pub fn check_routing(&self, from_member_id: &str, to_member_id: &str) -> RoutingDecision {
        if self
            .allowed_recipient_member_ids_for(from_member_id)
            .iter()
            .any(|member_id| member_id == to_member_id)
        {
            return RoutingDecision::Allowed;
        }

        RoutingDecision::Blocked(format!(
            "recipient_member_id '{to_member_id}' is not currently routable from sender_member_id '{from_member_id}'. Allowed recipient_member_id values: {}",
            self.allowed_recipient_member_ids_for(from_member_id).join(", ")
        ))
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOrgRunRecord {
    pub id: String,
    pub org_id: String,
    pub coordinator_agent_id: String,
    pub root_session_id: Option<String>,
    pub org_snapshot_json: Option<String>,
    pub entry_mode: AgentOrgRunEntryMode,
    pub status: AgentOrgRunStatus,
    pub work_item_id: Option<String>,
    pub project_slug: Option<String>,
    pub routine_fire_id: Option<String>,
    pub summary: Option<String>,
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone)]
pub struct CreateAgentOrgRunParams {
    pub org_id: String,
    pub coordinator_agent_id: String,
    pub root_session_id: Option<String>,
    pub org_snapshot: OrgDefinition,
    pub entry_mode: AgentOrgRunEntryMode,
    pub status: AgentOrgRunStatus,
    pub work_item_id: Option<String>,
    pub project_slug: Option<String>,
    pub routine_fire_id: Option<String>,
}

/// Initialize runtime Agent Org tables in `sessions.db`.
pub fn init_schema(conn: &Connection) -> SqliteResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_org_runs (
            id TEXT PRIMARY KEY,
            org_id TEXT NOT NULL,
            coordinator_agent_id TEXT NOT NULL,
            root_session_id TEXT,
            org_snapshot_json TEXT,
            entry_mode TEXT NOT NULL,
            status TEXT NOT NULL,
            work_item_id TEXT,
            project_slug TEXT,
            routine_fire_id TEXT,
            summary TEXT,
            last_error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            completed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_agent_org_runs_org_updated
            ON agent_org_runs(org_id, updated_at);
        CREATE INDEX IF NOT EXISTS idx_agent_org_runs_root_session
            ON agent_org_runs(root_session_id);
        CREATE INDEX IF NOT EXISTS idx_agent_org_runs_work_item
            ON agent_org_runs(work_item_id);
        CREATE INDEX IF NOT EXISTS idx_agent_org_runs_status
            ON agent_org_runs(status);",
    )?;
    Ok(())
}

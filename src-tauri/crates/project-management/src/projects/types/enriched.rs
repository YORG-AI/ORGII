//! Enriched work item types with pre-resolved references.

use serde::{Deserialize, Serialize};

use super::orchestrator::{
    FollowUpRef, LinkedSession, OrchestratorConfig, OrchestratorState, ProofOfWork,
    WorkItemSchedule,
};
use super::project::{CommentEntry, TodoEntry};
use super::routines::WorkItemRoutineSource;
use super::work_items::{
    WorkItemCloseOut, WorkItemExecutionLock, WorkItemHandoff, WorkItemHistoryEvent,
    WorkItemOriginSession, WorkItemWorkProduct,
};

// ============================================
// Enriched Work Item (pre-resolved labels/members)
// ============================================

/// Resolved person reference (from member ID lookup)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolvedPerson {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    pub color: String,
}

/// Resolved label reference (from label ID lookup)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolvedLabel {
    pub id: String,
    pub name: String,
    pub color: String,
}

/// Resolved project reference
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolvedProject {
    pub id: String,
    pub name: String,
}

/// Resolved milestone reference
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolvedMilestone {
    pub id: String,
    pub name: String,
}

/// Work item with pre-resolved labels, members, and computed fields.
/// Sent directly to the frontend, eliminating the need for JS-side
/// Map construction and resolution loops.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrichedWorkItem {
    // Core identity
    pub id: String,
    pub short_id: String,
    pub title: String,
    pub body: String,
    pub filename: String,

    // Status
    pub status: String,
    pub priority: String,
    pub starred: bool,

    // Resolved references
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assignee: Option<ResolvedPerson>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assignee_type: Option<String>,
    pub labels: Vec<ResolvedLabel>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<ResolvedProject>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub milestone: Option<ResolvedMilestone>,

    // Dates
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_date: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin_session: Option<WorkItemOriginSession>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_by_person: Option<ResolvedPerson>,

    // Sub-items
    pub todos: Vec<TodoEntry>,
    pub comments: Vec<CommentEntry>,
    pub history: Vec<WorkItemHistoryEvent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handoff: Option<WorkItemHandoff>,

    // Agent workflow
    pub linked_sessions: Vec<LinkedSession>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proof_of_work: Option<ProofOfWork>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orchestrator_config: Option<OrchestratorConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orchestrator_state: Option<OrchestratorState>,
    pub follow_up_items: Vec<FollowUpRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schedule: Option<WorkItemSchedule>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub routine_source: Option<WorkItemRoutineSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_lock: Option<WorkItemExecutionLock>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub close_out: Option<WorkItemCloseOut>,
    pub work_products: Vec<WorkItemWorkProduct>,
}

//! Agent workflow types: orchestrator, proof of work, review, linked sessions.
//!
//! Composite structs live here. The leaf enums they reference
//! (`OrchestratorPhase`, `ReviewOutcome`, `AgentRole`, `LinkedSessionType`,
//! `LinkedSessionStatus`, `ReviewCommentSeverity`, `ResolutionStatus`,
//! `PrStatus`, `FileChangeStatus`) live in `core_types::workflow` so that
//! `agent_core` can reference them without taking a dependency on
//! `project_management`. Re-exported below for backward-compatible imports.

use serde::{Deserialize, Serialize};

pub use core_types::workflow::{
    AgentRole, FileChange, FileChangeStatus, FollowUpRef, LastFailure, LinkedSession,
    LinkedSessionStatus, LinkedSessionType, OrchestratorPhase, PrStatus, ProofOfWork,
    ResolutionStatus, ResolvedFromPrevious, ReviewComment, ReviewCommentSeverity, ReviewConfig,
    ReviewFeedback, ReviewOutcome, ReviewerRef, TestResults, WorkItemDiffStats, WorkItemSchedule,
};

/// How an execution path should be mounted into an agent Session.
///
/// A local workspace is the primary checkout itself. A worktree is an
/// already-registered secondary checkout and must pass the stricter Git
/// worktree validation during launch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceExecutionMode {
    LocalWorkspace,
    Worktree,
}

/// Per-work-item orchestrator configuration (user-editable)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OrchestratorConfig {
    /// Deprecated: use `review_config` instead. Kept for backward compat with old YAML.
    #[serde(default)]
    pub review_enabled: bool,
    /// Structured review configuration. Takes priority over `review_enabled`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_config: Option<ReviewConfig>,
    #[serde(default)]
    pub follow_up_enabled: bool,
    #[serde(default = "default_false")]
    pub auto_retry_on_failure: bool,
    #[serde(default = "default_max_retry_count")]
    pub max_retry_count: u32,
    #[serde(default = "app_utils::default_true")]
    pub auto_create_pr: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_account_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_model_id: Option<String>,
    /// IDs of custom agents from Agent Orgs to use as sub-agents
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sub_agent_ids: Vec<String>,
    /// ID of the agent organization assigned to this work item
    #[serde(skip_serializing_if = "Option::is_none")]
    pub org_id: Option<String>,
    /// Execution mode passed to the launched agent session.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_mode: Option<String>,
    /// Custom agent definition to use as the main executor (None = default SDE).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_definition_id: Option<String>,
    /// Absolute path to the code repository where the SDE Agent operates.
    /// Overrides the project-level `linked_repos` fallback.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    /// Whether `worktree_path` is the primary checkout or a registered Git
    /// worktree. Optional for backward compatibility with older Work Items.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_mode: Option<WorkspaceExecutionMode>,
}

fn default_false() -> bool {
    false
}

fn default_max_retry_count() -> u32 {
    2
}

impl Default for OrchestratorConfig {
    fn default() -> Self {
        Self {
            review_enabled: false,
            review_config: None,
            follow_up_enabled: false,
            auto_retry_on_failure: false,
            max_retry_count: 2,
            auto_create_pr: true,
            selected_account_id: None,
            selected_model_id: None,
            sub_agent_ids: Vec::new(),
            org_id: None,
            agent_mode: None,
            agent_definition_id: None,
            worktree_path: None,
            workspace_mode: None,
        }
    }
}

impl OrchestratorConfig {
    /// Resolve the effective review configuration.
    /// `review_config` takes priority; falls back to legacy `review_enabled`.
    pub fn effective_review_config(&self) -> Option<ReviewConfig> {
        if self.review_config.is_some() {
            return self.review_config.clone();
        }
        if self.review_enabled {
            return Some(ReviewConfig::default());
        }
        None
    }
}

/// Orchestrator runtime state (managed by orchestrator, not user-editable)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OrchestratorState {
    #[serde(default)]
    pub current_phase: OrchestratorPhase,
    #[serde(default)]
    pub retry_count: u32,
    /// Current review iteration (0 = first review, increments on each ChangesRequested cycle).
    #[serde(default)]
    pub review_round: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_failure: Option<LastFailure>,
    #[serde(default)]
    pub interrupted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interrupted_phase: Option<OrchestratorPhase>,
    /// Snapshot of OrchestratorConfig taken when workflow starts (idle -> coding).
    /// All phase transitions read from this, not from orchestrator_config.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_config: Option<OrchestratorConfig>,
}

impl Default for OrchestratorState {
    fn default() -> Self {
        Self {
            current_phase: OrchestratorPhase::Idle,
            retry_count: 0,
            review_round: 0,
            last_failure: None,
            interrupted: false,
            interrupted_phase: None,
            active_config: None,
        }
    }
}

/// Project-level defaults for agent workflows
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentDefaults {
    #[serde(default)]
    pub orchestrator_config: OrchestratorConfig,
}

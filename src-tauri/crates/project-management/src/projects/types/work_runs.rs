//! Durable Work Item execution and dispatch wire types.
//!
//! A Work Item Run is one execution episode. It is deliberately separate
//! from the Work Item lifecycle (product intent) and linked Session lifecycle
//! (runtime transport). `pm_dispatch_outbox` owns delivery attempts; neither
//! a delivered dispatch nor a terminal Session may silently complete the
//! Work Item.

use serde::{Deserialize, Serialize};

use super::WorkspaceExecutionMode;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkItemRunStatus {
    Queued,
    Deferred,
    Dispatching,
    Running,
    Waiting,
    Succeeded,
    Failed,
    Cancelled,
}

impl WorkItemRunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Deferred => "deferred",
            Self::Dispatching => "dispatching",
            Self::Running => "running",
            Self::Waiting => "waiting",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Cancelled)
    }
}

impl TryFrom<&str> for WorkItemRunStatus {
    type Error = String;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "queued" => Ok(Self::Queued),
            "deferred" => Ok(Self::Deferred),
            "dispatching" => Ok(Self::Dispatching),
            "running" => Ok(Self::Running),
            "waiting" => Ok(Self::Waiting),
            "succeeded" => Ok(Self::Succeeded),
            "failed" => Ok(Self::Failed),
            "cancelled" => Ok(Self::Cancelled),
            other => Err(format!("unknown Work Item Run status '{other}'")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum WorkItemRunTrigger {
    Manual,
    Schedule {
        schedule_key: String,
    },
    Routine {
        routine_id: String,
        fire_id: String,
    },
    DiscussionComment {
        comment_id: String,
        author_id: Option<String>,
    },
    StageBarrier {
        parent_work_item_id: String,
        stage: Option<u32>,
        settled_key: String,
    },
    Review {
        previous_run_id: String,
    },
    FollowUp {
        previous_run_id: String,
    },
    Retry {
        previous_run_id: String,
    },
}

impl WorkItemRunTrigger {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::Schedule { .. } => "schedule",
            Self::Routine { .. } => "routine",
            Self::DiscussionComment { .. } => "discussion_comment",
            Self::StageBarrier { .. } => "stage_barrier",
            Self::Review { .. } => "review",
            Self::FollowUp { .. } => "follow_up",
            Self::Retry { .. } => "retry",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum WorkItemRunTarget {
    StartWorkItem {
        account_id: Option<String>,
        model_id: Option<String>,
    },
    ResumeSession {
        session_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkItemRunTargetSnapshot {
    pub target: WorkItemRunTarget,
    pub work_item_revision: i64,
    /// Immutable work-item content used to build the execution brief. Older
    /// Runs deserialize these as `None` and retain the legacy live-read path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work_item_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work_item_body: Option<String>,
    /// Project context and repository identity captured when the Run is
    /// enqueued. Dispatch must not silently switch repositories after a
    /// project or Work Item is edited.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_description: Option<String>,
    pub workspace_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_branch: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub linked_repositories: Vec<String>,
    /// Explicit escape hatch for environments that deliberately coordinate a
    /// shared checkout outside ORG2. The safe default is one active Run per
    /// resolved workspace path.
    #[serde(default)]
    pub allow_shared_checkout: bool,
    /// Immutable launch interpretation for `workspace_path`. This prevents a
    /// local checkout from being reinterpreted as a Git worktree at dispatch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_mode: Option<WorkspaceExecutionMode>,
    pub agent_definition_id: Option<String>,
    pub agent_org_id: Option<String>,
}

impl WorkItemRunTargetSnapshot {
    pub fn new(target: WorkItemRunTarget) -> Self {
        Self {
            target,
            work_item_revision: 0,
            work_item_title: None,
            work_item_body: None,
            project_description: None,
            workspace_path: None,
            repository: None,
            repository_ref: None,
            default_branch: None,
            linked_repositories: Vec::new(),
            allow_shared_checkout: false,
            workspace_mode: None,
            agent_definition_id: None,
            agent_org_id: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkItemRunFailureClass {
    TransientNetwork,
    ProviderUnavailable,
    Timeout,
    Authentication,
    Authorization,
    Quota,
    Configuration,
    InvalidInput,
    Model,
    ContextOverflow,
    Runtime,
    Cancelled,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkItemRunRetryDisposition {
    ResumeSession,
    StartNewSession,
    DoNotRetry,
    ManualReview,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkItemRunFailure {
    pub class: WorkItemRunFailureClass,
    pub code: String,
    pub message: String,
    pub retryable: bool,
    pub retry_disposition: WorkItemRunRetryDisposition,
    pub occurred_at: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkItemRunUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub total_tokens: u64,
    pub cost_usd: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkItemRun {
    pub id: String,
    pub project_slug: Option<String>,
    pub org_id: String,
    pub work_item_id: String,
    pub trigger: WorkItemRunTrigger,
    pub target_snapshot: WorkItemRunTargetSnapshot,
    pub input: serde_json::Value,
    pub status: WorkItemRunStatus,
    pub attempt: u32,
    pub max_attempts: u32,
    pub parent_run_id: Option<String>,
    pub session_id: Option<String>,
    pub failure: Option<WorkItemRunFailure>,
    pub usage: WorkItemRunUsage,
    pub idempotency_key: String,
    pub generation: u64,
    pub created_at: String,
    pub updated_at: String,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnqueueWorkItemRunRequest {
    pub project_slug: Option<String>,
    pub org_id: String,
    pub work_item_id: String,
    pub trigger: WorkItemRunTrigger,
    pub target_snapshot: WorkItemRunTargetSnapshot,
    #[serde(default)]
    pub input: serde_json::Value,
    pub idempotency_key: String,
    #[serde(default = "default_run_max_attempts")]
    pub max_attempts: u32,
    pub parent_run_id: Option<String>,
}

pub fn default_run_max_attempts() -> u32 {
    3
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkItemDispatchStatus {
    Pending,
    Leased,
    RetryWait,
    Delivered,
    DeadLetter,
    Cancelled,
}

impl WorkItemDispatchStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Leased => "leased",
            Self::RetryWait => "retry_wait",
            Self::Delivered => "delivered",
            Self::DeadLetter => "dead_letter",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkItemDispatchLease {
    pub dispatch_id: String,
    pub lease_token: String,
    pub lease_owner: String,
    pub lease_expires_at: String,
    pub delivery_attempt: u32,
    pub run: WorkItemRun,
}

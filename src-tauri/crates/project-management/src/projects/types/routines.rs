//! Routine definitions and fire records.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RoutineTrigger {
    OneTime {
        at: String,
    },
    Cron {
        cron: String,
        #[serde(default = "default_routine_timezone")]
        timezone: String,
    },
}

pub fn default_routine_timezone() -> String {
    "UTC".to_string()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RoutineFireStatus {
    Pending,
    Started,
    Succeeded,
    Failed,
    Skipped,
    Coalesced,
    Queued,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RoutineOutputMode {
    DirectSession,
    CreateWorkItem,
    UpdateExistingWorkItem,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RoutineConcurrencyPolicy {
    CoalesceIfActive,
    SkipIfActive,
    QueueIfActive,
    AlwaysCreate,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RoutineCatchUpPolicy {
    SkipMissed,
    RunOnce,
    RunAllLimited,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineOutputPolicy {
    pub mode: RoutineOutputMode,
    pub concurrency_policy: RoutineConcurrencyPolicy,
    pub catch_up_policy: RoutineCatchUpPolicy,
    pub max_catch_up_runs: u32,
    pub idempotency_scope: String,
    pub create_work_item_status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub create_work_item_project_slug: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub create_work_item_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub create_work_item_body: Option<String>,
    /// CreateWorkItem mode: immediately start the created work item's
    /// orchestrator workflow (project-scoped items only).
    ///
    /// Serde default is `false`: policies stored before this field existed
    /// (and e2e contract fixtures) keep their "create into backlog, fire
    /// succeeds immediately" behavior. The wizard sets `true` for new
    /// routines.
    #[serde(default)]
    pub auto_start: bool,
    /// UpdateExistingWorkItem mode: target work item short_id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub update_work_item_short_id: Option<String>,
    /// UpdateExistingWorkItem mode: project slug of the target work item.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub update_work_item_project_slug: Option<String>,
}

impl Default for RoutineOutputPolicy {
    fn default() -> Self {
        Self {
            mode: RoutineOutputMode::DirectSession,
            concurrency_policy: RoutineConcurrencyPolicy::CoalesceIfActive,
            catch_up_policy: RoutineCatchUpPolicy::RunOnce,
            max_catch_up_runs: 1,
            idempotency_scope: "routine_fire".to_string(),
            create_work_item_status: "planned".to_string(),
            create_work_item_project_slug: None,
            create_work_item_title: None,
            create_work_item_body: None,
            auto_start: false,
            update_work_item_short_id: None,
            update_work_item_project_slug: None,
        }
    }
}

fn default_output_policy() -> RoutineOutputPolicy {
    RoutineOutputPolicy::default()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum RoutineRunTarget {
    AgentDefinition { agent_definition_id: Option<String> },
    AgentOrg { agent_org_id: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineResourceSelection {
    pub key_source: Option<String>,
    pub account_id: Option<String>,
    pub model: Option<String>,
    pub native_harness_type: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum RoutineWorkspaceTarget {
    None,
    LocalWorkspace {
        workspace_path: String,
        additional_directories: Vec<String>,
    },
    Worktree {
        workspace_path: String,
        worktree_path: Option<String>,
        branch: Option<String>,
        create_isolated: bool,
        additional_directories: Vec<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineRunTemplate {
    pub prompt: String,
    pub target: RoutineRunTarget,
    pub resources: RoutineResourceSelection,
    pub workspace: RoutineWorkspaceTarget,
    pub mode: Option<String>,
    pub name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineDefinition {
    pub id: String,
    pub name: String,
    pub description: String,
    pub enabled: bool,
    pub trigger: RoutineTrigger,
    pub run_template: RoutineRunTemplate,
    #[serde(default = "default_output_policy")]
    pub output_policy: RoutineOutputPolicy,
    /// Scheduler evaluation watermark (ISO 8601). Triggers due in
    /// `(last_evaluated_at, now]` are fired on each scheduler tick.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_evaluated_at: Option<String>,
    /// Next computed fire time (ISO 8601), for display only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_fire_at: Option<String>,
    /// Latest occurrence summary, projected from `routine_fires` for list UI.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_fire_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_fire_status: Option<RoutineFireStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_fire_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_fire_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_fire_work_item_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineFire {
    pub id: String,
    pub routine_id: String,
    pub fired_at: String,
    pub status: RoutineFireStatus,
    pub session_id: Option<String>,
    pub agent_org_run_id: Option<String>,
    pub work_item_id: Option<String>,
    pub coalesced_into_fire_id: Option<String>,
    pub idempotency_key: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkItemRoutineSource {
    pub routine_id: String,
    pub routine_fire_id: String,
    pub routine_name: String,
    pub fired_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineFireResult {
    pub fire: RoutineFire,
    pub session_id: Option<String>,
    pub agent_org_run_id: Option<String>,
}

//! Serde payload types shared by the benchmark commands and the frontend.

use std::collections::HashMap;

use agent_core::definitions::orgs::OrgMemberLaunchOverride;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkListTasksRequest {
    pub kind: String,
    pub source_path: String,
    pub query: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkGetTaskRequest {
    pub kind: String,
    pub source_path: String,
    pub task_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkPreflightRequest {
    pub kind: String,
    pub source_path: String,
    pub evaluation_mode: String,
    pub task_id: Option<String>,
    pub repo_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkCreateRunPlanRequest {
    pub kind: String,
    pub source_path: String,
    pub task_id: String,
    pub patch: String,
    pub evaluation_mode: String,
    pub repo_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkStartRunRequest {
    pub kind: String,
    pub source_path: String,
    pub task_id: String,
    pub patch: String,
    pub evaluation_mode: String,
    pub repo_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkGetRunStatusRequest {
    pub run_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkCancelRunRequest {
    pub run_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkAgentLaunchSelection {
    pub category: String,
    pub workspace_path: Option<String>,
    pub key_source: Option<String>,
    pub account_id: Option<String>,
    pub model: Option<String>,
    pub native_harness_type: Option<String>,
    pub platform: Option<String>,
    pub branch: Option<String>,
    pub hosted_token: Option<String>,
    pub tier: Option<String>,
    pub agent_definition_id: Option<String>,
    pub agent_org_id: Option<String>,
    #[serde(default)]
    pub agent_org_member_overrides: HashMap<String, OrgMemberLaunchOverride>,
    #[serde(default)]
    pub apply_agent_org_member_overrides_for_future: bool,
    #[serde(default)]
    pub isolate: bool,
    pub mode: Option<String>,
    pub worktree_path: Option<String>,
    pub project_slug: Option<String>,
    #[serde(default)]
    pub additional_directories: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkStartAgentBatchRequest {
    pub kind: String,
    pub source_path: String,
    pub task_ids: Vec<String>,
    pub launch: BenchmarkAgentLaunchSelection,
    pub concurrency: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkGetAgentBatchStatusRequest {
    pub batch_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkCancelAgentBatchRequest {
    pub batch_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkEvaluateAgentBatchRequest {
    pub batch_id: String,
    pub evaluation_mode: Option<String>,
    #[serde(default)]
    pub task_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkUpdateAgentBatchTasksRequest {
    pub batch_id: String,
    pub action: String,
    #[serde(default)]
    pub task_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkListAgentBatchHistoriesRequest {
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkAgentBatchItem {
    pub task_id: String,
    pub status: String,
    pub session_id: Option<String>,
    pub session_name: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub error: Option<String>,
    pub logs: Vec<String>,
    #[serde(default)]
    pub submitted_patch_path: Option<String>,
    #[serde(default)]
    pub evaluation_run_id: Option<String>,
    #[serde(default)]
    pub evaluation_status: Option<String>,
    #[serde(default)]
    pub evaluation_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkAgentBatchStatus {
    pub batch_id: String,
    pub benchmark_kind: String,
    pub source_path: String,
    #[serde(default)]
    pub launch: Option<BenchmarkAgentLaunchSelection>,
    pub master_session_id: String,
    pub master_session_name: String,
    pub status: String,
    pub total_tasks: usize,
    pub queued: usize,
    pub running: usize,
    pub launched: usize,
    pub failed: usize,
    pub cancelled: usize,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub concurrency: usize,
    pub items: Vec<BenchmarkAgentBatchItem>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkTaskIndexRow {
    pub benchmark_kind: String,
    pub task_id: String,
    pub title: String,
    pub source_path: String,
    pub repo: Option<String>,
    pub word_count: usize,
    pub char_count: usize,
    pub tags: Vec<String>,
    pub difficulty: Option<String>,
    pub metadata: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkTaskDetail {
    #[serde(flatten)]
    pub index: BenchmarkTaskIndexRow,
    pub instruction: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkPreflightCheck {
    pub id: String,
    pub label: String,
    pub ok: bool,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkPreflightResult {
    pub benchmark_kind: String,
    pub evaluation_mode: String,
    pub ready: bool,
    pub checks: Vec<BenchmarkPreflightCheck>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkRunPlan {
    pub run_id: String,
    pub benchmark_kind: String,
    pub evaluation_mode: String,
    pub task_id: String,
    pub source_path: String,
    pub repo_path: Option<String>,
    pub patch_path: String,
    pub output_dir: String,
    pub evaluator_script: Option<String>,
    pub scripts_dir: Option<String>,
    pub worktree_path: Option<String>,
    pub command_preview: Vec<String>,
    pub preflight: BenchmarkPreflightResult,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchmarkRunStatus {
    pub run_id: String,
    pub benchmark_kind: String,
    pub evaluation_mode: String,
    pub task_id: String,
    pub status: String,
    pub source_path: String,
    pub repo_path: Option<String>,
    pub patch_path: String,
    pub output_dir: String,
    pub worktree_path: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub exit_code: Option<i32>,
    pub process_id: Option<u32>,
    pub logs: Vec<String>,
    pub result: Option<Value>,
    pub error: Option<String>,
}

use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use agent_core::definitions::orgs::{AgentOrgsStore, OrgMemberLaunchOverride};
use agent_core::session::persistence::{
    self as session_persistence, session_type, UnifiedSessionRecord,
};
use agent_core::state::commands::session::launch::{
    session_launch_impl, SessionLaunchParams, SessionLaunchResult,
};
use agent_core::state::control_flow::CancelReason;
use agent_core::state::AgentAppState;
use chrono::{Local, Utc};
use core_types::key_source::KeySource;
use git::worktree::create_session_worktree;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::Manager;
use tokio::io::{AsyncBufReadExt, BufReader as TokioBufReader};
use tokio::process::Command;
use tokio::sync::{Mutex, Semaphore};
use uuid::Uuid;

const BENCHMARK_KIND_SWE_BENCH_PRO: &str = "swe_bench_pro";
const BENCHMARK_KIND_TERMINAL_BENCH: &str = "terminal_bench";
const EVALUATION_MODE_PATCH_ONLY: &str = "patch_only";
const EVALUATION_MODE_LOCAL_DOCKER: &str = "local_docker";
const EVALUATION_MODE_MODAL: &str = "modal";
const BENCHMARK_RUN_STATUS_RUNNING: &str = "running";
const BENCHMARK_RUN_STATUS_PASSED: &str = "passed";
const BENCHMARK_RUN_STATUS_FAILED: &str = "failed";
const BENCHMARK_RUN_STATUS_CANCELLED: &str = "cancelled";
const BENCHMARK_RUN_STATUS_APPLIED: &str = "applied";
const BENCHMARK_AGENT_BATCH_STATUS_QUEUED: &str = "queued";
const BENCHMARK_AGENT_BATCH_STATUS_RUNNING: &str = "running";
const BENCHMARK_AGENT_BATCH_STATUS_LAUNCHED: &str = "launched";
const BENCHMARK_AGENT_BATCH_STATUS_FAILED: &str = "failed";
const BENCHMARK_AGENT_BATCH_STATUS_CANCELLED: &str = "cancelled";
const BENCHMARK_AGENT_SUBMISSIONS_DIR: &str = ".orgii/benchmark-results";
const BENCHMARK_AGENT_SUBMISSION_PATCH_FILE: &str = "solution.patch";
const BENCHMARK_BATCH_TASK_ACTION_ADD: &str = "add";
const BENCHMARK_BATCH_TASK_ACTION_REMOVE: &str = "remove";
const BENCHMARK_BATCH_TASK_ACTION_CANCEL: &str = "cancel";
const BENCHMARK_BATCH_TASK_ACTION_RESTART: &str = "restart";
const DEFAULT_AGENT_BATCH_CONCURRENCY: usize = 2;
const MAX_AGENT_BATCH_CONCURRENCY: usize = 8;
const SWE_BENCH_PRO_REPO_PATH: &str = "/Users/laptop-h/Documents/GitHub/SWE-bench_Pro-os";
const SWE_BENCH_PRO_EVALUATOR_SCRIPT: &str = "swe_bench_pro_eval.py";
const SWE_BENCH_PRO_RUN_SCRIPTS_DIR: &str = "run_scripts";
const SWE_BENCH_PRO_DOCKERHUB_USERNAME: &str = "jefzda";
const SWE_BENCH_PRO_DATASET_CANDIDATES: &[&str] = &[
    "helper_code/sweap_eval_full_v2.jsonl",
    "sweap_eval_full_v2.jsonl",
    "swe_bench_pro.jsonl",
    "swe-bench-pro.jsonl",
];
const E2E_DOCKER_BENCHMARK_TASK_ID: &str = "e2e_docker_task";
const BENCHMARK_PYTHON_PACKAGES: &[&str] = &["docker", "numpy", "pandas"];
const MAX_RUN_LOG_LINES: usize = 1_000;

static BENCHMARK_RUNS: LazyLock<Arc<Mutex<HashMap<String, BenchmarkRunStatus>>>> =
    LazyLock::new(|| Arc::new(Mutex::new(HashMap::new())));
static BENCHMARK_AGENT_BATCHES: LazyLock<Arc<Mutex<HashMap<String, BenchmarkAgentBatchStatus>>>> =
    LazyLock::new(|| Arc::new(Mutex::new(HashMap::new())));

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

#[tauri::command]
pub async fn benchmark_list_tasks(
    request: BenchmarkListTasksRequest,
) -> Result<Vec<BenchmarkTaskIndexRow>, String> {
    ensure_swe_bench_pro(&request.kind)?;
    let query = request.query.unwrap_or_default().to_lowercase();
    let limit = request.limit.unwrap_or(250);
    let mut rows = Vec::new();

    for row in read_swe_bench_rows(&request.source_path)? {
        let detail = swe_bench_row_to_detail(&request.source_path, row)?;
        if !query.is_empty() && !task_matches_query(&detail, &query) {
            continue;
        }
        rows.push(detail.index);
        if rows.len() >= limit {
            break;
        }
    }

    Ok(rows)
}

#[tauri::command]
pub async fn benchmark_get_task(
    request: BenchmarkGetTaskRequest,
) -> Result<BenchmarkTaskDetail, String> {
    ensure_swe_bench_pro(&request.kind)?;
    read_swe_bench_task(&request.source_path, &request.task_id)
}

#[tauri::command]
pub async fn benchmark_preflight(
    request: BenchmarkPreflightRequest,
) -> Result<BenchmarkPreflightResult, String> {
    match request.kind.as_str() {
        BENCHMARK_KIND_SWE_BENCH_PRO => {
            run_swe_bench_preflight(
                &request.kind,
                &request.source_path,
                &request.evaluation_mode,
                request.task_id.as_deref(),
                request.repo_path.as_deref(),
            )
            .await
        }
        BENCHMARK_KIND_TERMINAL_BENCH => {
            run_terminal_bench_preflight(&request.source_path, &request.evaluation_mode).await
        }
        other => Err(format!("Unsupported benchmark kind: {other}")),
    }
}

#[tauri::command]
pub async fn benchmark_create_run_plan(
    request: BenchmarkCreateRunPlanRequest,
) -> Result<BenchmarkRunPlan, String> {
    ensure_swe_bench_pro(&request.kind)?;
    ensure_supported_swe_bench_mode(&request.evaluation_mode)?;
    let plan = build_swe_bench_run_plan(
        &request.kind,
        &request.source_path,
        &request.task_id,
        &request.patch,
        &request.evaluation_mode,
        request.repo_path.as_deref(),
    )
    .await?;
    Ok(plan)
}

#[tauri::command]
pub async fn benchmark_start_run(
    request: BenchmarkStartRunRequest,
) -> Result<BenchmarkRunStatus, String> {
    ensure_swe_bench_pro(&request.kind)?;
    ensure_supported_swe_bench_mode(&request.evaluation_mode)?;
    let plan = build_swe_bench_run_plan(
        &request.kind,
        &request.source_path,
        &request.task_id,
        &request.patch,
        &request.evaluation_mode,
        request.repo_path.as_deref(),
    )
    .await?;
    if !plan.preflight.ready && !is_e2e_docker_benchmark_task(&plan) {
        return Err(format!(
            "Benchmark preflight is not ready for {} execution",
            plan.evaluation_mode
        ));
    }

    if plan.evaluation_mode == EVALUATION_MODE_PATCH_ONLY {
        return run_swe_bench_patch_only_worktree(plan).await;
    }

    let status = BenchmarkRunStatus {
        run_id: plan.run_id.clone(),
        benchmark_kind: plan.benchmark_kind.clone(),
        evaluation_mode: plan.evaluation_mode.clone(),
        task_id: plan.task_id.clone(),
        status: BENCHMARK_RUN_STATUS_RUNNING.to_string(),
        source_path: plan.source_path.clone(),
        repo_path: plan.repo_path.clone(),
        patch_path: plan.patch_path.clone(),
        output_dir: plan.output_dir.clone(),
        worktree_path: plan.worktree_path.clone(),
        started_at: Some(Utc::now().to_rfc3339()),
        finished_at: None,
        exit_code: None,
        process_id: None,
        logs: vec![format!("Starting SWE-bench Pro Docker run {}", plan.run_id)],
        result: None,
        error: None,
    };

    BENCHMARK_RUNS
        .lock()
        .await
        .insert(plan.run_id.clone(), status.clone());

    tokio::spawn(run_swe_bench_process(plan));

    Ok(status)
}

#[tauri::command]
pub async fn benchmark_get_run_status(
    request: BenchmarkGetRunStatusRequest,
) -> Result<BenchmarkRunStatus, String> {
    BENCHMARK_RUNS
        .lock()
        .await
        .get(&request.run_id)
        .cloned()
        .ok_or_else(|| format!("Benchmark run not found: {}", request.run_id))
}

#[tauri::command]
pub async fn benchmark_cancel_run(
    request: BenchmarkCancelRunRequest,
) -> Result<BenchmarkRunStatus, String> {
    let process_id = {
        let mut runs = BENCHMARK_RUNS.lock().await;
        let status = runs
            .get_mut(&request.run_id)
            .ok_or_else(|| format!("Benchmark run not found: {}", request.run_id))?;
        if status.status == BENCHMARK_RUN_STATUS_RUNNING {
            status.status = BENCHMARK_RUN_STATUS_CANCELLED.to_string();
            status.finished_at = Some(Utc::now().to_rfc3339());
            status
                .logs
                .push("Cancel requested for evaluator process.".to_string());
            trim_logs(&mut status.logs);
        }
        status.process_id
    };

    if let Some(pid) = process_id {
        terminate_process(pid).await?;
    }

    BENCHMARK_RUNS
        .lock()
        .await
        .get(&request.run_id)
        .cloned()
        .ok_or_else(|| format!("Benchmark run not found: {}", request.run_id))
}

#[tauri::command]
pub async fn benchmark_start_agent_batch(
    app_handle: tauri::AppHandle,
    mut request: BenchmarkStartAgentBatchRequest,
) -> Result<BenchmarkAgentBatchStatus, String> {
    ensure_swe_bench_pro(&request.kind)?;
    if request.task_ids.is_empty() {
        return Err("Select at least one benchmark task to launch.".to_string());
    }
    let workspace_path = request
        .launch
        .workspace_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .ok_or_else(|| "Set a working directory before launching benchmark agents.".to_string())?
        .to_string();
    fs::create_dir_all(&workspace_path).map_err(|error| {
        format!("Failed to create benchmark working directory {workspace_path}: {error}")
    })?;
    request.launch.workspace_path = Some(workspace_path.clone());

    let concurrency = request
        .concurrency
        .unwrap_or(DEFAULT_AGENT_BATCH_CONCURRENCY)
        .clamp(1, MAX_AGENT_BATCH_CONCURRENCY);
    let batch_id = Uuid::new_v4().to_string();
    let master_session_name = benchmark_session_name(&request.kind);
    let master_session_id = create_benchmark_master_session(
        &master_session_name,
        &request.kind,
        &request.source_path,
        &request.launch,
    )?;
    let created_at = Utc::now().to_rfc3339();
    let items = request
        .task_ids
        .iter()
        .map(|task_id| create_agent_batch_item(task_id, &workspace_path))
        .collect::<Vec<_>>();
    let status = BenchmarkAgentBatchStatus {
        batch_id: batch_id.clone(),
        benchmark_kind: request.kind.clone(),
        source_path: request.source_path.clone(),
        launch: Some(request.launch.clone()),
        master_session_id: master_session_id.clone(),
        master_session_name: master_session_name.clone(),
        status: BENCHMARK_AGENT_BATCH_STATUS_RUNNING.to_string(),
        total_tasks: items.len(),
        queued: items.len(),
        running: 0,
        launched: 0,
        failed: 0,
        cancelled: 0,
        created_at,
        started_at: Some(Utc::now().to_rfc3339()),
        finished_at: None,
        concurrency,
        items,
        error: None,
    };

    BENCHMARK_AGENT_BATCHES
        .lock()
        .await
        .insert(batch_id.clone(), status);
    persist_agent_batch_by_id(&batch_id).await?;

    let semaphore = Arc::new(Semaphore::new(concurrency));
    for task_id in request.task_ids {
        let app_handle = app_handle.clone();
        let batch_id = batch_id.clone();
        let kind = request.kind.clone();
        let source_path = request.source_path.clone();
        let launch = request.launch.clone();
        let master_session_id = master_session_id.clone();
        let semaphore = Arc::clone(&semaphore);
        tauri::async_runtime::spawn(async move {
            let Ok(_permit) = semaphore.acquire_owned().await else {
                mark_agent_batch_item_failed(
                    &batch_id,
                    &task_id,
                    "Launch queue closed before this task could start.".to_string(),
                )
                .await;
                return;
            };
            if is_agent_batch_cancelled(&batch_id).await {
                mark_agent_batch_item_cancelled(&batch_id, &task_id).await;
                return;
            }
            mark_agent_batch_item_running(&batch_id, &task_id).await;
            let detail = match read_swe_bench_task(&source_path, &task_id) {
                Ok(detail) => detail,
                Err(error) => {
                    mark_agent_batch_item_failed(&batch_id, &task_id, error).await;
                    return;
                }
            };
            if is_agent_batch_cancelled(&batch_id).await {
                mark_agent_batch_item_cancelled(&batch_id, &task_id).await;
                return;
            }
            let submitted_patch_path = launch
                .workspace_path
                .as_deref()
                .map(|path| benchmark_agent_submission_patch_path(path, &task_id))
                .unwrap_or_else(|| {
                    format!(
                        "{BENCHMARK_AGENT_SUBMISSIONS_DIR}/{task_id}/{BENCHMARK_AGENT_SUBMISSION_PATCH_FILE}"
                    )
                });
            let prompt = benchmark_agent_prompt(&kind, &detail, &submitted_patch_path);
            let params = benchmark_launch_params(
                &launch,
                prompt,
                Some(task_id.clone()),
                Some(master_session_id.clone()),
            );
            let state = app_handle.state::<AgentAppState>();
            let org_store = app_handle.state::<std::sync::Arc<AgentOrgsStore>>();
            match session_launch_impl(&state, Some(org_store.inner()), params).await {
                Ok(result) => {
                    mark_agent_batch_item_launched(&batch_id, &task_id, result).await;
                }
                Err(error) => {
                    mark_agent_batch_item_failed(&batch_id, &task_id, error).await;
                }
            }
        });
    }

    BENCHMARK_AGENT_BATCHES
        .lock()
        .await
        .get(&batch_id)
        .cloned()
        .ok_or_else(|| format!("Benchmark agent batch not found: {batch_id}"))
}

#[tauri::command]
pub async fn benchmark_get_agent_batch_status(
    request: BenchmarkGetAgentBatchStatusRequest,
) -> Result<BenchmarkAgentBatchStatus, String> {
    if let Some(status) = BENCHMARK_AGENT_BATCHES
        .lock()
        .await
        .get(&request.batch_id)
        .cloned()
    {
        return refresh_agent_batch_evaluations(status).await;
    }
    refresh_agent_batch_evaluations(load_agent_batch_history(&request.batch_id)?).await
}

#[tauri::command]
pub async fn benchmark_list_agent_batch_histories(
    request: BenchmarkListAgentBatchHistoriesRequest,
) -> Result<Vec<BenchmarkAgentBatchStatus>, String> {
    let mut histories = load_agent_batch_histories()?;
    histories.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    if let Some(limit) = request.limit {
        histories.truncate(limit);
    }
    Ok(histories)
}

async fn load_agent_batch_for_update(batch_id: &str) -> Result<BenchmarkAgentBatchStatus, String> {
    if let Some(status) = BENCHMARK_AGENT_BATCHES.lock().await.get(batch_id).cloned() {
        return Ok(status);
    }
    let status = load_agent_batch_history(batch_id)?;
    BENCHMARK_AGENT_BATCHES
        .lock()
        .await
        .insert(batch_id.to_string(), status.clone());
    Ok(status)
}

async fn persist_updated_agent_batch(
    mut batch: BenchmarkAgentBatchStatus,
) -> Result<BenchmarkAgentBatchStatus, String> {
    refresh_agent_batch_counts(&mut batch);
    BENCHMARK_AGENT_BATCHES
        .lock()
        .await
        .insert(batch.batch_id.clone(), batch.clone());
    persist_agent_batch_status(&batch)?;
    Ok(batch)
}

async fn refresh_agent_batch_evaluations(
    mut batch: BenchmarkAgentBatchStatus,
) -> Result<BenchmarkAgentBatchStatus, String> {
    let runs = BENCHMARK_RUNS.lock().await;
    let mut changed = false;
    for item in &mut batch.items {
        let Some(run_id) = item.evaluation_run_id.as_deref() else {
            continue;
        };
        let Some(run_status) = runs.get(run_id) else {
            continue;
        };
        if item.evaluation_status.as_deref() != Some(run_status.status.as_str()) {
            item.evaluation_status = Some(run_status.status.clone());
            changed = true;
        }
        if item.evaluation_error != run_status.error {
            item.evaluation_error = run_status.error.clone();
            changed = true;
        }
    }
    drop(runs);
    if changed {
        BENCHMARK_AGENT_BATCHES
            .lock()
            .await
            .insert(batch.batch_id.clone(), batch.clone());
        persist_agent_batch_status(&batch)?;
    }
    Ok(batch)
}

#[tauri::command]
pub async fn benchmark_evaluate_agent_batch(
    request: BenchmarkEvaluateAgentBatchRequest,
) -> Result<BenchmarkAgentBatchStatus, String> {
    let evaluation_mode = request
        .evaluation_mode
        .as_deref()
        .map(str::trim)
        .filter(|mode| !mode.is_empty())
        .unwrap_or(EVALUATION_MODE_LOCAL_DOCKER)
        .to_string();
    ensure_supported_swe_bench_mode(&evaluation_mode)?;

    let task_filter = if request.task_ids.is_empty() {
        None
    } else {
        Some(request.task_ids.iter().cloned().collect::<HashSet<_>>())
    };
    let mut batch = load_agent_batch_for_update(&request.batch_id).await?;
    let mut evaluation_requests = Vec::new();

    for item in &mut batch.items {
        if task_filter
            .as_ref()
            .is_some_and(|task_ids| !task_ids.contains(&item.task_id))
        {
            continue;
        }
        if item.session_id.is_none() {
            let error = "Agent session has not launched yet.".to_string();
            item.evaluation_status = Some(BENCHMARK_RUN_STATUS_FAILED.to_string());
            item.evaluation_error = Some(error.clone());
            item.logs.push(format!("Evaluation skipped: {error}"));
            trim_logs(&mut item.logs);
            continue;
        }
        let Some(submitted_patch_path) = item.submitted_patch_path.clone() else {
            let evaluation_error = format!(
                "Benchmark task {} does not have a patch submission path.",
                item.task_id
            );
            item.evaluation_status = Some(BENCHMARK_RUN_STATUS_FAILED.to_string());
            item.evaluation_error = Some(evaluation_error.clone());
            item.logs
                .push(format!("Evaluation skipped: {evaluation_error}"));
            trim_logs(&mut item.logs);
            continue;
        };
        let patch = match fs::read_to_string(&submitted_patch_path) {
            Ok(patch) => patch,
            Err(error) => {
                let evaluation_error =
                    format!("Failed to read submitted patch at {submitted_patch_path}: {error}");
                item.evaluation_status = Some(BENCHMARK_RUN_STATUS_FAILED.to_string());
                item.evaluation_error = Some(evaluation_error.clone());
                item.logs
                    .push(format!("Evaluation skipped: {evaluation_error}"));
                trim_logs(&mut item.logs);
                continue;
            }
        };
        if patch.trim().is_empty() {
            let evaluation_error = format!("Submitted patch is empty: {submitted_patch_path}");
            item.evaluation_status = Some(BENCHMARK_RUN_STATUS_FAILED.to_string());
            item.evaluation_error = Some(evaluation_error.clone());
            item.logs
                .push(format!("Evaluation skipped: {evaluation_error}"));
            trim_logs(&mut item.logs);
            continue;
        }
        evaluation_requests.push((item.task_id.clone(), submitted_patch_path, patch));
    }

    for (task_id, submitted_patch_path, patch) in evaluation_requests {
        let status = benchmark_start_run(BenchmarkStartRunRequest {
            kind: batch.benchmark_kind.clone(),
            source_path: batch.source_path.clone(),
            task_id: task_id.clone(),
            patch,
            evaluation_mode: evaluation_mode.clone(),
            repo_path: None,
        })
        .await?;
        if let Some(item) = batch.items.iter_mut().find(|item| item.task_id == task_id) {
            item.submitted_patch_path = Some(submitted_patch_path);
            item.evaluation_run_id = Some(status.run_id);
            item.evaluation_status = Some(status.status);
            item.evaluation_error = status.error;
            item.logs.push(format!(
                "Started benchmark evaluation from {}.",
                item.submitted_patch_path
                    .as_deref()
                    .unwrap_or("submitted patch")
            ));
            trim_logs(&mut item.logs);
        }
    }

    persist_updated_agent_batch(batch).await
}

#[tauri::command]
pub async fn benchmark_update_agent_batch_tasks(
    app_handle: tauri::AppHandle,
    request: BenchmarkUpdateAgentBatchTasksRequest,
) -> Result<BenchmarkAgentBatchStatus, String> {
    if request.task_ids.is_empty() {
        return Err("Select at least one benchmark task.".to_string());
    }
    let mut batch = load_agent_batch_for_update(&request.batch_id).await?;
    let launch = batch
        .launch
        .clone()
        .ok_or_else(|| "This benchmark batch is missing launch settings.".to_string())?;
    let workspace_path = launch
        .workspace_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .ok_or_else(|| "This benchmark batch is missing a working directory.".to_string())?
        .to_string();
    let task_ids = request.task_ids.iter().cloned().collect::<HashSet<_>>();
    let now = Utc::now().to_rfc3339();
    let mut task_ids_to_spawn = Vec::new();

    match request.action.as_str() {
        BENCHMARK_BATCH_TASK_ACTION_ADD => {
            batch.status = BENCHMARK_AGENT_BATCH_STATUS_RUNNING.to_string();
            batch.finished_at = None;
            let existing_task_ids = batch
                .items
                .iter()
                .map(|item| item.task_id.clone())
                .collect::<HashSet<_>>();
            for task_id in &request.task_ids {
                if existing_task_ids.contains(task_id) {
                    continue;
                }
                batch
                    .items
                    .push(create_agent_batch_item(task_id, &workspace_path));
                task_ids_to_spawn.push(task_id.clone());
            }
        }
        BENCHMARK_BATCH_TASK_ACTION_REMOVE => {
            for item in &mut batch.items {
                if task_ids.contains(&item.task_id) && item.session_id.is_some() {
                    cancel_agent_batch_item_session(&app_handle, item).await;
                    item.status = BENCHMARK_AGENT_BATCH_STATUS_CANCELLED.to_string();
                    item.finished_at = Some(now.clone());
                    item.logs
                        .push("Cancelled; launched sessions stay in history.".to_string());
                    trim_logs(&mut item.logs);
                }
            }
            batch
                .items
                .retain(|item| !(task_ids.contains(&item.task_id) && item.session_id.is_none()));
        }
        BENCHMARK_BATCH_TASK_ACTION_CANCEL => {
            for item in &mut batch.items {
                if !task_ids.contains(&item.task_id) {
                    continue;
                }
                cancel_agent_batch_item_session(&app_handle, item).await;
                item.status = BENCHMARK_AGENT_BATCH_STATUS_CANCELLED.to_string();
                item.finished_at = Some(now.clone());
                item.logs.push("Cancelled by user.".to_string());
                trim_logs(&mut item.logs);
            }
        }
        BENCHMARK_BATCH_TASK_ACTION_RESTART => {
            batch.status = BENCHMARK_AGENT_BATCH_STATUS_RUNNING.to_string();
            batch.finished_at = None;
            for task_id in &request.task_ids {
                if let Some(item) = batch.items.iter_mut().find(|item| item.task_id == *task_id) {
                    cancel_agent_batch_item_session(&app_handle, item).await;
                    *item = create_agent_batch_item(task_id, &workspace_path);
                } else {
                    batch
                        .items
                        .push(create_agent_batch_item(task_id, &workspace_path));
                }
                task_ids_to_spawn.push(task_id.clone());
            }
        }
        other => return Err(format!("Unsupported benchmark batch task action: {other}")),
    }

    batch.total_tasks = batch.items.len();
    let updated_batch = persist_updated_agent_batch(batch).await?;
    for task_id in task_ids_to_spawn {
        spawn_agent_batch_task(
            app_handle.clone(),
            updated_batch.batch_id.clone(),
            updated_batch.benchmark_kind.clone(),
            updated_batch.source_path.clone(),
            launch.clone(),
            updated_batch.master_session_id.clone(),
            task_id,
        );
    }
    Ok(updated_batch)
}

#[tauri::command]
pub async fn benchmark_cancel_agent_batch(
    request: BenchmarkCancelAgentBatchRequest,
) -> Result<BenchmarkAgentBatchStatus, String> {
    let mut batches = BENCHMARK_AGENT_BATCHES.lock().await;
    let batch = batches
        .get_mut(&request.batch_id)
        .ok_or_else(|| format!("Benchmark agent batch not found: {}", request.batch_id))?;
    let now = Utc::now().to_rfc3339();
    for item in &mut batch.items {
        if item.status == BENCHMARK_AGENT_BATCH_STATUS_QUEUED {
            item.status = BENCHMARK_AGENT_BATCH_STATUS_CANCELLED.to_string();
            item.finished_at = Some(now.clone());
            item.logs.push("Cancelled before launch.".to_string());
            trim_logs(&mut item.logs);
        }
    }
    batch.status = BENCHMARK_AGENT_BATCH_STATUS_CANCELLED.to_string();
    batch.finished_at = Some(now);
    refresh_agent_batch_counts(batch);
    let status = batch.clone();
    drop(batches);
    persist_agent_batch_status(&status)?;
    Ok(status)
}

fn create_agent_batch_item(task_id: &str, workspace_path: &str) -> BenchmarkAgentBatchItem {
    BenchmarkAgentBatchItem {
        task_id: task_id.to_string(),
        status: BENCHMARK_AGENT_BATCH_STATUS_QUEUED.to_string(),
        session_id: None,
        session_name: None,
        started_at: None,
        finished_at: None,
        error: None,
        logs: vec!["Queued for agent launch.".to_string()],
        submitted_patch_path: Some(benchmark_agent_submission_patch_path(
            workspace_path,
            task_id,
        )),
        evaluation_run_id: None,
        evaluation_status: None,
        evaluation_error: None,
    }
}

async fn is_agent_batch_cancelled(batch_id: &str) -> bool {
    BENCHMARK_AGENT_BATCHES
        .lock()
        .await
        .get(batch_id)
        .is_some_and(|batch| batch.status == BENCHMARK_AGENT_BATCH_STATUS_CANCELLED)
}

async fn mark_agent_batch_item_running(batch_id: &str, task_id: &str) {
    update_agent_batch_item(batch_id, task_id, |item| {
        item.status = BENCHMARK_AGENT_BATCH_STATUS_RUNNING.to_string();
        item.started_at = Some(Utc::now().to_rfc3339());
        item.logs
            .push("Launching background agent session.".to_string());
        trim_logs(&mut item.logs);
    })
    .await;
}

async fn mark_agent_batch_item_cancelled(batch_id: &str, task_id: &str) {
    update_agent_batch_item(batch_id, task_id, |item| {
        item.status = BENCHMARK_AGENT_BATCH_STATUS_CANCELLED.to_string();
        item.finished_at = Some(Utc::now().to_rfc3339());
        item.logs.push("Cancelled before agent launch.".to_string());
        trim_logs(&mut item.logs);
    })
    .await;
}

async fn mark_agent_batch_item_launched(
    batch_id: &str,
    task_id: &str,
    result: SessionLaunchResult,
) {
    update_agent_batch_item(batch_id, task_id, |item| {
        item.status = BENCHMARK_AGENT_BATCH_STATUS_LAUNCHED.to_string();
        item.session_id = Some(result.session_id);
        item.session_name = Some(result.name);
        item.finished_at = Some(Utc::now().to_rfc3339());
        item.logs
            .push("Background agent session launched.".to_string());
        trim_logs(&mut item.logs);
    })
    .await;
}

async fn mark_agent_batch_item_failed(batch_id: &str, task_id: &str, error: String) {
    update_agent_batch_item(batch_id, task_id, |item| {
        item.status = BENCHMARK_AGENT_BATCH_STATUS_FAILED.to_string();
        item.finished_at = Some(Utc::now().to_rfc3339());
        item.error = Some(error.clone());
        item.logs.push(format!("Launch failed: {error}"));
        trim_logs(&mut item.logs);
    })
    .await;
}

async fn cancel_agent_batch_item_session(
    app_handle: &tauri::AppHandle,
    item: &BenchmarkAgentBatchItem,
) {
    let Some(session_id) = item.session_id.as_deref() else {
        return;
    };
    let state = app_handle.state::<AgentAppState>();
    state
        .cancel_session(session_id, CancelReason::ProgrammaticShutdown)
        .await;
}

fn spawn_agent_batch_task(
    app_handle: tauri::AppHandle,
    batch_id: String,
    kind: String,
    source_path: String,
    launch: BenchmarkAgentLaunchSelection,
    master_session_id: String,
    task_id: String,
) {
    tauri::async_runtime::spawn(async move {
        if is_agent_batch_cancelled(&batch_id).await {
            mark_agent_batch_item_cancelled(&batch_id, &task_id).await;
            return;
        }
        mark_agent_batch_item_running(&batch_id, &task_id).await;
        let detail = match read_swe_bench_task(&source_path, &task_id) {
            Ok(detail) => detail,
            Err(error) => {
                mark_agent_batch_item_failed(&batch_id, &task_id, error).await;
                return;
            }
        };
        let submitted_patch_path = launch
            .workspace_path
            .as_deref()
            .map(|path| benchmark_agent_submission_patch_path(path, &task_id))
            .unwrap_or_else(|| {
                format!(
                    "{BENCHMARK_AGENT_SUBMISSIONS_DIR}/{task_id}/{BENCHMARK_AGENT_SUBMISSION_PATCH_FILE}"
                )
            });
        let prompt = benchmark_agent_prompt(&kind, &detail, &submitted_patch_path);
        let params = benchmark_launch_params(
            &launch,
            prompt,
            Some(task_id.clone()),
            Some(master_session_id.clone()),
        );
        let state = app_handle.state::<AgentAppState>();
        let org_store = app_handle.state::<std::sync::Arc<AgentOrgsStore>>();
        match session_launch_impl(&state, Some(org_store.inner()), params).await {
            Ok(result) => {
                mark_agent_batch_item_launched(&batch_id, &task_id, result).await;
            }
            Err(error) => {
                mark_agent_batch_item_failed(&batch_id, &task_id, error).await;
            }
        }
    });
}

async fn update_agent_batch_item<F>(batch_id: &str, task_id: &str, update: F)
where
    F: FnOnce(&mut BenchmarkAgentBatchItem),
{
    let status = {
        let mut batches = BENCHMARK_AGENT_BATCHES.lock().await;
        let Some(batch) = batches.get_mut(batch_id) else {
            return;
        };
        if let Some(item) = batch.items.iter_mut().find(|item| item.task_id == task_id) {
            update(item);
        }
        refresh_agent_batch_counts(batch);
        batch.clone()
    };
    if let Err(error) = persist_agent_batch_status(&status) {
        tracing::warn!(
            batch_id = %status.batch_id,
            error = %error,
            "[benchmark] failed to persist agent batch status"
        );
    }
}

fn refresh_agent_batch_counts(batch: &mut BenchmarkAgentBatchStatus) {
    batch.queued = batch
        .items
        .iter()
        .filter(|item| item.status == BENCHMARK_AGENT_BATCH_STATUS_QUEUED)
        .count();
    batch.running = batch
        .items
        .iter()
        .filter(|item| item.status == BENCHMARK_AGENT_BATCH_STATUS_RUNNING)
        .count();
    batch.launched = batch
        .items
        .iter()
        .filter(|item| item.status == BENCHMARK_AGENT_BATCH_STATUS_LAUNCHED)
        .count();
    batch.failed = batch
        .items
        .iter()
        .filter(|item| item.status == BENCHMARK_AGENT_BATCH_STATUS_FAILED)
        .count();
    batch.cancelled = batch
        .items
        .iter()
        .filter(|item| item.status == BENCHMARK_AGENT_BATCH_STATUS_CANCELLED)
        .count();

    if batch.running > 0 || batch.queued > 0 {
        if batch.status != BENCHMARK_AGENT_BATCH_STATUS_CANCELLED {
            batch.status = BENCHMARK_AGENT_BATCH_STATUS_RUNNING.to_string();
        }
        return;
    }

    if batch.finished_at.is_none() {
        batch.finished_at = Some(Utc::now().to_rfc3339());
    }
    if batch.failed > 0 {
        batch.status = BENCHMARK_AGENT_BATCH_STATUS_FAILED.to_string();
    } else if batch.cancelled > 0 {
        batch.status = BENCHMARK_AGENT_BATCH_STATUS_CANCELLED.to_string();
    } else {
        batch.status = BENCHMARK_AGENT_BATCH_STATUS_LAUNCHED.to_string();
    }
}

fn benchmark_launch_params(
    launch: &BenchmarkAgentLaunchSelection,
    content: String,
    session_name: Option<String>,
    parent_session_id: Option<String>,
) -> SessionLaunchParams {
    SessionLaunchParams {
        category: launch.category.clone(),
        content,
        workspace_path: launch.workspace_path.clone(),
        key_source: launch.key_source.clone(),
        account_id: launch.account_id.clone(),
        model: launch.model.clone(),
        native_harness_type: launch.native_harness_type.clone(),
        platform: launch.platform.clone(),
        branch: launch.branch.clone(),
        launch_args: None,
        hosted_token: launch.hosted_token.clone(),
        tier: launch.tier.clone(),
        name: session_name,
        background: true,
        images: None,
        ide_context: None,
        agent_definition_id: launch.agent_definition_id.clone(),
        agent_org_id: launch.agent_org_id.clone(),
        agent_org_member_overrides: launch.agent_org_member_overrides.clone(),
        apply_agent_org_member_overrides_for_future: launch
            .apply_agent_org_member_overrides_for_future,
        isolate: launch.isolate,
        mode: launch.mode.clone(),
        org_id: None,
        project_id: None,
        project_name: None,
        work_item_id: None,
        agent_role: None,
        worktree_path: launch.worktree_path.clone(),
        project_slug: launch.project_slug.clone(),
        parent_session_id,
        additional_directories: launch.additional_directories.clone(),
    }
}

fn benchmark_session_name(kind: &str) -> String {
    let benchmark_name = benchmark_display_name(kind);
    let timestamp = Local::now().format("%H:%M");
    format!("{benchmark_name} - {timestamp}")
}

fn benchmark_display_name(kind: &str) -> &'static str {
    match kind {
        BENCHMARK_KIND_SWE_BENCH_PRO => "SWE-bench Pro",
        BENCHMARK_KIND_TERMINAL_BENCH => "Terminal-Bench",
        _ => "Benchmark",
    }
}

fn create_benchmark_master_session(
    name: &str,
    kind: &str,
    source_path: &str,
    launch: &BenchmarkAgentLaunchSelection,
) -> Result<String, String> {
    let session_id = format!("benchmark-{}", Uuid::new_v4());
    let now = Utc::now().to_rfc3339();
    let key_source = launch
        .key_source
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .and_then(KeySource::parse)
        .unwrap_or_default();
    let user_input = format!(
        "Benchmark run coordinator\n\nBenchmark: {}\nSource: {}",
        benchmark_display_name(kind),
        source_path
    );
    let session = UnifiedSessionRecord {
        session_id: session_id.clone(),
        name: name.to_string(),
        status: agent_core::session::SessionStatus::Running
            .as_str()
            .to_string(),
        model: launch.model.clone(),
        account_id: launch.account_id.clone(),
        user_input: Some(user_input),
        created_at: now.clone(),
        updated_at: now,
        session_type: session_type::CODING.to_string(),
        workspace_path: launch.workspace_path.clone(),
        project_slug: launch.project_slug.clone(),
        agent_definition_id: launch.agent_definition_id.clone(),
        key_source,
        agent_exec_mode: launch.mode.clone().filter(|mode| !mode.trim().is_empty()),
        native_harness_type: launch.native_harness_type.clone(),
        ..Default::default()
    };
    session_persistence::upsert_session(&session).map_err(|err| err.to_string())?;
    Ok(session_id)
}

fn benchmark_agent_prompt(
    kind: &str,
    detail: &BenchmarkTaskDetail,
    submitted_patch_path: &str,
) -> String {
    let repo = detail
        .index
        .repo
        .as_deref()
        .unwrap_or("the target repository");
    let base_commit = detail
        .index
        .metadata
        .get("base_commit")
        .and_then(string_value)
        .unwrap_or_else(|| "the task base commit".to_string());
    format!(
        "You are running an official benchmark task. The final result will be evaluated by the benchmark harness, not by ORGII.\n\nBenchmark: {kind}\nTask ID: {task_id}\nRepository: {repo}\nBase commit: {base_commit}\nPatch submission path: {submitted_patch_path}\n\nInstructions:\n- Work inside the configured working directory. If the target repository is not already present there, clone it from its public upstream repository into that working directory before editing.\n- After cloning or locating the repository, check out the task base commit before applying changes.\n- Make the minimal code changes needed to satisfy the task.\n- Do not modify unrelated files.\n- Do not invent new tests or change benchmark tests unless the task explicitly requires it.\n- Before finishing, write your final unified diff patch to the patch submission path above. Create parent directories if needed.\n- The patch file must contain only the solution diff that should be evaluated.\n- When you finish, summarize the changed files, the validation you ran, and confirm that you wrote the patch file.\n- Leave the repository in a state where a git diff captures your solution patch.\n\nTask:\n{instruction}",
        task_id = detail.index.task_id,
        submitted_patch_path = submitted_patch_path,
        instruction = detail.instruction
    )
}

async fn run_swe_bench_preflight(
    kind: &str,
    source_path: &str,
    evaluation_mode: &str,
    task_id: Option<&str>,
    repo_path: Option<&str>,
) -> Result<BenchmarkPreflightResult, String> {
    ensure_swe_bench_pro(kind)?;
    let mut checks = Vec::new();
    let resolved_source_path = resolve_swe_bench_source_path(source_path);
    let source_detail = match &resolved_source_path {
        Ok(path) => format!("{} → {}", source_path, path.display()),
        Err(error) => error.clone(),
    };
    let source_exists = resolved_source_path.is_ok();
    checks.push(BenchmarkPreflightCheck {
        id: "source_path".to_string(),
        label: "SWE-bench Pro dataset folder".to_string(),
        ok: source_exists,
        detail: Some(source_detail),
    });

    let mut readable_rows = 0usize;
    if source_exists {
        match read_swe_bench_rows(source_path) {
            Ok(rows) => readable_rows = rows.len(),
            Err(error) => checks.push(BenchmarkPreflightCheck {
                id: "source_read".to_string(),
                label: "Read source rows".to_string(),
                ok: false,
                detail: Some(error),
            }),
        }
    }
    checks.push(BenchmarkPreflightCheck {
        id: "task_rows".to_string(),
        label: "Task rows loaded".to_string(),
        ok: readable_rows > 0,
        detail: Some(format!("{readable_rows} rows")),
    });

    let python = command_version("python3", &["--version"]).await;
    checks.push(BenchmarkPreflightCheck {
        id: "python".to_string(),
        label: "Python 3".to_string(),
        ok: python.is_ok(),
        detail: Some(python.unwrap_or_else(|error| error)),
    });

    match evaluation_mode {
        EVALUATION_MODE_PATCH_ONLY => {
            checks.push(BenchmarkPreflightCheck {
                id: "evaluation_mode".to_string(),
                label: "Patch-only worktree mode".to_string(),
                ok: true,
                detail: Some(
                    "Creates a git worktree and applies the patch without Docker.".to_string(),
                ),
            });
            if let Some(selected_task_id) = task_id {
                push_selected_task_checks(&mut checks, source_path, selected_task_id);
            }
            push_patch_only_worktree_checks(&mut checks, repo_path, source_path, task_id).await;
        }
        EVALUATION_MODE_LOCAL_DOCKER => {
            push_swe_bench_local_docker_checks(&mut checks, task_id).await;
            if let Some(selected_task_id) = task_id {
                push_selected_task_checks(&mut checks, source_path, selected_task_id);
            }
        }
        EVALUATION_MODE_MODAL => {
            let modal = command_version("modal", &["--version"]).await;
            checks.push(BenchmarkPreflightCheck {
                id: "modal_cli".to_string(),
                label: "Modal CLI".to_string(),
                ok: modal.is_ok(),
                detail: Some(modal.unwrap_or_else(|error| error)),
            });
            let modal_config = modal_config_path();
            checks.push(BenchmarkPreflightCheck {
                id: "modal_config".to_string(),
                label: "Modal config".to_string(),
                ok: modal_config.is_file(),
                detail: Some(modal_config.display().to_string()),
            });
        }
        other => {
            checks.push(BenchmarkPreflightCheck {
                id: "evaluation_mode".to_string(),
                label: "Evaluation mode".to_string(),
                ok: false,
                detail: Some(format!("Unsupported evaluation mode: {other}")),
            });
        }
    }

    let ready = checks.iter().all(|check| check.ok);
    Ok(BenchmarkPreflightResult {
        benchmark_kind: kind.to_string(),
        evaluation_mode: evaluation_mode.to_string(),
        ready,
        checks,
    })
}

async fn push_patch_only_worktree_checks(
    checks: &mut Vec<BenchmarkPreflightCheck>,
    repo_path: Option<&str>,
    source_path: &str,
    task_id: Option<&str>,
) {
    let repo_path_value = repo_path.unwrap_or_default().trim();
    let repo_path_buf = PathBuf::from(repo_path_value);
    checks.push(BenchmarkPreflightCheck {
        id: "repo_path".to_string(),
        label: "Target repo checkout".to_string(),
        ok: !repo_path_value.is_empty() && repo_path_buf.is_dir(),
        detail: Some(if repo_path_value.is_empty() {
            "Set a local repository path for worktree mode.".to_string()
        } else {
            repo_path_value.to_string()
        }),
    });

    if !repo_path_value.is_empty() && repo_path_buf.is_dir() {
        let git_check = command_version_in_dir(
            &repo_path_buf,
            "git",
            &["rev-parse", "--is-inside-work-tree"],
        )
        .await;
        checks.push(BenchmarkPreflightCheck {
            id: "repo_git".to_string(),
            label: "Target repo is a git worktree".to_string(),
            ok: git_check.as_deref() == Ok("true"),
            detail: Some(git_check.unwrap_or_else(|error| error)),
        });
    }

    if let Some(selected_task_id) = task_id {
        let base_commit = find_swe_bench_row(source_path, selected_task_id)
            .ok()
            .and_then(|row| string_field(&row, "base_commit"));
        let base_commit_value = base_commit.unwrap_or_default();
        checks.push(BenchmarkPreflightCheck {
            id: "base_commit".to_string(),
            label: "Task base commit".to_string(),
            ok: !base_commit_value.trim().is_empty(),
            detail: Some(base_commit_value.clone()),
        });

        if !base_commit_value.trim().is_empty()
            && !repo_path_value.is_empty()
            && repo_path_buf.is_dir()
        {
            let commit_check = command_version_in_dir(
                &repo_path_buf,
                "git",
                &[
                    "cat-file",
                    "-e",
                    &format!("{}^{{commit}}", base_commit_value.trim()),
                ],
            )
            .await;
            checks.push(BenchmarkPreflightCheck {
                id: "base_commit_exists".to_string(),
                label: "Base commit exists in target repo".to_string(),
                ok: commit_check.is_ok(),
                detail: Some(commit_check.unwrap_or_else(|error| error)),
            });
        }
    }
}

async fn push_swe_bench_local_docker_checks(
    checks: &mut Vec<BenchmarkPreflightCheck>,
    task_id: Option<&str>,
) {
    let docker_version = command_version("docker", &["--version"]).await;
    checks.push(BenchmarkPreflightCheck {
        id: "docker_cli".to_string(),
        label: "Docker CLI".to_string(),
        ok: docker_version.is_ok(),
        detail: Some(docker_version.unwrap_or_else(|error| error)),
    });

    let docker_info = command_version("docker", &["info", "--format", "{{.ServerVersion}}"]).await;
    checks.push(BenchmarkPreflightCheck {
        id: "docker_daemon".to_string(),
        label: "Docker daemon".to_string(),
        ok: docker_info.is_ok(),
        detail: Some(docker_info.unwrap_or_else(|error| error)),
    });

    let benchmark_python = ensure_benchmark_python_env().await;
    checks.push(BenchmarkPreflightCheck {
        id: "benchmark_python_env".to_string(),
        label: "ORGII benchmark Python environment".to_string(),
        ok: benchmark_python.is_ok(),
        detail: Some(
            benchmark_python
                .as_ref()
                .map(|path| path.display().to_string())
                .unwrap_or_else(|error| error.clone()),
        ),
    });

    if let Ok(python_path) = benchmark_python {
        for package_name in BENCHMARK_PYTHON_PACKAGES {
            let package_check = run_python_import(&python_path, package_name).await;
            checks.push(BenchmarkPreflightCheck {
                id: format!("python_package_{package_name}"),
                label: format!("Python package: {package_name}"),
                ok: package_check.is_ok(),
                detail: Some(package_check.unwrap_or_else(|error| error)),
            });
        }
    }

    let evaluator_script = swe_bench_evaluator_script_path();
    checks.push(BenchmarkPreflightCheck {
        id: "evaluator_script".to_string(),
        label: "SWE-bench Pro evaluator script".to_string(),
        ok: evaluator_script.is_file(),
        detail: Some(evaluator_script.display().to_string()),
    });

    let scripts_dir = swe_bench_run_scripts_dir();
    checks.push(BenchmarkPreflightCheck {
        id: "run_scripts_dir".to_string(),
        label: "SWE-bench Pro run scripts".to_string(),
        ok: scripts_dir.is_dir(),
        detail: Some(scripts_dir.display().to_string()),
    });

    if let Some(selected_task_id) = task_id {
        let run_script = scripts_dir.join(selected_task_id).join("run_script.sh");
        checks.push(BenchmarkPreflightCheck {
            id: "task_run_script".to_string(),
            label: "Selected task run script".to_string(),
            ok: run_script.is_file(),
            detail: Some(run_script.display().to_string()),
        });

        let parser_script = scripts_dir.join(selected_task_id).join("parser.py");
        checks.push(BenchmarkPreflightCheck {
            id: "task_parser_script".to_string(),
            label: "Selected task parser script".to_string(),
            ok: parser_script.is_file(),
            detail: Some(parser_script.display().to_string()),
        });
    }
}

async fn run_terminal_bench_preflight(
    source_path: &str,
    evaluation_mode: &str,
) -> Result<BenchmarkPreflightResult, String> {
    let mut checks = Vec::new();
    let source_path_buf = PathBuf::from(source_path);
    checks.push(BenchmarkPreflightCheck {
        id: "adapter_boundary".to_string(),
        label: "Terminal-Bench adapter boundary".to_string(),
        ok: false,
        detail: Some(
            "Terminal-Bench uses tb run with an agent harness; it is intentionally separate from SWE-bench Pro patch evaluation."
                .to_string(),
        ),
    });
    checks.push(BenchmarkPreflightCheck {
        id: "dataset_path".to_string(),
        label: "Terminal-Bench dataset path".to_string(),
        ok: source_path_buf.exists(),
        detail: Some(source_path.to_string()),
    });

    let tb = command_version("tb", &["--help"]).await;
    checks.push(BenchmarkPreflightCheck {
        id: "tb_cli".to_string(),
        label: "Terminal-Bench tb CLI".to_string(),
        ok: tb.is_ok(),
        detail: Some(tb.unwrap_or_else(|error| error)),
    });

    let uv_tb = command_version("uv", &["run", "tb", "--help"]).await;
    checks.push(BenchmarkPreflightCheck {
        id: "uv_tb_cli".to_string(),
        label: "Terminal-Bench via uv run tb".to_string(),
        ok: uv_tb.is_ok(),
        detail: Some(uv_tb.unwrap_or_else(|error| error)),
    });

    let docker_info = command_version("docker", &["info", "--format", "{{.ServerVersion}}"]).await;
    checks.push(BenchmarkPreflightCheck {
        id: "docker_daemon".to_string(),
        label: "Docker daemon".to_string(),
        ok: docker_info.is_ok(),
        detail: Some(docker_info.unwrap_or_else(|error| error)),
    });

    Ok(BenchmarkPreflightResult {
        benchmark_kind: BENCHMARK_KIND_TERMINAL_BENCH.to_string(),
        evaluation_mode: evaluation_mode.to_string(),
        ready: false,
        checks,
    })
}

fn push_selected_task_checks(
    checks: &mut Vec<BenchmarkPreflightCheck>,
    source_path: &str,
    task_id: &str,
) {
    match find_swe_bench_row(source_path, task_id) {
        Ok(row) => {
            checks.push(BenchmarkPreflightCheck {
                id: "selected_task".to_string(),
                label: "Selected SWE-bench Pro task".to_string(),
                ok: true,
                detail: Some(task_id.to_string()),
            });
            for key in [
                "instance_id",
                "before_repo_set_cmd",
                "selected_test_files_to_run",
                "base_commit",
                "FAIL_TO_PASS",
                "PASS_TO_PASS",
                "repo",
            ] {
                checks.push(BenchmarkPreflightCheck {
                    id: format!("task_metadata_{key}"),
                    label: format!("Task metadata: {key}"),
                    ok: !string_field(&row, key)
                        .unwrap_or_default()
                        .trim()
                        .is_empty()
                        || row.get(key).is_some_and(|value| !value.is_null()),
                    detail: row
                        .get(key)
                        .map(|value| truncate_detail(&value.to_string(), 160)),
                });
            }
        }
        Err(error) => checks.push(BenchmarkPreflightCheck {
            id: "selected_task".to_string(),
            label: "Selected SWE-bench Pro task".to_string(),
            ok: false,
            detail: Some(error),
        }),
    }
}

async fn build_swe_bench_run_plan(
    kind: &str,
    source_path: &str,
    task_id: &str,
    patch: &str,
    evaluation_mode: &str,
    repo_path: Option<&str>,
) -> Result<BenchmarkRunPlan, String> {
    if patch.trim().is_empty() {
        return Err("Patch content is required to run SWE-bench Pro evaluation".to_string());
    }
    let resolved_source_path = resolve_swe_bench_source_path(source_path)?;
    let resolved_source_path_string = resolved_source_path.display().to_string();
    let task = read_swe_bench_task(&resolved_source_path_string, task_id)?;

    let preflight = run_swe_bench_preflight(
        kind,
        &resolved_source_path_string,
        evaluation_mode,
        Some(task_id),
        repo_path,
    )
    .await?;
    let run_id = format!("swe-{}", Uuid::new_v4());
    let output_dir = benchmark_run_output_dir(&run_id);
    std::fs::create_dir_all(&output_dir)
        .map_err(|error| format!("Failed to create run output dir: {error}"))?;
    let patch_path = if evaluation_mode == EVALUATION_MODE_PATCH_ONLY {
        let patch_path = output_dir.join("patch.diff");
        std::fs::write(&patch_path, patch)
            .map_err(|error| format!("Failed to write patch diff: {error}"))?;
        patch_path
    } else {
        let patch_path = output_dir.join("patches.json");
        let patch_json = serde_json::json!([{
            "instance_id": task_id,
            "patch": patch,
            "prefix": run_id,
        }]);
        let patch_file = File::create(&patch_path)
            .map_err(|error| format!("Failed to create patch JSON: {error}"))?;
        serde_json::to_writer_pretty(patch_file, &patch_json)
            .map_err(|error| format!("Failed to write patch JSON: {error}"))?;
        patch_path
    };

    let evaluator_script = if evaluation_mode == EVALUATION_MODE_LOCAL_DOCKER {
        Some(swe_bench_evaluator_script_path())
    } else {
        None
    };
    let scripts_dir = if evaluation_mode == EVALUATION_MODE_LOCAL_DOCKER {
        Some(swe_bench_run_scripts_dir())
    } else {
        None
    };
    let repo_path_string = repo_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let worktree_path = None;
    let command_preview = if evaluation_mode == EVALUATION_MODE_PATCH_ONLY {
        swe_bench_patch_only_command_preview(&task, &patch_path)
    } else {
        swe_bench_command_preview(&resolved_source_path_string, &patch_path, &output_dir)
    };

    Ok(BenchmarkRunPlan {
        run_id,
        benchmark_kind: kind.to_string(),
        evaluation_mode: evaluation_mode.to_string(),
        task_id: task_id.to_string(),
        source_path: resolved_source_path_string,
        repo_path: repo_path_string,
        patch_path: patch_path.display().to_string(),
        output_dir: output_dir.display().to_string(),
        evaluator_script: evaluator_script.map(|path| path.display().to_string()),
        scripts_dir: scripts_dir.map(|path| path.display().to_string()),
        worktree_path,
        command_preview,
        preflight,
    })
}

async fn run_swe_bench_patch_only_worktree(
    plan: BenchmarkRunPlan,
) -> Result<BenchmarkRunStatus, String> {
    let repo_path = plan
        .repo_path
        .as_deref()
        .ok_or_else(|| "Target repo path is required for patch-only worktree mode".to_string())?;
    let task_row = find_swe_bench_row(&plan.source_path, &plan.task_id)?;
    let base_commit = string_field(&task_row, "base_commit")
        .ok_or_else(|| format!("Task {} is missing base_commit", plan.task_id))?;
    let repo_path_buf = PathBuf::from(repo_path);
    let started_at = Utc::now().to_rfc3339();
    let mut logs = vec![
        format!(
            "Starting SWE-bench Pro patch-only worktree run {}",
            plan.run_id
        ),
        format!("Target repo: {repo_path}"),
        format!("Base commit: {base_commit}"),
        format!("Patch diff: {}", plan.patch_path),
    ];

    let worktree = create_session_worktree(&repo_path_buf, &plan.run_id, Some(&base_commit), None)?;
    logs.push(format!("Created worktree: {}", worktree.path));
    logs.push(format!("Created branch: {}", worktree.branch));

    let patch_output = git::tokio_git_command()?
        .arg("apply")
        .arg("--whitespace=nowarn")
        .arg(&plan.patch_path)
        .current_dir(&worktree.path)
        .output()
        .await
        .map_err(|error| format!("Failed to apply patch in worktree: {error}"))?;

    let status = if patch_output.status.success() {
        logs.push("Patch applied cleanly to worktree.".to_string());
        BENCHMARK_RUN_STATUS_APPLIED
    } else {
        let stderr = String::from_utf8_lossy(&patch_output.stderr)
            .trim()
            .to_string();
        logs.push(if stderr.is_empty() {
            format!("git apply exited with {}", patch_output.status)
        } else {
            format!("git apply failed: {stderr}")
        });
        BENCHMARK_RUN_STATUS_FAILED
    };

    let diff_stat = command_version_in_dir(Path::new(&worktree.path), "git", &["diff", "--stat"])
        .await
        .unwrap_or_else(|error| format!("Unable to read diff stat: {error}"));
    if !diff_stat.trim().is_empty() {
        logs.push("Diff stat:".to_string());
        logs.extend(diff_stat.lines().map(ToOwned::to_owned));
    }

    let result = serde_json::json!({
        "applied": status == BENCHMARK_RUN_STATUS_APPLIED,
        "officialEvaluation": false,
        "message": "Patch-only worktree mode applies the patch but does not run the official SWE-bench test harness."
    });
    let status_value = BenchmarkRunStatus {
        run_id: plan.run_id.clone(),
        benchmark_kind: plan.benchmark_kind.clone(),
        evaluation_mode: plan.evaluation_mode.clone(),
        task_id: plan.task_id.clone(),
        status: status.to_string(),
        source_path: plan.source_path.clone(),
        repo_path: plan.repo_path.clone(),
        patch_path: plan.patch_path.clone(),
        output_dir: plan.output_dir.clone(),
        worktree_path: Some(worktree.path),
        started_at: Some(started_at),
        finished_at: Some(Utc::now().to_rfc3339()),
        exit_code: patch_output.status.code(),
        process_id: None,
        logs,
        result: Some(result),
        error: if status == BENCHMARK_RUN_STATUS_FAILED {
            Some("Patch did not apply cleanly to the worktree.".to_string())
        } else {
            None
        },
    };

    BENCHMARK_RUNS
        .lock()
        .await
        .insert(plan.run_id.clone(), status_value.clone());

    Ok(status_value)
}

async fn run_swe_bench_process(plan: BenchmarkRunPlan) {
    append_run_log(&plan.run_id, format!("Output dir: {}", plan.output_dir)).await;
    append_run_log(&plan.run_id, format!("Patch JSON: {}", plan.patch_path)).await;

    if is_e2e_docker_benchmark_task(&plan) {
        run_e2e_docker_benchmark_process(plan).await;
        return;
    }

    let Some(evaluator_script) = plan.evaluator_script.as_deref() else {
        finish_run(
            &plan.run_id,
            BENCHMARK_RUN_STATUS_FAILED,
            None,
            Some("Missing evaluator script for Docker run".to_string()),
        )
        .await;
        return;
    };
    let Some(scripts_dir) = plan.scripts_dir.as_deref() else {
        finish_run(
            &plan.run_id,
            BENCHMARK_RUN_STATUS_FAILED,
            None,
            Some("Missing run scripts directory for Docker run".to_string()),
        )
        .await;
        return;
    };

    let benchmark_python = match ensure_benchmark_python_env().await {
        Ok(path) => path,
        Err(error) => {
            finish_run(
                &plan.run_id,
                BENCHMARK_RUN_STATUS_FAILED,
                None,
                Some(format!(
                    "Benchmark Python environment is not ready: {error}"
                )),
            )
            .await;
            return;
        }
    };
    append_run_log(
        &plan.run_id,
        format!("Benchmark Python: {}", benchmark_python.display()),
    )
    .await;

    let mut command = Command::new(&benchmark_python);
    command
        .arg(evaluator_script)
        .arg("--raw_sample_path")
        .arg(&plan.source_path)
        .arg("--patch_path")
        .arg(&plan.patch_path)
        .arg("--output_dir")
        .arg(&plan.output_dir)
        .arg("--scripts_dir")
        .arg(scripts_dir)
        .arg("--dockerhub_username")
        .arg(SWE_BENCH_PRO_DOCKERHUB_USERNAME)
        .arg("--use_local_docker")
        .arg("--num_workers")
        .arg("1")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            finish_run(
                &plan.run_id,
                BENCHMARK_RUN_STATUS_FAILED,
                None,
                Some(format!("Failed to spawn evaluator: {error}")),
            )
            .await;
            return;
        }
    };

    if let Some(process_id) = child.id() {
        set_run_process_id(&plan.run_id, process_id).await;
    }

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let run_id_for_stdout = plan.run_id.clone();
    let run_id_for_stderr = plan.run_id.clone();

    let stdout_task = tokio::spawn(async move {
        if let Some(stdout_pipe) = stdout {
            let mut lines = TokioBufReader::new(stdout_pipe).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                append_run_log(&run_id_for_stdout, format!("stdout: {line}")).await;
            }
        }
    });

    let stderr_task = tokio::spawn(async move {
        if let Some(stderr_pipe) = stderr {
            let mut lines = TokioBufReader::new(stderr_pipe).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                append_run_log(&run_id_for_stderr, format!("stderr: {line}")).await;
            }
        }
    });

    let wait_result = child.wait().await;
    let _ = tokio::join!(stdout_task, stderr_task);

    match wait_result {
        Ok(exit_status) => {
            let exit_code = exit_status.code();
            let result = read_eval_result(&plan.output_dir, &plan.task_id).ok();
            let result_passed = result
                .as_ref()
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
            let status = if exit_status.success() && result_passed {
                BENCHMARK_RUN_STATUS_PASSED
            } else {
                BENCHMARK_RUN_STATUS_FAILED
            };
            finish_run_with_result(&plan.run_id, status, exit_code, result, None).await;
        }
        Err(error) => {
            finish_run(
                &plan.run_id,
                BENCHMARK_RUN_STATUS_FAILED,
                None,
                Some(format!("Failed while waiting for evaluator: {error}")),
            )
            .await;
        }
    }
}

async fn run_e2e_docker_benchmark_process(plan: BenchmarkRunPlan) {
    append_run_log(
        &plan.run_id,
        "Running ORGII Docker benchmark E2E evaluator fixture.".to_string(),
    )
    .await;
    append_run_log(&plan.run_id, "orgii-docker-benchmark-e2e".to_string()).await;

    let mut command = Command::new("docker");
    command
        .arg("info")
        .arg("--format")
        .arg("{{.ServerVersion}}")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            finish_run(
                &plan.run_id,
                BENCHMARK_RUN_STATUS_FAILED,
                None,
                Some(format!("Failed to spawn Docker evaluator fixture: {error}")),
            )
            .await;
            return;
        }
    };

    if let Some(process_id) = child.id() {
        set_run_process_id(&plan.run_id, process_id).await;
    }

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let run_id_for_stdout = plan.run_id.clone();
    let run_id_for_stderr = plan.run_id.clone();
    let stdout_task = tokio::spawn(async move {
        if let Some(stdout_pipe) = stdout {
            let mut lines = TokioBufReader::new(stdout_pipe).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                append_run_log(&run_id_for_stdout, format!("stdout: {line}")).await;
            }
        }
    });
    let stderr_task = tokio::spawn(async move {
        if let Some(stderr_pipe) = stderr {
            let mut lines = TokioBufReader::new(stderr_pipe).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                append_run_log(&run_id_for_stderr, format!("stderr: {line}")).await;
            }
        }
    });

    let wait_result = child.wait().await;
    let _ = tokio::join!(stdout_task, stderr_task);
    match wait_result {
        Ok(exit_status) => {
            let exit_code = exit_status.code();
            let result = serde_json::json!(exit_status.success());
            let status = if exit_status.success() {
                BENCHMARK_RUN_STATUS_PASSED
            } else {
                BENCHMARK_RUN_STATUS_FAILED
            };
            let results_path = Path::new(&plan.output_dir).join("eval_results.json");
            if let Err(error) = fs::write(
                &results_path,
                serde_json::json!({ plan.task_id.clone(): result }).to_string(),
            ) {
                append_run_log(
                    &plan.run_id,
                    format!("Failed to write E2E eval results: {error}"),
                )
                .await;
            }
            finish_run_with_result(&plan.run_id, status, exit_code, Some(result), None).await;
        }
        Err(error) => {
            finish_run(
                &plan.run_id,
                BENCHMARK_RUN_STATUS_FAILED,
                None,
                Some(format!(
                    "Failed while waiting for Docker evaluator fixture: {error}"
                )),
            )
            .await;
        }
    }
}

fn is_e2e_docker_benchmark_task(plan: &BenchmarkRunPlan) -> bool {
    cfg!(debug_assertions)
        && plan.evaluation_mode == EVALUATION_MODE_LOCAL_DOCKER
        && plan.task_id == E2E_DOCKER_BENCHMARK_TASK_ID
}

async fn set_run_process_id(run_id: &str, process_id: u32) {
    let mut runs = BENCHMARK_RUNS.lock().await;
    if let Some(status) = runs.get_mut(run_id) {
        status.process_id = Some(process_id);
        status
            .logs
            .push(format!("Evaluator process started with PID {process_id}"));
        trim_logs(&mut status.logs);
    }
}

async fn append_run_log(run_id: &str, line: String) {
    let mut runs = BENCHMARK_RUNS.lock().await;
    if let Some(status) = runs.get_mut(run_id) {
        if status.status == BENCHMARK_RUN_STATUS_CANCELLED {
            return;
        }
        status.logs.push(line);
        trim_logs(&mut status.logs);
    }
}

async fn finish_run(
    run_id: &str,
    status_value: &str,
    exit_code: Option<i32>,
    error: Option<String>,
) {
    finish_run_with_result(run_id, status_value, exit_code, None, error).await;
}

async fn finish_run_with_result(
    run_id: &str,
    status_value: &str,
    exit_code: Option<i32>,
    result: Option<Value>,
    error: Option<String>,
) {
    let mut runs = BENCHMARK_RUNS.lock().await;
    if let Some(status) = runs.get_mut(run_id) {
        if status.status == BENCHMARK_RUN_STATUS_CANCELLED {
            return;
        }
        status.status = status_value.to_string();
        status.finished_at = Some(Utc::now().to_rfc3339());
        status.exit_code = exit_code;
        status.result = result;
        status.error = error.clone();
        if let Some(message) = error {
            status.logs.push(message);
        }
        status
            .logs
            .push(format!("Run finished with status: {status_value}"));
        trim_logs(&mut status.logs);
    }
}

fn ensure_swe_bench_pro(kind: &str) -> Result<(), String> {
    if kind == BENCHMARK_KIND_SWE_BENCH_PRO {
        Ok(())
    } else {
        Err(format!("Unsupported benchmark kind: {kind}"))
    }
}

fn ensure_supported_swe_bench_mode(evaluation_mode: &str) -> Result<(), String> {
    if matches!(
        evaluation_mode,
        EVALUATION_MODE_LOCAL_DOCKER | EVALUATION_MODE_PATCH_ONLY
    ) {
        Ok(())
    } else {
        Err(format!(
            "Unsupported benchmark run mode: {evaluation_mode}. Supported modes: local_docker, patch_only."
        ))
    }
}

fn resolve_swe_bench_source_path(source_path: &str) -> Result<PathBuf, String> {
    let path = Path::new(source_path);
    if path.is_file() {
        return Ok(path.to_path_buf());
    }
    if !path.is_dir() {
        return Err(format!(
            "SWE-bench Pro source does not exist: {source_path}"
        ));
    }

    for candidate in SWE_BENCH_PRO_DATASET_CANDIDATES {
        let candidate_path = path.join(candidate);
        if candidate_path.is_file() {
            return Ok(candidate_path);
        }
    }

    let mut jsonl_files = Vec::new();
    collect_jsonl_files(path, &mut jsonl_files)?;
    if jsonl_files.len() == 1 {
        return Ok(jsonl_files.remove(0));
    }

    if jsonl_files.is_empty() {
        return Err(format!(
            "No SWE-bench Pro JSONL dataset found in folder: {source_path}"
        ));
    }

    let candidate_list = jsonl_files
        .iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    Err(format!(
        "Multiple JSONL files found in benchmark folder. Use a folder containing one dataset file or one of the known SWE-bench Pro paths. Found: {candidate_list}"
    ))
}

fn collect_jsonl_files(dir: &Path, jsonl_files: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|error| format!("Failed to read folder: {error}"))? {
        let entry = entry.map_err(|error| format!("Failed to read folder entry: {error}"))?;
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl_files(&path, jsonl_files)?;
        } else if path
            .extension()
            .is_some_and(|extension| extension.to_string_lossy() == "jsonl")
        {
            jsonl_files.push(path);
        }
    }
    Ok(())
}

fn read_swe_bench_rows(source_path: &str) -> Result<Vec<Value>, String> {
    let path = resolve_swe_bench_source_path(source_path)?;
    let file = File::open(&path).map_err(|error| {
        format!(
            "Failed to open SWE-bench Pro dataset {}: {error}",
            path.display()
        )
    })?;
    let reader = BufReader::new(file);
    let mut rows = Vec::new();
    for (line_index, line) in reader.lines().enumerate() {
        let line =
            line.map_err(|error| format!("Failed to read line {}: {error}", line_index + 1))?;
        if line.trim().is_empty() {
            continue;
        }
        let row: Value = serde_json::from_str(&line)
            .map_err(|error| format!("Invalid JSONL line {}: {error}", line_index + 1))?;
        rows.push(row);
    }
    Ok(rows)
}

fn read_swe_bench_task(source_path: &str, task_id: &str) -> Result<BenchmarkTaskDetail, String> {
    swe_bench_row_to_detail(source_path, find_swe_bench_row(source_path, task_id)?)
}

fn find_swe_bench_row(source_path: &str, task_id: &str) -> Result<Value, String> {
    for row in read_swe_bench_rows(source_path)? {
        let instance_id = string_field(&row, "instance_id").unwrap_or_default();
        if instance_id == task_id {
            return Ok(row);
        }
    }
    Err(format!("SWE-bench Pro task not found: {task_id}"))
}

fn swe_bench_row_to_detail(source_path: &str, row: Value) -> Result<BenchmarkTaskDetail, String> {
    let task_id = string_field(&row, "instance_id")
        .ok_or_else(|| "SWE-bench Pro row is missing instance_id".to_string())?;
    let problem_statement = string_field(&row, "problem_statement").unwrap_or_default();
    let requirements = string_field(&row, "requirements").unwrap_or_default();
    let interface = string_field(&row, "interface").unwrap_or_default();
    let instruction = compose_swe_bench_instruction(&problem_statement, &requirements, &interface);
    let title = first_non_empty_line(&problem_statement).unwrap_or_else(|| task_id.clone());
    let repo = string_field(&row, "repo").or_else(|| string_field(&row, "repo_name"));
    let char_count = instruction.chars().count();
    let word_count = instruction.split_whitespace().count();

    let metadata = serde_json::json!({
        "baseCommit": string_field(&row, "base_commit"),
        "imageName": string_field(&row, "image_name"),
        "dockerhubTag": string_field(&row, "dockerhub_tag"),
        "selectedTestFilesToRun": row.get("selected_test_files_to_run").cloned(),
        "failToPass": row.get("FAIL_TO_PASS").cloned(),
        "passToPass": row.get("PASS_TO_PASS").cloned(),
    });

    Ok(BenchmarkTaskDetail {
        index: BenchmarkTaskIndexRow {
            benchmark_kind: BENCHMARK_KIND_SWE_BENCH_PRO.to_string(),
            task_id,
            title,
            source_path: source_path.to_string(),
            repo,
            word_count,
            char_count,
            tags: vec!["swe-bench-pro".to_string()],
            difficulty: None,
            metadata,
        },
        instruction,
    })
}

fn compose_swe_bench_instruction(
    problem_statement: &str,
    requirements: &str,
    interface: &str,
) -> String {
    let mut parts = Vec::new();
    if !problem_statement.trim().is_empty() {
        parts.push(problem_statement.trim().to_string());
    }
    if !requirements.trim().is_empty() {
        parts.push(format!("Requirements:\n{}", requirements.trim()));
    }
    if !interface.trim().is_empty() {
        parts.push(format!("New interfaces introduced:\n{}", interface.trim()));
    }
    parts.join("\n\n")
}

fn first_non_empty_line(value: &str) -> Option<String> {
    value
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.chars().take(120).collect())
}

fn task_matches_query(detail: &BenchmarkTaskDetail, query: &str) -> bool {
    detail.index.task_id.to_lowercase().contains(query)
        || detail.index.title.to_lowercase().contains(query)
        || detail
            .index
            .repo
            .as_ref()
            .map(|repo| repo.to_lowercase().contains(query))
            .unwrap_or(false)
}

fn string_field(row: &Value, key: &str) -> Option<String> {
    row.get(key).and_then(string_value)
}

fn string_value(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

async fn command_version(command: &str, args: &[&str]) -> Result<String, String> {
    run_command_for_stdout(None, command, args).await
}

async fn command_version_in_dir(
    cwd: &Path,
    command: &str,
    args: &[&str],
) -> Result<String, String> {
    run_command_for_stdout(Some(cwd), command, args).await
}

async fn run_command_for_stdout(
    cwd: Option<&Path>,
    command: &str,
    args: &[&str],
) -> Result<String, String> {
    let mut command_builder = Command::new(command);
    command_builder.args(args);
    if let Some(current_dir) = cwd {
        command_builder.current_dir(current_dir);
    }
    let output = command_builder
        .output()
        .await
        .map_err(|error| format!("Failed to run {command}: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("{command} exited with {}", output.status)
        } else {
            stderr
        });
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(stdout)
}

async fn ensure_benchmark_python_env() -> Result<PathBuf, String> {
    let env_dir = benchmark_python_env_dir();
    let python_path = benchmark_python_path();
    if !python_path.is_file() {
        fs::create_dir_all(
            env_dir
                .parent()
                .ok_or_else(|| "Invalid benchmark Python environment path".to_string())?,
        )
        .map_err(|error| format!("Failed to create benchmark Python env directory: {error}"))?;

        let uv_result = Command::new("uv")
            .arg("venv")
            .arg("--python")
            .arg("python3")
            .arg(&env_dir)
            .output()
            .await;
        let created_with_uv = uv_result
            .as_ref()
            .map(|output| output.status.success())
            .unwrap_or(false);
        if !created_with_uv {
            let output = Command::new("python3")
                .arg("-m")
                .arg("venv")
                .arg(&env_dir)
                .output()
                .await
                .map_err(|error| format!("Failed to create benchmark Python venv: {error}"))?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                return Err(if stderr.is_empty() {
                    format!("python3 -m venv exited with {}", output.status)
                } else {
                    stderr
                });
            }
        }
    }

    if benchmark_python_packages_ready(&python_path).await {
        return Ok(python_path);
    }

    install_benchmark_python_packages(&python_path).await?;
    if benchmark_python_packages_ready(&python_path).await {
        Ok(python_path)
    } else {
        Err("Benchmark Python packages were installed but import checks still fail".to_string())
    }
}

async fn benchmark_python_packages_ready(python_path: &Path) -> bool {
    for package_name in BENCHMARK_PYTHON_PACKAGES {
        if run_python_import(python_path, package_name).await.is_err() {
            return false;
        }
    }
    true
}

async fn install_benchmark_python_packages(python_path: &Path) -> Result<(), String> {
    let uv_output = Command::new("uv")
        .arg("pip")
        .arg("install")
        .arg("--python")
        .arg(python_path)
        .arg("--upgrade")
        .arg("--force-reinstall")
        .args(BENCHMARK_PYTHON_PACKAGES.iter().copied())
        .output()
        .await;
    if let Ok(output) = uv_output {
        if output.status.success() {
            return Ok(());
        }
    }

    let ensurepip_output = Command::new(python_path)
        .arg("-m")
        .arg("ensurepip")
        .arg("--upgrade")
        .output()
        .await
        .map_err(|error| format!("Failed to bootstrap benchmark Python pip: {error}"))?;
    if !ensurepip_output.status.success() {
        let stderr = String::from_utf8_lossy(&ensurepip_output.stderr)
            .trim()
            .to_string();
        return Err(if stderr.is_empty() {
            format!("ensurepip exited with {}", ensurepip_output.status)
        } else {
            stderr
        });
    }

    let output = Command::new(python_path)
        .arg("-m")
        .arg("pip")
        .arg("install")
        .arg("--upgrade")
        .arg("--force-reinstall")
        .args(BENCHMARK_PYTHON_PACKAGES.iter().copied())
        .output()
        .await
        .map_err(|error| format!("Failed to install benchmark Python packages: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        format!(
            "Benchmark Python package install exited with {}",
            output.status
        )
    } else {
        stderr
    })
}

async fn run_python_import(python_path: &Path, package_name: &str) -> Result<String, String> {
    let output = Command::new(python_path)
        .arg("-c")
        .arg(format!(
            "import {package_name}; print(getattr({package_name}, '__version__', 'ok'))"
        ))
        .output()
        .await
        .map_err(|error| format!("Failed to run {}: {error}", python_path.display()))?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        format!("{} exited with {}", python_path.display(), output.status)
    } else {
        stderr
    })
}

async fn terminate_process(process_id: u32) -> Result<(), String> {
    #[cfg(unix)]
    let output = Command::new("kill")
        .arg("-TERM")
        .arg(process_id.to_string())
        .output()
        .await;

    #[cfg(windows)]
    let output = Command::new("taskkill")
        .arg("/PID")
        .arg(process_id.to_string())
        .arg("/T")
        .arg("/F")
        .output()
        .await;

    let output =
        output.map_err(|error| format!("Failed to terminate process {process_id}: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("Process termination exited with {}", output.status)
        } else {
            stderr
        })
    }
}

fn modal_config_path() -> PathBuf {
    app_paths::home_dir().join(".modal.toml")
}

fn swe_bench_repo_path() -> PathBuf {
    std::env::var("ORGII_SWE_BENCH_PRO_REPO_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(SWE_BENCH_PRO_REPO_PATH))
}

fn swe_bench_evaluator_script_path() -> PathBuf {
    swe_bench_repo_path().join(SWE_BENCH_PRO_EVALUATOR_SCRIPT)
}

fn swe_bench_run_scripts_dir() -> PathBuf {
    swe_bench_repo_path().join(SWE_BENCH_PRO_RUN_SCRIPTS_DIR)
}

fn benchmark_runs_dir() -> PathBuf {
    app_paths::orgii_root().join("benchmark-runs")
}

fn benchmark_agent_submission_patch_path(workspace_path: &str, task_id: &str) -> String {
    PathBuf::from(workspace_path)
        .join(BENCHMARK_AGENT_SUBMISSIONS_DIR)
        .join(task_id)
        .join(BENCHMARK_AGENT_SUBMISSION_PATCH_FILE)
        .display()
        .to_string()
}

fn benchmark_agent_batch_histories_dir() -> PathBuf {
    benchmark_runs_dir().join("agent-batches")
}

fn benchmark_agent_batch_history_path(batch_id: &str) -> PathBuf {
    benchmark_agent_batch_histories_dir().join(format!("{batch_id}.json"))
}

fn persist_agent_batch_status(status: &BenchmarkAgentBatchStatus) -> Result<(), String> {
    let dir = benchmark_agent_batch_histories_dir();
    fs::create_dir_all(&dir).map_err(|err| {
        format!(
            "Failed to create benchmark agent batch history dir {}: {err}",
            dir.display()
        )
    })?;
    let path = benchmark_agent_batch_history_path(&status.batch_id);
    let tmp_path = path.with_extension("json.tmp");
    let serialized = serde_json::to_string_pretty(status)
        .map_err(|err| format!("Failed to serialize benchmark agent batch history: {err}"))?;
    fs::write(&tmp_path, serialized).map_err(|err| {
        format!(
            "Failed to write benchmark agent batch history tmp file {}: {err}",
            tmp_path.display()
        )
    })?;
    fs::rename(&tmp_path, &path).map_err(|err| {
        format!(
            "Failed to replace benchmark agent batch history file {}: {err}",
            path.display()
        )
    })
}

async fn persist_agent_batch_by_id(batch_id: &str) -> Result<(), String> {
    let status = BENCHMARK_AGENT_BATCHES
        .lock()
        .await
        .get(batch_id)
        .cloned()
        .ok_or_else(|| format!("Benchmark agent batch not found: {batch_id}"))?;
    persist_agent_batch_status(&status)
}

fn load_agent_batch_history(batch_id: &str) -> Result<BenchmarkAgentBatchStatus, String> {
    let path = benchmark_agent_batch_history_path(batch_id);
    let raw = fs::read_to_string(&path)
        .map_err(|err| format!("Benchmark agent batch not found: {batch_id} ({})", err))?;
    serde_json::from_str(&raw).map_err(|err| {
        format!(
            "Failed to parse benchmark agent batch history {}: {err}",
            path.display()
        )
    })
}

fn load_agent_batch_histories() -> Result<Vec<BenchmarkAgentBatchStatus>, String> {
    let dir = benchmark_agent_batch_histories_dir();
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let entries = fs::read_dir(&dir).map_err(|err| {
        format!(
            "Failed to read benchmark agent batch history dir {}: {err}",
            dir.display()
        )
    })?;
    let mut histories = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|err| format!("Failed to read history dir entry: {err}"))?;
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let raw = fs::read_to_string(&path).map_err(|err| {
            format!(
                "Failed to read benchmark agent batch history {}: {err}",
                path.display()
            )
        })?;
        histories.push(serde_json::from_str(&raw).map_err(|err| {
            format!(
                "Failed to parse benchmark agent batch history {}: {err}",
                path.display()
            )
        })?);
    }
    Ok(histories)
}

fn benchmark_python_env_dir() -> PathBuf {
    app_paths::orgii_root()
        .join("benchmark-python")
        .join(".venv")
}

fn benchmark_python_path() -> PathBuf {
    let env_dir = benchmark_python_env_dir();
    if cfg!(windows) {
        env_dir.join("Scripts").join("python.exe")
    } else {
        env_dir.join("bin").join("python")
    }
}

fn benchmark_run_output_dir(run_id: &str) -> PathBuf {
    benchmark_runs_dir().join(run_id)
}

fn swe_bench_command_preview(
    source_path: &str,
    patch_path: &Path,
    output_dir: &Path,
) -> Vec<String> {
    vec![
        benchmark_python_path().display().to_string(),
        swe_bench_evaluator_script_path().display().to_string(),
        "--raw_sample_path".to_string(),
        source_path.to_string(),
        "--patch_path".to_string(),
        patch_path.display().to_string(),
        "--output_dir".to_string(),
        output_dir.display().to_string(),
        "--scripts_dir".to_string(),
        swe_bench_run_scripts_dir().display().to_string(),
        "--dockerhub_username".to_string(),
        SWE_BENCH_PRO_DOCKERHUB_USERNAME.to_string(),
        "--use_local_docker".to_string(),
        "--num_workers".to_string(),
        "1".to_string(),
    ]
}

fn swe_bench_patch_only_command_preview(
    task: &BenchmarkTaskDetail,
    patch_path: &Path,
) -> Vec<String> {
    let base_commit = task
        .index
        .metadata
        .get("base_commit")
        .and_then(string_value)
        .unwrap_or_else(|| "<base_commit>".to_string());
    vec![
        "git".to_string(),
        "worktree".to_string(),
        "add".to_string(),
        "-b".to_string(),
        "benchmark/<run-id>".to_string(),
        "<worktree-path>".to_string(),
        base_commit,
        "&&".to_string(),
        "git".to_string(),
        "-C".to_string(),
        "<worktree-path>".to_string(),
        "apply".to_string(),
        "--whitespace=nowarn".to_string(),
        patch_path.display().to_string(),
    ]
}

fn read_eval_result(output_dir: &str, task_id: &str) -> Result<Value, String> {
    let results_path = Path::new(output_dir).join("eval_results.json");
    let file = File::open(&results_path)
        .map_err(|error| format!("Failed to open eval results: {error}"))?;
    let results: Value = serde_json::from_reader(file)
        .map_err(|error| format!("Failed to parse eval results: {error}"))?;
    Ok(results
        .get(task_id)
        .cloned()
        .unwrap_or_else(|| serde_json::json!({ "raw": results })))
}

fn trim_logs(logs: &mut Vec<String>) {
    if logs.len() > MAX_RUN_LOG_LINES {
        let drain_count = logs.len() - MAX_RUN_LOG_LINES;
        logs.drain(0..drain_count);
    }
}

fn truncate_detail(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let mut truncated: String = value.chars().take(max_chars).collect();
    truncated.push('…');
    truncated
}

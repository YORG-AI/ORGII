//! `#[tauri::command]` entry points for the benchmark surface.

use std::collections::HashSet;
use std::fs;
use std::sync::Arc;

use agent_core::definitions::orgs::AgentOrgsStore;
use agent_core::state::commands::session::launch::session_launch_impl;
use agent_core::state::AgentAppState;
use chrono::Utc;
use tauri::Manager;
use tokio::sync::Semaphore;
use uuid::Uuid;

use super::agent_batch::{
    cancel_agent_batch_item_session, create_agent_batch_item, is_agent_batch_cancelled,
    load_agent_batch_for_update, mark_agent_batch_item_cancelled, mark_agent_batch_item_failed,
    mark_agent_batch_item_launched, mark_agent_batch_item_running, persist_updated_agent_batch,
    refresh_agent_batch_counts, refresh_agent_batch_evaluations, spawn_agent_batch_task,
};
use super::dataset::{
    ensure_supported_swe_bench_mode, ensure_swe_bench_pro, read_swe_bench_rows,
    read_swe_bench_task, swe_bench_row_to_detail, task_matches_query,
};
use super::dto::{
    BenchmarkAgentBatchStatus, BenchmarkCancelAgentBatchRequest, BenchmarkCancelRunRequest,
    BenchmarkCreateRunPlanRequest, BenchmarkEvaluateAgentBatchRequest,
    BenchmarkGetAgentBatchStatusRequest, BenchmarkGetRunStatusRequest, BenchmarkGetTaskRequest,
    BenchmarkListAgentBatchHistoriesRequest, BenchmarkListTasksRequest, BenchmarkPreflightRequest,
    BenchmarkPreflightResult, BenchmarkRunPlan, BenchmarkRunStatus,
    BenchmarkStartAgentBatchRequest, BenchmarkStartRunRequest, BenchmarkTaskDetail,
    BenchmarkTaskIndexRow, BenchmarkUpdateAgentBatchTasksRequest,
};
use super::e2e_docker::is_e2e_docker_benchmark_task;
use super::history::{
    load_agent_batch_histories, load_agent_batch_history, persist_agent_batch_by_id,
    persist_agent_batch_status,
};
use super::launch::{
    benchmark_agent_prompt, benchmark_launch_params, benchmark_session_name,
    create_benchmark_master_session,
};
use super::paths::benchmark_agent_submission_patch_path;
use super::preflight::{run_swe_bench_preflight, run_terminal_bench_preflight};
use super::process::terminate_process;
use super::retention::{prune_terminal_agent_batches, prune_terminal_runs};
use super::run::trim_logs;
use super::swe_bench::{
    build_swe_bench_run_plan, run_swe_bench_patch_only_worktree, run_swe_bench_process,
};
use super::{
    BENCHMARK_AGENT_BATCHES, BENCHMARK_AGENT_BATCH_STATUS_CANCELLED,
    BENCHMARK_AGENT_BATCH_STATUS_QUEUED, BENCHMARK_AGENT_BATCH_STATUS_RUNNING,
    BENCHMARK_AGENT_SUBMISSIONS_DIR, BENCHMARK_AGENT_SUBMISSION_PATCH_FILE,
    BENCHMARK_BATCH_TASK_ACTION_ADD, BENCHMARK_BATCH_TASK_ACTION_CANCEL,
    BENCHMARK_BATCH_TASK_ACTION_REMOVE, BENCHMARK_BATCH_TASK_ACTION_RESTART,
    BENCHMARK_KIND_SWE_BENCH_PRO, BENCHMARK_KIND_TERMINAL_BENCH, BENCHMARK_RUNS,
    BENCHMARK_RUN_STATUS_CANCELLED, BENCHMARK_RUN_STATUS_FAILED, BENCHMARK_RUN_STATUS_RUNNING,
    DEFAULT_AGENT_BATCH_CONCURRENCY, EVALUATION_MODE_LOCAL_DOCKER, EVALUATION_MODE_PATCH_ONLY,
    MAX_AGENT_BATCH_CONCURRENCY,
};

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
        let process_id = status.process_id;
        prune_terminal_runs(&mut runs);
        process_id
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
    prune_terminal_agent_batches(&mut batches);
    drop(batches);
    persist_agent_batch_status(&status)?;
    Ok(status)
}

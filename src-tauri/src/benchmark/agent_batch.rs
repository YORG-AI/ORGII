//! Agent batch lifecycle: item state transitions, task spawning, and counters.

use agent_core::definitions::orgs::AgentOrgsStore;
use agent_core::state::commands::session::launch::{session_launch_impl, SessionLaunchResult};
use agent_core::state::control_flow::CancelReason;
use agent_core::state::AgentAppState;
use chrono::Utc;
use tauri::Manager;

use super::dataset::read_swe_bench_task;
use super::dto::{
    BenchmarkAgentBatchItem, BenchmarkAgentBatchStatus, BenchmarkAgentLaunchSelection,
};
use super::history::{load_agent_batch_history, persist_agent_batch_status};
use super::launch::{benchmark_agent_prompt, benchmark_launch_params};
use super::paths::benchmark_agent_submission_patch_path;
use super::retention::prune_terminal_agent_batches;
use super::run::trim_logs;
use super::{
    BENCHMARK_AGENT_BATCHES, BENCHMARK_AGENT_BATCH_STATUS_CANCELLED,
    BENCHMARK_AGENT_BATCH_STATUS_FAILED, BENCHMARK_AGENT_BATCH_STATUS_LAUNCHED,
    BENCHMARK_AGENT_BATCH_STATUS_QUEUED, BENCHMARK_AGENT_BATCH_STATUS_RUNNING,
    BENCHMARK_AGENT_SUBMISSIONS_DIR, BENCHMARK_AGENT_SUBMISSION_PATCH_FILE, BENCHMARK_RUNS,
};

pub(super) async fn load_agent_batch_for_update(
    batch_id: &str,
) -> Result<BenchmarkAgentBatchStatus, String> {
    if let Some(status) = BENCHMARK_AGENT_BATCHES.lock().await.get(batch_id).cloned() {
        return Ok(status);
    }
    let status = load_agent_batch_history(batch_id)?;
    let mut batches = BENCHMARK_AGENT_BATCHES.lock().await;
    batches.insert(batch_id.to_string(), status.clone());
    prune_terminal_agent_batches(&mut batches);
    Ok(status)
}

pub(super) async fn persist_updated_agent_batch(
    mut batch: BenchmarkAgentBatchStatus,
) -> Result<BenchmarkAgentBatchStatus, String> {
    refresh_agent_batch_counts(&mut batch);
    let mut batches = BENCHMARK_AGENT_BATCHES.lock().await;
    batches.insert(batch.batch_id.clone(), batch.clone());
    prune_terminal_agent_batches(&mut batches);
    drop(batches);
    persist_agent_batch_status(&batch)?;
    Ok(batch)
}

pub(super) async fn refresh_agent_batch_evaluations(
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
        let mut batches = BENCHMARK_AGENT_BATCHES.lock().await;
        batches.insert(batch.batch_id.clone(), batch.clone());
        prune_terminal_agent_batches(&mut batches);
        drop(batches);
        persist_agent_batch_status(&batch)?;
    }
    Ok(batch)
}

pub(super) fn create_agent_batch_item(
    task_id: &str,
    workspace_path: &str,
) -> BenchmarkAgentBatchItem {
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

pub(super) async fn is_agent_batch_cancelled(batch_id: &str) -> bool {
    BENCHMARK_AGENT_BATCHES
        .lock()
        .await
        .get(batch_id)
        .is_some_and(|batch| batch.status == BENCHMARK_AGENT_BATCH_STATUS_CANCELLED)
}

pub(super) async fn mark_agent_batch_item_running(batch_id: &str, task_id: &str) {
    update_agent_batch_item(batch_id, task_id, |item| {
        item.status = BENCHMARK_AGENT_BATCH_STATUS_RUNNING.to_string();
        item.started_at = Some(Utc::now().to_rfc3339());
        item.logs
            .push("Launching background agent session.".to_string());
        trim_logs(&mut item.logs);
    })
    .await;
}

pub(super) async fn mark_agent_batch_item_cancelled(batch_id: &str, task_id: &str) {
    update_agent_batch_item(batch_id, task_id, |item| {
        item.status = BENCHMARK_AGENT_BATCH_STATUS_CANCELLED.to_string();
        item.finished_at = Some(Utc::now().to_rfc3339());
        item.logs.push("Cancelled before agent launch.".to_string());
        trim_logs(&mut item.logs);
    })
    .await;
}

pub(super) async fn mark_agent_batch_item_launched(
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

pub(super) async fn mark_agent_batch_item_failed(batch_id: &str, task_id: &str, error: String) {
    update_agent_batch_item(batch_id, task_id, |item| {
        item.status = BENCHMARK_AGENT_BATCH_STATUS_FAILED.to_string();
        item.finished_at = Some(Utc::now().to_rfc3339());
        item.error = Some(error.clone());
        item.logs.push(format!("Launch failed: {error}"));
        trim_logs(&mut item.logs);
    })
    .await;
}

pub(super) async fn cancel_agent_batch_item_session(
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

pub(super) fn spawn_agent_batch_task(
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
        let status = batch.clone();
        prune_terminal_agent_batches(&mut batches);
        status
    };
    if let Err(error) = persist_agent_batch_status(&status) {
        tracing::warn!(
            batch_id = %status.batch_id,
            error = %error,
            "[benchmark] failed to persist agent batch status"
        );
    }
}

pub(super) fn refresh_agent_batch_counts(batch: &mut BenchmarkAgentBatchStatus) {
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

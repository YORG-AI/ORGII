//! Bookkeeping for in-flight benchmark evaluator runs.

use chrono::Utc;
use serde_json::Value;

use super::{BENCHMARK_RUNS, BENCHMARK_RUN_STATUS_CANCELLED, MAX_RUN_LOG_LINES};

pub(super) async fn set_run_process_id(run_id: &str, process_id: u32) {
    let mut runs = BENCHMARK_RUNS.lock().await;
    if let Some(status) = runs.get_mut(run_id) {
        status.process_id = Some(process_id);
        status
            .logs
            .push(format!("Evaluator process started with PID {process_id}"));
        trim_logs(&mut status.logs);
    }
}

pub(super) async fn append_run_log(run_id: &str, line: String) {
    let mut runs = BENCHMARK_RUNS.lock().await;
    if let Some(status) = runs.get_mut(run_id) {
        if status.status == BENCHMARK_RUN_STATUS_CANCELLED {
            return;
        }
        status.logs.push(line);
        trim_logs(&mut status.logs);
    }
}

pub(super) async fn finish_run(
    run_id: &str,
    status_value: &str,
    exit_code: Option<i32>,
    error: Option<String>,
) {
    finish_run_with_result(run_id, status_value, exit_code, None, error).await;
}

pub(super) async fn finish_run_with_result(
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

pub(super) fn trim_logs(logs: &mut Vec<String>) {
    if logs.len() > MAX_RUN_LOG_LINES {
        let drain_count = logs.len() - MAX_RUN_LOG_LINES;
        logs.drain(0..drain_count);
    }
}

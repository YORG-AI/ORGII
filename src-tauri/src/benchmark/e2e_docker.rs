//! Debug-only Docker evaluator fixture used by the benchmark E2E suite.

use std::fs;
use std::path::Path;

use tokio::io::{AsyncBufReadExt, BufReader as TokioBufReader};
use tokio::process::Command;

use super::dto::BenchmarkRunPlan;
use super::run::{append_run_log, finish_run, finish_run_with_result, set_run_process_id};
use super::{
    BENCHMARK_RUN_STATUS_FAILED, BENCHMARK_RUN_STATUS_PASSED, E2E_DOCKER_BENCHMARK_TASK_ID,
    EVALUATION_MODE_LOCAL_DOCKER,
};

pub(super) async fn run_e2e_docker_benchmark_process(plan: BenchmarkRunPlan) {
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

pub(super) fn is_e2e_docker_benchmark_task(plan: &BenchmarkRunPlan) -> bool {
    cfg!(debug_assertions)
        && plan.evaluation_mode == EVALUATION_MODE_LOCAL_DOCKER
        && plan.task_id == E2E_DOCKER_BENCHMARK_TASK_ID
}

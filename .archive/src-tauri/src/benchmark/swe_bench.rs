//! SWE-bench Pro run planning and evaluator execution.

use std::fs::File;
use std::path::{Path, PathBuf};

use chrono::Utc;
use git::worktree::create_session_worktree;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader as TokioBufReader};
use tokio::process::Command;
use uuid::Uuid;

use super::dataset::{
    find_swe_bench_row, read_swe_bench_task, resolve_swe_bench_source_path, string_field,
    string_value,
};
use super::dto::{BenchmarkRunPlan, BenchmarkRunStatus, BenchmarkTaskDetail};
use super::e2e_docker::{is_e2e_docker_benchmark_task, run_e2e_docker_benchmark_process};
use super::paths::{
    benchmark_python_path, benchmark_run_output_dir, swe_bench_evaluator_script_path,
    swe_bench_run_scripts_dir,
};
use super::preflight::run_swe_bench_preflight;
use super::process::{command_version_in_dir, ensure_benchmark_python_env};
use super::retention::prune_terminal_runs;
use super::run::{append_run_log, finish_run, finish_run_with_result, set_run_process_id};
use super::{
    BENCHMARK_RUNS, BENCHMARK_RUN_STATUS_APPLIED, BENCHMARK_RUN_STATUS_FAILED,
    BENCHMARK_RUN_STATUS_PASSED, EVALUATION_MODE_LOCAL_DOCKER, EVALUATION_MODE_PATCH_ONLY,
    SWE_BENCH_PRO_DOCKERHUB_USERNAME,
};

pub(super) async fn build_swe_bench_run_plan(
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

    let (evaluator_script, scripts_dir) = if evaluation_mode == EVALUATION_MODE_LOCAL_DOCKER {
        let evaluator_script =
            swe_bench_evaluator_script_path().map_err(|error| error.message())?;
        let scripts_dir = swe_bench_run_scripts_dir().map_err(|error| error.message())?;
        (Some(evaluator_script), Some(scripts_dir))
    } else {
        (None, None)
    };
    let repo_path_string = repo_path
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let worktree_path = None;
    let command_preview = match (&evaluator_script, &scripts_dir) {
        (Some(evaluator_script), Some(scripts_dir)) => swe_bench_command_preview(
            evaluator_script,
            scripts_dir,
            &resolved_source_path_string,
            &patch_path,
            &output_dir,
        ),
        _ => swe_bench_patch_only_command_preview(&task, &patch_path),
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

pub(super) async fn run_swe_bench_patch_only_worktree(
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

    let mut runs = BENCHMARK_RUNS.lock().await;
    runs.insert(plan.run_id.clone(), status_value.clone());
    prune_terminal_runs(&mut runs);
    drop(runs);

    Ok(status_value)
}

pub(super) async fn run_swe_bench_process(plan: BenchmarkRunPlan) {
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

fn swe_bench_command_preview(
    evaluator_script: &Path,
    scripts_dir: &Path,
    source_path: &str,
    patch_path: &Path,
    output_dir: &Path,
) -> Vec<String> {
    vec![
        benchmark_python_path().display().to_string(),
        evaluator_script.display().to_string(),
        "--raw_sample_path".to_string(),
        source_path.to_string(),
        "--patch_path".to_string(),
        patch_path.display().to_string(),
        "--output_dir".to_string(),
        output_dir.display().to_string(),
        "--scripts_dir".to_string(),
        scripts_dir.display().to_string(),
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

//! Preflight readiness checks for SWE-bench Pro and Terminal-Bench.

use std::path::PathBuf;

use super::dataset::{
    ensure_swe_bench_pro, find_swe_bench_row, read_swe_bench_rows, resolve_swe_bench_source_path,
    string_field,
};
use super::dto::{BenchmarkPreflightCheck, BenchmarkPreflightResult};
use super::paths::{modal_config_path, swe_bench_evaluator_script_path, swe_bench_run_scripts_dir};
use super::process::{
    command_version, command_version_in_dir, ensure_benchmark_python_env, run_python_import,
};
use super::{
    BENCHMARK_KIND_TERMINAL_BENCH, BENCHMARK_PYTHON_PACKAGES, EVALUATION_MODE_LOCAL_DOCKER,
    EVALUATION_MODE_MODAL, EVALUATION_MODE_PATCH_ONLY,
};

pub(super) async fn run_swe_bench_preflight(
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

pub(super) async fn run_terminal_bench_preflight(
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

fn truncate_detail(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let mut truncated: String = value.chars().take(max_chars).collect();
    truncated.push('…');
    truncated
}

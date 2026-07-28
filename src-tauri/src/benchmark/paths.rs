//! Filesystem locations used by benchmark runs and agent batches.

use std::path::PathBuf;

use super::{
    BENCHMARK_AGENT_SUBMISSIONS_DIR, BENCHMARK_AGENT_SUBMISSION_PATCH_FILE,
    SWE_BENCH_PRO_EVALUATOR_SCRIPT, SWE_BENCH_PRO_REPO_PATH, SWE_BENCH_PRO_RUN_SCRIPTS_DIR,
};

pub(super) fn modal_config_path() -> PathBuf {
    app_paths::home_dir().join(".modal.toml")
}

fn swe_bench_repo_path() -> PathBuf {
    std::env::var("ORGII_SWE_BENCH_PRO_REPO_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(SWE_BENCH_PRO_REPO_PATH))
}

pub(super) fn swe_bench_evaluator_script_path() -> PathBuf {
    swe_bench_repo_path().join(SWE_BENCH_PRO_EVALUATOR_SCRIPT)
}

pub(super) fn swe_bench_run_scripts_dir() -> PathBuf {
    swe_bench_repo_path().join(SWE_BENCH_PRO_RUN_SCRIPTS_DIR)
}

fn benchmark_runs_dir() -> PathBuf {
    app_paths::orgii_root().join("benchmark-runs")
}

pub(super) fn benchmark_agent_submission_patch_path(workspace_path: &str, task_id: &str) -> String {
    PathBuf::from(workspace_path)
        .join(BENCHMARK_AGENT_SUBMISSIONS_DIR)
        .join(task_id)
        .join(BENCHMARK_AGENT_SUBMISSION_PATCH_FILE)
        .display()
        .to_string()
}

pub(super) fn benchmark_agent_batch_histories_dir() -> PathBuf {
    benchmark_runs_dir().join("agent-batches")
}

pub(super) fn benchmark_agent_batch_history_path(batch_id: &str) -> PathBuf {
    benchmark_agent_batch_histories_dir().join(format!("{batch_id}.json"))
}

pub(super) fn benchmark_python_env_dir() -> PathBuf {
    app_paths::orgii_root()
        .join("benchmark-python")
        .join(".venv")
}

pub(super) fn benchmark_python_path() -> PathBuf {
    let env_dir = benchmark_python_env_dir();
    if cfg!(windows) {
        env_dir.join("Scripts").join("python.exe")
    } else {
        env_dir.join("bin").join("python")
    }
}

pub(super) fn benchmark_run_output_dir(run_id: &str) -> PathBuf {
    benchmark_runs_dir().join(run_id)
}

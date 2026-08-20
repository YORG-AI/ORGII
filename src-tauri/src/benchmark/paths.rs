//! Filesystem locations used by benchmark runs and agent batches.

use std::path::PathBuf;

use super::{
    BENCHMARK_AGENT_SUBMISSIONS_DIR, BENCHMARK_AGENT_SUBMISSION_PATCH_FILE,
    SWE_BENCH_PRO_EVALUATOR_SCRIPT, SWE_BENCH_PRO_RUN_SCRIPTS_DIR,
};

/// Environment variable naming the local SWE-bench Pro harness checkout
/// (the repo containing the evaluator script and per-task run scripts).
pub(super) const SWE_BENCH_PRO_REPO_PATH_ENV: &str = "ORGII_SWE_BENCH_PRO_REPO_PATH";

/// Typed "not configured" state for the SWE-bench Pro harness repository.
///
/// There is intentionally no filesystem default: callers must surface this as
/// a configure-first error instead of failing later on a missing file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct SweBenchRepoNotConfigured;

impl SweBenchRepoNotConfigured {
    pub(super) fn message(self) -> String {
        format!(
            "SWE-bench Pro repository path is not configured. Set the {SWE_BENCH_PRO_REPO_PATH_ENV} environment variable to a local SWE-bench Pro checkout before running Docker evaluation."
        )
    }
}

/// Resolves the harness repo path with explicit-first precedence:
/// explicit value (app setting / command argument) → environment variable →
/// typed "not configured" error. Blank values count as unset.
fn resolve_swe_bench_repo_path(
    explicit: Option<&str>,
    env_value: Option<&str>,
) -> Result<PathBuf, SweBenchRepoNotConfigured> {
    [explicit, env_value]
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or(SweBenchRepoNotConfigured)
}

fn swe_bench_repo_path() -> Result<PathBuf, SweBenchRepoNotConfigured> {
    // No explicit app setting exists yet, so the environment variable is the
    // only configuration source (also used by the E2E suite fixture).
    resolve_swe_bench_repo_path(
        None,
        std::env::var(SWE_BENCH_PRO_REPO_PATH_ENV).ok().as_deref(),
    )
}

pub(super) fn modal_config_path() -> PathBuf {
    app_paths::home_dir().join(".modal.toml")
}

pub(super) fn swe_bench_evaluator_script_path() -> Result<PathBuf, SweBenchRepoNotConfigured> {
    Ok(swe_bench_repo_path()?.join(SWE_BENCH_PRO_EVALUATOR_SCRIPT))
}

pub(super) fn swe_bench_run_scripts_dir() -> Result<PathBuf, SweBenchRepoNotConfigured> {
    Ok(swe_bench_repo_path()?.join(SWE_BENCH_PRO_RUN_SCRIPTS_DIR))
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

#[cfg(test)]
mod tests {
    use super::{
        resolve_swe_bench_repo_path, SweBenchRepoNotConfigured, SWE_BENCH_PRO_REPO_PATH_ENV,
    };
    use std::path::PathBuf;

    #[test]
    fn explicit_value_wins_over_environment() {
        assert_eq!(
            resolve_swe_bench_repo_path(Some("/explicit/harness"), Some("/env/harness")),
            Ok(PathBuf::from("/explicit/harness"))
        );
    }

    #[test]
    fn environment_is_used_when_no_explicit_value() {
        assert_eq!(
            resolve_swe_bench_repo_path(None, Some("/env/harness")),
            Ok(PathBuf::from("/env/harness"))
        );
    }

    #[test]
    fn blank_explicit_value_falls_back_to_environment() {
        assert_eq!(
            resolve_swe_bench_repo_path(Some("   "), Some("/env/harness")),
            Ok(PathBuf::from("/env/harness"))
        );
    }

    #[test]
    fn resolved_paths_are_trimmed() {
        assert_eq!(
            resolve_swe_bench_repo_path(None, Some("  /env/harness  ")),
            Ok(PathBuf::from("/env/harness"))
        );
    }

    #[test]
    fn missing_configuration_is_a_typed_error() {
        assert_eq!(
            resolve_swe_bench_repo_path(None, None),
            Err(SweBenchRepoNotConfigured)
        );
    }

    #[test]
    fn blank_configuration_counts_as_unset() {
        assert_eq!(
            resolve_swe_bench_repo_path(Some(""), Some("   ")),
            Err(SweBenchRepoNotConfigured)
        );
    }

    #[test]
    fn not_configured_message_names_the_environment_variable() {
        assert!(SweBenchRepoNotConfigured
            .message()
            .contains(SWE_BENCH_PRO_REPO_PATH_ENV));
    }
}

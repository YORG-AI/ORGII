//! Benchmark harness surface (SWE-bench Pro and Terminal-Bench).
//!
//! Layout:
//! - `dto`: serde payload types exchanged with the frontend.
//! - `commands`: the `#[tauri::command]` entry points (re-exported below).
//! - `dataset`: SWE-bench Pro dataset resolution and JSONL parsing.
//! - `preflight`: readiness checks per benchmark kind and evaluation mode.
//! - `swe_bench`: run planning plus patch-only and Docker evaluator execution.
//! - `e2e_docker`: debug-only Docker evaluator fixture for the E2E suite.
//! - `run`: in-flight run status bookkeeping.
//! - `agent_batch` / `launch` / `history`: agent batch lifecycle, session launch
//!   helpers, and on-disk batch history.
//! - `paths` / `process`: filesystem locations and external process helpers.

mod agent_batch;
mod commands;
mod dataset;
mod dto;
mod e2e_docker;
mod history;
mod launch;
mod paths;
mod preflight;
mod process;
mod run;
mod swe_bench;

use std::collections::HashMap;
use std::sync::{Arc, LazyLock};

use tokio::sync::Mutex;

pub use commands::*;
pub use dto::*;

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

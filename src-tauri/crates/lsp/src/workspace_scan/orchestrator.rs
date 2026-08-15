//! Lint Scan Orchestrator
//!
//! Moves the scheduling logic from frontend TypeScript to Rust backend.
//! The frontend calls a single `lint_scan_orchestrated` command and receives
//! events as each tool completes.
//!
//! Features:
//! - Python tool deduplication (ruff > pylint > flake8)
//! - ESLint directory chunking (parallel per-directory scans)
//! - Heavy tool concurrency limiting (memory-constrained Node.js tools)
//! - Event-based progress reporting
//! - Single final summary

use serde::Serialize;
use std::collections::HashSet;
use std::sync::Arc;
use tauri::Emitter;
use tokio::sync::Semaphore;

use super::clippy;
use super::css;
use super::eslint;
use super::golangci_lint;
use super::process::eslint_available;
use super::python;
use super::shell;
use super::types::{AvailableTool, SingleToolResult, WorkspaceDiagnostic};
use super::typescript;
use crate::command_detection::command_exists;
use crate::workspace_config::is_lint_tool_enabled;

// ============================================
// Constants
// ============================================

/// Max concurrent heavy (Node.js) tools to avoid memory spikes.
/// Each ESLint process loads ~300MB for TypeScript parser.
const MAX_HEAVY_CONCURRENCY: usize = 2;

/// Tools that spawn heavy Node.js processes.
const HEAVY_TOOLS: &[&str] = &["eslint", "tsc", "stylelint"];

/// Python tools that overlap — only one should run.
const PYTHON_EXCLUSIVE_TOOLS: &[&str] = &["ruff", "pylint", "flake8"];

// NOTE: LSP cache fallback is handled in the frontend for now.
// The orchestrator runs all tools directly.

// ============================================
// Event Types (sent to frontend)
// ============================================

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LintToolStartedEvent {
    pub tool: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LintToolCompletedEvent {
    pub tool: String,
    pub diagnostics: Vec<WorkspaceDiagnostic>,
    pub files_scanned: u32,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LintScanCompleteEvent {
    pub tools_run: Vec<String>,
    pub total_diagnostics: usize,
    pub errors: Vec<String>,
}

// ============================================
// Result Types
// ============================================

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LintScanSummary {
    pub tools_run: Vec<String>,
    pub total_diagnostics: usize,
    pub total_files_scanned: u32,
    pub errors: Vec<String>,
}

// ============================================
// Internal Types
// ============================================

/// A single scan job (one tool invocation).
struct ScanJob {
    /// Base tool name (e.g. "eslint", "clippy")
    tool: String,
    /// Display label (e.g. "eslint:src/hooks")
    label: String,
    /// Optional subdirectory for ESLint chunking
    target_dir: Option<String>,
    /// Optional file paths for scoped scans
    file_paths: Option<Vec<String>>,
    /// Whether this is a heavy (Node.js) tool
    is_heavy: bool,
}

// ============================================
// Orchestrator Command
// ============================================

/// Orchestrated lint scan — single command that handles everything.
///
/// 1. Discovers available tools
/// 2. Deduplicates Python tools (ruff > pylint > flake8)
/// 3. Expands ESLint into per-directory jobs
/// 4. Runs jobs with concurrency limits
/// 5. Emits events as each tool completes
/// 6. Returns final summary
#[tauri::command]
pub async fn lint_scan_orchestrated(
    workspace_path: String,
    tool_overrides: Option<Vec<String>>,
    scope_files: Option<Vec<String>>,
    window: tauri::Window,
) -> Result<LintScanSummary, String> {
    let wp = workspace_path.clone();

    // Step 1: Get available tools
    let all_tools = get_available_tools(&wp);

    // Filter to active tools
    let override_set: Option<HashSet<String>> = tool_overrides.map(|v| v.into_iter().collect());
    let active_tools: Vec<AvailableTool> = all_tools
        .into_iter()
        .filter(|tool| {
            if let Some(ref overrides) = override_set {
                tool.installed && overrides.contains(&tool.name)
            } else {
                tool.enabled && tool.installed
            }
        })
        .collect();

    if active_tools.is_empty() {
        return Ok(LintScanSummary {
            tools_run: vec![],
            total_diagnostics: 0,
            total_files_scanned: 0,
            errors: vec!["No lint tools available".to_string()],
        });
    }

    // Step 2: Deduplicate Python tools
    let chosen_python = pick_python_tool(&active_tools);
    let python_exclusive: HashSet<&str> = PYTHON_EXCLUSIVE_TOOLS.iter().copied().collect();
    let tools_to_run: Vec<AvailableTool> = active_tools
        .into_iter()
        .filter(|tool| {
            if python_exclusive.contains(tool.name.as_str()) {
                chosen_python.as_ref() == Some(&tool.name)
            } else {
                true
            }
        })
        .collect();

    // Step 3: Build jobs
    let heavy_tools_set: HashSet<&str> = HEAVY_TOOLS.iter().copied().collect();
    let mut jobs: Vec<ScanJob> = Vec::new();

    for tool in &tools_to_run {
        let is_heavy = heavy_tools_set.contains(tool.name.as_str());

        // ESLint: expand to per-directory jobs unless scoped to files
        if tool.name == "eslint" && scope_files.is_none() {
            match eslint::get_eslint_targets(&wp) {
                Ok(targets) if targets.len() > 1 => {
                    for target in targets {
                        jobs.push(ScanJob {
                            tool: tool.name.clone(),
                            label: format!("eslint:{}", target),
                            target_dir: Some(target),
                            file_paths: None,
                            is_heavy,
                        });
                    }
                    continue;
                }
                _ => {} // Fall through to single job
            }
        }

        jobs.push(ScanJob {
            tool: tool.name.clone(),
            label: tool.name.clone(),
            target_dir: None,
            file_paths: scope_files.clone(),
            is_heavy,
        });
    }

    if jobs.is_empty() {
        return Ok(LintScanSummary {
            tools_run: vec![],
            total_diagnostics: 0,
            total_files_scanned: 0,
            errors: vec!["No scan targets found".to_string()],
        });
    }

    // Step 4: Execute jobs with concurrency control
    let results = Arc::new(tokio::sync::Mutex::new(Vec::<SingleToolResult>::new()));
    let errors = Arc::new(tokio::sync::Mutex::new(Vec::<String>::new()));
    let heavy_semaphore = Arc::new(Semaphore::new(MAX_HEAVY_CONCURRENCY));

    let mut handles = Vec::new();

    for job in jobs {
        let wp = workspace_path.clone();
        let window = window.clone();
        let results = Arc::clone(&results);
        let errors = Arc::clone(&errors);
        let semaphore = Arc::clone(&heavy_semaphore);

        let handle = tokio::spawn(async move {
            // Acquire permit for heavy tools
            let _permit = if job.is_heavy {
                Some(semaphore.acquire().await.ok())
            } else {
                None
            };

            // Emit started event
            let _ = window.emit(
                "lint:tool_started",
                LintToolStartedEvent {
                    tool: job.label.clone(),
                },
            );

            // Run the tool
            let result = run_tool_job(&wp, &job).await;

            // Store result
            let mut results_guard = results.lock().await;
            let tool_result = match result {
                Ok(output) => {
                    log::info!(
                        "[LintOrchestrator] {} completed: {} diagnostics in {} files",
                        job.label,
                        output.diagnostics.len(),
                        output.files_scanned
                    );
                    SingleToolResult {
                        tool: job.label.clone(),
                        diagnostics: output.diagnostics.clone(),
                        files_scanned: output.files_scanned,
                        error: None,
                    }
                }
                Err(err) => {
                    log::warn!("[LintOrchestrator] {} failed: {}", job.label, err);
                    errors.lock().await.push(format!("{}: {}", job.label, err));
                    SingleToolResult {
                        tool: job.label.clone(),
                        diagnostics: vec![],
                        files_scanned: 0,
                        error: Some(err.clone()),
                    }
                }
            };

            // Emit completed event
            let _ = window.emit(
                "lint:tool_completed",
                LintToolCompletedEvent {
                    tool: tool_result.tool.clone(),
                    diagnostics: tool_result.diagnostics.clone(),
                    files_scanned: tool_result.files_scanned,
                    error: tool_result.error.clone(),
                },
            );

            results_guard.push(tool_result);
        });

        handles.push(handle);
    }

    // Wait for all jobs to complete
    for handle in handles {
        let _ = handle.await;
    }

    // Step 5: Build summary
    let results = results.lock().await;
    let errors = errors.lock().await;

    // Aggregate by base tool name (collapse eslint:* into one)
    let mut tools_run: Vec<String> = results
        .iter()
        .map(|r| r.tool.split(':').next().unwrap_or(&r.tool).to_string())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    tools_run.sort();

    let total_diagnostics: usize = results.iter().map(|r| r.diagnostics.len()).sum();
    let total_files_scanned: u32 = results.iter().map(|r| r.files_scanned).sum();

    let summary = LintScanSummary {
        tools_run: tools_run.clone(),
        total_diagnostics,
        total_files_scanned,
        errors: errors.to_vec(),
    };

    // Emit final complete event
    let _ = window.emit(
        "lint:scan_complete",
        LintScanCompleteEvent {
            tools_run,
            total_diagnostics,
            errors: errors.to_vec(),
        },
    );

    Ok(summary)
}

// ============================================
// Tool Discovery
// ============================================

fn node_bin_exists(workspace_path: &str, bin_name: &str) -> bool {
    std::path::Path::new(workspace_path)
        .join("node_modules")
        .join(".bin")
        .join(bin_name)
        .exists()
}

fn get_available_tools(workspace_path: &str) -> Vec<AvailableTool> {
    vec![
        // JS / TS
        AvailableTool {
            name: "eslint".to_string(),
            enabled: is_lint_tool_enabled(workspace_path, "eslint"),
            installed: eslint_available(workspace_path),
        },
        AvailableTool {
            name: "tsc".to_string(),
            enabled: is_lint_tool_enabled(workspace_path, "tsc"),
            installed: node_bin_exists(workspace_path, "tsc") || command_exists("tsc"),
        },
        // CSS
        AvailableTool {
            name: "stylelint".to_string(),
            enabled: is_lint_tool_enabled(workspace_path, "stylelint"),
            installed: node_bin_exists(workspace_path, "stylelint") || command_exists("stylelint"),
        },
        // Rust
        AvailableTool {
            name: "rust-analyzer".to_string(),
            enabled: is_lint_tool_enabled(workspace_path, "rust-analyzer"),
            installed: command_exists("rust-analyzer"),
        },
        AvailableTool {
            name: "clippy".to_string(),
            enabled: is_lint_tool_enabled(workspace_path, "clippy"),
            installed: command_exists("cargo"),
        },
        // Python
        AvailableTool {
            name: "ruff".to_string(),
            enabled: is_lint_tool_enabled(workspace_path, "ruff"),
            installed: command_exists("ruff"),
        },
        AvailableTool {
            name: "pylint".to_string(),
            enabled: is_lint_tool_enabled(workspace_path, "pylint"),
            installed: command_exists("pylint"),
        },
        AvailableTool {
            name: "flake8".to_string(),
            enabled: is_lint_tool_enabled(workspace_path, "flake8"),
            installed: command_exists("flake8"),
        },
        AvailableTool {
            name: "mypy".to_string(),
            enabled: is_lint_tool_enabled(workspace_path, "mypy"),
            installed: command_exists("mypy"),
        },
        // Go
        AvailableTool {
            name: "golangci-lint".to_string(),
            enabled: is_lint_tool_enabled(workspace_path, "golangci-lint"),
            installed: command_exists("golangci-lint"),
        },
        // Shell
        AvailableTool {
            name: "shellcheck".to_string(),
            enabled: is_lint_tool_enabled(workspace_path, "shellcheck"),
            installed: command_exists("shellcheck"),
        },
    ]
}

/// Pick which Python linter to run (prefer ruff > pylint > flake8).
fn pick_python_tool(tools: &[AvailableTool]) -> Option<String> {
    for preferred in ["ruff", "pylint", "flake8"] {
        if tools
            .iter()
            .any(|t| t.name == preferred && t.enabled && t.installed)
        {
            return Some(preferred.to_string());
        }
    }
    None
}

// ============================================
// Tool Execution
// ============================================

/// Run a single tool job.
async fn run_tool_job(
    workspace_path: &str,
    job: &ScanJob,
) -> Result<super::types::ToolRunOutput, String> {
    let wp = workspace_path.to_string();
    let tool = job.tool.clone();
    let target_dir = job.target_dir.clone();
    let file_paths = job.file_paths.clone();

    // Run tool in blocking thread
    tokio::task::spawn_blocking(move || match tool.as_str() {
        "eslint" => eslint::run_eslint_workspace(&wp, target_dir.as_deref(), file_paths.as_deref()),
        "tsc" => typescript::run_tsc_workspace(&wp),
        "stylelint" => css::run_stylelint_workspace(&wp, file_paths.as_deref()),
        "rust-analyzer" => clippy::run_cargo_check_workspace(&wp),
        "clippy" => clippy::run_clippy_workspace(&wp),
        "ruff" => python::run_ruff_workspace(&wp, file_paths.as_deref()),
        "pylint" => python::run_pylint_workspace(&wp, file_paths.as_deref()),
        "flake8" => python::run_flake8_workspace(&wp, file_paths.as_deref()),
        "mypy" => python::run_mypy_workspace(&wp),
        "golangci-lint" => golangci_lint::run_golangci_lint_workspace(&wp),
        "shellcheck" => shell::run_shellcheck_workspace(&wp, file_paths.as_deref()),
        other => Err(format!("Unknown tool: {}", other)),
    })
    .await
    .map_err(|err| format!("Task panicked: {}", err))?
}

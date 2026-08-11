//! Workspace Lint Scanner (Incremental, per-tool)
//!
//! Three commands power the Problems panel "Scan Workspace" feature:
//!
//! 1. `lint_scan_get_tools`     — Returns which tools are available & enabled
//! 2. `lint_scan_run_tool`      — Runs a single tool (optionally scoped to a subdir)
//! 3. `lint_get_eslint_targets` — Returns subdirectories to lint with ESLint
//!
//! Plus `lint_scan_orchestrated` (in `orchestrator`) — single command that
//! handles everything via events (recommended for new UIs).

mod clippy;
mod css;
mod eslint;
mod golangci_lint;
pub mod orchestrator;
mod process;
mod python;
mod shell;
pub mod types;
mod typescript;

use std::path::Path;

use types::{AvailableTool, SingleToolResult};

use super::command_detection::command_exists;
use super::workspace_config::is_lint_tool_enabled;
use process::eslint_available;

// ============================================
// Helpers for tool detection
// ============================================

/// Check if a local node_modules binary exists for the given tool.
fn node_bin_exists(workspace_path: &str, bin_name: &str) -> bool {
    Path::new(workspace_path)
        .join("node_modules")
        .join(".bin")
        .join(bin_name)
        .exists()
}

// ============================================
// Tauri Commands
// ============================================

/// Get the list of available lint tools for this workspace.
/// Returns quickly so the frontend knows what to iterate over.
#[tauri::command]
pub async fn lint_scan_get_tools(workspace_path: String) -> Result<Vec<AvailableTool>, String> {
    let wp = &workspace_path;

    let tools = vec![
        // ── JavaScript / TypeScript ──
        AvailableTool {
            name: "eslint".to_string(),
            enabled: is_lint_tool_enabled(wp, "eslint"),
            installed: eslint_available(wp),
        },
        AvailableTool {
            name: "tsc".to_string(),
            enabled: is_lint_tool_enabled(wp, "tsc"),
            installed: node_bin_exists(wp, "tsc") || command_exists("tsc"),
        },
        // ── CSS / SCSS ──
        AvailableTool {
            name: "stylelint".to_string(),
            enabled: is_lint_tool_enabled(wp, "stylelint"),
            installed: node_bin_exists(wp, "stylelint") || command_exists("stylelint"),
        },
        // ── Rust ──
        AvailableTool {
            name: "rust-analyzer".to_string(),
            enabled: is_lint_tool_enabled(wp, "rust-analyzer"),
            installed: command_exists("rust-analyzer"),
        },
        AvailableTool {
            name: "clippy".to_string(),
            enabled: is_lint_tool_enabled(wp, "clippy"),
            installed: command_exists("cargo"),
        },
        // ── Python ──
        AvailableTool {
            name: "ruff".to_string(),
            enabled: is_lint_tool_enabled(wp, "ruff"),
            installed: command_exists("ruff"),
        },
        AvailableTool {
            name: "pylint".to_string(),
            enabled: is_lint_tool_enabled(wp, "pylint"),
            installed: command_exists("pylint"),
        },
        AvailableTool {
            name: "flake8".to_string(),
            enabled: is_lint_tool_enabled(wp, "flake8"),
            installed: command_exists("flake8"),
        },
        AvailableTool {
            name: "mypy".to_string(),
            enabled: is_lint_tool_enabled(wp, "mypy"),
            installed: command_exists("mypy"),
        },
        // ── Go ──
        AvailableTool {
            name: "golangci-lint".to_string(),
            enabled: is_lint_tool_enabled(wp, "golangci-lint"),
            installed: command_exists("golangci-lint"),
        },
        // ── Shell ──
        AvailableTool {
            name: "shellcheck".to_string(),
            enabled: is_lint_tool_enabled(wp, "shellcheck"),
            installed: command_exists("shellcheck"),
        },
    ];

    Ok(tools)
}

/// Run a single lint tool and return its diagnostics.
/// `target_dir` is an optional subdirectory (relative) to scope the scan —
/// currently only ESLint uses it for per-directory chunking.
/// `file_paths` is an optional list of absolute file paths to restrict scanning
/// to (for "opened-tabs" and "diff" scan scopes). Tools that support file-level
/// args pass them directly; project-level tools filter output server-side.
#[tauri::command]
pub async fn lint_scan_run_tool(
    workspace_path: String,
    tool: String,
    target_dir: Option<String>,
    file_paths: Option<Vec<String>>,
) -> Result<SingleToolResult, String> {
    log::info!(
        "[WorkspaceScan] Running tool '{}' on: {} (target_dir: {:?}, file_paths: {})",
        tool,
        workspace_path,
        target_dir,
        file_paths
            .as_ref()
            .map_or("all".to_string(), |fp| format!("{} files", fp.len()))
    );

    let wp = workspace_path.clone();
    let tool_clone = tool.clone();
    let td = target_dir.clone();
    let fp = file_paths.clone();

    let result = tauri::async_runtime::spawn_blocking(move || match tool_clone.as_str() {
        // JS / TS — ESLint supports file-level args
        "eslint" => eslint::run_eslint_workspace(&wp, td.as_deref(), fp.as_deref()),
        // tsc is project-level; filter output
        "tsc" => typescript::run_tsc_workspace(&wp),
        // CSS — stylelint supports file-level args
        "stylelint" => css::run_stylelint_workspace(&wp, fp.as_deref()),
        // Rust — project-level; filter output
        "rust-analyzer" => clippy::run_cargo_check_workspace(&wp),
        "clippy" => clippy::run_clippy_workspace(&wp),
        // Python — ruff, pylint, flake8 support file-level args
        "ruff" => python::run_ruff_workspace(&wp, fp.as_deref()),
        "pylint" => python::run_pylint_workspace(&wp, fp.as_deref()),
        "flake8" => python::run_flake8_workspace(&wp, fp.as_deref()),
        // mypy works better project-level
        "mypy" => python::run_mypy_workspace(&wp),
        // Go — project-level
        "golangci-lint" => golangci_lint::run_golangci_lint_workspace(&wp),
        // Shell — shellcheck supports file-level args
        "shellcheck" => shell::run_shellcheck_workspace(&wp, fp.as_deref()),
        other => Err(format!("Unknown tool: {}", other)),
    })
    .await
    .map_err(|join_err| format!("Tool thread panicked: {}", join_err))?;

    let label = if let Some(ref dir) = target_dir {
        format!("{}:{}", tool, dir)
    } else {
        tool.clone()
    };

    // Project-level tools that don't accept file args — filter output server-side
    let project_level_tools: std::collections::HashSet<&str> =
        ["tsc", "rust-analyzer", "clippy", "mypy", "golangci-lint"]
            .iter()
            .copied()
            .collect();

    match result {
        Ok(mut output) => {
            // For project-level tools, filter diagnostics to scoped files
            if let Some(ref scope_files) = file_paths {
                if project_level_tools.contains(tool.as_str()) && !scope_files.is_empty() {
                    let scope_set: std::collections::HashSet<&str> =
                        scope_files.iter().map(|s| s.as_str()).collect();
                    let before = output.diagnostics.len();
                    output
                        .diagnostics
                        .retain(|diag| scope_set.contains(diag.file_path.as_str()));
                    log::info!(
                        "[WorkspaceScan] {} filtered {} → {} diagnostics (scope: {} files)",
                        label,
                        before,
                        output.diagnostics.len(),
                        scope_files.len()
                    );
                }
            }

            log::info!(
                "[WorkspaceScan] {} found {} diagnostics in {} files",
                label,
                output.diagnostics.len(),
                output.files_scanned
            );
            Ok(SingleToolResult {
                tool: label,
                diagnostics: output.diagnostics,
                files_scanned: output.files_scanned,
                error: None,
            })
        }
        Err(err) => {
            log::warn!("[WorkspaceScan] {} error: {}", label, err);
            Ok(SingleToolResult {
                tool: label,
                diagnostics: vec![],
                files_scanned: 0,
                error: Some(err),
            })
        }
    }
}

/// Return subdirectories to run ESLint on separately for incremental results.
#[tauri::command]
pub async fn lint_get_eslint_targets(workspace_path: String) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || eslint::get_eslint_targets(&workspace_path))
        .await
        .map_err(|err| format!("Task join error: {}", err))?
}

/// Return absolute paths of files changed in the git working tree + staging area.
/// Used by the "Changed Files" scan scope.
#[tauri::command]
pub async fn lint_scan_diff_files(workspace_path: String) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || {
        use std::collections::HashSet;
        let wp = Path::new(&workspace_path);

        // Unstaged changes
        let unstaged = git::git_command()?
            .args(["diff", "--name-only"])
            .current_dir(wp)
            .output()
            .map_err(|err| format!("git diff failed: {}", err))?;

        // Staged changes
        let staged = git::git_command()?
            .args(["diff", "--cached", "--name-only"])
            .current_dir(wp)
            .output()
            .map_err(|err| format!("git diff --cached failed: {}", err))?;

        // Untracked files
        let untracked = git::git_command()?
            .args(["ls-files", "--others", "--exclude-standard"])
            .current_dir(wp)
            .output()
            .map_err(|err| format!("git ls-files failed: {}", err))?;

        let mut files = HashSet::new();
        for output in [&unstaged, &staged, &untracked] {
            let text = String::from_utf8_lossy(&output.stdout);
            for line in text.lines() {
                let trimmed = line.trim();
                if !trimmed.is_empty() {
                    let abs = wp.join(trimmed).to_string_lossy().to_string();
                    files.insert(abs);
                }
            }
        }

        Ok(files.into_iter().collect())
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))?
}

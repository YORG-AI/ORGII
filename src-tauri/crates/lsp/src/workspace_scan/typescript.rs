//! TypeScript type-checker runner (`tsc --noEmit`).
//!
//! Catches type errors that ESLint cannot — missing properties, wrong argument
//! types, unresolved imports, etc.

use std::path::Path;
use std::process::Command;

use super::process::{run_command_with_custom_timeout, COMPILE_TIMEOUT_SECS};
use super::types::{ToolRunOutput, WorkspaceDiagnostic};

/// Run `tsc --noEmit` on the workspace.
/// Requires a `tsconfig.json` in the workspace root.
pub fn run_tsc_workspace(workspace_path: &str) -> Result<ToolRunOutput, String> {
    let workspace = Path::new(workspace_path);

    // Only run if tsconfig.json exists
    if !workspace.join("tsconfig.json").exists() {
        return Ok(ToolRunOutput::empty());
    }

    // Prefer local tsc from node_modules
    let tsc_path = workspace.join("node_modules").join(".bin").join("tsc");
    let tsc_cmd = if tsc_path.exists() {
        tsc_path.to_string_lossy().to_string()
    } else {
        "tsc".to_string()
    };

    log::info!(
        "[WorkspaceScan] Running tsc --noEmit on: {}",
        workspace_path
    );

    let output = run_command_with_custom_timeout(
        Command::new(&tsc_cmd)
            .args(["--noEmit", "--pretty", "false"])
            .current_dir(workspace_path),
        COMPILE_TIMEOUT_SECS,
    )?;

    // tsc exits non-zero when there are errors — that's expected
    let stdout = String::from_utf8_lossy(&output.stdout);
    if stdout.trim().is_empty() {
        return Ok(ToolRunOutput::empty());
    }

    let mut diagnostics = Vec::new();

    // Format: path/file.ts(line,col): error TSxxxx: message
    for line in stdout.lines() {
        if let Some(diag) = parse_tsc_line(line, workspace_path) {
            diagnostics.push(diag);
        }
    }

    log::info!(
        "[WorkspaceScan] tsc found {} diagnostics",
        diagnostics.len()
    );
    Ok(ToolRunOutput::from_diagnostics(diagnostics))
}

/// Parse a single tsc output line.
/// Format: `file.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.`
fn parse_tsc_line(line: &str, workspace_path: &str) -> Option<WorkspaceDiagnostic> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }

    // Find the (line,col) part
    let paren_open = line.find('(')?;
    let paren_close = line[paren_open..].find(')')? + paren_open;

    let file = &line[..paren_open];
    let coords = &line[paren_open + 1..paren_close];
    let rest = line[paren_close + 1..].trim_start_matches(':').trim();

    // Parse line,col
    let mut parts = coords.split(',');
    let line_num: u32 = parts.next()?.trim().parse().ok()?;
    let column: u32 = parts.next()?.trim().parse().ok()?;

    // Parse "error TSxxxx: message" or "warning TSxxxx: message"
    let (severity, after_severity) = if let Some(after) = rest.strip_prefix("error ") {
        ("error", after)
    } else {
        let after = rest.strip_prefix("warning ")?;
        ("warning", after)
    };

    // Split "TS2322: message" into code and message
    let (code, message) = if let Some(colon_idx) = after_severity.find(": ") {
        (
            Some(after_severity[..colon_idx].to_string()),
            after_severity[colon_idx + 2..].to_string(),
        )
    } else {
        (None, after_severity.to_string())
    };

    let file_path = if Path::new(file).is_absolute() {
        file.to_string()
    } else {
        Path::new(workspace_path)
            .join(file)
            .to_string_lossy()
            .to_string()
    };

    Some(WorkspaceDiagnostic {
        file_path,
        line: line_num,
        column,
        end_line: None,
        end_column: None,
        severity: severity.to_string(),
        message,
        source: "tsc".to_string(),
        code,
    })
}

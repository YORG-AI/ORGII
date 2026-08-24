//! Descendant tool-process diagnostics, kept separate from app totals.

use std::collections::HashSet;

use tauri::AppHandle;

use super::inventory::{collect_process_inventory, descendant_depth};
use super::ownership::owned_webview_processes;
use super::platform::process_instance_key;
use super::types::{ToolProcessCategory, ToolProcessMemoryDiagnostic};

fn tool_process_category(name: &str) -> ToolProcessCategory {
    let lower = name.to_ascii_lowercase();
    if matches!(
        lower.as_str(),
        "zsh" | "bash" | "fish" | "sh" | "pwsh" | "powershell"
    ) || lower.contains("terminal")
    {
        ToolProcessCategory::Terminal
    } else if [
        "claude", "codex", "cursor", "qoder", "opencode", "gemini", "kiro", "trae",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
    {
        ToolProcessCategory::AgentCli
    } else {
        ToolProcessCategory::McpOrTool
    }
}

pub(super) fn collect_tool_process_memory_diagnostics(
    app: &AppHandle,
) -> Vec<ToolProcessMemoryDiagnostic> {
    let inventory = collect_process_inventory(false);
    #[cfg(windows)]
    let (owned_helpers, _, _) = owned_webview_processes(app, &inventory);
    #[cfg(not(windows))]
    let (owned_helpers, _, _) = owned_webview_processes(&inventory);
    #[cfg(not(windows))]
    let _ = app;

    let root_pid = std::process::id();
    let owned_pids: HashSet<u32> = owned_helpers.keys().map(|key| key.pid).collect();
    let mut diagnostics: Vec<ToolProcessMemoryDiagnostic> = inventory
        .iter()
        .filter_map(|descriptor| {
            let depth = descendant_depth(descriptor.pid, root_pid, &inventory)?;
            if owned_pids.contains(&descriptor.pid) {
                return None;
            }
            Some(ToolProcessMemoryDiagnostic {
                pid: descriptor.pid,
                parent_pid: descriptor.parent_pid,
                process_instance_id: process_instance_key(descriptor).wire_id(),
                name: descriptor.name.clone(),
                category: tool_process_category(&descriptor.name),
                rss_bytes: descriptor.rss_bytes,
                virtual_memory_bytes: descriptor.virtual_memory_bytes,
                depth,
            })
        })
        .collect();
    diagnostics.sort_by(|left, right| {
        right
            .rss_bytes
            .cmp(&left.rss_bytes)
            .then_with(|| left.pid.cmp(&right.pid))
    });
    diagnostics
}

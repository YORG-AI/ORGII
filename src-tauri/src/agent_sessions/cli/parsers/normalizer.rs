//! Tool name normalization.
//!
//! All CLI agents' tool names are normalized to Cursor's vocabulary.
//! Cursor is the canonical format — its events pass through unchanged.

use std::collections::HashMap;
use std::sync::LazyLock;

use super::types::CliAgentType;

// ============================================
// Tool name maps (Agent → Cursor)
// ============================================

static CLAUDE_TO_CURSOR: LazyLock<HashMap<&'static str, &'static str>> = LazyLock::new(|| {
    let mut m = HashMap::new();
    m.insert("Bash", "Shell");
    m.insert("Write", "Edit");
    m.insert("Edit", "Edit");
    m.insert("Read", "Read");
    m.insert("Grep", "Grep");
    m.insert("Glob", "Glob");
    m.insert("TodoWrite", "UpdateTodos");
    m.insert("Task", "Task");
    m.insert("WebSearch", "WebSearch");
    m.insert("WebFetch", "WebFetch");
    m
});

static CODEX_TO_CURSOR: LazyLock<HashMap<&'static str, &'static str>> = LazyLock::new(|| {
    let mut m = HashMap::new();
    m.insert("Write", "Edit");
    m.insert("RunCommand", "Shell");
    m.insert("UpdateTodos", "UpdateTodos");
    m.insert("Read", "Read");
    m.insert("Grep", "Grep");
    m.insert("Glob", "Glob");
    m.insert("Ls", "Ls");
    // Item types from new format
    m.insert("command_execution", "Shell");
    m.insert("file_change", "Edit");
    m.insert("file_edit", "Edit");
    m.insert("todo_list", "UpdateTodos");
    m.insert("agent_message", "message");
    m
});

/// Normalize a tool name from any agent to the Cursor canonical format.
///
/// Copilot uses ACP with its own `map_acp_kind()` in `parsers::copilot` and
/// never calls this function. The match arm is kept for exhaustiveness only.
pub fn normalize_tool_name(agent: CliAgentType, raw_name: &str) -> String {
    let map = match agent {
        CliAgentType::CursorCli => return raw_name.to_string(), // Cursor is canonical
        CliAgentType::ClaudeCode => &*CLAUDE_TO_CURSOR,
        CliAgentType::Codex => &*CODEX_TO_CURSOR,
        // These agents use their own formats or ACP, pass through unchanged
        CliAgentType::Copilot
        | CliAgentType::Kiro
        | CliAgentType::KimiCli
        | CliAgentType::OpenCode
        | CliAgentType::Aider
        | CliAgentType::Goose
        | CliAgentType::Amp
        | CliAgentType::Cline
        | CliAgentType::Kilo
        | CliAgentType::Grok
        | CliAgentType::Devin
        | CliAgentType::Rovo
        | CliAgentType::Hermes
        | CliAgentType::OpenClaw
        | CliAgentType::Aug
        | CliAgentType::Codebuff
        | CliAgentType::QwenCode
        | CliAgentType::MimoCode
        | CliAgentType::Antigravity
        | CliAgentType::Continue
        | CliAgentType::Droid
        | CliAgentType::MistralVibe
        | CliAgentType::Autohand
        | CliAgentType::Omp
        | CliAgentType::Pi => return raw_name.to_string(),
    };

    map.get(raw_name)
        .map(|s| s.to_string())
        .unwrap_or_else(|| raw_name.to_string())
}

/// Unwrap a Codex shell command wrapper.
///
/// Codex wraps commands as `/bin/bash -lc 'actual command'`.
/// This extracts the inner command.
pub fn unwrap_codex_command(command: &str) -> String {
    if command.starts_with("/bin/bash -lc '") && command.ends_with('\'') {
        command[15..command.len() - 1].to_string()
    } else {
        command.to_string()
    }
}

/// Extract file path from tool args (checks common field names).
pub fn extract_file_path(args: &serde_json::Value) -> Option<String> {
    for field in &["file_path", "path", "notebook_path", "filePath"] {
        if let Some(path) = args.get(field).and_then(|v| v.as_str()) {
            return Some(path.to_string());
        }
    }
    None
}

/// Extract command from tool args.
pub fn extract_command(args: &serde_json::Value) -> Option<String> {
    args.get("command").and_then(|v| {
        if let Some(s) = v.as_str() {
            Some(s.to_string())
        } else if let Some(arr) = v.as_array() {
            Some(
                arr.iter()
                    .filter_map(|item| item.as_str())
                    .collect::<Vec<_>>()
                    .join(" "),
            )
        } else {
            None
        }
    })
}

#[cfg(test)]
#[path = "tests/normalizer_tests.rs"]
mod tests;

use super::*;
use crate::agent_sessions::cli::parsers::types::CliAgentType;
use serde_json::json;

#[test]
fn normalize_tool_name_cursor_passes_through() {
    assert_eq!(
        normalize_tool_name(CliAgentType::CursorCli, "Shell"),
        "Shell"
    );
    assert_eq!(normalize_tool_name(CliAgentType::CursorCli, "Edit"), "Edit");
}

#[test]
fn normalize_tool_name_claude_bash_to_shell() {
    assert_eq!(
        normalize_tool_name(CliAgentType::ClaudeCode, "Bash"),
        "Shell"
    );
}

#[test]
fn normalize_tool_name_claude_write_to_edit() {
    assert_eq!(
        normalize_tool_name(CliAgentType::ClaudeCode, "Write"),
        "Edit"
    );
}

#[test]
fn normalize_tool_name_claude_read_unchanged() {
    assert_eq!(
        normalize_tool_name(CliAgentType::ClaudeCode, "Read"),
        "Read"
    );
}

#[test]
fn normalize_tool_name_codex_run_command_to_shell() {
    assert_eq!(
        normalize_tool_name(CliAgentType::Codex, "RunCommand"),
        "Shell"
    );
}

#[test]
fn normalize_tool_name_codex_file_change_to_edit() {
    assert_eq!(
        normalize_tool_name(CliAgentType::Codex, "file_change"),
        "Edit"
    );
}

#[test]
fn normalize_tool_name_copilot_passes_through() {
    assert_eq!(
        normalize_tool_name(CliAgentType::Copilot, "SomeTool"),
        "SomeTool"
    );
}

#[test]
fn normalize_tool_name_unknown_returns_raw() {
    assert_eq!(
        normalize_tool_name(CliAgentType::ClaudeCode, "UnknownTool"),
        "UnknownTool"
    );
}

#[test]
fn normalize_tool_name_kiro_passes_through() {
    assert_eq!(
        normalize_tool_name(CliAgentType::Kiro, "CustomTool"),
        "CustomTool"
    );
}

#[test]
fn unwrap_codex_command_wraps_bash() {
    assert_eq!(unwrap_codex_command("/bin/bash -lc 'ls -la'"), "ls -la");
}

#[test]
fn unwrap_codex_command_non_wrapped_passes_through() {
    assert_eq!(unwrap_codex_command("ls -la"), "ls -la");
}

#[test]
fn unwrap_codex_command_empty_inner() {
    assert_eq!(unwrap_codex_command("/bin/bash -lc ''"), "");
}

#[test]
fn unwrap_codex_command_no_trailing_quote_returns_as_is() {
    let cmd = "/bin/bash -lc 'ls -la";
    assert_eq!(unwrap_codex_command(cmd), cmd);
}

#[test]
fn extract_file_path_from_file_path() {
    let args = json!({ "file_path": "/foo/bar.rs" });
    assert_eq!(extract_file_path(&args), Some("/foo/bar.rs".to_string()));
}

#[test]
fn extract_file_path_from_path() {
    let args = json!({ "path": "/baz/qux.ts" });
    assert_eq!(extract_file_path(&args), Some("/baz/qux.ts".to_string()));
}

#[test]
fn extract_file_path_from_notebook_path() {
    let args = json!({ "notebook_path": "/notebook.ipynb" });
    assert_eq!(
        extract_file_path(&args),
        Some("/notebook.ipynb".to_string())
    );
}

#[test]
fn extract_file_path_from_file_path_camel_case() {
    let args = json!({ "filePath": "/camel/case.ts" });
    assert_eq!(extract_file_path(&args), Some("/camel/case.ts".to_string()));
}

#[test]
fn extract_file_path_no_known_field_returns_none() {
    let args = json!({ "other_field": "/ignored" });
    assert_eq!(extract_file_path(&args), None);
}

#[test]
fn extract_command_string_command() {
    let args = json!({ "command": "ls -la" });
    assert_eq!(extract_command(&args), Some("ls -la".to_string()));
}

#[test]
fn extract_command_array_command_joins_with_space() {
    let args = json!({ "command": ["ls", "-la", "/tmp"] });
    assert_eq!(extract_command(&args), Some("ls -la /tmp".to_string()));
}

#[test]
fn extract_command_null_returns_none() {
    let args = json!({ "command": null });
    assert_eq!(extract_command(&args), None);
}

#[test]
fn extract_command_non_string_non_array_returns_none() {
    let args = json!({ "command": 42 });
    assert_eq!(extract_command(&args), None);
}

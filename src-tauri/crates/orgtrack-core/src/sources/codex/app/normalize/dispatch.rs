//! Raw Codex tool name/argument dispatch into canonical ORGII tool calls.

use serde_json::Value;

use crate::sources::imported_history;

use super::agent_args::{normalize_agent_message_args, normalize_spawn_agent_args};
use super::exploration::exploration_tool_calls_from_shell_args;
use super::shell_read::{read_file_arg_values_from_shell_args, read_file_args_from_shell_args};
use super::tool_args::{
    normalize_apply_patch_args, normalize_edit_args, normalize_search_args, normalize_shell_args,
    normalize_web_search_args, normalize_write_stdin_args,
};

pub(crate) fn normalize_codex_tool_calls(raw_name: &str, args: Value) -> Vec<(String, Value)> {
    let key = normalize_tool_name_key(raw_name);
    match key.as_str() {
        key if is_codex_shell_tool_key(key) => {
            let shell_args = normalize_shell_args(args);
            if let Some(read_args) = read_file_arg_values_from_shell_args(&shell_args) {
                read_args
                    .into_iter()
                    .map(|args| (imported_history::FUNCTION_READ_FILE.to_string(), args))
                    .collect()
            } else if let Some(calls) = exploration_tool_calls_from_shell_args(&shell_args) {
                calls
            } else {
                vec![(
                    imported_history::FUNCTION_RUN_COMMAND_LINE.to_string(),
                    shell_args,
                )]
            }
        }
        "rg" | "ripgrep" | "grep" | "search" | "code_search" | "search_code"
        | "search_codebase" => vec![(
            imported_history::FUNCTION_CODE_SEARCH.to_string(),
            normalize_search_args(args),
        )],
        "web__run" | "web_run" | "web_search" => {
            vec![("web_search".to_string(), normalize_web_search_args(args))]
        }
        "write_stdin" => vec![(
            imported_history::FUNCTION_AWAIT_OUTPUT.to_string(),
            normalize_write_stdin_args(args),
        )],
        "spawn_agent" => vec![("subagent".to_string(), normalize_spawn_agent_args(args))],
        "send_message" | "followup_task" => normalize_agent_message_args(key.as_str(), args)
            .map(|args| vec![("org_send_message".to_string(), args)])
            .unwrap_or_default(),
        "cat" | "sed" | "head" | "tail" => {
            let shell_args = normalize_shell_args(args);
            if let Some(read_args) = read_file_args_from_shell_args(&shell_args) {
                vec![(imported_history::FUNCTION_READ_FILE.to_string(), read_args)]
            } else {
                vec![(
                    imported_history::FUNCTION_RUN_COMMAND_LINE.to_string(),
                    shell_args,
                )]
            }
        }
        "apply_patch" => vec![(
            imported_history::FUNCTION_EDIT_FILE.to_string(),
            normalize_apply_patch_args(args),
        )],
        "edit" | "edit_file" | "write" | "write_file" | "create_file" => vec![(
            imported_history::FUNCTION_EDIT_FILE.to_string(),
            normalize_edit_args(raw_name, args),
        )],
        _ => vec![(raw_name.to_string(), args)],
    }
}

pub(in crate::sources::codex::app) fn is_codex_shell_tool_key(key: &str) -> bool {
    matches!(
        key,
        "shell"
            | "shell_command"
            | "exec_command"
            | "bash"
            | "terminal"
            | "terminal_command"
            | "run_shell"
            | "run_command"
            | "execute"
            | "exec"
    )
}

pub(in crate::sources::codex::app) fn normalize_tool_name_key(raw_name: &str) -> String {
    raw_name
        .trim()
        .strip_prefix("mcp_orgii_")
        .unwrap_or_else(|| raw_name.trim())
        .chars()
        .map(|ch| match ch {
            '-' | ' ' | '.' => '_',
            _ => ch.to_ascii_lowercase(),
        })
        .collect()
}

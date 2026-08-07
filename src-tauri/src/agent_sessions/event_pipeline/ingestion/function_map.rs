//! Function name normalization for event storage.
//!
//! This module provides the `resolve_function_name` function used during event
//! ingestion to normalize raw tool/function names to canonical forms for DB storage.
//!
//! **Single Source of Truth:** `cli_agents::alias_map` defines all CLI agent aliases.
//! This module delegates to that map for storage canonical names, ensuring consistency
//! between session persistence and UI routing.

use crate::agent_sessions::cli::parsers::alias_map;
use core_types::tool_names;

/// Resolve the canonical function name for a raw event chunk (for DB storage).
///
/// Resolution order:
/// 1. Look up in CLI alias map → return `storage` canonical
/// 2. For `tool_call` action_type: extract nested `tool_name` and resolve
/// 3. Fallback: lowercase original name or "unknown"
///
/// Note: This returns the **storage** canonical form (fine-grained, e.g. "edit_file_by_replace").
/// For UI routing, use `alias_map::get_ui_canonical()` which returns coarse groupings.
pub fn resolve_function_name(
    raw_function: &str,
    action_type: &str,
    args: Option<&serde_json::Value>,
) -> String {
    // 1. Try function name in CLI alias map
    if !raw_function.is_empty() {
        if let Some((storage, _ui)) = alias_map::resolve_cli_alias(raw_function) {
            return storage.to_string();
        }
    }

    // 2. Try action type in CLI alias map
    if !action_type.is_empty() {
        if let Some((storage, _ui)) = alias_map::resolve_cli_alias(action_type) {
            return storage.to_string();
        }
    }

    // 3. Handle tool_call with nested tool name
    if action_type == "tool_call" {
        if let Some(args_val) = args {
            if let Some(obj) = args_val.as_object() {
                let tool_name = obj
                    .get("tool_name")
                    .and_then(|v| v.as_str())
                    .or_else(|| obj.get("name").and_then(|v| v.as_str()));

                if let Some(name) = tool_name {
                    if let Some((storage, _ui)) = alias_map::resolve_cli_alias(name) {
                        return storage.to_string();
                    }
                    return name.to_lowercase();
                }
            }
        }
    }

    // 4. Fallback: lowercase or "unknown"
    if !raw_function.is_empty() {
        raw_function.to_lowercase()
    } else if !action_type.is_empty() {
        action_type.to_lowercase()
    } else {
        "unknown".to_string()
    }
}

/// Resolve the UI canonical key used by the frontend registry.
///
/// Most CLI aliases collapse to coarse UI groups (for example `Bash` →
/// `run_shell`), but aliases that normalize to first-class built-in tool names
/// must preserve that built-in identity so action labels and chat blocks are
/// resolved from the Rust registry.
pub fn resolve_ui_canonical(function_name: &str) -> String {
    match function_name {
        tool_names::AWAIT_OUTPUT => tool_names::AWAIT_OUTPUT.to_string(),
        _ => alias_map::get_ui_canonical(function_name).to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_claude_code_mappings() {
        assert_eq!(resolve_function_name("Read", "", None), "read_file");
        assert_eq!(resolve_function_name("Write", "", None), "create_file");
        assert_eq!(resolve_function_name("Bash", "", None), "run_command_line");
        assert_eq!(
            resolve_function_name("Edit", "", None),
            "edit_file_by_replace"
        );
        assert_eq!(
            resolve_function_name("MultiEdit", "", None),
            "edit_file_by_replace"
        );
        assert_eq!(resolve_function_name("Grep", "", None), "grep");
        assert_eq!(resolve_function_name("Search", "", None), "codebase_search");
        assert_eq!(resolve_function_name("LS", "", None), "list_directory");
        assert_eq!(resolve_function_name("Glob", "", None), "glob_file_search");
        assert_eq!(resolve_function_name("Delete", "", None), "delete_file");
    }

    #[test]
    fn test_cursor_cli_mappings() {
        assert_eq!(
            resolve_function_name("shellToolCall", "", None),
            "run_command_line"
        );
        assert_eq!(
            resolve_function_name("editToolCall", "", None),
            "edit_file_by_replace"
        );
        assert_eq!(resolve_function_name("readToolCall", "", None), "read_file");
        assert_eq!(
            resolve_function_name("deleteToolCall", "", None),
            "delete_file"
        );
        assert_eq!(resolve_function_name("Await", "", None), "await_output");
        assert_eq!(resolve_function_name("wait", "", None), "await_output");
        assert_eq!(
            resolve_function_name("awaitToolCall", "", None),
            "await_output"
        );
    }

    #[test]
    fn test_action_type_fallback() {
        assert_eq!(resolve_function_name("", "llm_thinking", None), "thinking");
        assert_eq!(resolve_function_name("", "assistant", None), "assistant");
    }

    #[test]
    fn test_tool_call_nested() {
        let args = serde_json::json!({"tool_name": "Read"});
        assert_eq!(
            resolve_function_name("", "tool_call", Some(&args)),
            "read_file"
        );

        let args_edit = serde_json::json!({"tool_name": "Edit"});
        assert_eq!(
            resolve_function_name("", "tool_call", Some(&args_edit)),
            "edit_file_by_replace"
        );
    }

    #[test]
    fn test_unknown_fallback() {
        assert_eq!(resolve_function_name("", "", None), "unknown");
        assert_eq!(resolve_function_name("CustomTool", "", None), "customtool");
    }

    #[test]
    fn test_todo_mappings() {
        assert_eq!(resolve_function_name("TodoWrite", "", None), "manage_todo");
        assert_eq!(
            resolve_function_name("UpdateTodos", "", None),
            "manage_todo"
        );
        assert_eq!(
            resolve_function_name("manage_todo", "", None),
            "manage_todo"
        );
        assert_eq!(resolve_function_name("todo_write", "", None), "manage_todo");
    }

    #[test]
    fn test_subagent_mappings() {
        assert_eq!(resolve_function_name("Task", "", None), "subagent");
        assert_eq!(resolve_function_name("spawn", "", None), "subagent");
        assert_eq!(resolve_function_name("session", "", None), "subagent");
    }

    #[test]
    fn test_shell_variants() {
        assert_eq!(resolve_function_name("Shell", "", None), "run_command_line");
        assert_eq!(
            resolve_function_name("run_shell", "", None),
            "run_command_line"
        );
        assert_eq!(resolve_function_name("bash", "", None), "run_command_line");
    }

    #[test]
    fn test_web_mappings() {
        assert_eq!(resolve_function_name("WebSearch", "", None), "web_search");
        assert_eq!(resolve_function_name("WebFetch", "", None), "web_fetch");
        assert_eq!(resolve_function_name("web_fetch", "", None), "web_fetch");
    }
}

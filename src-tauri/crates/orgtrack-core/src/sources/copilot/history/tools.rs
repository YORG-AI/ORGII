//! Copilot tool-request → canonical function-name/args mapping and the
//! tool-result content flattener.

use serde_json::{json, Value};

use crate::sources::imported_history;

use super::bounded::bounded_tool_arguments;
use super::{MAX_ID_BYTES, MAX_REPLAY_MESSAGE_CHARS, MAX_TOOL_OUTPUT_CHARS};

/// Map a Copilot tool request onto the canonical function names the frontend
/// extractors read. Best-effort: `bash` and the `str_replace_editor` family
/// (`view` / `create` / `str_replace` / `edit` / `insert`, args `path` /
/// `old_str` / `new_str` / `file_text`) reshape into typed cards; anything
/// unknown passes through with its raw name and args so nothing is dropped.
pub(super) fn map_copilot_tool_call(name: &str, arguments: &Value) -> (String, Value) {
    let args_str = |key: &str| {
        arguments
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .chars()
            .take(MAX_REPLAY_MESSAGE_CHARS)
            .collect::<String>()
    };
    let editor_command = |command: &str| match command {
        "view" => Some((
            imported_history::FUNCTION_READ_FILE.to_string(),
            json!({ "file_path": args_str("path") }),
        )),
        "create" => Some((
            imported_history::FUNCTION_EDIT_FILE.to_string(),
            json!({
                "file_path": args_str("path"),
                "old_string": "",
                "new_string": args_str("file_text"),
            }),
        )),
        "str_replace" | "edit" | "insert" => Some((
            imported_history::FUNCTION_EDIT_FILE.to_string(),
            json!({
                "file_path": args_str("path"),
                "old_string": args_str("old_str"),
                "new_string": args_str("new_str"),
            }),
        )),
        _ => None,
    };

    let mapped = match name {
        "bash" | "shell" => {
            let command = args_str("command");
            (!command.is_empty()).then(|| {
                (
                    imported_history::FUNCTION_RUN_COMMAND_LINE.to_string(),
                    json!({ "command": command.clone(), "cmd": command }),
                )
            })
        }
        "str_replace_editor" => editor_command(&args_str("command")),
        "view" | "create" | "str_replace" | "edit" => editor_command(name),
        "grep" => Some((
            imported_history::FUNCTION_CODE_SEARCH.to_string(),
            bounded_tool_arguments(arguments).unwrap_or(Value::Null),
        )),
        "glob" => Some((
            imported_history::FUNCTION_GLOB_FILE_SEARCH.to_string(),
            bounded_tool_arguments(arguments).unwrap_or(Value::Null),
        )),
        _ => None,
    };
    mapped.unwrap_or_else(|| {
        (
            name.chars().take(MAX_ID_BYTES).collect(),
            bounded_tool_arguments(arguments).unwrap_or(Value::Null),
        )
    })
}

/// Flatten a `tool.execution_complete` `result.content` value (a plain string
/// in every observed store; tolerate arrays/objects defensively) into capped
/// text.
pub(super) fn tool_result_text(content: Option<&Value>) -> String {
    fn append(value: &Value, out: &mut String, remaining: &mut usize) {
        if *remaining == 0 {
            return;
        }
        match value {
            Value::String(text) => {
                if !text.trim().is_empty() {
                    if !out.is_empty() {
                        out.push('\n');
                    }
                    let fragment = text.trim().chars().take(*remaining).collect::<String>();
                    *remaining = remaining.saturating_sub(fragment.chars().count());
                    out.push_str(&fragment);
                }
            }
            Value::Array(items) => {
                for item in items {
                    append(item, out, remaining);
                    if *remaining == 0 {
                        break;
                    }
                }
            }
            Value::Null => {}
            other => append(&Value::String(other.to_string()), out, remaining),
        }
    }
    let mut out = String::new();
    let mut remaining = MAX_TOOL_OUTPUT_CHARS;
    if let Some(content) = content {
        append(content, &mut out, &mut remaining);
    }
    if remaining == 0 {
        out.push_str("\n… (truncated)");
    }
    out
}

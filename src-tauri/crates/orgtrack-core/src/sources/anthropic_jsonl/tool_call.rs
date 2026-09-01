use serde_json::{json, Value};

use crate::sources::imported_history;

pub(super) fn normalize_tool_call(raw_name: &str, args: Value) -> (String, Value) {
    match raw_name.to_ascii_lowercase().as_str() {
        "bash" | "shell" | "execute" | "run_command" => {
            let command = args
                .get("command")
                .and_then(Value::as_str)
                .or_else(|| args.get("cmd").and_then(Value::as_str))
                .unwrap_or_default();
            (
                imported_history::FUNCTION_RUN_COMMAND_LINE.to_string(),
                json!({ "command": command, "cmd": command, "payload": args }),
            )
        }
        "write" | "edit" | "patch" | "apply_patch" | "str_replace" => {
            let file_path = args
                .get("filePath")
                .and_then(Value::as_str)
                .or_else(|| args.get("file_path").and_then(Value::as_str))
                .or_else(|| args.get("path").and_then(Value::as_str))
                .unwrap_or_default();
            (
                imported_history::FUNCTION_EDIT_FILE.to_string(),
                json!({ "action": raw_name, "file_path": file_path, "payload": args }),
            )
        }
        _ => (raw_name.to_string(), args),
    }
}

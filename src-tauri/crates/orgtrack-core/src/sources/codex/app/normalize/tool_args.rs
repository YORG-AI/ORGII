//! Per-tool argument shaping for shell, stdin, patch, edit, and search calls.

use serde_json::{json, Value};

use super::super::impact::patch_file_path_from_line;

pub(super) fn normalize_shell_args(args: Value) -> Value {
    let command = args
        .get("command")
        .and_then(Value::as_str)
        .or_else(|| args.get("cmd").and_then(Value::as_str))
        .or_else(|| args.get("input").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string();
    let cwd = args
        .get("cwd")
        .and_then(Value::as_str)
        .or_else(|| args.get("workdir").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string();
    json!({
        "command": command.clone(),
        "cmd": command,
        "cwd": cwd.clone(),
        "workdir": cwd,
        "payload": args,
    })
}

pub(super) fn normalize_write_stdin_args(args: Value) -> Value {
    let session_id = args
        .get("session_id")
        .or_else(|| args.get("sessionId"))
        .and_then(|value| match value {
            Value::String(value) => Some(value.clone()),
            Value::Number(value) => Some(value.to_string()),
            _ => None,
        })
        .unwrap_or_default();
    let chars = args
        .get("chars")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let block_until_ms = args
        .get("yield_time_ms")
        .or_else(|| args.get("yield_time"))
        .and_then(Value::as_i64)
        .unwrap_or_default();
    json!({
        "command": "wait_for",
        "handle": session_id.clone(),
        "handles": [session_id.clone()],
        "session_id": session_id,
        "chars": chars,
        "block_until_ms": block_until_ms,
        "payload": args,
    })
}

pub(super) fn normalize_apply_patch_args(args: Value) -> Value {
    let patch = args
        .get("patch")
        .and_then(Value::as_str)
        .or_else(|| args.get("patch_text").and_then(Value::as_str))
        .or_else(|| args.get("input").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string();
    let file_path = first_apply_patch_file_path(&patch).unwrap_or_default();
    json!({
        "action": "apply_patch",
        "patch": patch.clone(),
        "patch_text": patch,
        "file_path": file_path.clone(),
        "target_file": file_path,
        "payload": args,
    })
}

pub(super) fn normalize_edit_args(raw_name: &str, args: Value) -> Value {
    if args
        .get("patch")
        .and_then(Value::as_str)
        .or_else(|| args.get("patch_text").and_then(Value::as_str))
        .is_some()
    {
        return normalize_apply_patch_args(args);
    }

    let file_path = args
        .get("file_path")
        .and_then(Value::as_str)
        .or_else(|| args.get("path").and_then(Value::as_str))
        .or_else(|| args.get("target_file").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string();
    let old_content = args
        .get("old_content")
        .and_then(Value::as_str)
        .or_else(|| args.get("old_str").and_then(Value::as_str))
        .or_else(|| args.get("old_string").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string();
    let new_content = args
        .get("new_content")
        .and_then(Value::as_str)
        .or_else(|| args.get("new_str").and_then(Value::as_str))
        .or_else(|| args.get("new_string").and_then(Value::as_str))
        .or_else(|| args.get("content").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string();

    json!({
        "action": raw_name,
        "file_path": file_path.clone(),
        "target_file": file_path,
        "old_content": old_content.clone(),
        "new_content": new_content.clone(),
        "content": new_content,
        "payload": args,
    })
}

pub(super) fn normalize_search_args(args: Value) -> Value {
    let query = args
        .get("query")
        .and_then(Value::as_str)
        .or_else(|| args.get("pattern").and_then(Value::as_str))
        .or_else(|| args.get("search_query").and_then(Value::as_str))
        .or_else(|| args.get("regex").and_then(Value::as_str))
        .or_else(|| args.get("input").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string();
    json!({
        "action": "grep",
        "query": query.clone(),
        "pattern": query,
        "payload": args,
    })
}

pub(in crate::sources::codex::app) fn normalize_web_search_args(args: Value) -> Value {
    let action = args
        .get("action")
        .and_then(Value::as_str)
        .or_else(|| args.get("type").and_then(Value::as_str))
        .unwrap_or("search")
        .to_string();
    let url = args
        .get("url")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let pattern = args
        .get("pattern")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let query = args
        .get("query")
        .and_then(Value::as_str)
        .or_else(|| args.get("search_query").and_then(Value::as_str))
        .or_else(|| args.get("input").and_then(Value::as_str))
        .or_else(|| (!url.is_empty()).then_some(url.as_str()))
        .or_else(|| (!pattern.is_empty()).then_some(pattern.as_str()))
        .unwrap_or_default()
        .to_string();
    let queries = args.get("queries").cloned().unwrap_or_else(|| json!([]));
    json!({
        "action": action,
        "query": query,
        "queries": queries,
        "url": url,
        "pattern": pattern,
        "payload": args,
    })
}

fn first_apply_patch_file_path(patch: &str) -> Option<String> {
    for line in patch.lines() {
        if let Some(path) = patch_file_path_from_line(line) {
            if path != "/dev/null" {
                return Some(path);
            }
        }
    }
    None
}

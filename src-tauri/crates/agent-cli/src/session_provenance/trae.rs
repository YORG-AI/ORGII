//! Trae managed hooks: a standalone `hooks.json` with a top-level `version`
//! and the Claude-Code-style nested `hooks.PostToolUse[]` shape, but a single
//! `command` string per hook (no `commandWindows`).

use serde_json::{json, Value};

use super::config::{command_contains_marker, hooks_object_mut};

// Trae's tool names are its own (e.g. `RunCommand`) and its file-tool names are
// not publicly enumerated, so match all tools; the adapter drops non-file ones.
pub(super) const TRAE_POST_TOOL_USE_MATCHER: &str = ".*";

/// Trae uses a standalone `hooks.json` with a top-level `version` plus the
/// Claude-Code-style nested `hooks.PostToolUse[]` shape — but a single
/// `command` string per hook (no `commandWindows`). The caller passes the
/// platform-appropriate command.
pub(super) fn update_trae_platform(
    config: &mut Value,
    enabled: bool,
    command: &str,
) -> Result<(), String> {
    config
        .as_object_mut()
        .ok_or_else(|| "Trae hook config root must be a JSON object".to_string())?
        .entry("version")
        .or_insert(json!(1));
    let hooks = hooks_object_mut(config)?;
    if !hooks.contains_key("PostToolUse") {
        hooks.insert("PostToolUse".to_string(), Value::Array(Vec::new()));
    }
    let groups = hooks
        .get_mut("PostToolUse")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| "Trae hook config `hooks.PostToolUse` must be an array".to_string())?;
    for group in groups.iter_mut() {
        if let Some(commands) = group.get_mut("hooks").and_then(Value::as_array_mut) {
            commands.retain(|command| !command_contains_marker(command));
        }
    }
    groups.retain(|group| {
        group
            .get("hooks")
            .and_then(Value::as_array)
            .is_none_or(|commands| !commands.is_empty())
    });
    if enabled {
        groups.push(json!({
            "matcher": TRAE_POST_TOOL_USE_MATCHER,
            "hooks": [{ "type": "command", "command": command, "timeout": 5 }]
        }));
    }
    Ok(())
}

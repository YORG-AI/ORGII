//! Antigravity managed hooks: its `hooks.json` is a map of
//! group-name -> event -> hooks. ORGII owns one whole named group so its
//! install never entangles with other tools' groups (e.g. `orca-status`).

use serde_json::{json, Value};

use super::config::command_is_managed_for_platform;
use super::SessionProvenanceHookPlatform;

// Antigravity lifecycle event arrays added to the owned hook group.
pub(super) const ANTIGRAVITY_LIFECYCLE_EVENTS: &[&str] =
    &["PreInvocation", "PostInvocation", "Stop"];
// Antigravity uses the Claude-Code-style nested `PostToolUse` shape; its
// matcher convention is the literal `*` (see the on-disk `hooks.json`).
const ANTIGRAVITY_POST_TOOL_USE_MATCHER: &str = "*";
// The top-level group key ORGII owns inside Antigravity's `hooks.json` (a map of
// group-name -> event -> hooks). Owning a whole group keeps our install
// isolated from other tools' groups (e.g. `orca-status`).
pub(super) const ANTIGRAVITY_HOOK_GROUP: &str = "orgii-session-provenance";

/// Antigravity's `hooks.json` is a map of group-name -> event -> hooks. ORGII
/// owns one whole named group so its install never entangles with other tools'
/// groups (e.g. `orca-status`).
pub(super) fn update_antigravity_platform(
    config: &mut Value,
    enabled: bool,
    live_status: bool,
    command: &str,
) -> Result<(), String> {
    let root = config
        .as_object_mut()
        .ok_or_else(|| "Antigravity hook config root must be a JSON object".to_string())?;
    if enabled {
        let mut group = serde_json::Map::new();
        group.insert(
            "PostToolUse".to_string(),
            json!([{
                "matcher": ANTIGRAVITY_POST_TOOL_USE_MATCHER,
                "hooks": [{ "type": "command", "command": command, "timeout": 5 }]
            }]),
        );
        if live_status {
            for event_name in ANTIGRAVITY_LIFECYCLE_EVENTS {
                group.insert(
                    (*event_name).to_string(),
                    json!([{
                        "hooks": [{ "type": "command", "command": command, "timeout": 5 }]
                    }]),
                );
            }
        }
        root.insert(ANTIGRAVITY_HOOK_GROUP.to_string(), Value::Object(group));
    } else {
        root.remove(ANTIGRAVITY_HOOK_GROUP);
    }
    Ok(())
}

pub(super) fn antigravity_has_managed_hook(config: &Value) -> bool {
    config
        .get(ANTIGRAVITY_HOOK_GROUP)
        .and_then(|group| group.get("PostToolUse"))
        .and_then(Value::as_array)
        .is_some_and(|groups| {
            groups.iter().any(|group| {
                group
                    .get("hooks")
                    .and_then(Value::as_array)
                    .is_some_and(|commands| {
                        commands.iter().any(|command| {
                            command_is_managed_for_platform(
                                command,
                                SessionProvenanceHookPlatform::Antigravity,
                            )
                        })
                    })
            })
        })
}

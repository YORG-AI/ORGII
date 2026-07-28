//! Codex managed hooks: the provenance PostToolUse matcher, the required
//! SessionStart/Subagent events that also drive activation, and the optional
//! live-status lifecycle events.

use serde_json::Value;

use super::config::update_nested_event;

// Codex hook matchers use the public canonical tool names, not the internal
// transcript/runtime names (`exec`, `exec_command`, etc.). Keep this aligned
// with the official Hook matcher contract so Bash and apply_patch both fire.
pub(super) const CODEX_POST_TOOL_USE_MATCHER: &str = "Bash|apply_patch|Edit|Write|mcp__.*";
// Codex events required whenever provenance capture is enabled. SessionStart
// proves that Codex accepted and executed the current managed definitions;
// the subagent events preserve exact actor attribution.
pub(super) const CODEX_REQUIRED_EVENTS: &[&str] =
    &["SessionStart", "SubagentStart", "SubagentStop"];
// Optional Codex lifecycle events (all matcher-less). SessionStart remains
// installed when live status is off because it also drives hook activation;
// PreToolUse is the per-tool working heartbeat when live status is on.
pub(super) const CODEX_LIFECYCLE_EVENTS: &[&str] = &[
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "Stop",
];

pub(super) fn update_codex_platform(
    config: &mut Value,
    enabled: bool,
    live_status: bool,
    unix_command: &str,
    windows_command: &str,
) -> Result<(), String> {
    update_nested_event(
        config,
        "PostToolUse",
        enabled,
        Some(CODEX_POST_TOOL_USE_MATCHER),
        unix_command,
        windows_command,
    )?;
    for event_name in CODEX_REQUIRED_EVENTS {
        update_nested_event(
            config,
            event_name,
            enabled,
            None,
            unix_command,
            windows_command,
        )?;
    }
    for event_name in CODEX_LIFECYCLE_EVENTS {
        update_nested_event(
            config,
            event_name,
            enabled && live_status,
            None,
            unix_command,
            windows_command,
        )?;
    }
    Ok(())
}

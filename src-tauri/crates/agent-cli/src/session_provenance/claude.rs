//! Claude Code managed hooks: the provenance PostToolUse matchers plus the
//! nested-event live-status lifecycle group (including the blocking
//! PermissionRequest approval long-poll timeout).

use serde_json::Value;

use super::config::{update_nested_event_with_timeout, DEFAULT_HOOK_TIMEOUT_SECS};
use super::CLAUDE_PERMISSION_REQUEST_HOOK_TIMEOUT_SECS;

pub(super) const CLAUDE_CODE_POST_TOOL_USE_MATCHER: &str =
    "Read|Write|Edit|MultiEdit|NotebookEdit|Delete|Glob|Grep";
// With live status on, PostToolUse widens to every tool: non-file payloads
// yield zero provenance envelopes (no spool spam) but each one refreshes the
// session's `working` heartbeat, so a long tool run doesn't read as stalled.
// Exactly one managed PostToolUse group exists either way — the matcher is
// switched, never doubled (two groups would spawn two captures per file tool).
pub(super) const CLAUDE_CODE_LIVE_STATUS_POST_TOOL_USE_MATCHER: &str = "*";
// Lifecycle (live-status) events for Claude Code, installed alongside the
// provenance PostToolUse hook when live status is enabled. Matcher-less
// events are turn boundaries; tool-scoped events carry `*` so every tool
// reports. Vocabulary mirrors the Claude Code hooks contract
// (UserPromptSubmit/Stop/StopFailure/PermissionRequest/PreToolUse/
// PostToolUseFailure) and maps in `orgtrack_core::status_adapter`.
pub(super) const CLAUDE_CODE_LIFECYCLE_EVENTS: &[(&str, Option<&str>)] = &[
    ("UserPromptSubmit", None),
    ("Stop", None),
    ("StopFailure", None),
    ("PermissionRequest", Some("*")),
    ("PreToolUse", Some("*")),
    ("PostToolUseFailure", Some("*")),
];

/// Install (or remove, when `install` is false) the Claude Code lifecycle
/// events. Always iterates the full list so flipping live status off strips
/// previously-installed entries instead of leaving them behind.
pub(super) fn update_claude_lifecycle_events(
    config: &mut Value,
    install: bool,
    unix_command: &str,
    windows_command: &str,
) -> Result<(), String> {
    for (event_name, matcher) in CLAUDE_CODE_LIFECYCLE_EVENTS {
        update_nested_event_with_timeout(
            config,
            event_name,
            install,
            *matcher,
            unix_command,
            windows_command,
            claude_lifecycle_event_timeout_secs(event_name),
        )?;
    }
    Ok(())
}

/// Per-event managed hook timeout for the Claude Code lifecycle group.
/// Only PermissionRequest blocks (interactive approval long-poll).
fn claude_lifecycle_event_timeout_secs(event_name: &str) -> u64 {
    if event_name == "PermissionRequest" {
        CLAUDE_PERMISSION_REQUEST_HOOK_TIMEOUT_SECS
    } else {
        DEFAULT_HOOK_TIMEOUT_SECS
    }
}

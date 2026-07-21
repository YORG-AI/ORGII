//! Kimi managed hooks: a TOML `[[hooks]]` array inside the user's main
//! `~/.kimi/config.toml`. TOML round-tripping does not preserve comments, so
//! the writer skips rewrites when the on-disk shape already matches.

use std::path::Path;

use super::config::{hook_commands, write_atomic, HOOK_MARKER};
use super::SessionProvenanceHookPlatform;

// Kimi lifecycle `[[hooks]]` entries (Claude-family names; the
// AskUserQuestion waiting special-case lives in the status normalizer).
const KIMI_LIFECYCLE_EVENTS: &[&str] = &[
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUseFailure",
    "PermissionRequest",
    "Stop",
    "StopFailure",
];
// Kimi's file tools (matched on the tool name).
const KIMI_POST_TOOL_USE_MATCHER: &str = "WriteFile|StrReplaceFile|ReadFile|Grep|Glob";

/// True if the user's Kimi `config.toml` already carries our managed `[[hooks]]`
/// entry (command contains [`HOOK_MARKER`]).
pub(super) fn kimi_config_is_managed(path: &Path) -> bool {
    kimi_config_managed_entry_count(path) > 0
}

/// Number of ORGII-managed `[[hooks]]` entries in Kimi's `config.toml`.
fn kimi_config_managed_entry_count(path: &Path) -> usize {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return 0;
    };
    let Ok(root) = toml::from_str::<toml::Value>(&raw) else {
        return 0;
    };
    root.get("hooks")
        .and_then(|hooks| hooks.as_array())
        .map(|hooks| {
            hooks
                .iter()
                .filter(|entry| {
                    entry
                        .get("command")
                        .and_then(|command| command.as_str())
                        .is_some_and(|command| command.contains(HOOK_MARKER))
                })
                .count()
        })
        .unwrap_or(0)
}

/// Rewrite Kimi's `[[hooks]]` array in place: drop any prior managed entry, then
/// (re)add ours when enabled. Pure TOML manipulation, isolated for testing.
pub(super) fn kimi_apply_managed_hook(
    root: &mut toml::Value,
    enabled: bool,
    live_status: bool,
    command: &str,
) -> Result<(), String> {
    let table = root
        .as_table_mut()
        .ok_or_else(|| "Kimi config root must be a TOML table".to_string())?;
    let mut hooks: Vec<toml::Value> = table
        .get("hooks")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    hooks.retain(|entry| {
        entry
            .get("command")
            .and_then(|command| command.as_str())
            .map(|command| !command.contains(HOOK_MARKER))
            .unwrap_or(true)
    });
    if enabled {
        let managed_entry = |event: &str, matcher: Option<&str>| {
            let mut entry = toml::map::Map::new();
            entry.insert("event".to_string(), toml::Value::String(event.to_string()));
            if let Some(matcher) = matcher {
                entry.insert(
                    "matcher".to_string(),
                    toml::Value::String(matcher.to_string()),
                );
            }
            entry.insert(
                "command".to_string(),
                toml::Value::String(command.to_string()),
            );
            entry.insert("timeout".to_string(), toml::Value::Integer(5));
            toml::Value::Table(entry)
        };
        hooks.push(managed_entry(
            "PostToolUse",
            Some(KIMI_POST_TOOL_USE_MATCHER),
        ));
        if live_status {
            for event in KIMI_LIFECYCLE_EVENTS {
                // PreToolUse carries no matcher: every tool (including
                // AskUserQuestion → waiting) must report.
                hooks.push(managed_entry(event, None));
            }
        }
    }
    if hooks.is_empty() {
        table.remove("hooks");
    } else {
        table.insert("hooks".to_string(), toml::Value::Array(hooks));
    }
    Ok(())
}

/// Install/remove Kimi's managed `[[hooks]]` entry inside `~/.kimi/config.toml`.
/// TOML round-tripping does not preserve comments, so we skip the write when the
/// desired install state already holds — avoiding a needless rewrite of the
/// user's main config on every reconcile.
pub(super) fn update_kimi_platform(
    enabled: bool,
    live_status: bool,
    executable: &Path,
) -> Result<(), String> {
    let path = SessionProvenanceHookPlatform::Kimi.config_path();
    // Skip the comment-destroying rewrite only when the on-disk shape already
    // matches the desired one — entry COUNT matters, not mere presence, or a
    // live-status flip would never upgrade/downgrade the installed set.
    let desired_count = if !enabled {
        0
    } else if live_status {
        1 + KIMI_LIFECYCLE_EVENTS.len()
    } else {
        1
    };
    if kimi_config_managed_entry_count(&path) == desired_count {
        return Ok(());
    }
    let mut root: toml::Value = if path.exists() {
        let raw = std::fs::read_to_string(&path)
            .map_err(|err| format!("Failed to read {}: {err}", path.display()))?;
        toml::from_str(&raw).map_err(|err| format!("Invalid TOML in {}: {err}", path.display()))?
    } else {
        toml::Value::Table(toml::map::Map::new())
    };
    let (unix_command, windows_command) = hook_commands(executable, "kimi");
    let command = if cfg!(windows) {
        windows_command
    } else {
        unix_command
    };
    kimi_apply_managed_hook(&mut root, enabled, live_status, &command)?;
    let serialized = toml::to_string_pretty(&root)
        .map_err(|err| format!("Failed to serialize Kimi config: {err}"))?;
    write_atomic(&path, serialized.as_bytes())
}

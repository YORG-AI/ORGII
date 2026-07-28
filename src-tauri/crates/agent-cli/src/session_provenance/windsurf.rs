//! Windsurf managed hooks: hooks keyed by event name (no matcher), each a flat
//! `{command, powershell, show_output}` object installed into the file-touch
//! events only.

use serde_json::{json, Value};

use super::config::{command_contains_marker, command_is_managed_for_platform, hooks_object_mut};
use super::SessionProvenanceHookPlatform;

/// Windsurf keys hooks by event name (no matcher); each hook is a flat
/// `{command, powershell, show_output}` object. We install into the
/// file-touch events only.
pub(super) fn update_windsurf_platform(
    config: &mut Value,
    enabled: bool,
    unix_command: &str,
    windows_command: &str,
) -> Result<(), String> {
    let hooks = hooks_object_mut(config)?;
    for event_name in ["post_read_code", "post_write_code"] {
        if !hooks.contains_key(event_name) {
            hooks.insert(event_name.to_string(), Value::Array(Vec::new()));
        }
        let commands = hooks
            .get_mut(event_name)
            .and_then(Value::as_array_mut)
            .ok_or_else(|| format!("Windsurf hook config `hooks.{event_name}` must be an array"))?;
        commands.retain(|command| !command_contains_marker(command));
        if enabled {
            commands.push(json!({
                "command": unix_command,
                "powershell": windows_command,
                "show_output": false
            }));
        }
    }
    Ok(())
}

pub(super) fn windsurf_event_has_managed_hook(config: &Value, event_name: &str) -> bool {
    config
        .get("hooks")
        .and_then(|hooks| hooks.get(event_name))
        .and_then(Value::as_array)
        .is_some_and(|commands| {
            commands.iter().any(|command| {
                command_is_managed_for_platform(command, SessionProvenanceHookPlatform::Windsurf)
            })
        })
}

//! Cursor managed hooks: flat camelCase event arrays with an optional `.*`
//! matcher, plus its completeness predicate.

use serde_json::{json, Value};

use super::config::{command_contains_marker, command_is_managed_for_platform, hooks_object_mut};
use super::SessionProvenanceHookPlatform;

// Cursor lifecycle events (flat camelCase arrays; Cursor has no
// waiting/permission vocabulary — Done comes from stop/sessionEnd).
// (event, needs `.*` matcher)
pub(super) const CURSOR_LIFECYCLE_EVENTS: &[(&str, bool)] = &[
    ("beforeSubmitPrompt", false),
    ("stop", false),
    ("preToolUse", true),
    ("postToolUseFailure", true),
];

pub(super) fn update_cursor_platform(
    config: &mut Value,
    enabled: bool,
    live_status: bool,
    unix_command: &str,
) -> Result<(), String> {
    config
        .as_object_mut()
        .ok_or_else(|| "Cursor hook config root must be a JSON object".to_string())?
        .entry("version")
        .or_insert(json!(1));
    let hooks = hooks_object_mut(config)?;
    let mut events: Vec<(&str, bool, bool)> = vec![
        // (event, needs matcher, install?)
        ("postToolUse", true, enabled),
        ("subagentStart", false, enabled),
        ("subagentStop", false, enabled),
    ];
    for (event_name, needs_matcher) in CURSOR_LIFECYCLE_EVENTS {
        events.push((event_name, *needs_matcher, enabled && live_status));
    }
    for (event_name, needs_matcher, install) in events {
        if !hooks.contains_key(event_name) {
            hooks.insert(event_name.to_string(), Value::Array(Vec::new()));
        }
        let commands = hooks
            .get_mut(event_name)
            .and_then(Value::as_array_mut)
            .ok_or_else(|| format!("Cursor hook config `hooks.{event_name}` must be an array"))?;
        commands.retain(|command| !command_contains_marker(command));
        if install {
            let mut hook = json!({ "command": unix_command });
            if needs_matcher {
                hook.as_object_mut()
                    .expect("hook is object")
                    .insert("matcher".to_string(), json!(".*"));
            }
            commands.push(hook);
        }
    }
    Ok(())
}

pub(super) fn cursor_event_has_managed_hook(
    config: &Value,
    event_name: &str,
    matcher: Option<&str>,
) -> bool {
    config
        .get("hooks")
        .and_then(|hooks| hooks.get(event_name))
        .and_then(Value::as_array)
        .is_some_and(|commands| {
            commands.iter().any(|command| {
                let matcher_matches = match matcher {
                    Some(expected) => {
                        command.get("matcher").and_then(Value::as_str) == Some(expected)
                    }
                    None => command.get("matcher").is_none(),
                };
                matcher_matches
                    && command_is_managed_for_platform(
                        command,
                        SessionProvenanceHookPlatform::Cursor,
                    )
            })
        })
}

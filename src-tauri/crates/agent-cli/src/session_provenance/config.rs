//! Shared config plumbing for managed session-provenance hooks: preferences
//! file I/O, atomic writes, the marker constant, and the generic nested-JSON
//! hook helpers reused across the Claude-Code-family platforms.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use super::SessionProvenanceHookPlatform;

pub(super) const HOOK_MARKER: &str = "--session-provenance-hook";
const PREFERENCES_SCHEMA_VERSION: u32 = 1;
// Every managed hook is observational and must return fast — except the
// Claude Code PermissionRequest entry, which long-polls the desktop for an
// interactive approval decision on managed Manual-mode sessions (see the
// app's `orgtrack::session_provenance::approval_gate`). Its config timeout
// must exceed the hook-side HTTP read timeout (130s), which itself exceeds
// the desktop's 120s park timeout, so Claude never kills the hook mid-wait.
pub(super) const DEFAULT_HOOK_TIMEOUT_SECS: u64 = 5;
static HOOK_CONFIG_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize)]
// No `deny_unknown_fields`: a newer build may add platform fields an older build
// doesn't recognize. Unknown fields are ignored (and missing ones fall back to
// `Default`) so backends of different versions can read each other's
// preferences file instead of hard-failing — a hard failure here would abort
// hook installation entirely and silently disable all capture.
#[serde(rename_all = "camelCase", default)]
pub(super) struct HookPreferences {
    schema_version: u32,
    /// Master switch over every managed hook. When off, all platform hooks
    /// are uninstalled regardless of the per-platform flags below; those
    /// flags are preserved so switching back on restores the previous
    /// per-platform selection.
    pub(super) master_enabled: bool,
    /// Whether lifecycle (live-status) events are installed alongside the
    /// provenance PostToolUse hooks and whether the capture subprocess posts
    /// normalized status events to the desktop's loopback endpoint. Off keeps
    /// provenance capture intact but removes the lifecycle event entries.
    pub(super) live_status_enabled: bool,
    claude_code: bool,
    codex: bool,
    cursor: bool,
    // Newer platforms. Struct-level `default` fills these from `Default` when a
    // pre-existing v1 preferences file omits them, so no schema bump is needed:
    // an upgrading user picks up the new managed hooks at the next reconcile.
    qwen_code: bool,
    factory_droid: bool,
    trae: bool,
    opencode: bool,
    windsurf: bool,
    kimi: bool,
    antigravity: bool,
    zcode: bool,
}

impl Default for HookPreferences {
    fn default() -> Self {
        Self {
            schema_version: PREFERENCES_SCHEMA_VERSION,
            master_enabled: true,
            live_status_enabled: true,
            claude_code: true,
            codex: true,
            cursor: true,
            qwen_code: true,
            factory_droid: true,
            trae: true,
            opencode: true,
            windsurf: true,
            kimi: true,
            antigravity: true,
            zcode: true,
        }
    }
}

impl HookPreferences {
    /// Whether the hook should actually be installed for `platform`: the
    /// per-platform flag gated by the master switch.
    pub(super) fn effective_enabled(&self, platform: SessionProvenanceHookPlatform) -> bool {
        self.master_enabled && self.enabled(platform)
    }

    pub(super) fn enabled(&self, platform: SessionProvenanceHookPlatform) -> bool {
        match platform {
            SessionProvenanceHookPlatform::ClaudeCode => self.claude_code,
            SessionProvenanceHookPlatform::Codex => self.codex,
            SessionProvenanceHookPlatform::Cursor => self.cursor,
            SessionProvenanceHookPlatform::QwenCode => self.qwen_code,
            SessionProvenanceHookPlatform::FactoryDroid => self.factory_droid,
            SessionProvenanceHookPlatform::Trae => self.trae,
            SessionProvenanceHookPlatform::OpenCode => self.opencode,
            SessionProvenanceHookPlatform::Windsurf => self.windsurf,
            SessionProvenanceHookPlatform::Kimi => self.kimi,
            SessionProvenanceHookPlatform::Antigravity => self.antigravity,
            SessionProvenanceHookPlatform::ZCode => self.zcode,
        }
    }

    pub(super) fn set_enabled(&mut self, platform: SessionProvenanceHookPlatform, enabled: bool) {
        match platform {
            SessionProvenanceHookPlatform::ClaudeCode => self.claude_code = enabled,
            SessionProvenanceHookPlatform::Codex => self.codex = enabled,
            SessionProvenanceHookPlatform::Cursor => self.cursor = enabled,
            SessionProvenanceHookPlatform::QwenCode => self.qwen_code = enabled,
            SessionProvenanceHookPlatform::FactoryDroid => self.factory_droid = enabled,
            SessionProvenanceHookPlatform::Trae => self.trae = enabled,
            SessionProvenanceHookPlatform::OpenCode => self.opencode = enabled,
            SessionProvenanceHookPlatform::Windsurf => self.windsurf = enabled,
            SessionProvenanceHookPlatform::Kimi => self.kimi = enabled,
            SessionProvenanceHookPlatform::Antigravity => self.antigravity = enabled,
            SessionProvenanceHookPlatform::ZCode => self.zcode = enabled,
        }
    }
}

fn preferences_path() -> PathBuf {
    app_paths::orgii_root()
        .join("session-provenance")
        .join("hooks.json")
}

pub(super) fn operation_guard() -> Result<MutexGuard<'static, ()>, String> {
    HOOK_CONFIG_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "Session-provenance hook config lock is poisoned".to_string())
}

pub(super) fn read_preferences() -> Result<HookPreferences, String> {
    let path = preferences_path();
    if !path.exists() {
        return Ok(HookPreferences::default());
    }
    let bytes =
        std::fs::read(&path).map_err(|err| format!("Failed to read {}: {err}", path.display()))?;
    let preferences: HookPreferences = serde_json::from_slice(&bytes)
        .map_err(|err| format!("Invalid session-provenance preferences: {err}"))?;
    if preferences.schema_version != PREFERENCES_SCHEMA_VERSION {
        return Err(format!(
            "Unsupported session-provenance preferences schema version: {}",
            preferences.schema_version
        ));
    }
    Ok(preferences)
}

pub(super) fn write_preferences(preferences: &HookPreferences) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(preferences)
        .map_err(|err| format!("Failed to serialize hook preferences: {err}"))?;
    write_atomic(&preferences_path(), &bytes)
}

pub(super) fn read_config(path: &Path) -> Result<Value, String> {
    if !path.exists() {
        return Ok(Value::Object(Map::new()));
    }
    let bytes =
        std::fs::read(path).map_err(|err| format!("Failed to read {}: {err}", path.display()))?;
    serde_json::from_slice(&bytes)
        .map_err(|err| format!("Invalid JSON in {}: {err}", path.display()))
}

pub(super) fn write_config(path: &Path, config: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(config)
        .map_err(|err| format!("Failed to serialize {}: {err}", path.display()))?;
    write_atomic(path, &bytes)
}

pub(super) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    // Startup reconciliation runs on every desktop launch. Avoid atomically
    // replacing provider configs (and their inode/mtime) when their rendered
    // bytes are already current: some providers watch these files and reload
    // hooks on replacement.
    if std::fs::read(path).is_ok_and(|existing| existing == bytes) {
        return Ok(());
    }
    let parent = path
        .parent()
        .ok_or_else(|| format!("Hook config has no parent directory: {}", path.display()))?;
    std::fs::create_dir_all(parent)
        .map_err(|err| format!("Failed to create {}: {err}", parent.display()))?;
    let mut temp = tempfile::Builder::new()
        .prefix(".orgii-session-provenance-")
        .suffix(".tmp")
        .tempfile_in(parent)
        .map_err(|err| format!("Failed to create temp file in {}: {err}", parent.display()))?;
    temp.write_all(bytes)
        .map_err(|err| format!("Failed to write hook config temp file: {err}"))?;
    temp.as_file()
        .sync_all()
        .map_err(|err| format!("Failed to flush hook config temp file: {err}"))?;
    app_paths::set_sensitive_file_permissions(temp.path()).ok();
    temp.persist(path)
        .map(|_| ())
        .map_err(|err| format!("Failed to publish {}: {}", path.display(), err.error))
}

pub(super) fn hook_commands(executable: &Path, source: &str) -> (String, String) {
    let raw = executable.to_string_lossy();
    let unix_path = format!("'{}'", raw.replace('\'', "'\\''"));
    let windows_path = format!("\"{}\"", raw.replace('"', "\\\""));
    (
        format!("{unix_path} {HOOK_MARKER} {source}"),
        format!("{windows_path} {HOOK_MARKER} {source}"),
    )
}

pub(super) fn command_contains_marker(value: &Value) -> bool {
    value
        .get("command")
        .and_then(Value::as_str)
        .is_some_and(|command| command.contains(HOOK_MARKER))
        || value
            .get("commandWindows")
            .and_then(Value::as_str)
            .is_some_and(|command| command.contains(HOOK_MARKER))
}

pub(super) fn command_is_managed_for_platform(
    value: &Value,
    platform: SessionProvenanceHookPlatform,
) -> bool {
    let expected = format!("{HOOK_MARKER} {}", platform.source_arg());
    ["command", "commandWindows"].into_iter().any(|field| {
        value
            .get(field)
            .and_then(Value::as_str)
            .is_some_and(|command| command.trim_end().ends_with(&expected))
    })
}

pub(super) fn hooks_object_mut(config: &mut Value) -> Result<&mut Map<String, Value>, String> {
    let root = config
        .as_object_mut()
        .ok_or_else(|| "Hook config root must be a JSON object".to_string())?;
    if !root.contains_key("hooks") {
        root.insert("hooks".to_string(), Value::Object(Map::new()));
    }
    root.get_mut("hooks")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "Hook config `hooks` must be a JSON object".to_string())
}

pub(super) fn update_nested_platform(
    config: &mut Value,
    enabled: bool,
    matcher: &str,
    unix_command: &str,
    windows_command: &str,
) -> Result<(), String> {
    update_nested_event(
        config,
        "PostToolUse",
        enabled,
        Some(matcher),
        unix_command,
        windows_command,
    )
}

pub(super) fn update_nested_event(
    config: &mut Value,
    event_name: &str,
    enabled: bool,
    matcher: Option<&str>,
    unix_command: &str,
    windows_command: &str,
) -> Result<(), String> {
    update_nested_event_with_timeout(
        config,
        event_name,
        enabled,
        matcher,
        unix_command,
        windows_command,
        DEFAULT_HOOK_TIMEOUT_SECS,
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn update_nested_event_with_timeout(
    config: &mut Value,
    event_name: &str,
    enabled: bool,
    matcher: Option<&str>,
    unix_command: &str,
    windows_command: &str,
    timeout_secs: u64,
) -> Result<(), String> {
    let hooks = hooks_object_mut(config)?;
    if !hooks.contains_key(event_name) {
        hooks.insert(event_name.to_string(), Value::Array(Vec::new()));
    }
    let groups = hooks
        .get_mut(event_name)
        .and_then(Value::as_array_mut)
        .ok_or_else(|| format!("Hook config `hooks.{event_name}` must be an array"))?;
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
        let mut group = json!({
            "hooks": [{
                "type": "command",
                "command": unix_command,
                "commandWindows": windows_command,
                "timeout": timeout_secs
            }]
        });
        if let Some(matcher) = matcher {
            group
                .as_object_mut()
                .expect("hook group is object")
                .insert("matcher".to_string(), json!(matcher));
        }
        groups.push(group);
    }
    Ok(())
}

pub(super) fn nested_event_has_managed_hook(
    config: &Value,
    platform: SessionProvenanceHookPlatform,
    event_name: &str,
    matcher: Option<&str>,
) -> bool {
    config
        .get("hooks")
        .and_then(|hooks| hooks.get(event_name))
        .and_then(Value::as_array)
        .is_some_and(|groups| {
            groups.iter().any(|group| {
                let matcher_matches = match matcher {
                    Some(expected) => {
                        group.get("matcher").and_then(Value::as_str) == Some(expected)
                    }
                    None => group.get("matcher").is_none(),
                };
                matcher_matches
                    && group
                        .get("hooks")
                        .and_then(Value::as_array)
                        .is_some_and(|commands| {
                            commands
                                .iter()
                                .any(|command| command_is_managed_for_platform(command, platform))
                        })
            })
        })
}

/// True when the managed command entry for `event_name` carries exactly
/// `timeout_secs`. Used to detect stale Claude `PermissionRequest` installs
/// (pre-approval-bridge `timeout: 5`) so startup reconcile repairs them —
/// a 5s cap would kill the interactive approval long-poll mid-wait.
pub(super) fn nested_event_managed_hook_has_timeout(
    config: &Value,
    platform: SessionProvenanceHookPlatform,
    event_name: &str,
    matcher: Option<&str>,
    timeout_secs: u64,
) -> bool {
    config
        .get("hooks")
        .and_then(|hooks| hooks.get(event_name))
        .and_then(Value::as_array)
        .is_some_and(|groups| {
            groups.iter().any(|group| {
                let matcher_matches = match matcher {
                    Some(expected) => {
                        group.get("matcher").and_then(Value::as_str) == Some(expected)
                    }
                    None => group.get("matcher").is_none(),
                };
                matcher_matches
                    && group
                        .get("hooks")
                        .and_then(Value::as_array)
                        .is_some_and(|commands| {
                            commands.iter().any(|command| {
                                command_is_managed_for_platform(command, platform)
                                    && command.get("timeout").and_then(Value::as_u64)
                                        == Some(timeout_secs)
                            })
                        })
            })
        })
}

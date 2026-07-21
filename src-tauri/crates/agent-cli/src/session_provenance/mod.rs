//! Managed hook installation for session provenance.
//!
//! ORG2 owns only hook entries whose command includes [`HOOK_MARKER`]. User
//! hooks and unrelated configuration are preserved semantically when the JSON
//! is rewritten.
//!
//! The module splits per CLI-agent platform: shared config plumbing lives in
//! [`config`], and each platform submodule owns its install/predicate logic.
//! This file keeps the public surface (the platform enum, status/receipt
//! types, and the Tauri entry points) plus the cross-platform dispatch.

mod antigravity;
mod claude;
mod codex;
mod config;
mod cursor;
mod factory_droid;
mod kimi;
mod opencode;
mod qwen_code;
mod trae;
mod windsurf;
mod zcode;

#[cfg(test)]
mod tests;

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use antigravity::{
    antigravity_has_managed_hook, update_antigravity_platform, ANTIGRAVITY_HOOK_GROUP,
    ANTIGRAVITY_LIFECYCLE_EVENTS,
};
use claude::{
    update_claude_lifecycle_events, CLAUDE_CODE_LIFECYCLE_EVENTS,
    CLAUDE_CODE_LIVE_STATUS_POST_TOOL_USE_MATCHER, CLAUDE_CODE_POST_TOOL_USE_MATCHER,
};
use codex::{
    update_codex_platform, CODEX_LIFECYCLE_EVENTS, CODEX_POST_TOOL_USE_MATCHER,
    CODEX_REQUIRED_EVENTS,
};
use config::{
    command_is_managed_for_platform, hook_commands, nested_event_has_managed_hook,
    nested_event_managed_hook_has_timeout, operation_guard, read_config, read_preferences,
    update_nested_event, update_nested_platform, write_atomic, write_config, write_preferences,
    HookPreferences,
};
use cursor::{cursor_event_has_managed_hook, update_cursor_platform, CURSOR_LIFECYCLE_EVENTS};
use factory_droid::{FACTORY_DROID_LIFECYCLE_EVENTS, FACTORY_DROID_POST_TOOL_USE_MATCHER};
use kimi::{kimi_config_is_managed, update_kimi_platform};
use opencode::{opencode_plugin_is_managed, opencode_plugin_path, update_opencode_plugin};
use qwen_code::QWEN_CODE_POST_TOOL_USE_MATCHER;
use trae::{update_trae_platform, TRAE_POST_TOOL_USE_MATCHER};
use windsurf::{update_windsurf_platform, windsurf_event_has_managed_hook};
use zcode::{update_zcode_plugin, zcode_plugin_hooks_path, zcode_plugin_is_managed};

const ACTIVATION_RECEIPT_SCHEMA_VERSION: u32 = 1;
const ALL_SESSION_PROVENANCE_HOOK_PLATFORMS: [SessionProvenanceHookPlatform; 11] = [
    SessionProvenanceHookPlatform::ClaudeCode,
    SessionProvenanceHookPlatform::Codex,
    SessionProvenanceHookPlatform::Cursor,
    SessionProvenanceHookPlatform::QwenCode,
    SessionProvenanceHookPlatform::FactoryDroid,
    SessionProvenanceHookPlatform::Trae,
    SessionProvenanceHookPlatform::OpenCode,
    SessionProvenanceHookPlatform::Windsurf,
    SessionProvenanceHookPlatform::Kimi,
    SessionProvenanceHookPlatform::Antigravity,
    SessionProvenanceHookPlatform::ZCode,
];
// Every managed hook is observational and must return fast — except the
// Claude Code PermissionRequest entry, which long-polls the desktop for an
// interactive approval decision on managed Manual-mode sessions (see the
// app's `orgtrack::session_provenance::approval_gate`). Its config timeout
// must exceed the hook-side HTTP read timeout (130s), which itself exceeds
// the desktop's 120s park timeout, so Claude never kills the hook mid-wait.
pub const CLAUDE_PERMISSION_REQUEST_HOOK_TIMEOUT_SECS: u64 = 300;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionProvenanceHookPlatform {
    ClaudeCode,
    Codex,
    Cursor,
    QwenCode,
    FactoryDroid,
    Trae,
    // `snake_case` would render this as `open_code`; the wire id (frontend enum,
    // source string, icon) is the single word `opencode`.
    #[serde(rename = "opencode")]
    OpenCode,
    Windsurf,
    Kimi,
    Antigravity,
    #[serde(rename = "zcode")]
    ZCode,
}

impl SessionProvenanceHookPlatform {
    pub(super) fn source_arg(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude",
            Self::Codex => "codex",
            Self::Cursor => "cursor",
            Self::QwenCode => "qwen",
            Self::FactoryDroid => "droid",
            Self::Trae => "trae",
            Self::OpenCode => "opencode",
            Self::Windsurf => "windsurf",
            Self::Kimi => "kimi",
            Self::Antigravity => "antigravity",
            Self::ZCode => "zcode",
        }
    }

    pub(super) fn config_path(self) -> PathBuf {
        match self {
            Self::ClaudeCode => app_paths::home_dir().join(".claude").join("settings.json"),
            Self::Codex => app_paths::home_dir().join(".codex").join("hooks.json"),
            Self::Cursor => app_paths::home_dir().join(".cursor").join("hooks.json"),
            // Qwen Code reads Claude-Code-style JSON `hooks` from its settings;
            // Factory Droid uses a dedicated hooks file, both under $HOME.
            Self::QwenCode => app_paths::home_dir().join(".qwen").join("settings.json"),
            Self::FactoryDroid => app_paths::home_dir().join(".factory").join("hooks.json"),
            // Trae's global hooks file lives in its app dir. Trae CN uses
            // `.trae-cn`; the international build uses `.trae`. Prefer whichever
            // is present so each machine targets its installed variant.
            Self::Trae => {
                let cn = app_paths::home_dir().join(".trae-cn");
                let base = if cn.is_dir() {
                    cn
                } else {
                    app_paths::home_dir().join(".trae")
                };
                base.join("hooks.json")
            }
            // OpenCode captures via a managed plugin FILE (not a JSON hooks
            // object) under its XDG config dir.
            Self::OpenCode => opencode_plugin_path(),
            // Windsurf's user hooks file; Antigravity's is under ~/.gemini/config.
            Self::Windsurf => app_paths::home_dir()
                .join(".codeium")
                .join("windsurf")
                .join("hooks.json"),
            // Kimi is a TOML config file (the user's main config).
            Self::Kimi => app_paths::home_dir().join(".kimi").join("config.toml"),
            Self::Antigravity => app_paths::home_dir()
                .join(".gemini")
                .join("config")
                .join("hooks.json"),
            // ZCode captures via a managed plugin; surface its hooks.json.
            Self::ZCode => zcode_plugin_hooks_path(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionProvenanceHookStatus {
    pub platform: SessionProvenanceHookPlatform,
    pub enabled: bool,
    pub desired_enabled: bool,
    pub activation_state: SessionProvenanceHookActivationState,
    pub last_activated_at: Option<String>,
    pub config_path: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionProvenanceHookActivationState {
    Inactive,
    AwaitingVerification,
    Active,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HookActivationReceipt {
    schema_version: u32,
    platform: SessionProvenanceHookPlatform,
    hook_fingerprint: String,
    activated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HookSessionActivationReceipt {
    schema_version: u32,
    platform: SessionProvenanceHookPlatform,
    source_session_id: String,
    hook_fingerprint: String,
    activated_at: String,
}

fn activation_receipt_path(platform: SessionProvenanceHookPlatform) -> PathBuf {
    app_paths::orgii_root()
        .join("session-provenance")
        .join("activations")
        .join(format!("{}.json", platform.source_arg()))
}

fn session_activation_receipt_path(
    platform: SessionProvenanceHookPlatform,
    source_session_id: &str,
) -> PathBuf {
    let digest = Sha256::digest(source_session_id.as_bytes());
    app_paths::orgii_root()
        .join("session-provenance")
        .join("activations")
        .join(platform.source_arg())
        .join("sessions")
        .join(format!("{digest:x}.json"))
}

fn read_session_activation_receipt(
    platform: SessionProvenanceHookPlatform,
    source_session_id: &str,
) -> Option<HookSessionActivationReceipt> {
    let bytes = std::fs::read(session_activation_receipt_path(platform, source_session_id)).ok()?;
    let receipt: HookSessionActivationReceipt = serde_json::from_slice(&bytes).ok()?;
    (receipt.schema_version == ACTIVATION_RECEIPT_SCHEMA_VERSION
        && receipt.platform == platform
        && receipt.source_session_id == source_session_id)
        .then_some(receipt)
}

fn session_activation_matches(
    fingerprint: &str,
    source_session_id: &str,
    receipt: Option<HookSessionActivationReceipt>,
) -> bool {
    receipt.is_some_and(|receipt| {
        receipt.source_session_id == source_session_id && receipt.hook_fingerprint == fingerprint
    })
}

fn update_platform(
    platform: SessionProvenanceHookPlatform,
    enabled: bool,
    live_status: bool,
    executable: &Path,
) -> Result<(), String> {
    // OpenCode (plugin file), Kimi (TOML), and ZCode (plugin tree) are not JSON
    // hooks objects — handle them before any JSON read/write.
    match platform {
        SessionProvenanceHookPlatform::OpenCode => {
            return update_opencode_plugin(enabled, executable);
        }
        SessionProvenanceHookPlatform::Kimi => {
            return update_kimi_platform(enabled, live_status, executable);
        }
        SessionProvenanceHookPlatform::ZCode => {
            return update_zcode_plugin(enabled, executable);
        }
        _ => {}
    }
    let path = platform.config_path();
    if !enabled && !path.exists() {
        return Ok(());
    }
    let mut config = read_config(&path)?;
    let original_config = config.clone();
    let (unix_command, windows_command) = hook_commands(executable, platform.source_arg());
    match platform {
        SessionProvenanceHookPlatform::ClaudeCode => {
            let post_tool_use_matcher = if live_status {
                CLAUDE_CODE_LIVE_STATUS_POST_TOOL_USE_MATCHER
            } else {
                CLAUDE_CODE_POST_TOOL_USE_MATCHER
            };
            update_nested_platform(
                &mut config,
                enabled,
                post_tool_use_matcher,
                &unix_command,
                &windows_command,
            )?;
            update_claude_lifecycle_events(
                &mut config,
                enabled && live_status,
                &unix_command,
                &windows_command,
            )?;
        }
        SessionProvenanceHookPlatform::Codex => update_codex_platform(
            &mut config,
            enabled,
            live_status,
            &unix_command,
            &windows_command,
        )?,
        SessionProvenanceHookPlatform::Cursor => {
            let cursor_command = if cfg!(windows) {
                &windows_command
            } else {
                &unix_command
            };
            update_cursor_platform(&mut config, enabled, live_status, cursor_command)?
        }
        // Qwen Code and Factory Droid consume the same Claude-Code-style nested
        // JSON `hooks.PostToolUse` schema; only the file-tool matcher differs.
        SessionProvenanceHookPlatform::QwenCode => update_nested_platform(
            &mut config,
            enabled,
            QWEN_CODE_POST_TOOL_USE_MATCHER,
            &unix_command,
            &windows_command,
        )?,
        SessionProvenanceHookPlatform::FactoryDroid => {
            update_nested_platform(
                &mut config,
                enabled,
                FACTORY_DROID_POST_TOOL_USE_MATCHER,
                &unix_command,
                &windows_command,
            )?;
            for (event_name, matcher) in FACTORY_DROID_LIFECYCLE_EVENTS {
                update_nested_event(
                    &mut config,
                    event_name,
                    enabled && live_status,
                    *matcher,
                    &unix_command,
                    &windows_command,
                )?;
            }
        }
        SessionProvenanceHookPlatform::Trae => {
            let command = if cfg!(windows) {
                &windows_command
            } else {
                &unix_command
            };
            update_trae_platform(&mut config, enabled, command)?
        }
        SessionProvenanceHookPlatform::Windsurf => {
            update_windsurf_platform(&mut config, enabled, &unix_command, &windows_command)?
        }
        SessionProvenanceHookPlatform::Antigravity => {
            let command = if cfg!(windows) {
                &windows_command
            } else {
                &unix_command
            };
            update_antigravity_platform(&mut config, enabled, live_status, command)?
        }
        SessionProvenanceHookPlatform::OpenCode
        | SessionProvenanceHookPlatform::Kimi
        | SessionProvenanceHookPlatform::ZCode => {
            unreachable!("OpenCode/Kimi/ZCode are handled before the JSON path")
        }
    }
    if config == original_config {
        Ok(())
    } else {
        write_config(&path, &config)
    }
}

fn config_has_complete_managed_hooks(
    config: &Value,
    platform: SessionProvenanceHookPlatform,
    live_status: bool,
) -> bool {
    match platform {
        // The expected Claude install shape depends on the live-status
        // preference; checking the wrong shape would make startup reconcile
        // flap between "repair" and "on".
        SessionProvenanceHookPlatform::ClaudeCode => {
            if live_status {
                nested_event_has_managed_hook(
                    config,
                    platform,
                    "PostToolUse",
                    Some(CLAUDE_CODE_LIVE_STATUS_POST_TOOL_USE_MATCHER),
                ) && CLAUDE_CODE_LIFECYCLE_EVENTS
                    .iter()
                    .all(|(event_name, matcher)| {
                        nested_event_has_managed_hook(config, platform, event_name, *matcher)
                    })
                    // The approval-bridge long-poll needs the raised
                    // PermissionRequest timeout; a stale `timeout: 5`
                    // entry counts as incomplete so reconcile repairs it.
                    && nested_event_managed_hook_has_timeout(
                        config,
                        platform,
                        "PermissionRequest",
                        Some("*"),
                        CLAUDE_PERMISSION_REQUEST_HOOK_TIMEOUT_SECS,
                    )
            } else {
                nested_event_has_managed_hook(
                    config,
                    platform,
                    "PostToolUse",
                    Some(CLAUDE_CODE_POST_TOOL_USE_MATCHER),
                )
            }
        }
        SessionProvenanceHookPlatform::Codex => {
            nested_event_has_managed_hook(
                config,
                platform,
                "PostToolUse",
                Some(CODEX_POST_TOOL_USE_MATCHER),
            ) && CODEX_REQUIRED_EVENTS
                .iter()
                .all(|event_name| nested_event_has_managed_hook(config, platform, event_name, None))
                && (!live_status
                    || CODEX_LIFECYCLE_EVENTS.iter().all(|event_name| {
                        nested_event_has_managed_hook(config, platform, event_name, None)
                    }))
        }
        SessionProvenanceHookPlatform::Cursor => {
            cursor_event_has_managed_hook(config, "postToolUse", Some(".*"))
                && cursor_event_has_managed_hook(config, "subagentStart", None)
                && cursor_event_has_managed_hook(config, "subagentStop", None)
                && (!live_status
                    || CURSOR_LIFECYCLE_EVENTS
                        .iter()
                        .all(|(event_name, needs_matcher)| {
                            cursor_event_has_managed_hook(
                                config,
                                event_name,
                                needs_matcher.then_some(".*"),
                            )
                        }))
        }
        SessionProvenanceHookPlatform::QwenCode => nested_event_has_managed_hook(
            config,
            platform,
            "PostToolUse",
            Some(QWEN_CODE_POST_TOOL_USE_MATCHER),
        ),
        SessionProvenanceHookPlatform::FactoryDroid => {
            nested_event_has_managed_hook(
                config,
                platform,
                "PostToolUse",
                Some(FACTORY_DROID_POST_TOOL_USE_MATCHER),
            ) && (!live_status
                || FACTORY_DROID_LIFECYCLE_EVENTS
                    .iter()
                    .all(|(event_name, matcher)| {
                        nested_event_has_managed_hook(config, platform, event_name, *matcher)
                    }))
        }
        SessionProvenanceHookPlatform::Trae => nested_event_has_managed_hook(
            config,
            platform,
            "PostToolUse",
            Some(TRAE_POST_TOOL_USE_MATCHER),
        ),
        SessionProvenanceHookPlatform::Windsurf => {
            windsurf_event_has_managed_hook(config, "post_read_code")
                && windsurf_event_has_managed_hook(config, "post_write_code")
        }
        SessionProvenanceHookPlatform::Antigravity => {
            antigravity_has_managed_hook(config)
                && (!live_status
                    || ANTIGRAVITY_LIFECYCLE_EVENTS.iter().all(|event_name| {
                        config
                            .get(ANTIGRAVITY_HOOK_GROUP)
                            .and_then(|group| group.get(*event_name))
                            .is_some()
                    }))
        }
        // OpenCode (plugin file), Kimi (TOML), and ZCode (plugin tree) install
        // state is checked directly in `config_has_managed_hooks`; none reach
        // this JSON predicate.
        SessionProvenanceHookPlatform::OpenCode
        | SessionProvenanceHookPlatform::Kimi
        | SessionProvenanceHookPlatform::ZCode => false,
    }
}

fn config_has_managed_hooks(platform: SessionProvenanceHookPlatform) -> Result<bool, String> {
    match platform {
        SessionProvenanceHookPlatform::OpenCode => {
            return Ok(opencode_plugin_is_managed(&opencode_plugin_path()));
        }
        SessionProvenanceHookPlatform::Kimi => {
            return Ok(kimi_config_is_managed(&platform.config_path()));
        }
        SessionProvenanceHookPlatform::ZCode => {
            return Ok(zcode_plugin_is_managed());
        }
        _ => {}
    }
    let config = read_config(&platform.config_path())?;
    // Fail-open mirror of `live_status_enabled_quick` (minus the master gate,
    // which `update_platform`'s `enabled` already encodes at install time).
    let live_status = read_preferences()
        .map(|preferences| preferences.live_status_enabled)
        .unwrap_or(true);
    Ok(config_has_complete_managed_hooks(
        &config,
        platform,
        live_status,
    ))
}

/// Fingerprint only ORG2-managed definitions, so unrelated user hooks neither
/// invalidate nor accidentally satisfy a Codex activation receipt.
fn managed_hook_fingerprint(
    config: &Value,
    platform: SessionProvenanceHookPlatform,
) -> Option<String> {
    let hooks = config.get("hooks")?.as_object()?;
    let mut definitions = Vec::new();
    for (event_name, groups) in hooks {
        let Some(groups) = groups.as_array() else {
            continue;
        };
        for group in groups {
            let matcher = group.get("matcher").cloned().unwrap_or(Value::Null);
            let Some(commands) = group.get("hooks").and_then(Value::as_array) else {
                continue;
            };
            for command in commands {
                if !command_is_managed_for_platform(command, platform) {
                    continue;
                }
                definitions.push(
                    serde_json::to_string(&json!({
                        "event": event_name,
                        "matcher": matcher,
                        "type": command.get("type").cloned().unwrap_or(Value::Null),
                        "command": command.get("command").cloned().unwrap_or(Value::Null),
                        "commandWindows": command
                            .get("commandWindows")
                            .cloned()
                            .unwrap_or(Value::Null),
                        "timeout": command.get("timeout").cloned().unwrap_or(Value::Null),
                    }))
                    .expect("managed hook fingerprint value is serializable"),
                );
            }
        }
    }
    if definitions.is_empty() {
        return None;
    }
    definitions.sort();
    let digest = Sha256::digest(definitions.join("\n").as_bytes());
    Some(format!("{digest:x}"))
}

fn current_managed_hook_fingerprint(
    platform: SessionProvenanceHookPlatform,
) -> Result<Option<String>, String> {
    match platform {
        SessionProvenanceHookPlatform::Codex => {
            let config = read_config(&platform.config_path())?;
            Ok(managed_hook_fingerprint(&config, platform))
        }
        _ => Ok(None),
    }
}

fn read_activation_receipt(
    platform: SessionProvenanceHookPlatform,
) -> Option<HookActivationReceipt> {
    let bytes = std::fs::read(activation_receipt_path(platform)).ok()?;
    let receipt = serde_json::from_slice::<HookActivationReceipt>(&bytes).ok()?;
    (receipt.schema_version == ACTIVATION_RECEIPT_SCHEMA_VERSION && receipt.platform == platform)
        .then_some(receipt)
}

fn codex_activation_from_receipt(
    fingerprint: &str,
    receipt: Option<HookActivationReceipt>,
) -> (SessionProvenanceHookActivationState, Option<String>) {
    if let Some(receipt) = receipt.filter(|receipt| receipt.hook_fingerprint == fingerprint) {
        (
            SessionProvenanceHookActivationState::Active,
            Some(receipt.activated_at),
        )
    } else {
        (
            SessionProvenanceHookActivationState::AwaitingVerification,
            None,
        )
    }
}

fn activation_for_installed_hook(
    platform: SessionProvenanceHookPlatform,
    installed: bool,
) -> Result<(SessionProvenanceHookActivationState, Option<String>), String> {
    if !installed {
        return Ok((SessionProvenanceHookActivationState::Inactive, None));
    }
    if platform != SessionProvenanceHookPlatform::Codex {
        return Ok((SessionProvenanceHookActivationState::Active, None));
    }

    let fingerprint = current_managed_hook_fingerprint(platform)?.ok_or_else(|| {
        "Installed Codex hooks are missing a managed definition fingerprint".to_string()
    })?;
    Ok(codex_activation_from_receipt(
        &fingerprint,
        read_activation_receipt(platform),
    ))
}

fn append_error(existing: Option<String>, next: String) -> Option<String> {
    Some(match existing {
        Some(existing) => format!("{existing}; {next}"),
        None => next,
    })
}

fn build_hook_status(
    platform: SessionProvenanceHookPlatform,
    desired_enabled: bool,
    operation_error: Option<String>,
) -> SessionProvenanceHookStatus {
    let (enabled, mut error) = match config_has_managed_hooks(platform) {
        Ok(enabled) => (enabled, operation_error),
        Err(inspection_error) => (
            false,
            append_error(
                operation_error,
                format!("failed to inspect resulting hook config: {inspection_error}"),
            ),
        ),
    };
    let (activation_state, last_activated_at) =
        match activation_for_installed_hook(platform, enabled) {
            Ok(activation) => activation,
            Err(activation_error) => {
                error = append_error(error, activation_error);
                (SessionProvenanceHookActivationState::Inactive, None)
            }
        };
    SessionProvenanceHookStatus {
        platform,
        enabled,
        desired_enabled,
        activation_state,
        last_activated_at,
        config_path: platform.config_path().to_string_lossy().into_owned(),
        error,
    }
}

/// Record proof that Codex invoked the current ORG2-managed hook definition.
/// Record global Codex hook activation and, for a SessionStart event, task-
/// scoped evidence. The global receipt drives the settings UI; the task
/// receipt lets transcript reconciliation distinguish a healthy live hook
/// path from a task whose hooks never activated.
pub fn record_session_provenance_hook_activation(
    source: &str,
    session_start_source_session_id: Option<&str>,
) -> Result<bool, String> {
    if source != SessionProvenanceHookPlatform::Codex.source_arg() {
        return Ok(false);
    }
    let _guard = operation_guard()?;
    let platform = SessionProvenanceHookPlatform::Codex;
    if !config_has_managed_hooks(platform)? {
        return Ok(false);
    }
    let fingerprint = current_managed_hook_fingerprint(platform)?.ok_or_else(|| {
        "Cannot record Codex activation without managed hook definitions".to_string()
    })?;
    let activated_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let mut changed = false;
    if read_activation_receipt(platform)
        .is_none_or(|receipt| receipt.hook_fingerprint != fingerprint)
    {
        let receipt = HookActivationReceipt {
            schema_version: ACTIVATION_RECEIPT_SCHEMA_VERSION,
            platform,
            hook_fingerprint: fingerprint.clone(),
            activated_at: activated_at.clone(),
        };
        let bytes = serde_json::to_vec_pretty(&receipt)
            .map_err(|err| format!("Failed to serialize hook activation receipt: {err}"))?;
        write_atomic(&activation_receipt_path(platform), &bytes)?;
        changed = true;
    }
    if let Some(source_session_id) = session_start_source_session_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let current = session_activation_matches(
            &fingerprint,
            source_session_id,
            read_session_activation_receipt(platform, source_session_id),
        );
        if !current {
            let receipt = HookSessionActivationReceipt {
                schema_version: ACTIVATION_RECEIPT_SCHEMA_VERSION,
                platform,
                source_session_id: source_session_id.to_string(),
                hook_fingerprint: fingerprint.clone(),
                activated_at: activated_at.clone(),
            };
            let bytes = serde_json::to_vec_pretty(&receipt).map_err(|err| {
                format!("Failed to serialize hook session activation receipt: {err}")
            })?;
            write_atomic(
                &session_activation_receipt_path(platform, source_session_id),
                &bytes,
            )?;
            changed = true;
        }
    }
    Ok(changed)
}

/// Whether this Codex task emitted SessionStart under the currently installed
/// managed hook definition. Missing, stale, or malformed receipts are false.
pub fn codex_session_start_is_active(source_session_id: &str) -> Result<bool, String> {
    let _guard = operation_guard()?;
    let platform = SessionProvenanceHookPlatform::Codex;
    let Some(fingerprint) = current_managed_hook_fingerprint(platform)? else {
        return Ok(false);
    };
    Ok(session_activation_matches(
        &fingerprint,
        source_session_id,
        read_session_activation_receipt(platform, source_session_id),
    ))
}

/// Reconcile hook files with ORG2 preferences. On first launch preferences
/// default to all supported platforms enabled.
pub fn ensure_hooks_from_preferences() -> Result<(), String> {
    let _guard = operation_guard()?;
    // A malformed or version-incompatible preferences file must never prevent
    // hook installation. Fall back to defaults (all enabled) and self-heal the
    // file below rather than aborting and disabling all capture.
    let preferences = read_preferences().unwrap_or_else(|err| {
        tracing::warn!(
            error = %err,
            "[SessionProvenance] Unreadable hook preferences; reinstalling with defaults"
        );
        HookPreferences::default()
    });
    let executable = std::env::current_exe()
        .map_err(|err| format!("Failed to locate ORG2 executable: {err}"))?;
    let mut errors = Vec::new();
    for platform in ALL_SESSION_PROVENANCE_HOOK_PLATFORMS {
        if let Err(err) = update_platform(
            platform,
            preferences.effective_enabled(platform),
            preferences.live_status_enabled,
            &executable,
        ) {
            errors.push(format!("{platform:?}: {err}"));
        }
    }
    write_preferences(&preferences)?;
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

#[tauri::command]
pub async fn session_provenance_hooks_status() -> Result<Vec<SessionProvenanceHookStatus>, String> {
    tokio::task::spawn_blocking(|| {
        let _guard = operation_guard()?;
        let preferences = read_preferences()?;
        Ok::<_, String>(
            ALL_SESSION_PROVENANCE_HOOK_PLATFORMS
                .into_iter()
                .map(|platform| build_hook_status(platform, preferences.enabled(platform), None))
                .collect::<Vec<_>>(),
        )
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[tauri::command]
pub async fn session_provenance_hooks_set_enabled(
    platform: SessionProvenanceHookPlatform,
    enabled: bool,
) -> Result<SessionProvenanceHookStatus, String> {
    tokio::task::spawn_blocking(move || {
        let _guard = operation_guard()?;
        let executable = std::env::current_exe()
            .map_err(|err| format!("Failed to locate ORG2 executable: {err}"))?;
        let mut preferences = read_preferences()?;
        preferences.set_enabled(platform, enabled);
        write_preferences(&preferences)?;
        // Persist the user's desired state before touching a provider file.
        // If a malformed or read-only config cannot be repaired immediately,
        // startup reconciliation can retry without losing the opt-out.
        // The master switch gates the actual installation.
        let update_error = update_platform(
            platform,
            preferences.effective_enabled(platform),
            preferences.live_status_enabled,
            &executable,
        )
        .err();
        Ok(build_hook_status(platform, enabled, update_error))
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

/// Lock-free master-switch probe for the short-lived hook capture process.
/// Errs on the side of capturing (true): a missing or corrupt preferences
/// file must never silently discard signals while hooks are still installed.
pub fn provenance_hooks_master_enabled_quick() -> bool {
    read_preferences()
        .map(|preferences| preferences.master_enabled)
        .unwrap_or(true)
}

/// Lock-free live-status probe for the short-lived hook capture process.
/// Same fail-open contract as the master probe: a missing/corrupt
/// preferences file must not silently drop status posts while lifecycle
/// hooks are still installed.
pub fn live_status_enabled_quick() -> bool {
    read_preferences()
        .map(|preferences| preferences.master_enabled && preferences.live_status_enabled)
        .unwrap_or(true)
}

/// Whether lifecycle (live-status) hook events are enabled.
#[tauri::command]
pub async fn session_provenance_live_status_enabled() -> Result<bool, String> {
    tokio::task::spawn_blocking(|| {
        let _guard = operation_guard()?;
        Ok::<_, String>(read_preferences()?.live_status_enabled)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

/// Flip the live-status switch: reinstalls every platform's managed hooks in
/// the matching shape (lifecycle events added or stripped; provenance
/// PostToolUse hooks stay either way). Returns refreshed per-platform
/// statuses.
#[tauri::command]
pub async fn session_provenance_set_live_status_enabled(
    enabled: bool,
) -> Result<Vec<SessionProvenanceHookStatus>, String> {
    tokio::task::spawn_blocking(move || {
        let _guard = operation_guard()?;
        let executable = std::env::current_exe()
            .map_err(|err| format!("Failed to locate ORG2 executable: {err}"))?;
        let mut preferences = read_preferences()?;
        preferences.live_status_enabled = enabled;
        write_preferences(&preferences)?;
        Ok::<_, String>(
            ALL_SESSION_PROVENANCE_HOOK_PLATFORMS
                .into_iter()
                .map(|platform| {
                    let update_error = update_platform(
                        platform,
                        preferences.effective_enabled(platform),
                        preferences.live_status_enabled,
                        &executable,
                    )
                    .err();
                    build_hook_status(platform, preferences.enabled(platform), update_error)
                })
                .collect::<Vec<_>>(),
        )
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

/// Whether the master switch over all managed provenance hooks is on.
#[tauri::command]
pub async fn session_provenance_hooks_master_enabled() -> Result<bool, String> {
    tokio::task::spawn_blocking(|| {
        let _guard = operation_guard()?;
        Ok::<_, String>(read_preferences()?.master_enabled)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

/// Flip the master switch over all managed provenance hooks. Per-platform
/// preferences are preserved: switching off uninstalls every managed hook,
/// switching back on reinstalls the platforms that were individually enabled.
/// Returns the refreshed per-platform statuses.
#[tauri::command]
pub async fn session_provenance_hooks_set_master_enabled(
    enabled: bool,
) -> Result<Vec<SessionProvenanceHookStatus>, String> {
    tokio::task::spawn_blocking(move || {
        let _guard = operation_guard()?;
        let executable = std::env::current_exe()
            .map_err(|err| format!("Failed to locate ORG2 executable: {err}"))?;
        let mut preferences = read_preferences()?;
        preferences.master_enabled = enabled;
        write_preferences(&preferences)?;
        Ok::<_, String>(
            ALL_SESSION_PROVENANCE_HOOK_PLATFORMS
                .into_iter()
                .map(|platform| {
                    let update_error = update_platform(
                        platform,
                        preferences.effective_enabled(platform),
                        preferences.live_status_enabled,
                        &executable,
                    )
                    .err();
                    build_hook_status(platform, preferences.enabled(platform), update_error)
                })
                .collect::<Vec<_>>(),
        )
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

//! Managed hook installation for session provenance.
//!
//! ORG2 owns only hook entries whose command includes [`HOOK_MARKER`]. User
//! hooks and unrelated configuration are preserved semantically when the JSON
//! is rewritten.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

const HOOK_MARKER: &str = "--session-provenance-hook";
const PREFERENCES_SCHEMA_VERSION: u32 = 1;
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
// Codex hook matchers use the public canonical tool names, not the internal
// transcript/runtime names (`exec`, `exec_command`, etc.). Keep this aligned
// with the official Hook matcher contract so Bash and apply_patch both fire.
const CODEX_POST_TOOL_USE_MATCHER: &str = "Bash|apply_patch|Edit|Write|mcp__.*";
const CLAUDE_CODE_POST_TOOL_USE_MATCHER: &str =
    "Read|Write|Edit|MultiEdit|NotebookEdit|Delete|Glob|Grep";
// With live status on, PostToolUse widens to every tool: non-file payloads
// yield zero provenance envelopes (no spool spam) but each one refreshes the
// session's `working` heartbeat, so a long tool run doesn't read as stalled.
// Exactly one managed PostToolUse group exists either way — the matcher is
// switched, never doubled (two groups would spawn two captures per file tool).
const CLAUDE_CODE_LIVE_STATUS_POST_TOOL_USE_MATCHER: &str = "*";
// Lifecycle (live-status) events for Claude Code, installed alongside the
// provenance PostToolUse hook when live status is enabled. Matcher-less
// events are turn boundaries; tool-scoped events carry `*` so every tool
// reports. Vocabulary mirrors the Claude Code hooks contract
// (UserPromptSubmit/Stop/StopFailure/PermissionRequest/PreToolUse/
// PostToolUseFailure) and maps in `orgtrack_core::status_adapter`.
const CLAUDE_CODE_LIFECYCLE_EVENTS: &[(&str, Option<&str>)] = &[
    ("UserPromptSubmit", None),
    ("Stop", None),
    ("StopFailure", None),
    ("PermissionRequest", Some("*")),
    ("PreToolUse", Some("*")),
    ("PostToolUseFailure", Some("*")),
];
// Every managed hook is observational and must return fast — except the
// Claude Code PermissionRequest entry, which long-polls the desktop for an
// interactive approval decision on managed Manual-mode sessions (see the
// app's `orgtrack::session_provenance::approval_gate`). Its config timeout
// must exceed the hook-side HTTP read timeout (130s), which itself exceeds
// the desktop's 120s park timeout, so Claude never kills the hook mid-wait.
const DEFAULT_HOOK_TIMEOUT_SECS: u64 = 5;
pub const CLAUDE_PERMISSION_REQUEST_HOOK_TIMEOUT_SECS: u64 = 300;
// Codex events required whenever provenance capture is enabled. SessionStart
// proves that Codex accepted and executed the current managed definitions;
// the subagent events preserve exact actor attribution.
const CODEX_REQUIRED_EVENTS: &[&str] = &["SessionStart", "SubagentStart", "SubagentStop"];
// Optional Codex lifecycle events (all matcher-less). SessionStart remains
// installed when live status is off because it also drives hook activation;
// PreToolUse is the per-tool working heartbeat when live status is on.
const CODEX_LIFECYCLE_EVENTS: &[&str] = &[
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "Stop",
];
// Cursor lifecycle events (flat camelCase arrays; Cursor has no
// waiting/permission vocabulary — Done comes from stop/sessionEnd).
// (event, needs `.*` matcher)
const CURSOR_LIFECYCLE_EVENTS: &[(&str, bool)] = &[
    ("beforeSubmitPrompt", false),
    ("stop", false),
    ("preToolUse", true),
    ("postToolUseFailure", true),
];
// Factory Droid emits Claude-Code-shaped lifecycle events.
const FACTORY_DROID_LIFECYCLE_EVENTS: &[(&str, Option<&str>)] = CLAUDE_CODE_LIFECYCLE_EVENTS;
// Antigravity lifecycle event arrays added to the owned hook group.
const ANTIGRAVITY_LIFECYCLE_EVENTS: &[&str] = &["PreInvocation", "PostInvocation", "Stop"];
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
// Qwen Code is a Gemini-family CLI: its file tools are snake_case
// (`write_file`, `replace`, `read_file`, …). Scope the managed PostToolUse
// hook to those so it does not spawn a capture process on every shell call.
const QWEN_CODE_POST_TOOL_USE_MATCHER: &str =
    "write_file|replace|read_file|read_many_files|glob|search_file_content";
// Factory Droid emits Claude-Code-shaped payloads with its own file verbs
// (`Create`, `Edit`, `ApplyPatch`).
const FACTORY_DROID_POST_TOOL_USE_MATCHER: &str =
    "Read|Write|Create|Edit|MultiEdit|ApplyPatch|Delete|Glob|Grep";
// Trae's tool names are its own (e.g. `RunCommand`) and its file-tool names are
// not publicly enumerated, so match all tools; the adapter drops non-file ones.
const TRAE_POST_TOOL_USE_MATCHER: &str = ".*";
// Antigravity uses the Claude-Code-style nested `PostToolUse` shape; its
// matcher convention is the literal `*` (see the on-disk `hooks.json`).
const ANTIGRAVITY_POST_TOOL_USE_MATCHER: &str = "*";
// Kimi's file tools (matched on the tool name).
const KIMI_POST_TOOL_USE_MATCHER: &str = "WriteFile|StrReplaceFile|ReadFile|Grep|Glob";
// The top-level group key ORGII owns inside Antigravity's `hooks.json` (a map of
// group-name -> event -> hooks). Owning a whole group keeps our install
// isolated from other tools' groups (e.g. `orca-status`).
const ANTIGRAVITY_HOOK_GROUP: &str = "orgii-session-provenance";
// ZCode bundles hooks inside plugins. ORGII ships a tiny managed plugin under
// its own filesystem marketplace so it never touches ZCode's official plugins.
// ZCode's tool names are not enumerated publicly; match all and let the adapter
// drop non-file tools.
const ZCODE_POST_TOOL_USE_MATCHER: &str = ".*";
const ZCODE_PLUGIN_MARKETPLACE: &str = "orgii";
const ZCODE_PLUGIN_NAME: &str = "session-provenance";
const ZCODE_PLUGIN_VERSION: &str = "0.1.0";
// The managed OpenCode plugin file. `__ORGII_BINARY__` is replaced with the
// JS-escaped absolute ORGII executable path at install time. The marker string
// (`HOOK_MARKER`) must appear so the installer can recognize its own file.
const OPENCODE_PLUGIN_TEMPLATE: &str = include_str!("session_provenance_opencode_plugin.js");
static HOOK_CONFIG_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

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
    fn source_arg(self) -> &'static str {
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

    fn config_path(self) -> PathBuf {
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

/// Root of ZCode's filesystem plugin store (`~/.zcode/cli/plugins`).
fn zcode_plugins_root() -> PathBuf {
    app_paths::home_dir()
        .join(".zcode")
        .join("cli")
        .join("plugins")
}

fn zcode_plugin_cache_dir() -> PathBuf {
    zcode_plugins_root()
        .join("cache")
        .join(ZCODE_PLUGIN_MARKETPLACE)
        .join(ZCODE_PLUGIN_NAME)
        .join(ZCODE_PLUGIN_VERSION)
}

fn zcode_plugin_hooks_path() -> PathBuf {
    zcode_plugin_cache_dir().join("hooks").join("hooks.json")
}

/// Empty marker directory whose presence enables the plugin.
fn zcode_plugin_data_dir() -> PathBuf {
    zcode_plugins_root()
        .join("data")
        .join(format!("{ZCODE_PLUGIN_NAME}@{ZCODE_PLUGIN_MARKETPLACE}"))
}

fn zcode_marketplace_dir() -> PathBuf {
    zcode_plugins_root()
        .join("marketplaces")
        .join(ZCODE_PLUGIN_MARKETPLACE)
}

/// Absolute path of the managed OpenCode plugin file
/// (`$XDG_CONFIG_HOME/opencode/plugin/orgii-session-provenance.js`, defaulting
/// to `~/.config`).
fn opencode_plugin_path() -> PathBuf {
    let config_home = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .unwrap_or_else(|| app_paths::home_dir().join(".config"));
    config_home
        .join("opencode")
        .join("plugin")
        .join("orgii-session-provenance.js")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
// No `deny_unknown_fields`: a newer build may add platform fields an older build
// doesn't recognize. Unknown fields are ignored (and missing ones fall back to
// `Default`) so backends of different versions can read each other's
// preferences file instead of hard-failing — a hard failure here would abort
// hook installation entirely and silently disable all capture.
#[serde(rename_all = "camelCase", default)]
struct HookPreferences {
    schema_version: u32,
    /// Master switch over every managed hook. When off, all platform hooks
    /// are uninstalled regardless of the per-platform flags below; those
    /// flags are preserved so switching back on restores the previous
    /// per-platform selection.
    master_enabled: bool,
    /// Whether lifecycle (live-status) events are installed alongside the
    /// provenance PostToolUse hooks and whether the capture subprocess posts
    /// normalized status events to the desktop's loopback endpoint. Off keeps
    /// provenance capture intact but removes the lifecycle event entries.
    live_status_enabled: bool,
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
    fn effective_enabled(&self, platform: SessionProvenanceHookPlatform) -> bool {
        self.master_enabled && self.enabled(platform)
    }

    fn enabled(&self, platform: SessionProvenanceHookPlatform) -> bool {
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

    fn set_enabled(&mut self, platform: SessionProvenanceHookPlatform, enabled: bool) {
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

fn preferences_path() -> PathBuf {
    app_paths::orgii_root()
        .join("session-provenance")
        .join("hooks.json")
}

fn activation_receipt_path(platform: SessionProvenanceHookPlatform) -> PathBuf {
    app_paths::orgii_root()
        .join("session-provenance")
        .join("activations")
        .join(format!("{}.json", platform.source_arg()))
}

fn operation_guard() -> Result<MutexGuard<'static, ()>, String> {
    HOOK_CONFIG_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "Session-provenance hook config lock is poisoned".to_string())
}

fn read_preferences() -> Result<HookPreferences, String> {
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

fn write_preferences(preferences: &HookPreferences) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(preferences)
        .map_err(|err| format!("Failed to serialize hook preferences: {err}"))?;
    write_atomic(&preferences_path(), &bytes)
}

fn read_config(path: &Path) -> Result<Value, String> {
    if !path.exists() {
        return Ok(Value::Object(Map::new()));
    }
    let bytes =
        std::fs::read(path).map_err(|err| format!("Failed to read {}: {err}", path.display()))?;
    serde_json::from_slice(&bytes)
        .map_err(|err| format!("Invalid JSON in {}: {err}", path.display()))
}

fn write_config(path: &Path, config: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(config)
        .map_err(|err| format!("Failed to serialize {}: {err}", path.display()))?;
    write_atomic(path, &bytes)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
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

fn hook_commands(executable: &Path, source: &str) -> (String, String) {
    let raw = executable.to_string_lossy();
    let unix_path = format!("'{}'", raw.replace('\'', "'\\''"));
    let windows_path = format!("\"{}\"", raw.replace('"', "\\\""));
    (
        format!("{unix_path} {HOOK_MARKER} {source}"),
        format!("{windows_path} {HOOK_MARKER} {source}"),
    )
}

fn command_contains_marker(value: &Value) -> bool {
    value
        .get("command")
        .and_then(Value::as_str)
        .is_some_and(|command| command.contains(HOOK_MARKER))
        || value
            .get("commandWindows")
            .and_then(Value::as_str)
            .is_some_and(|command| command.contains(HOOK_MARKER))
}

fn command_is_managed_for_platform(value: &Value, platform: SessionProvenanceHookPlatform) -> bool {
    let expected = format!("{HOOK_MARKER} {}", platform.source_arg());
    ["command", "commandWindows"].into_iter().any(|field| {
        value
            .get(field)
            .and_then(Value::as_str)
            .is_some_and(|command| command.trim_end().ends_with(&expected))
    })
}

fn hooks_object_mut(config: &mut Value) -> Result<&mut Map<String, Value>, String> {
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

fn update_nested_platform(
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

/// Install (or remove, when `install` is false) the Claude Code lifecycle
/// events. Always iterates the full list so flipping live status off strips
/// previously-installed entries instead of leaving them behind.
fn update_claude_lifecycle_events(
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

fn update_nested_event(
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
fn update_nested_event_with_timeout(
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

fn update_codex_platform(
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

fn update_cursor_platform(
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

/// Trae uses a standalone `hooks.json` with a top-level `version` plus the
/// Claude-Code-style nested `hooks.PostToolUse[]` shape — but a single
/// `command` string per hook (no `commandWindows`). The caller passes the
/// platform-appropriate command.
fn update_trae_platform(
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

/// Escape a filesystem path for embedding inside a JS double-quoted string
/// literal (backslashes and quotes). Windows paths carry backslashes.
fn js_escaped_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
}

/// True only if `path` is our managed OpenCode plugin (contains [`HOOK_MARKER`]),
/// so uninstall never deletes a user-authored plugin that happens to share the
/// filename.
fn opencode_plugin_is_managed(path: &Path) -> bool {
    std::fs::read_to_string(path)
        .map(|contents| contents.contains(HOOK_MARKER))
        .unwrap_or(false)
}

/// Install/remove the managed OpenCode plugin file. OpenCode has no JSON hook
/// config; capture is a JS plugin that pipes provenance JSON to this binary.
fn update_opencode_plugin(enabled: bool, executable: &Path) -> Result<(), String> {
    let path = opencode_plugin_path();
    if !enabled {
        if opencode_plugin_is_managed(&path) {
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                Err(err) => {
                    return Err(format!("Failed to remove {}: {err}", path.display()));
                }
            }
        }
        return Ok(());
    }
    let contents = OPENCODE_PLUGIN_TEMPLATE.replace("__ORGII_BINARY__", &js_escaped_path(executable));
    write_atomic(&path, contents.as_bytes())
}

/// Windsurf keys hooks by event name (no matcher); each hook is a flat
/// `{command, powershell, show_output}` object. We install into the
/// file-touch events only.
fn update_windsurf_platform(
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

fn windsurf_event_has_managed_hook(config: &Value, event_name: &str) -> bool {
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

/// Antigravity's `hooks.json` is a map of group-name -> event -> hooks. ORGII
/// owns one whole named group so its install never entangles with other tools'
/// groups (e.g. `orca-status`).
fn update_antigravity_platform(
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

fn antigravity_has_managed_hook(config: &Value) -> bool {
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

/// True if the user's Kimi `config.toml` already carries our managed `[[hooks]]`
/// entry (command contains [`HOOK_MARKER`]).
fn kimi_config_is_managed(path: &Path) -> bool {
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
fn kimi_apply_managed_hook(
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
        hooks.push(managed_entry("PostToolUse", Some(KIMI_POST_TOOL_USE_MATCHER)));
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
fn update_kimi_platform(enabled: bool, live_status: bool, executable: &Path) -> Result<(), String> {
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

/// The Claude-Code-style `hooks/hooks.json` body for ORGII's ZCode plugin.
fn zcode_hooks_value(command: &str) -> Value {
    json!({
        "hooks": {
            "PostToolUse": [{
                "matcher": ZCODE_POST_TOOL_USE_MATCHER,
                "hooks": [{ "type": "command", "command": command, "timeout": 5 }]
            }]
        }
    })
}

/// ZCode's installed-plugin registry: `~/.zcode/cli/plugins/installed_plugins.json`.
///
/// ZCode discovers installed plugins from this registry, not by scanning the
/// cache tree. A plugin absent from here is invisible to ZCode even when its
/// cache/marketplace/data files are all on disk, so the startup log reports
/// `pluginCount` without it and `hookCount: 0`. Entries are keyed by plugin id
/// (`<name>@<marketplace>`).
fn zcode_installed_plugins_path() -> PathBuf {
    zcode_plugins_root().join("installed_plugins.json")
}

/// Register (or update) our plugin in ZCode's `installed_plugins.json`, writing
/// `plugins["session-provenance@orgii"]` with the install path and version.
/// Other plugins' entries are preserved.
fn zcode_set_plugin_installed(cache_path: &Path) -> Result<(), String> {
    let path = zcode_installed_plugins_path();
    let mut config = read_config(&path)?;
    zcode_add_plugin_to_registry(&mut config, cache_path);
    write_atomic(
        &path,
        &serde_json::to_vec_pretty(&config)
            .map_err(|err| format!("Failed to serialize installed_plugins.json: {err}"))?,
    )
}

/// Pure transform: add/replace our plugin's registry entry in a config value.
fn zcode_add_plugin_to_registry(config: &mut Value, cache_path: &Path) {
    let root = match config.as_object_mut() {
        Some(root) => root,
        None => {
            tracing::warn!(
                "[SessionProvenance] installed_plugins.json root is not an object; skipping registry write"
            );
            return;
        }
    };
    if root.get("version").is_none() {
        root.insert("version".to_string(), json!(1));
    }
    let plugins = root
        .entry("plugins".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if let Some(map) = plugins.as_object_mut() {
        map.insert(
            zcode_plugin_id().to_string(),
            json!({
                "installPath": cache_path.to_string_lossy(),
                "version": ZCODE_PLUGIN_VERSION,
                "installedAt": chrono::Utc::now()
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                "scope": "user",
            }),
        );
    }
}

/// Pure check: does this registry value contain our plugin?
fn zcode_registry_has_plugin(config: &Value) -> bool {
    config
        .get("plugins")
        .and_then(|plugins| plugins.get(zcode_plugin_id()))
        .is_some()
}

/// Pure transform: remove our plugin's entry from a registry value.
fn zcode_remove_plugin_from_registry_value(config: &mut Value) {
    if let Some(map) = config
        .get_mut("plugins")
        .and_then(Value::as_object_mut)
    {
        map.remove(zcode_plugin_id());
    }
}

/// Remove our plugin from ZCode's `installed_plugins.json`. Other entries and
/// the file itself are left untouched.
fn zcode_remove_plugin_from_registry() -> Result<(), String> {
    let path = zcode_installed_plugins_path();
    if !path.exists() {
        return Ok(());
    }
    let mut config = read_config(&path)?;
    let removed = zcode_registry_has_plugin(&config);
    if removed {
        zcode_remove_plugin_from_registry_value(&mut config);
        write_atomic(
            &path,
            &serde_json::to_vec_pretty(&config)
                .map_err(|err| format!("Failed to serialize installed_plugins.json: {err}"))?,
        )?;
    }
    Ok(())
}

/// ZCode's user config file: `~/.zcode/cli/config.json`.
///
/// ZCode persists per-plugin enablement here under
/// `plugins.enabledPlugins[<id>]`. A plugin is only active when its id maps to
/// `true`; the default is `false`, so installing the cache/marketplace/data
/// files alone is not enough — the config entry must be set too.
fn zcode_config_path() -> PathBuf {
    app_paths::home_dir()
        .join(".zcode")
        .join("cli")
        .join("config.json")
}

/// The plugin id ZCode uses for our managed plugin: `<name>@<marketplace>`.
const fn zcode_plugin_id() -> &'static str {
    // `format!` is not const, so inline the two known constants.
    // Keep in sync with ZCODE_PLUGIN_NAME and ZCODE_PLUGIN_MARKETPLACE.
    "session-provenance@orgii"
}

/// Read ZCode's `config.json`, returning an empty object when missing or
/// unparseable (mirrors ZCode's own tolerant `readJsonConfigFileOrEmpty`).
fn read_zcode_config() -> Value {
    let path = zcode_config_path();
    read_config(&path).unwrap_or_else(|err| {
        tracing::warn!(
            path = %path.display(),
            error = %err,
            "[SessionProvenance] Failed to read ZCode config.json; treating as empty"
        );
        Value::Object(Map::new())
    })
}

/// True if ZCode's config.json marks our plugin as enabled.
fn zcode_plugin_is_enabled_in_config() -> bool {
    zcode_plugin_is_enabled_in(&read_zcode_config())
}

/// Pure check: does this ZCode config value mark our plugin enabled?
fn zcode_plugin_is_enabled_in(config: &Value) -> bool {
    config
        .get("plugins")
        .and_then(|plugins| plugins.get("enabledPlugins"))
        .and_then(|map| map.get(zcode_plugin_id()))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// Set our plugin's enablement in ZCode's `config.json`.
///
/// Writes `plugins.enabledPlugins["session-provenance@orgii"] = enabled` with an
/// atomic temp+rename, preserving every other key the user may have. Creates the
/// file (and its parent) when it does not yet exist.
fn zcode_set_plugin_enabled(enabled: bool) -> Result<(), String> {
    zcode_set_plugin_enabled_at(&zcode_config_path(), enabled)
}

/// Path-based core of [`zcode_set_plugin_enabled`], separated so it can be tested
/// without mutating the process-global `HOME`.
fn zcode_set_plugin_enabled_at(path: &Path, enabled: bool) -> Result<(), String> {
    let mut config = read_config(path)?;
    set_plugin_enabled_in_config(&mut config, enabled)?;
    let bytes = serde_json::to_vec_pretty(&config)
        .map_err(|err| format!("Failed to serialize ZCode config.json: {err}"))?;
    write_atomic(path, &bytes)
}

/// Pure transform: set our plugin's enablement flag in a ZCode config value.
fn set_plugin_enabled_in_config(config: &mut Value, enabled: bool) -> Result<(), String> {
    let root = config
        .as_object_mut()
        .ok_or_else(|| "ZCode config.json root must be a JSON object".to_string())?;
    let plugins = root
        .entry("plugins".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let enabled_plugins = plugins
        .as_object_mut()
        .ok_or_else(|| "ZCode config.json `plugins` must be a JSON object".to_string())?
        .entry("enabledPlugins".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    enabled_plugins
        .as_object_mut()
        .ok_or_else(|| "ZCode config.json `enabledPlugins` must be a JSON object".to_string())?
        .insert(zcode_plugin_id().to_string(), Value::Bool(enabled));
    Ok(())
}

/// True if our plugin is registered in ZCode's `installed_plugins.json`.
fn zcode_plugin_is_in_registry() -> bool {
    read_config(&zcode_installed_plugins_path())
        .map(|config| {
            config
                .get("plugins")
                .and_then(|plugins| plugins.get(zcode_plugin_id()))
                .is_some()
        })
        .unwrap_or(false)
}

/// True if ORGII's managed ZCode plugin is installed AND enabled. ZCode only
/// resolves a plugin when it is in `installed_plugins.json`, and only loads its
/// hooks when it is marked enabled in `config.json` — so all three conditions
/// must hold for capture to fire.
fn zcode_plugin_is_managed() -> bool {
    zcode_plugin_data_dir().is_dir()
        && std::fs::read_to_string(zcode_plugin_hooks_path())
            .map(|contents| contents.contains(HOOK_MARKER))
            .unwrap_or(false)
        && zcode_plugin_is_in_registry()
        && zcode_plugin_is_enabled_in_config()
}

/// Install/remove ORGII's managed ZCode plugin. ZCode resolves plugins from the
/// filesystem (`~/.zcode/cli/plugins`) at startup, so a self-contained plugin
/// under ORGII's own `orgii` marketplace (manifest + `hooks/hooks.json` + an
/// empty `data/<plugin>@<marketplace>` activation dir) is discovered without
/// touching ZCode's official plugin files.
fn update_zcode_plugin(enabled: bool, executable: &Path) -> Result<(), String> {
    let cache_dir = zcode_plugin_cache_dir();
    let data_dir = zcode_plugin_data_dir();
    let marketplace_dir = zcode_marketplace_dir();
    if !enabled {
        // Only ever remove ORGII's own `orgii` marketplace tree.
        for dir in [
            data_dir,
            zcode_plugins_root()
                .join("cache")
                .join(ZCODE_PLUGIN_MARKETPLACE),
            marketplace_dir,
        ] {
            match std::fs::remove_dir_all(&dir) {
                Ok(()) => {}
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                Err(err) => return Err(format!("Failed to remove {}: {err}", dir.display())),
            }
        }
        // Clear the enablement entry so ZCode stops loading our hooks. Ignore a
        // missing config.json — there is nothing to clean in that case.
        if zcode_config_path().exists() {
            zcode_set_plugin_enabled(false)?;
        }
        // Remove our entry from the installed-plugin registry so ZCode no longer
        // discovers the plugin at all.
        zcode_remove_plugin_from_registry()?;
        return Ok(());
    }
    let (unix_command, windows_command) = hook_commands(executable, "zcode");
    let command = if cfg!(windows) {
        &windows_command
    } else {
        &unix_command
    };
    write_config(
        &cache_dir.join(".zcode-plugin").join("plugin.json"),
        &json!({
            "name": ZCODE_PLUGIN_NAME,
            "version": ZCODE_PLUGIN_VERSION,
            "description": "ORGII session provenance — records file-interaction metadata via a managed hook. Prompts, tool output, and file contents are not stored.",
            "author": { "name": "ORGII" },
            "license": "MIT"
        }),
    )?;
    write_config(&zcode_plugin_hooks_path(), &zcode_hooks_value(command))?;
    write_config(
        &marketplace_dir.join("marketplace.json"),
        &json!({
            "name": ZCODE_PLUGIN_MARKETPLACE,
            "version": 1,
            "plugins": [{
                "cachePath": cache_dir.to_string_lossy(),
                "name": ZCODE_PLUGIN_NAME,
                "source": "filesystem",
                "version": ZCODE_PLUGIN_VERSION
            }]
        }),
    )?;
    std::fs::create_dir_all(&data_dir)
        .map_err(|err| format!("Failed to create {}: {err}", data_dir.display()))?;
    // ZCode discovers installed plugins from a registry
    // (`installed_plugins.json`), not by scanning the cache tree. Without an
    // entry here the plugin is invisible to ZCode even though all its files are
    // on disk, so the startup log shows hookCount: 0.
    zcode_set_plugin_installed(&cache_dir)?;
    // ZCode only loads hooks from plugins marked enabled in config.json; the
    // cache/marketplace/data files above make it discoverable, this entry makes
    // it active. Without it the startup log shows hookCount: 0.
    zcode_set_plugin_enabled(true)?;
    Ok(())
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
    write_config(&path, &config)
}

fn nested_event_has_managed_hook(
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
fn nested_event_managed_hook_has_timeout(
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

fn cursor_event_has_managed_hook(config: &Value, event_name: &str, matcher: Option<&str>) -> bool {
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
                    || CURSOR_LIFECYCLE_EVENTS.iter().all(|(event_name, needs_matcher)| {
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
        &config, platform, live_status,
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
/// A matching receipt is the only state that upgrades the UI from
/// `awaiting_verification` to `active`.
pub fn record_session_provenance_hook_activation(source: &str) -> Result<bool, String> {
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
    if read_activation_receipt(platform)
        .is_some_and(|receipt| receipt.hook_fingerprint == fingerprint)
    {
        return Ok(false);
    }
    let receipt = HookActivationReceipt {
        schema_version: ACTIVATION_RECEIPT_SCHEMA_VERSION,
        platform,
        hook_fingerprint: fingerprint,
        activated_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    };
    let bytes = serde_json::to_vec_pretty(&receipt)
        .map_err(|err| format!("Failed to serialize hook activation receipt: {err}"))?;
    write_atomic(&activation_receipt_path(platform), &bytes)?;
    Ok(true)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nested_config_preserves_user_hooks_and_removes_only_ours() {
        let mut config = json!({
            "hooks": {"PostToolUse": [{
                "matcher": "Read",
                "hooks": [{"type": "command", "command": "user-hook"}]
            }]},
            "theme": "dark"
        });
        update_nested_platform(
            &mut config,
            true,
            "Read",
            "orgii --session-provenance-hook claude",
            "orgii.exe --session-provenance-hook claude",
        )
        .expect("enable nested hook");
        update_nested_platform(&mut config, false, "Read", "unused", "unused")
            .expect("disable nested hook");
        assert_eq!(config["theme"], "dark");
        assert_eq!(
            config["hooks"]["PostToolUse"][0]["hooks"][0]["command"],
            "user-hook"
        );
        assert!(!config.to_string().contains(HOOK_MARKER));
    }

    #[test]
    fn claude_lifecycle_events_install_and_remove_symmetrically() {
        let mut config = json!({
            "hooks": {"Stop": [{
                "hooks": [{"type": "command", "command": "user-stop-hook"}]
            }]},
            "theme": "dark"
        });
        let unix = "orgii --session-provenance-hook claude";
        let windows = "orgii.exe --session-provenance-hook claude";
        update_claude_lifecycle_events(&mut config, true, unix, windows)
            .expect("install lifecycle events");
        for (event_name, matcher) in CLAUDE_CODE_LIFECYCLE_EVENTS {
            assert!(
                nested_event_has_managed_hook(
                    &config,
                    SessionProvenanceHookPlatform::ClaudeCode,
                    event_name,
                    *matcher
                ),
                "missing managed {event_name}"
            );
        }
        // Completeness follows the live-status shape once PostToolUse widens.
        update_nested_platform(
            &mut config,
            true,
            CLAUDE_CODE_LIVE_STATUS_POST_TOOL_USE_MATCHER,
            unix,
            windows,
        )
        .expect("install live-status PostToolUse");
        assert!(config_has_complete_managed_hooks(
            &config,
            SessionProvenanceHookPlatform::ClaudeCode,
            true
        ));
        // Legacy shape (file matcher only) is NOT complete under live status.
        assert!(!config_has_complete_managed_hooks(
            &json!({"hooks": {"PostToolUse": [{
                "matcher": CLAUDE_CODE_POST_TOOL_USE_MATCHER,
                "hooks": [{"type": "command", "command": unix}]
            }]}}),
            SessionProvenanceHookPlatform::ClaudeCode,
            true
        ));

        update_claude_lifecycle_events(&mut config, false, "unused", "unused")
            .expect("remove lifecycle events");
        // The user's own Stop hook survives; every managed lifecycle entry is
        // gone (PostToolUse keeps the managed provenance hook).
        assert_eq!(
            config["hooks"]["Stop"][0]["hooks"][0]["command"],
            "user-stop-hook"
        );
        for (event_name, matcher) in CLAUDE_CODE_LIFECYCLE_EVENTS {
            assert!(
                !nested_event_has_managed_hook(
                    &config,
                    SessionProvenanceHookPlatform::ClaudeCode,
                    event_name,
                    *matcher
                ),
                "managed {event_name} not removed"
            );
        }
        assert_eq!(config["theme"], "dark");
    }

    #[test]
    fn claude_permission_request_hook_gets_blocking_timeout_and_stale_installs_repair() {
        let unix = "orgii --session-provenance-hook claude";
        let windows = "orgii.exe --session-provenance-hook claude";
        let mut config = json!({});
        update_claude_lifecycle_events(&mut config, true, unix, windows)
            .expect("install lifecycle events");
        update_nested_platform(
            &mut config,
            true,
            CLAUDE_CODE_LIVE_STATUS_POST_TOOL_USE_MATCHER,
            unix,
            windows,
        )
        .expect("install live-status PostToolUse");

        // Only the PermissionRequest entry carries the raised long-poll
        // timeout; every other lifecycle event keeps the fast default.
        for (event_name, _) in CLAUDE_CODE_LIFECYCLE_EVENTS {
            let expected = if *event_name == "PermissionRequest" {
                CLAUDE_PERMISSION_REQUEST_HOOK_TIMEOUT_SECS
            } else {
                DEFAULT_HOOK_TIMEOUT_SECS
            };
            let timeout = config["hooks"][*event_name][0]["hooks"][0]["timeout"]
                .as_u64()
                .unwrap_or_else(|| panic!("missing timeout on {event_name}"));
            assert_eq!(timeout, expected, "wrong timeout on {event_name}");
        }
        assert!(config_has_complete_managed_hooks(
            &config,
            SessionProvenanceHookPlatform::ClaudeCode,
            true
        ));

        // A pre-approval-bridge install (PermissionRequest at the old 5s
        // timeout) is incomplete under live status, so startup reconcile
        // rewrites it with the raised timeout.
        config["hooks"]["PermissionRequest"][0]["hooks"][0]["timeout"] = json!(5);
        assert!(!config_has_complete_managed_hooks(
            &config,
            SessionProvenanceHookPlatform::ClaudeCode,
            true
        ));
        update_claude_lifecycle_events(&mut config, true, unix, windows)
            .expect("repair lifecycle events");
        assert!(config_has_complete_managed_hooks(
            &config,
            SessionProvenanceHookPlatform::ClaudeCode,
            true
        ));
    }

    #[test]
    fn claude_completeness_uses_legacy_shape_when_live_status_off() {
        let unix = "orgii --session-provenance-hook claude";
        let legacy = json!({"hooks": {"PostToolUse": [{
            "matcher": CLAUDE_CODE_POST_TOOL_USE_MATCHER,
            "hooks": [{"type": "command", "command": unix}]
        }]}});
        assert!(config_has_complete_managed_hooks(
            &legacy,
            SessionProvenanceHookPlatform::ClaudeCode,
            false
        ));
        assert!(!config_has_complete_managed_hooks(
            &legacy,
            SessionProvenanceHookPlatform::ClaudeCode,
            true
        ));
    }

    #[test]
    fn codex_matcher_uses_public_hook_tool_names() {
        assert!(CODEX_POST_TOOL_USE_MATCHER.contains("Bash"));
        assert!(CODEX_POST_TOOL_USE_MATCHER.contains("apply_patch"));
        assert!(!CODEX_POST_TOOL_USE_MATCHER.contains("exec_command"));
    }

    #[test]
    fn codex_config_installs_and_removes_required_hooks() {
        let mut config = json!({
            "hooks": {
                "SubagentStop": [{
                    "matcher": "explorer",
                    "hooks": [{"type": "command", "command": "user-hook"}]
                }]
            }
        });
        update_codex_platform(
            &mut config,
            true,
            false,
            "orgii --session-provenance-hook codex",
            "orgii.exe --session-provenance-hook codex",
        )
        .expect("enable Codex hooks");

        assert_eq!(config["hooks"]["PostToolUse"].as_array().unwrap().len(), 1);
        assert_eq!(config["hooks"]["SessionStart"].as_array().unwrap().len(), 1);
        assert_eq!(
            config["hooks"]["SubagentStart"].as_array().unwrap().len(),
            1
        );
        assert_eq!(config["hooks"]["SubagentStop"].as_array().unwrap().len(), 2);
        assert!(config_has_complete_managed_hooks(
            &config,
            SessionProvenanceHookPlatform::Codex,
            false
        ));

        config["hooks"]["SessionStart"] = json!([]);
        assert!(!config_has_complete_managed_hooks(
            &config,
            SessionProvenanceHookPlatform::Codex,
            false
        ));

        update_codex_platform(
            &mut config,
            true,
            false,
            "orgii --session-provenance-hook codex",
            "orgii.exe --session-provenance-hook codex",
        )
        .expect("repair incomplete Codex hooks");

        update_codex_platform(&mut config, false, false, "unused", "unused")
            .expect("disable Codex hooks");
        assert!(config.to_string().contains("user-hook"));
        assert!(!config.to_string().contains(HOOK_MARKER));
    }

    #[test]
    fn codex_fingerprint_tracks_only_managed_definition_changes() {
        let mut config = json!({
            "hooks": {
                "PostToolUse": [{
                    "matcher": "Read",
                    "hooks": [{"type": "command", "command": "user-hook"}]
                }]
            },
            "theme": "dark"
        });
        update_codex_platform(
            &mut config,
            true,
            false,
            "orgii --session-provenance-hook codex",
            "orgii.exe --session-provenance-hook codex",
        )
        .expect("enable Codex hooks");
        let original = managed_hook_fingerprint(&config, SessionProvenanceHookPlatform::Codex)
            .expect("managed fingerprint");

        config["hooks"]["PostToolUse"]
            .as_array_mut()
            .unwrap()
            .push(json!({
                "matcher": "Write",
                "hooks": [{"type": "command", "command": "another-user-hook"}]
            }));
        config["theme"] = json!("light");
        assert_eq!(
            managed_hook_fingerprint(&config, SessionProvenanceHookPlatform::Codex),
            Some(original.clone()),
            "unrelated user configuration must not invalidate approval"
        );

        let managed_group = config["hooks"]["PostToolUse"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|group| group.to_string().contains(HOOK_MARKER))
            .expect("managed PostToolUse group");
        managed_group["matcher"] = json!("apply_patch");
        assert_ne!(
            managed_hook_fingerprint(&config, SessionProvenanceHookPlatform::Codex),
            Some(original),
            "a managed matcher change requires fresh approval"
        );
    }

    #[test]
    fn codex_activation_requires_a_matching_receipt() {
        let receipt = HookActivationReceipt {
            schema_version: ACTIVATION_RECEIPT_SCHEMA_VERSION,
            platform: SessionProvenanceHookPlatform::Codex,
            hook_fingerprint: "current".to_string(),
            activated_at: "2026-07-15T12:00:00.000Z".to_string(),
        };
        assert_eq!(
            codex_activation_from_receipt("current", None),
            (
                SessionProvenanceHookActivationState::AwaitingVerification,
                None
            )
        );
        assert_eq!(
            codex_activation_from_receipt("stale", Some(receipt.clone())),
            (
                SessionProvenanceHookActivationState::AwaitingVerification,
                None
            )
        );
        assert_eq!(
            codex_activation_from_receipt("current", Some(receipt)),
            (
                SessionProvenanceHookActivationState::Active,
                Some("2026-07-15T12:00:00.000Z".to_string())
            )
        );
    }

    #[test]
    fn activation_state_is_immediate_for_providers_without_a_trust_gate() {
        assert_eq!(
            activation_for_installed_hook(SessionProvenanceHookPlatform::ClaudeCode, true)
                .expect("Claude activation"),
            (SessionProvenanceHookActivationState::Active, None)
        );
        assert_eq!(
            activation_for_installed_hook(SessionProvenanceHookPlatform::Codex, false)
                .expect("inactive Codex"),
            (SessionProvenanceHookActivationState::Inactive, None)
        );
    }

    #[test]
    fn cursor_config_preserves_user_events() {
        let mut config = json!({
            "version": 1,
            "hooks": {"postToolUse": [{"command": "user-hook"}]}
        });
        update_cursor_platform(&mut config, true, false, "orgii --session-provenance-hook cursor")
            .expect("enable Cursor hook");
        assert_eq!(config["hooks"]["postToolUse"].as_array().unwrap().len(), 2);
        assert_eq!(
            config["hooks"]["subagentStart"].as_array().unwrap().len(),
            1
        );
        assert_eq!(config["hooks"]["subagentStop"].as_array().unwrap().len(), 1);
        assert!(config_has_complete_managed_hooks(
            &config,
            SessionProvenanceHookPlatform::Cursor,
            false
        ));
        update_cursor_platform(&mut config, false, false, "unused").expect("disable Cursor hook");
        assert_eq!(config["hooks"]["postToolUse"].as_array().unwrap().len(), 1);
        assert!(config["hooks"]["subagentStart"]
            .as_array()
            .unwrap()
            .is_empty());
        assert!(config["hooks"]["subagentStop"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn qwen_config_installs_scoped_post_tool_use_and_preserves_user_hooks() {
        let mut config = json!({
            "hooks": {"PostToolUse": [{
                "matcher": "read_file",
                "hooks": [{"type": "command", "command": "user-hook"}]
            }]},
            "theme": "dark"
        });
        update_nested_platform(
            &mut config,
            true,
            QWEN_CODE_POST_TOOL_USE_MATCHER,
            "orgii --session-provenance-hook qwen",
            "orgii.exe --session-provenance-hook qwen",
        )
        .expect("enable Qwen hook");
        assert_eq!(config["theme"], "dark");
        assert!(config_has_complete_managed_hooks(
            &config,
            SessionProvenanceHookPlatform::QwenCode,
            false
        ));
        // The managed matcher is Qwen-specific, not the Claude Code one.
        assert!(!config_has_complete_managed_hooks(
            &config,
            SessionProvenanceHookPlatform::ClaudeCode,
            false
        ));
        update_nested_platform(&mut config, false, QWEN_CODE_POST_TOOL_USE_MATCHER, "x", "x")
            .expect("disable Qwen hook");
        assert!(config.to_string().contains("user-hook"));
        assert!(!config.to_string().contains(HOOK_MARKER));
    }

    #[test]
    fn factory_droid_config_installs_and_removes_only_our_hook() {
        let mut config = json!({});
        update_nested_platform(
            &mut config,
            true,
            FACTORY_DROID_POST_TOOL_USE_MATCHER,
            "orgii --session-provenance-hook droid",
            "orgii.exe --session-provenance-hook droid",
        )
        .expect("enable Droid hook");
        assert!(config_has_complete_managed_hooks(
            &config,
            SessionProvenanceHookPlatform::FactoryDroid,
            false
        ));
        assert!(config.to_string().contains(HOOK_MARKER));
        update_nested_platform(
            &mut config,
            false,
            FACTORY_DROID_POST_TOOL_USE_MATCHER,
            "x",
            "x",
        )
        .expect("disable Droid hook");
        assert!(!config.to_string().contains(HOOK_MARKER));
    }

    #[test]
    fn trae_config_installs_versioned_single_command_hook_and_preserves_user_hooks() {
        let mut config = json!({
            "version": 1,
            "hooks": {"PostToolUse": [{
                "matcher": "RunCommand",
                "hooks": [{"type": "command", "command": "user-hook"}]
            }]}
        });
        update_trae_platform(&mut config, true, "orgii --session-provenance-hook trae")
            .expect("enable Trae hook");
        assert_eq!(config["version"], 1);
        assert!(config_has_complete_managed_hooks(
            &config,
            SessionProvenanceHookPlatform::Trae,
            false
        ));
        // Trae uses a single `command` field — never `commandWindows`.
        let ours = config["hooks"]["PostToolUse"]
            .as_array()
            .unwrap()
            .iter()
            .find(|group| {
                group["hooks"][0]["command"]
                    .as_str()
                    .is_some_and(|command| command.contains(HOOK_MARKER))
            })
            .expect("managed Trae group");
        assert!(ours["hooks"][0].get("commandWindows").is_none());
        update_trae_platform(&mut config, false, "x").expect("disable Trae hook");
        assert!(config.to_string().contains("user-hook"));
        assert!(!config.to_string().contains(HOOK_MARKER));
    }

    #[test]
    fn windsurf_config_installs_event_keyed_hooks_and_preserves_user_hooks() {
        let mut config = json!({
            "hooks": {"post_write_code": [{"command": "user-hook"}]}
        });
        update_windsurf_platform(
            &mut config,
            true,
            "orgii --session-provenance-hook windsurf",
            "orgii.exe --session-provenance-hook windsurf",
        )
        .expect("enable Windsurf hook");
        // User hook preserved; our hook added to both file events.
        assert_eq!(
            config["hooks"]["post_write_code"].as_array().unwrap().len(),
            2
        );
        assert_eq!(
            config["hooks"]["post_read_code"].as_array().unwrap().len(),
            1
        );
        assert!(config_has_complete_managed_hooks(
            &config,
            SessionProvenanceHookPlatform::Windsurf,
            false
        ));
        update_windsurf_platform(&mut config, false, "x", "x").expect("disable Windsurf hook");
        assert_eq!(
            config["hooks"]["post_write_code"].as_array().unwrap().len(),
            1
        );
        assert!(config.to_string().contains("user-hook"));
        assert!(!config.to_string().contains(HOOK_MARKER));
    }

    #[test]
    fn antigravity_config_installs_own_group_and_preserves_others() {
        let mut config = json!({
            "orca-status": {
                "PostToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "orca-hook" }] }]
            }
        });
        update_antigravity_platform(
            &mut config,
            true,
            false,
            "orgii --session-provenance-hook antigravity",
        )
        .expect("enable Antigravity hook");
        // Foreign group untouched; our group present.
        assert!(config.get("orca-status").is_some());
        assert!(antigravity_has_managed_hook(&config));
        assert!(config_has_complete_managed_hooks(
            &config,
            SessionProvenanceHookPlatform::Antigravity,
            false
        ));
        update_antigravity_platform(&mut config, false, false, "x")
            .expect("disable Antigravity hook");
        assert!(config.get(ANTIGRAVITY_HOOK_GROUP).is_none());
        assert!(config.get("orca-status").is_some());
        assert!(!config.to_string().contains(HOOK_MARKER));
    }

    #[test]
    fn kimi_toml_install_preserves_user_hooks_and_removes_only_ours() {
        let mut root: toml::Value = toml::from_str(
            "model = \"kimi-k2\"\n\n[[hooks]]\nevent = \"Stop\"\ncommand = \"user-hook\"\n",
        )
        .expect("parse base config");
        kimi_apply_managed_hook(&mut root, true, false, "orgii --session-provenance-hook kimi")
            .expect("enable Kimi hook");
        let serialized = toml::to_string_pretty(&root).expect("serialize");
        assert!(serialized.contains("model = \"kimi-k2\""));
        assert!(serialized.contains("user-hook"));
        assert!(serialized.contains(HOOK_MARKER));
        assert!(serialized.contains("StrReplaceFile"));

        kimi_apply_managed_hook(&mut root, false, false, "unused").expect("disable Kimi hook");
        let serialized = toml::to_string_pretty(&root).expect("serialize");
        assert!(serialized.contains("user-hook"));
        assert!(!serialized.contains(HOOK_MARKER));
    }

    #[test]
    fn kimi_managed_detection_reads_the_toml_hooks_array() {
        let temp = tempfile::tempdir().expect("temp dir");
        let path = temp.path().join("config.toml");
        std::fs::write(
            &path,
            format!("[[hooks]]\nevent = \"PostToolUse\"\ncommand = \"orgii {HOOK_MARKER} kimi\"\n"),
        )
        .expect("write managed config");
        assert!(kimi_config_is_managed(&path));

        std::fs::write(&path, "[[hooks]]\nevent = \"Stop\"\ncommand = \"other\"\n")
            .expect("write user config");
        assert!(!kimi_config_is_managed(&path));
        assert!(!kimi_config_is_managed(&temp.path().join("missing.toml")));
    }

    #[test]
    fn opencode_plugin_template_embeds_binary_and_marker() {
        let rendered = OPENCODE_PLUGIN_TEMPLATE
            .replace("__ORGII_BINARY__", &js_escaped_path(Path::new("/Apps/ORG2/orgii")));
        assert!(rendered.contains("/Apps/ORG2/orgii"));
        assert!(rendered.contains(HOOK_MARKER));
        assert!(rendered.contains("tool.execute.after"));
        assert!(!rendered.contains("__ORGII_BINARY__"));
    }

    #[test]
    fn js_escaped_path_escapes_backslashes_and_quotes() {
        assert_eq!(
            js_escaped_path(Path::new(r"C:\Program Files\orgii.exe")),
            r"C:\\Program Files\\orgii.exe"
        );
    }

    #[test]
    fn opencode_managed_detection_only_matches_our_plugin() {
        let temp = tempfile::tempdir().expect("temp dir");
        let managed = temp.path().join("orgii-session-provenance.js");
        std::fs::write(&managed, format!("// {HOOK_MARKER} opencode\nexport const X = 1;"))
            .expect("write managed plugin");
        assert!(opencode_plugin_is_managed(&managed));

        let user = temp.path().join("user-plugin.js");
        std::fs::write(&user, "export const Y = 2;").expect("write user plugin");
        assert!(!opencode_plugin_is_managed(&user));
        assert!(!opencode_plugin_is_managed(&temp.path().join("missing.js")));
    }

    #[test]
    fn platform_wire_ids_match_the_frontend_enum() {
        // These strings are the contract with the TS `SessionProvenanceHookPlatformSchema`.
        // A mismatch makes `session_provenance_hooks_set_enabled` reject the platform.
        let cases = [
            (SessionProvenanceHookPlatform::ClaudeCode, "claude_code"),
            (SessionProvenanceHookPlatform::Codex, "codex"),
            (SessionProvenanceHookPlatform::Cursor, "cursor"),
            (SessionProvenanceHookPlatform::QwenCode, "qwen_code"),
            (SessionProvenanceHookPlatform::FactoryDroid, "factory_droid"),
            (SessionProvenanceHookPlatform::Trae, "trae"),
            (SessionProvenanceHookPlatform::OpenCode, "opencode"),
            (SessionProvenanceHookPlatform::Windsurf, "windsurf"),
            (SessionProvenanceHookPlatform::Kimi, "kimi"),
            (SessionProvenanceHookPlatform::Antigravity, "antigravity"),
            (SessionProvenanceHookPlatform::ZCode, "zcode"),
        ];
        for (platform, expected) in cases {
            assert_eq!(
                serde_json::to_value(platform).unwrap(),
                serde_json::Value::String(expected.to_string()),
                "unexpected wire id for {platform:?}"
            );
            let round_trip: SessionProvenanceHookPlatform =
                serde_json::from_value(serde_json::json!(expected)).unwrap();
            assert_eq!(round_trip, platform);
        }
    }

    #[test]
    fn preferences_default_to_all_platforms_enabled() {
        let preferences = HookPreferences::default();
        for platform in ALL_SESSION_PROVENANCE_HOOK_PLATFORMS {
            assert!(
                preferences.enabled(platform),
                "expected {platform:?} enabled by default"
            );
        }
        assert_eq!(ALL_SESSION_PROVENANCE_HOOK_PLATFORMS.len(), 11);
    }

    #[test]
    fn zcode_plugin_hooks_value_carries_marker_and_post_tool_use() {
        let hooks = zcode_hooks_value("orgii --session-provenance-hook zcode");
        assert_eq!(
            hooks["hooks"]["PostToolUse"][0]["matcher"],
            ZCODE_POST_TOOL_USE_MATCHER
        );
        let command = hooks["hooks"]["PostToolUse"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap();
        assert!(command.contains(HOOK_MARKER));
        assert!(command.ends_with("zcode"));
        // ZCode plugin/data/marketplace paths stay inside its plugin store.
        assert!(zcode_plugin_hooks_path()
            .to_string_lossy()
            .contains(".zcode/cli/plugins"));
        assert!(zcode_plugin_data_dir()
            .to_string_lossy()
            .ends_with("session-provenance@orgii"));
    }

    #[test]
    fn zcode_plugin_id_is_name_at_marketplace() {
        assert_eq!(
            zcode_plugin_id(),
            format!("{ZCODE_PLUGIN_NAME}@{ZCODE_PLUGIN_MARKETPLACE}")
        );
    }

    #[test]
    fn zcode_config_path_is_under_zcode_cli() {
        let path = zcode_config_path();
        let path_str = path.to_string_lossy();
        assert!(
            path_str.ends_with(".zcode/cli/config.json"),
            "expected ~/.zcode/cli/config.json, got {path_str}"
        );
    }

    #[test]
    fn zcode_set_plugin_enabled_writes_config_entry_and_preserves_user_keys() {
        let temp = tempfile::tempdir().expect("temp config dir");
        let config_path = temp.path().join("config.json");
        let seed = json!({
            "model": "glm-5",
            "plugins": {
                "enabledPlugins": { "other-plugin": true }
            }
        });
        std::fs::write(&config_path, seed.to_string()).expect("write seed config");

        // Initially our plugin is not enabled.
        let mut config = read_config(&config_path).expect("read seed");
        assert!(!zcode_plugin_is_enabled_in(&config));

        // Enable, then read back from disk to prove it persisted.
        set_plugin_enabled_in_config(&mut config, true).expect("enable in memory");
        assert!(zcode_plugin_is_enabled_in(&config));
        zcode_set_plugin_enabled_at(&config_path, true).expect("enable on disk");

        let written: Value =
            serde_json::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
        assert_eq!(written["model"], "glm-5");
        assert_eq!(written["plugins"]["enabledPlugins"]["other-plugin"], true);
        assert_eq!(written["plugins"]["enabledPlugins"][zcode_plugin_id()], true);

        // Disabling leaves the unrelated plugin and top-level keys intact.
        zcode_set_plugin_enabled_at(&config_path, false).expect("disable on disk");
        let written: Value =
            serde_json::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
        assert_eq!(written["model"], "glm-5");
        assert_eq!(written["plugins"]["enabledPlugins"]["other-plugin"], true);
        assert!(written["plugins"]["enabledPlugins"]
            .get(zcode_plugin_id())
            .is_none_or(|v| !v.as_bool().unwrap_or(true)));
    }

    #[test]
    fn zcode_set_plugin_enabled_creates_missing_config_file() {
        let temp = tempfile::tempdir().expect("temp config dir");
        let config_path = temp.path().join("nested").join("config.json");
        assert!(!config_path.exists());

        // No config.json exists yet; enabling must create it (and its parent).
        zcode_set_plugin_enabled_at(&config_path, true).expect("enable creates config");
        let written: Value =
            serde_json::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
        assert!(zcode_plugin_is_enabled_in(&written));
    }

    #[test]
    fn zcode_registry_round_trip_adds_and_removes_entry() {
        let temp = tempfile::tempdir().expect("temp registry dir");
        let registry_path = temp.path().join("installed_plugins.json");
        let cache_path = temp.path().join("cache").join("session-provenance").join("0.1.0");

        // Start from a registry that already lists an unrelated plugin.
        let seed = json!({
            "version": 1,
            "plugins": { "other@marketplace": { "installPath": "/x", "version": "1.0" } }
        });
        std::fs::write(&registry_path, seed.to_string()).expect("write seed registry");

        // The pure helpers are config-value based; verify via the real file by
        // re-reading after each write. We exercise the file-writing functions
        // directly against the temp path through a thin wrapper.
        // Note: zcode_set_plugin_installed uses the real plugins-root path, so
        // we verify the in-memory transform instead by parsing both states.
        let mut config = read_config(&registry_path).expect("read seed");
        assert!(!zcode_registry_has_plugin(&config));

        zcode_add_plugin_to_registry(&mut config, &cache_path);
        assert!(zcode_registry_has_plugin(&config));
        assert_eq!(
            config["plugins"][zcode_plugin_id()]["installPath"],
            cache_path.to_string_lossy().to_string()
        );
        // Unrelated plugin survives.
        assert!(config["plugins"].get("other@marketplace").is_some());

        // Remove only our entry.
        zcode_remove_plugin_from_registry_value(&mut config);
        assert!(!zcode_registry_has_plugin(&config));
        assert!(config["plugins"].get("other@marketplace").is_some());
    }

    #[test]
    fn zcode_unparseable_config_is_treated_as_empty_not_crash() {
        let config = serde_json::from_str::<Value>("{ not valid json");
        // The pure helpers operate on already-parsed values; the tolerance is
        // exercised by `read_zcode_config` falling back to an empty object, so
        // here we just confirm an empty object reads as not-enabled.
        let empty = Value::Object(Map::new());
        assert!(!zcode_plugin_is_enabled_in(&empty));
        assert!(config.is_err(), "garbage must fail to parse");
    }

    #[test]
    fn legacy_v1_preferences_without_new_platforms_still_load() {
        // A preferences file written before Qwen/Droid/Trae/OpenCode existed
        // omits their keys. Struct-level `default` must fill them (enabled)
        // without a schema bump.
        let preferences: HookPreferences = serde_json::from_value(json!({
            "schemaVersion": 1,
            "claudeCode": false,
            "codex": true,
            "cursor": true
        }))
        .expect("legacy preferences load");
        assert!(!preferences.enabled(SessionProvenanceHookPlatform::ClaudeCode));
        assert!(preferences.enabled(SessionProvenanceHookPlatform::QwenCode));
        assert!(preferences.enabled(SessionProvenanceHookPlatform::FactoryDroid));
        assert!(preferences.enabled(SessionProvenanceHookPlatform::Trae));
        assert!(preferences.enabled(SessionProvenanceHookPlatform::OpenCode));
    }

    #[test]
    fn unknown_hook_shapes_fail_without_clobbering_config() {
        let mut config = json!({"hooks": "future-format", "theme": "dark"});
        let original = config.clone();
        let error = update_nested_platform(&mut config, true, "Read", "orgii", "orgii.exe")
            .expect_err("unknown shape must fail closed");
        assert!(error.contains("must be a JSON object"));
        assert_eq!(config, original);
    }

    #[test]
    fn marker_in_unrelated_config_does_not_report_hooks_enabled() {
        let config = json!({"notes": HOOK_MARKER});
        assert!(!config_has_complete_managed_hooks(
            &config,
            SessionProvenanceHookPlatform::ClaudeCode,
            false
        ));
    }

    #[test]
    fn newer_preferences_are_read_tolerantly_not_rejected() {
        // A preferences file written by a NEWER build (extra platform field this
        // reader doesn't know) must deserialize by ignoring the unknown field,
        // not error — otherwise reconciliation aborts and all capture is
        // silently disabled. Known fields are still read; missing ones default.
        let preferences: HookPreferences = serde_json::from_value(json!({
            "schemaVersion": 1,
            "claudeCode": false,
            "codex": true,
            "cursor": true,
            "futurePlatform": true
        }))
        .expect("newer preferences load by ignoring unknown fields");
        assert!(!preferences.enabled(SessionProvenanceHookPlatform::ClaudeCode));
        assert!(preferences.enabled(SessionProvenanceHookPlatform::Codex));
        // Fields absent in this older-shaped file fall back to enabled.
        assert!(preferences.enabled(SessionProvenanceHookPlatform::ZCode));
    }

    #[test]
    fn atomic_write_replaces_an_existing_config() {
        let temp = tempfile::tempdir().expect("temporary config dir");
        let path = temp.path().join("hooks.json");
        std::fs::write(&path, b"old").expect("old config");

        write_atomic(&path, b"new").expect("replace config");

        assert_eq!(std::fs::read(&path).unwrap(), b"new");
    }
}

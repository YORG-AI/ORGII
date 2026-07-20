//! Hermes Agent lifecycle hook bridge.
//!
//! ORGII installs a small user-level Hermes plugin and enables it through the
//! official `hermes plugins enable` command. Integrated terminals inherit a
//! per-terminal callback credential from [`hermes_hook_prepare`]; Hermes
//! processes launched elsewhere discover a user-private runtime descriptor
//! while ORGII is running. Events arrive over a token-authenticated localhost
//! endpoint and are broadcast to the frontend.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::extract::Json;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::post;
use axum::Router;
use integrations::cli_binary_resolver::{resolve_cli_binary_command, CliBinaryId};
use serde::Deserialize;

use super::websocket_handler;

const PLUGIN_NAME: &str = "orgii-status";
const PLUGIN_MANIFEST: &str = include_str!("hermes_hook/plugin.yaml");
const PLUGIN_CODE: &str = include_str!("hermes_hook/__init__.py");
const TOKEN_HEADER: &str = "x-orgii-hermes-hook-token";
const PLUGIN_ENABLE_TIMEOUT: Duration = Duration::from_secs(10);
const PLUGIN_ENABLE_POLL_INTERVAL: Duration = Duration::from_millis(50);

static INSTALL_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static INSTALL_COMPLETE: OnceLock<()> = OnceLock::new();
static TERMINAL_TOKENS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
static GLOBAL_TOKEN: OnceLock<String> = OnceLock::new();
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);
static GLOBAL_CONFIG_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HermesHookRequest {
    terminal_session_id: Option<String>,
    payload: HermesHookPayload,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HermesHookPayload {
    hook_event_name: String,
    session_id: Option<String>,
    tool_name: Option<String>,
    tool_input_preview: Option<String>,
    model: Option<String>,
    cwd: Option<String>,
    duration_ms: Option<f64>,
    approval_surface: Option<String>,
}

pub fn router() -> Router {
    Router::new().route("/agent/hooks/hermes", post(receive_hermes_hook))
}

fn terminal_tokens() -> &'static Mutex<HashMap<String, String>> {
    TERMINAL_TOKENS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn global_config_lock() -> &'static Mutex<()> {
    GLOBAL_CONFIG_LOCK.get_or_init(|| Mutex::new(()))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum HermesHookSource {
    Integrated,
    External,
}

impl HermesHookSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::Integrated => "integrated",
            Self::External => "external",
        }
    }
}

fn global_token() -> &'static str {
    GLOBAL_TOKEN
        .get_or_init(|| uuid::Uuid::new_v4().simple().to_string())
        .as_str()
}

fn authenticate_request(
    terminal_session_id: Option<&str>,
    supplied_token: &str,
) -> Option<HermesHookSource> {
    if supplied_token.is_empty() {
        return None;
    }
    if let Some(terminal_session_id) = terminal_session_id.filter(|value| !value.is_empty()) {
        return terminal_tokens()
            .lock()
            .ok()
            .and_then(|tokens| tokens.get(terminal_session_id).cloned())
            .filter(|expected| expected == supplied_token)
            .map(|_| HermesHookSource::Integrated);
    }
    (global_token() == supplied_token).then_some(HermesHookSource::External)
}

fn hook_status(event_name: &str, approval_surface: Option<&str>) -> Option<&'static str> {
    match event_name {
        "on_session_start"
        | "pre_llm_call"
        | "pre_tool_call"
        | "post_tool_call"
        | "pre_verify"
        | "subagent_start"
        | "subagent_stop"
        | "post_approval_response" => Some("running"),
        "post_llm_call" | "on_session_end" | "on_session_reset" => Some("waiting"),
        "pre_approval_request" if approval_surface != Some("smart") => Some("blocked"),
        "pre_approval_request" => Some("running"),
        "on_session_finalize" => Some("done"),
        _ => None,
    }
}

async fn receive_hermes_hook(
    headers: HeaderMap,
    Json(request): Json<HermesHookRequest>,
) -> impl IntoResponse {
    let supplied_token = headers
        .get(TOKEN_HEADER)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let terminal_session_id = request
        .terminal_session_id
        .filter(|value| !value.is_empty());
    let Some(source) = authenticate_request(terminal_session_id.as_deref(), supplied_token) else {
        return StatusCode::UNAUTHORIZED;
    };

    let Some(message) = build_status_message(source, terminal_session_id, request.payload) else {
        return StatusCode::NO_CONTENT;
    };
    websocket_handler::broadcast(message.to_string());
    StatusCode::NO_CONTENT
}

fn build_status_message(
    source: HermesHookSource,
    terminal_session_id: Option<String>,
    payload: HermesHookPayload,
) -> Option<serde_json::Value> {
    let HermesHookPayload {
        hook_event_name,
        session_id,
        tool_name,
        tool_input_preview,
        model,
        cwd,
        duration_ms,
        approval_surface,
    } = payload;
    let status = hook_status(&hook_event_name, approval_surface.as_deref())?;
    let mut message = serde_json::json!({
        "type": "terminal_agent.status_changed",
        "cli_agent_type": "hermes",
        "source": source.as_str(),
        "agent_status": status,
        "hook_event_name": hook_event_name,
        "timestamp": chrono::Utc::now().timestamp_millis(),
    });
    if let Some(terminal_session_id) = terminal_session_id {
        message["terminal_session_id"] = terminal_session_id.into();
    }
    for (key, value) in [
        (
            "agent_session_id",
            session_id.map(serde_json::Value::String),
        ),
        ("tool_name", tool_name.map(serde_json::Value::String)),
        (
            "tool_input_preview",
            tool_input_preview.map(serde_json::Value::String),
        ),
        ("model", model.map(serde_json::Value::String)),
        ("cwd", cwd.map(serde_json::Value::String)),
        (
            "approval_surface",
            approval_surface.map(serde_json::Value::String),
        ),
        (
            "duration_ms",
            duration_ms
                .and_then(serde_json::Number::from_f64)
                .map(Into::into),
        ),
    ] {
        if let Some(value) = value {
            message[key] = value;
        }
    }
    Some(message)
}

fn write_if_changed(path: &Path, content: &str) -> Result<(), String> {
    if std::fs::read_to_string(path).is_ok_and(|existing| existing == content) {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create {}: {err}", parent.display()))?;
    }
    std::fs::write(path, content)
        .map_err(|err| format!("Failed to write {}: {err}", path.display()))
}

fn global_hook_config_path() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("ORGII_HERMES_HOOK_CONFIG") {
        return Ok(PathBuf::from(path));
    }
    Ok(dirs::home_dir()
        .ok_or_else(|| "Unable to resolve home directory".to_string())?
        .join(".orgii")
        .join("hermes-hook.env"))
}

fn global_hook_config_content(token: &str) -> String {
    format!(
        "ORGII_HERMES_HOOK_ENDPOINT=http://127.0.0.1:{}/agent/hooks/hermes\nORGII_HERMES_HOOK_TOKEN={token}\n",
        super::ide_server_port()
    )
}

fn write_private_file(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create {}: {err}", parent.display()))?;
    }

    let temporary_path = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4().simple()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    std::io::Write::write_all(
        &mut options
            .open(&temporary_path)
            .map_err(|err| format!("Failed to create {}: {err}", temporary_path.display()))?,
        content.as_bytes(),
    )
    .map_err(|err| format!("Failed to write {}: {err}", temporary_path.display()))?;
    if let Err(first_error) = std::fs::rename(&temporary_path, path) {
        // Windows does not replace an existing destination with `rename`.
        // The descriptor is process-scoped and can safely be recreated.
        if !path.exists()
            || std::fs::remove_file(path).is_err()
            || std::fs::rename(&temporary_path, path).is_err()
        {
            let _ = std::fs::remove_file(&temporary_path);
            return Err(format!(
                "Failed to replace {}: {first_error}",
                path.display()
            ));
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|err| format!("Failed to secure {}: {err}", path.display()))?;
    }
    Ok(())
}

fn enable_plugin_with_timeout(hermes: &str) -> Result<Output, String> {
    let mut child = Command::new(hermes)
        .args(["plugins", "enable", PLUGIN_NAME])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("Failed to run `{hermes} plugins enable {PLUGIN_NAME}`: {err}"))?;
    let deadline = Instant::now() + PLUGIN_ENABLE_TIMEOUT;

    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut stdout = Vec::new();
                let mut stderr = Vec::new();
                if let Some(mut pipe) = child.stdout.take() {
                    pipe.read_to_end(&mut stdout).map_err(|err| {
                        format!(
                            "Failed to read `{hermes} plugins enable {PLUGIN_NAME}` stdout: {err}"
                        )
                    })?;
                }
                if let Some(mut pipe) = child.stderr.take() {
                    pipe.read_to_end(&mut stderr).map_err(|err| {
                        format!(
                            "Failed to read `{hermes} plugins enable {PLUGIN_NAME}` stderr: {err}"
                        )
                    })?;
                }
                return Ok(Output {
                    status,
                    stdout,
                    stderr,
                });
            }
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(PLUGIN_ENABLE_POLL_INTERVAL);
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "`{hermes} plugins enable {PLUGIN_NAME}` timed out after {} seconds",
                    PLUGIN_ENABLE_TIMEOUT.as_secs()
                ));
            }
            Err(err) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "Failed while waiting for `{hermes} plugins enable {PLUGIN_NAME}`: {err}"
                ));
            }
        }
    }
}

fn ensure_plugin_installed() -> Result<(), String> {
    if INSTALL_COMPLETE.get().is_some() {
        return Ok(());
    }
    let _guard = INSTALL_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "Hermes hook installer lock is poisoned".to_string())?;
    if INSTALL_COMPLETE.get().is_some() {
        return Ok(());
    }

    let home = dirs::home_dir().ok_or_else(|| "Unable to resolve home directory".to_string())?;
    let plugin_dir = home.join(".hermes").join("plugins").join(PLUGIN_NAME);
    write_if_changed(&plugin_dir.join("plugin.yaml"), PLUGIN_MANIFEST)?;
    write_if_changed(&plugin_dir.join("__init__.py"), PLUGIN_CODE)?;

    let hermes = resolve_cli_binary_command(CliBinaryId::Hermes);
    let output = enable_plugin_with_timeout(&hermes)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        return Err(format!(
            "Hermes could not enable the {PLUGIN_NAME} plugin{}{}",
            if detail.is_empty() { "" } else { ": " },
            detail
        ));
    }

    let _ = INSTALL_COMPLETE.set(());
    Ok(())
}

fn initialize_global_hook_sync() -> Result<(), String> {
    ensure_plugin_installed()?;

    let _config_guard = global_config_lock()
        .lock()
        .map_err(|error| format!("Hermes global hook config lock poisoned: {error}"))?;

    if SHUTTING_DOWN.load(Ordering::Acquire) {
        return Ok(());
    }
    let path = global_hook_config_path()?;
    write_private_file(&path, &global_hook_config_content(global_token()))
}

fn remove_owned_global_hook_config(path: &Path, expected_content: &str) -> Result<(), String> {
    let existing = match std::fs::read_to_string(path) {
        Ok(existing) => existing,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(format!("Failed to read {}: {err}", path.display())),
    };
    if existing != expected_content {
        return Ok(());
    }
    std::fs::remove_file(path).map_err(|err| format!("Failed to remove {}: {err}", path.display()))
}

/// Remove this process's external-session descriptor during an actual app
/// shutdown. Ownership is verified so one ORGII process cannot delete a newer
/// process's descriptor.
pub fn cleanup_global_hook() {
    SHUTTING_DOWN.store(true, Ordering::Release);

    let _config_guard = match global_config_lock().lock() {
        Ok(guard) => guard,
        Err(error) => {
            tracing::warn!("Hermes global hook config lock poisoned during cleanup: {error}");
            return;
        }
    };

    let Some(token) = GLOBAL_TOKEN.get() else {
        return;
    };
    let result = global_hook_config_path().and_then(|path| {
        remove_owned_global_hook_config(&path, &global_hook_config_content(token))
    });
    if let Err(error) = result {
        tracing::warn!(%error, "[Hermes Hook] Failed to clean up global descriptor");
    }
}

/// Install the globally enabled plugin and publish the current process's
/// user-private callback credential. Failure is non-fatal to the IDE server;
/// callers should log it and keep the rest of ORGII available.
pub async fn initialize_global_hook() -> Result<(), String> {
    tokio::task::spawn_blocking(initialize_global_hook_sync)
        .await
        .map_err(|err| format!("Hermes global hook initializer failed: {err}"))?
}

/// Install/enable the ORGII Hermes plugin and return the environment that must
/// be inherited by the matching integrated terminal.
#[tauri::command]
pub async fn hermes_hook_prepare(
    terminal_session_id: String,
) -> Result<HashMap<String, String>, String> {
    if !terminal_session_id.starts_with("chatpanel-") {
        return Err("Hermes hooks require a chat-panel terminal session id".to_string());
    }
    tokio::task::spawn_blocking(ensure_plugin_installed)
        .await
        .map_err(|err| format!("Hermes hook installer task failed: {err}"))??;

    let token = uuid::Uuid::new_v4().simple().to_string();
    terminal_tokens()
        .lock()
        .map_err(|_| "Hermes hook token registry is poisoned".to_string())?
        .insert(terminal_session_id.clone(), token.clone());

    Ok(HashMap::from([
        (
            "ORGII_HERMES_HOOK_ENDPOINT".to_string(),
            format!(
                "http://127.0.0.1:{}/agent/hooks/hermes",
                super::ide_server_port()
            ),
        ),
        ("ORGII_HERMES_HOOK_TOKEN".to_string(), token),
        ("ORGII_TERMINAL_SESSION_ID".to_string(), terminal_session_id),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_working_events_to_running() {
        for event in [
            "on_session_start",
            "pre_llm_call",
            "pre_tool_call",
            "post_tool_call",
            "pre_verify",
            "subagent_start",
            "subagent_stop",
            "post_approval_response",
        ] {
            assert_eq!(hook_status(event, None), Some("running"), "{event}");
        }
    }

    #[test]
    fn maps_user_boundaries_to_waiting() {
        for event in ["post_llm_call", "on_session_end", "on_session_reset"] {
            assert_eq!(hook_status(event, None), Some("waiting"), "{event}");
        }
    }

    #[test]
    fn maps_approval_request_to_blocked() {
        assert_eq!(
            hook_status("pre_approval_request", Some("cli")),
            Some("blocked")
        );
        assert_eq!(
            hook_status("pre_approval_request", Some("smart")),
            Some("running")
        );
        assert_eq!(hook_status("post_approval_response", None), Some("running"));
    }

    #[test]
    fn only_finalize_marks_the_terminal_done() {
        assert_eq!(hook_status("on_session_finalize", None), Some("done"));
        assert_eq!(hook_status("unknown", None), None);
    }

    #[test]
    fn global_descriptor_contains_only_endpoint_and_token() {
        let content = global_hook_config_content("test-token");
        assert!(content.contains("ORGII_HERMES_HOOK_ENDPOINT=http://127.0.0.1:"));
        assert!(content.contains("ORGII_HERMES_HOOK_TOKEN=test-token"));
        assert!(!content.contains("ORGII_TERMINAL_SESSION_ID"));
    }

    #[test]
    fn cleanup_only_removes_the_descriptor_owned_by_this_process() {
        let directory = tempfile::tempdir().expect("temp directory");
        let path = directory.path().join("hermes-hook.env");
        let owned = global_hook_config_content("owned-token");
        write_private_file(&path, &owned).expect("write owned descriptor");

        remove_owned_global_hook_config(&path, "different descriptor")
            .expect("ignore descriptor from another process");
        assert!(path.exists());

        remove_owned_global_hook_config(&path, &owned).expect("remove owned descriptor");
        assert!(!path.exists());
    }

    #[test]
    fn external_auth_requires_the_process_global_token() {
        assert_eq!(
            authenticate_request(None, global_token()),
            Some(HermesHookSource::External)
        );
        assert_eq!(authenticate_request(None, "wrong-token"), None);
        assert_eq!(authenticate_request(None, ""), None);
    }

    #[test]
    fn external_wire_message_uses_hermes_identity_without_terminal_identity() {
        let message = build_status_message(
            HermesHookSource::External,
            None,
            HermesHookPayload {
                hook_event_name: "pre_approval_request".to_string(),
                session_id: Some("hermes-session".to_string()),
                tool_name: Some("terminal".to_string()),
                tool_input_preview: Some("needs approval".to_string()),
                model: None,
                cwd: Some("/workspace".to_string()),
                duration_ms: None,
                approval_surface: Some("cli".to_string()),
            },
        )
        .expect("status message");

        assert_eq!(message["source"], "external");
        assert_eq!(message["agent_session_id"], "hermes-session");
        assert_eq!(message["agent_status"], "blocked");
        assert!(message.get("terminal_session_id").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn global_descriptor_is_user_private() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().expect("temp directory");
        let path = directory.path().join("hermes-hook.env");
        write_private_file(&path, "token=test\n").expect("write descriptor");
        let mode = std::fs::metadata(path)
            .expect("descriptor metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
    }
}

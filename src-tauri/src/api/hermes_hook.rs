//! Hermes Agent lifecycle hook bridge.
//!
//! ORGII installs a small user-level Hermes plugin and enables it through the
//! official `hermes plugins enable` command. The plugin is inert unless a
//! Hermes process inherits the per-terminal callback environment returned by
//! [`hermes_hook_prepare`]. Events arrive over a token-authenticated localhost
//! endpoint and are broadcast to the frontend terminal that launched Hermes.

use std::collections::HashMap;
use std::path::Path;
use std::process::Command;
use std::sync::{Mutex, OnceLock};

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

static INSTALL_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static INSTALL_COMPLETE: OnceLock<()> = OnceLock::new();
static TERMINAL_TOKENS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HermesHookRequest {
    terminal_session_id: String,
    payload: HermesHookPayload,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HermesHookPayload {
    hook_event_name: String,
    #[allow(dead_code)]
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
    let token_matches = terminal_tokens()
        .lock()
        .ok()
        .and_then(|tokens| tokens.get(&request.terminal_session_id).cloned())
        .is_some_and(|expected| expected == supplied_token);
    if !token_matches {
        return StatusCode::UNAUTHORIZED;
    }

    let HermesHookPayload {
        hook_event_name,
        session_id: _,
        tool_name,
        tool_input_preview,
        model,
        cwd,
        duration_ms,
        approval_surface,
    } = request.payload;
    let Some(status) = hook_status(&hook_event_name, approval_surface.as_deref()) else {
        return StatusCode::NO_CONTENT;
    };
    let mut message = serde_json::json!({
        "type": "terminal_agent.status_changed",
        "terminal_session_id": request.terminal_session_id,
        "cli_agent_type": "hermes",
        "agent_status": status,
        "hook_event_name": hook_event_name,
        "timestamp": chrono::Utc::now().timestamp_millis(),
    });
    for (key, value) in [
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
    websocket_handler::broadcast(message.to_string());
    StatusCode::NO_CONTENT
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
    let output = Command::new(&hermes)
        .args(["plugins", "enable", PLUGIN_NAME])
        .output()
        .map_err(|err| format!("Failed to run `{hermes} plugins enable {PLUGIN_NAME}`: {err}"))?;
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
}

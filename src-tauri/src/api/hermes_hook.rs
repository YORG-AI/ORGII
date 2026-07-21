//! Native Hermes lifecycle hook integration.
//!
//! A managed Hermes plugin posts lifecycle callbacks to the existing
//! token-authenticated loopback hook server. Events are translated directly
//! into the current `AgentStatusEventV1` pipeline, so integrated TUI sessions
//! (via `ORGII_SESSION_ID`) and externally launched Hermes sessions share the
//! same live-status registry and frontend bridge.

use std::path::Path;
use std::process::Command;
use std::sync::{Mutex, OnceLock};

use axum::body::Bytes;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use axum::Router;
use integrations::cli_binary_resolver::{resolve_cli_binary_command, CliBinaryId};
use orgtrack_core::status_adapter::{AgentLiveState, AgentStatusEventV1};
use serde::Deserialize;

const PLUGIN_NAME: &str = "orgii-status";
const PLUGIN_MANIFEST: &str = include_str!("hermes_hook/plugin.yaml");
const PLUGIN_CODE: &str = include_str!("hermes_hook/__init__.py");
const HERMES_STATUS_ROUTE: &str = "/hooks/hermes-status";
const HERMES_STATUS_MAX_BODY_BYTES: usize = 64 * 1024;

static INSTALL_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static INSTALL_COMPLETE: OnceLock<()> = OnceLock::new();

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HermesHookRequest {
    payload: HermesHookPayload,
    #[serde(default)]
    orgii_session_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HermesHookPayload {
    hook_event_name: String,
    session_id: Option<String>,
    tool_name: Option<String>,
    tool_input_preview: Option<String>,
    cwd: Option<String>,
    approval_surface: Option<String>,
}

pub fn router() -> Router {
    Router::new().route(
        HERMES_STATUS_ROUTE,
        post(receive_hermes_hook).layer(axum::extract::DefaultBodyLimit::max(
            HERMES_STATUS_MAX_BODY_BYTES,
        )),
    )
}

fn hook_state(event_name: &str, approval_surface: Option<&str>) -> Option<AgentLiveState> {
    match event_name {
        "on_session_start"
        | "pre_llm_call"
        | "pre_tool_call"
        | "post_tool_call"
        | "pre_verify"
        | "subagent_start"
        | "subagent_stop"
        | "post_approval_response" => Some(AgentLiveState::Working),
        "post_llm_call" | "on_session_end" | "on_session_reset" => Some(AgentLiveState::Waiting),
        "pre_approval_request" if approval_surface != Some("smart") => {
            Some(AgentLiveState::Waiting)
        }
        "pre_approval_request" => Some(AgentLiveState::Working),
        "on_session_finalize" => Some(AgentLiveState::Done),
        _ => None,
    }
}

fn normalize_request(request: HermesHookRequest) -> Option<AgentStatusEventV1> {
    let HermesHookRequest {
        payload,
        orgii_session_id,
    } = request;
    let HermesHookPayload {
        hook_event_name,
        session_id,
        tool_name,
        tool_input_preview,
        cwd,
        approval_surface,
    } = payload;
    let source_session_id = session_id.filter(|value| !value.trim().is_empty())?;
    let state = hook_state(&hook_event_name, approval_surface.as_deref())?;
    let interactive_prompt = (state == AgentLiveState::Waiting)
        .then(|| tool_input_preview.clone())
        .flatten();

    Some(AgentStatusEventV1 {
        schema_version: orgtrack_core::status_adapter::AGENT_STATUS_SCHEMA_VERSION,
        source: "hermes".to_string(),
        source_session_id: source_session_id.clone(),
        session_id: format!("hermesapp-{source_session_id}"),
        state,
        event_name: hook_event_name,
        tool_name,
        tool_input_preview,
        interactive_prompt,
        is_interrupt: false,
        cwd,
        orgii_session_id: orgii_session_id.filter(|value| !value.trim().is_empty()),
        occurred_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    })
}

async fn receive_hermes_hook(headers: HeaderMap, body: Bytes) -> StatusCode {
    if !super::agent_status_ingest::authorize_hook_request(&headers) {
        return StatusCode::UNAUTHORIZED;
    }
    let request = match serde_json::from_slice::<HermesHookRequest>(&body) {
        Ok(request) => request,
        Err(error) => {
            tracing::debug!(%error, "[Hermes Hook] Dropping unparseable lifecycle callback");
            return StatusCode::BAD_REQUEST;
        }
    };
    let Some(event) = normalize_request(request) else {
        return StatusCode::NO_CONTENT;
    };
    crate::orgtrack::agent_live_status::ingest(event);
    StatusCode::NO_CONTENT
}

fn write_if_changed(path: &Path, content: &str) -> Result<(), String> {
    if std::fs::read_to_string(path).is_ok_and(|existing| existing == content) {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    }
    std::fs::write(path, content)
        .map_err(|error| format!("Failed to write {}: {error}", path.display()))
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
        .map_err(|error| {
            format!("Failed to run `{hermes} plugins enable {PLUGIN_NAME}`: {error}")
        })?;
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

/// Install and enable the globally inert Hermes plugin without delaying server
/// startup. The plugin reads the current process endpoint descriptor on each
/// callback, so no Hermes-specific credential or shutdown cleanup is needed.
pub async fn initialize() -> Result<(), String> {
    tokio::task::spawn_blocking(ensure_plugin_installed)
        .await
        .map_err(|error| format!("Hermes hook installer task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(event: &str, surface: Option<&str>) -> HermesHookRequest {
        HermesHookRequest {
            payload: HermesHookPayload {
                hook_event_name: event.to_string(),
                session_id: Some("hermes-session".to_string()),
                tool_name: Some("terminal".to_string()),
                tool_input_preview: Some("needs approval".to_string()),
                cwd: Some("/workspace".to_string()),
                approval_surface: surface.map(str::to_string),
            },
            orgii_session_id: Some("managed-session".to_string()),
        }
    }

    #[test]
    fn lifecycle_events_map_to_current_status_vocabulary() {
        assert_eq!(
            hook_state("pre_llm_call", None),
            Some(AgentLiveState::Working)
        );
        assert_eq!(
            hook_state("post_llm_call", None),
            Some(AgentLiveState::Waiting)
        );
        assert_eq!(
            hook_state("pre_approval_request", Some("cli")),
            Some(AgentLiveState::Waiting)
        );
        assert_eq!(
            hook_state("pre_approval_request", Some("smart")),
            Some(AgentLiveState::Working)
        );
        assert_eq!(
            hook_state("on_session_finalize", None),
            Some(AgentLiveState::Done)
        );
        assert_eq!(hook_state("unknown", None), None);
    }

    #[test]
    fn normalized_event_bridges_external_and_managed_identity() {
        let event = normalize_request(request("pre_approval_request", Some("cli")))
            .expect("normalized event");
        assert_eq!(event.source, "hermes");
        assert_eq!(event.session_id, "hermesapp-hermes-session");
        assert_eq!(event.orgii_session_id.as_deref(), Some("managed-session"));
        assert_eq!(event.state, AgentLiveState::Waiting);
        assert_eq!(event.interactive_prompt.as_deref(), Some("needs approval"));
    }

    #[test]
    fn callbacks_without_a_native_session_id_are_ignored() {
        let mut request = request("pre_llm_call", None);
        request.payload.session_id = None;
        assert!(normalize_request(request).is_none());
    }
}

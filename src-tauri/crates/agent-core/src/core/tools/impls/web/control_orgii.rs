//! ORGII GUI Action bridge — frontend ActionSystem dispatch infrastructure.
//!
//! `ActionBridge` / `ActionBridgeResult` are the shared plumbing the agent
//! uses to dispatch UI actions to the ORGII frontend over the Tauri IPC
//! Channel and await a structured response. They are consumed by:
//!
//! - `manage_session` and `CodingDispatchTool` (via
//!   `execute_gui_action_with_timeout`) for `session.*` and human-tool
//!   dispatch.
//! - Channel plumbing.
//!
//! Request-response mechanism:
//! 1. Caller broadcasts `agent:ade_action` (delivered to the frontend over
//!    the Tauri IPC Channel) with a correlation ID.
//! 2. Frontend dispatches the action through zodActionRegistry.
//! 3. Frontend calls `agent_ade_action_result` Tauri command with the result.
//! 4. Bridge resolves the pending oneshot channel and returns the result.
//!
//! `control_orgii` wraps this bridge for the dedicated GUI Control agent;
//! other tools use the same bridge for session and coding dispatch.

use async_trait::async_trait;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;
use tracing::{info, warn};

use crate::bus::broadcast_event;
use crate::tools::names as tool_names;
use crate::tools::traits::{required_string, Tool, ToolError};

/// Maximum number of pending IDE action requests (FIFO eviction).
const MAX_PENDING: usize = 50;

/// Timeout for waiting on the frontend response.
const IDE_ACTION_TIMEOUT_SECS: u64 = 10;

/// Result returned by the frontend after executing a GUI action.
pub struct ActionBridgeResult {
    pub success: bool,
    pub message: String,
    pub data: Option<Value>,
}

/// Shared bridge for pending GUI action requests.
///
/// Stored as `Arc<ActionBridge>` in `AgentAppState`. Both the `ide` and `app`
/// tools, plus the `agent_ade_action_result` Tauri command, share this.
#[derive(Default)]
pub struct ActionBridge {
    pending: Mutex<HashMap<String, oneshot::Sender<ActionBridgeResult>>>,
    /// Insertion order for FIFO eviction.
    order: Mutex<Vec<String>>,
}

impl ActionBridge {
    pub fn new() -> Self {
        Self::default()
    }

    /// Check if at least one frontend subscriber is connected — either a
    /// per-session Tauri IPC Channel (normal Tauri runtime) or a debug
    /// WebSocket client.
    ///
    /// When no frontend is connected, dispatch-mode tools should fall back to
    /// direct execution via `tool_service` rather than timing out.
    pub fn has_frontend() -> bool {
        crate::bus::frontend_subscriber_count() > 0
    }

    /// Insert a pending request. Evicts oldest if at capacity.
    fn insert(&self, correlation_id: String, sender: oneshot::Sender<ActionBridgeResult>) {
        let mut pending = self.pending.lock().unwrap();
        let mut order = self.order.lock().unwrap();

        // FIFO eviction
        while pending.len() >= MAX_PENDING {
            if let Some(oldest_key) = order.first().cloned() {
                pending.remove(&oldest_key);
                order.remove(0);
            } else {
                break;
            }
        }

        pending.insert(correlation_id.clone(), sender);
        order.push(correlation_id);
    }

    /// Resolve a pending request with a result. Called by the Tauri command.
    pub fn resolve(&self, correlation_id: &str, result: ActionBridgeResult) -> bool {
        let mut pending = self.pending.lock().unwrap();
        let mut order = self.order.lock().unwrap();

        if let Some(sender) = pending.remove(correlation_id) {
            order.retain(|key| key != correlation_id);
            if sender.send(result).is_err() {
                warn!(
                    "[ide_action] Pending request {} was dropped before result arrived",
                    correlation_id
                );
            }
            true
        } else {
            warn!(
                "[ide_action] No pending request for correlation_id: {}",
                correlation_id
            );
            false
        }
    }
}

pub struct OrgiiControlTool {
    bridge: Arc<ActionBridge>,
}

impl OrgiiControlTool {
    pub fn new(bridge: Arc<ActionBridge>) -> Self {
        Self { bridge }
    }
}

#[async_trait]
impl Tool for OrgiiControlTool {
    fn name(&self) -> &str {
        tool_names::CONTROL_ORGII
    }

    fn category(&self) -> &str {
        crate::tools::categories::WEB
    }

    fn description(&self) -> &str {
        "Inspect and control the ORGII GUI through the frontend ActionSystem. Prefer action=gui.context for current route/station/tab/session/URL state, action=gui.inspect to discover registered actions and visible controls, guide.* actions for tutorials/highlights, then action=gui.execute or a direct registered action to execute one."
    }

    fn parameters(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "operation": {
                    "type": "string",
                    "enum": ["dispatch"],
                    "description": "Optional. Omit this for normal use; dispatch is the only preferred operation."
                },
                "action": {
                    "type": "string",
                    "description": "Registered frontend ActionSystem action ID. Use gui.context to inspect current route/station/tab/session/URL state, gui.inspect to discover actions/controls/guides, guide.* for tutorials/highlights, gui.execute to execute a manifest target, or an exact registered action ID for obvious actions."
                },
                "query": {
                    "type": "string",
                    "description": "Deprecated. Put query inside params when using action=gui.inspect."
                },
                "params": {
                    "type": "object",
                    "description": "Parameters for the selected action. Use an empty object when the action has no parameters.",
                    "additionalProperties": true
                }
            },
            "required": []
        })
    }

    async fn execute_text(
        &self,
        params: Value,
        _ctx: &crate::tools::traits::CallContext,
    ) -> Result<String, ToolError> {
        execute_gui_control_operation(&self.bridge, tool_names::CONTROL_ORGII, params).await
    }
}

// ============================================================================
// Shared execution logic
// ============================================================================

async fn execute_gui_control_operation(
    bridge: &ActionBridge,
    tool_name: &str,
    params: Value,
) -> Result<String, ToolError> {
    let operation = params
        .get("operation")
        .and_then(Value::as_str)
        .unwrap_or("dispatch")
        .to_string();

    match operation.as_str() {
        "list" | "inspect" => {
            execute_gui_operation_with_timeout(
                bridge,
                tool_name,
                &operation,
                params,
                IDE_ACTION_TIMEOUT_SECS,
            )
            .await
        }
        "dispatch" => execute_gui_action(bridge, tool_name, params).await,
        other => Err(ToolError::InvalidParams(format!(
            "Unsupported control_orgii operation: {other}"
        ))),
    }
}

fn format_bridge_result(tool_name: &str, result: ActionBridgeResult) -> String {
    if result.success {
        match result.data {
            Some(data) => serde_json::to_string_pretty(&data).unwrap_or(result.message),
            None => result.message,
        }
    } else {
        format!("{tool_name} action failed: {}", result.message)
    }
}

async fn execute_gui_operation_with_timeout(
    bridge: &ActionBridge,
    tool_name: &str,
    operation: &str,
    params: Value,
    timeout_secs: u64,
) -> Result<String, ToolError> {
    let action = params
        .get("action")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| "gui.inspect".to_string());
    let mut action_params = params
        .get("params")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    let query = params.get("query").cloned();
    let correlation_id = uuid::Uuid::new_v4().to_string();

    info!(
        "[{tool_name}] GUI operation: operation={operation}, action={action}, correlation_id={correlation_id}"
    );

    let (sender, receiver) = oneshot::channel();
    bridge.insert(correlation_id.clone(), sender);

    if let Some(query) = query {
        action_params["query"] = query;
    }

    broadcast_event(
        "agent:ade_action",
        serde_json::json!({
            "sessionId": "",
            "correlationId": correlation_id,
            "operation": operation,
            "action": action,
            "params": action_params,
        }),
    );

    match tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), receiver).await {
        Ok(Ok(result)) => Ok(format_bridge_result(tool_name, result)),
        Ok(Err(_)) => Err(ToolError::ExecutionFailed(
            "Action channel closed unexpectedly. The frontend may not be connected.".to_string(),
        )),
        Err(_) => {
            let mut pending = bridge.pending.lock().unwrap();
            let mut order = bridge.order.lock().unwrap();
            pending.remove(&correlation_id);
            order.retain(|key| key != &correlation_id);

            Err(ToolError::Timeout(format!(
                "{tool_name} operation '{operation}' timed out after {timeout_secs}s. The frontend may not be listening."
            )))
        }
    }
}

/// Execute an action through the frontend ActionSystem via the `ActionBridge`
/// request/response mechanism (delivered over the Tauri IPC Channel).
/// Shared by `ide`, `app`, and `session` tools.
///
/// Uses the default timeout (`IDE_ACTION_TIMEOUT_SECS`).
pub async fn execute_gui_action(
    bridge: &ActionBridge,
    tool_name: &str,
    params: Value,
) -> Result<String, ToolError> {
    execute_gui_action_with_timeout(bridge, tool_name, params, IDE_ACTION_TIMEOUT_SECS).await
}

fn build_ade_action_envelope(
    correlation_id: &str,
    action: &str,
    action_params: Value,
    invoking_session_id: &str,
) -> Value {
    serde_json::json!({
        "sessionId": "",
        "correlationId": correlation_id,
        "action": action,
        "params": action_params,
        "invokingSessionId": invoking_session_id,
    })
}

/// Execute a GUI action with a custom timeout (in seconds).
///
/// Session operations may take longer than the default 10s (e.g., creating
/// a session spawns a process), so they pass a higher timeout.
pub async fn execute_gui_action_with_timeout(
    bridge: &ActionBridge,
    tool_name: &str,
    params: Value,
    timeout_secs: u64,
) -> Result<String, ToolError> {
    execute_gui_action_with_session(bridge, tool_name, params, timeout_secs, "").await
}

pub async fn execute_gui_action_with_session(
    bridge: &ActionBridge,
    tool_name: &str,
    params: Value,
    timeout_secs: u64,
    invoking_session_id: &str,
) -> Result<String, ToolError> {
    let action = required_string(&params, "action")?;
    let action_params = params
        .get("params")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));

    // Generate correlation ID
    let correlation_id = uuid::Uuid::new_v4().to_string();

    info!(
        "[{tool_name}] Dispatching: action={action}, correlation_id={correlation_id}, params={}",
        action_params
            .to_string()
            .chars()
            .take(200)
            .collect::<String>()
    );

    // Create oneshot channel for the response
    let (sender, receiver) = oneshot::channel();
    bridge.insert(correlation_id.clone(), sender);

    // Broadcast the action event to the frontend (Tauri IPC Channel)
    broadcast_event(
        "agent:ade_action",
        build_ade_action_envelope(&correlation_id, &action, action_params, invoking_session_id),
    );

    // Wait for the frontend to respond (with timeout)
    match tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), receiver).await {
        Ok(Ok(result)) => Ok(format_bridge_result(tool_name, result)),
        Ok(Err(_)) => Err(ToolError::ExecutionFailed(
            "Action channel closed unexpectedly. The frontend may not be connected.".to_string(),
        )),
        Err(_) => {
            // Timeout — clean up the pending entry
            let mut pending = bridge.pending.lock().unwrap();
            let mut order = bridge.order.lock().unwrap();
            pending.remove(&correlation_id);
            order.retain(|key| key != &correlation_id);

            Err(ToolError::Timeout(format!(
                "{tool_name} action '{action}' timed out after {timeout_secs}s. \
                 The frontend may not be listening."
            )))
        }
    }
}

#[cfg(test)]
mod envelope_tests {
    use super::*;

    #[test]
    fn stamps_invoking_session_id_without_touching_routing_session_id() {
        let envelope = build_ade_action_envelope(
            "corr-1",
            "session.replyComment",
            serde_json::json!({ "commentId": "c-1", "body": "done" }),
            "local-session-42",
        );
        assert_eq!(envelope["sessionId"], "");
        assert_eq!(envelope["invokingSessionId"], "local-session-42");
        assert_eq!(envelope["action"], "session.replyComment");
        assert_eq!(envelope["params"]["commentId"], "c-1");
        assert!(envelope["params"].get("localSessionId").is_none());
    }

    #[test]
    fn empty_session_id_leaves_invoking_session_id_empty() {
        let envelope =
            build_ade_action_envelope("corr-2", "gui.execute", serde_json::json!({}), "");
        assert_eq!(envelope["invokingSessionId"], "");
        assert_eq!(envelope["sessionId"], "");
    }
}

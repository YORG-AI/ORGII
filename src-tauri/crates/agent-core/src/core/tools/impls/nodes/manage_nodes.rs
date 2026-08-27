//! Node control tool: manage remote devices connected via WebSocket.
//!
//! Actions: status, describe, notify, camera_snap, camera_list, camera_clip,
//! screen_record, location_get, run, invoke.

use crate::nodes::registry::NodeRegistry;
use crate::tools::names as tool_names;
use crate::tools::traits::{optional_string, required_string, Tool, ToolError};
use async_trait::async_trait;
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::Mutex;

/// Default invoke timeout in milliseconds.
const DEFAULT_TIMEOUT_MS: u64 = 30_000;

/// Node control tool.
pub struct NodesTool {
    registry: Arc<Mutex<NodeRegistry>>,
}

impl NodesTool {
    pub fn new(registry: Arc<Mutex<NodeRegistry>>) -> Self {
        Self { registry }
    }

    /// Invoke a command on a node and format the result.
    async fn invoke_command(
        &self,
        node_id: &str,
        command: &str,
        params: Option<Value>,
        timeout_ms: u64,
    ) -> Result<String, ToolError> {
        let result = NodeRegistry::invoke(&self.registry, node_id, command, params, timeout_ms)
            .await
            .map_err(ToolError::ExecutionFailed)?;

        if result.ok {
            match result.payload {
                Some(payload) => Ok(serde_json::to_string_pretty(&payload)
                    .unwrap_or_else(|_| "Success (unparseable payload)".to_string())),
                None => Ok("Success".to_string()),
            }
        } else {
            let error_msg = result
                .error
                .map(|err| err.message)
                .unwrap_or_else(|| "Unknown error".to_string());
            Err(ToolError::ExecutionFailed(format!(
                "Node command failed: {}",
                error_msg
            )))
        }
    }
}

#[async_trait]
impl Tool for NodesTool {
    fn name(&self) -> &str {
        tool_names::MANAGE_NODES
    }

    fn category(&self) -> &str {
        crate::tools::categories::NODES
    }

    fn description(&self) -> &str {
        "Control remote devices (mobile phones, IoT, remote machines) connected via WebSocket. \
         Actions: status (list nodes), describe (node details), notify (push notification), \
         camera_snap (take photo), camera_list (list cameras), camera_clip (record video), \
         screen_record, location_get, run (execute command on node), invoke (generic command)."
    }

    fn parameters(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["status", "describe", "notify", "camera_snap", "camera_list",
                             "camera_clip", "screen_record", "location_get", "run", "invoke"],
                    "description": "Action to perform."
                },
                "node": {
                    "type": "string",
                    "description": "Target node ID (required for all actions except status)."
                },
                "title": {
                    "type": "string",
                    "description": "Notification title (notify action)."
                },
                "body": {
                    "type": "string",
                    "description": "Notification body (notify action)."
                },
                "facing": {
                    "type": "string",
                    "enum": ["front", "back", "both"],
                    "description": "Camera facing (camera_snap/camera_clip). Default: back."
                },
                "duration": {
                    "type": "string",
                    "description": "Recording duration (camera_clip/screen_record). E.g., '10s', '1m'."
                },
                "command": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Command arguments (run action). E.g., ['ls', '-la']."
                },
                "cwd": {
                    "type": "string",
                    "description": "Working directory for run action."
                },
                "invoke_command": {
                    "type": "string",
                    "description": "Raw command name for invoke action."
                },
                "invoke_params": {
                    "type": "object",
                    "description": "Raw parameters for invoke action."
                },
                "timeout_ms": {
                    "type": "integer",
                    "description": "Timeout in milliseconds. Default: 30000."
                }
            },
            "required": ["action"]
        })
    }

    async fn execute_text(
        &self,
        params: Value,
        ctx: &crate::tools::traits::CallContext,
    ) -> Result<String, ToolError> {
        ctx.require_tool_authority(self.name())?;
        let action = required_string(&params, "action")?;
        let timeout_ms = params
            .get("timeout_ms")
            .and_then(|val| val.as_u64())
            .unwrap_or(DEFAULT_TIMEOUT_MS);

        match action.as_str() {
            "status" => {
                let registry = self.registry.lock().await;
                let nodes = registry.list_nodes();

                if nodes.is_empty() {
                    return Ok("No nodes connected.".to_string());
                }

                let output = serde_json::to_string_pretty(&nodes)
                    .unwrap_or_else(|_| format!("{} nodes connected", nodes.len()));
                Ok(output)
            }

            "describe" => {
                let node_id = required_string(&params, "node")?;
                let registry = self.registry.lock().await;

                match registry.describe_node(&node_id) {
                    Some(info) => Ok(serde_json::to_string_pretty(&info)
                        .unwrap_or_else(|_| format!("Node: {}", node_id))),
                    None => Err(ToolError::InvalidParams(format!(
                        "Node '{}' not connected",
                        node_id
                    ))),
                }
            }

            "notify" => {
                let node_id = required_string(&params, "node")?;
                let title =
                    optional_string(&params, "title").unwrap_or_else(|| "Notification".to_string());
                let body = optional_string(&params, "body").unwrap_or_default();

                self.invoke_command(
                    &node_id,
                    "system.notify",
                    Some(serde_json::json!({ "title": title, "body": body })),
                    timeout_ms,
                )
                .await
            }

            "camera_snap" => {
                let node_id = required_string(&params, "node")?;
                let facing =
                    optional_string(&params, "facing").unwrap_or_else(|| "back".to_string());

                self.invoke_command(
                    &node_id,
                    "camera.snap",
                    Some(serde_json::json!({ "facing": facing })),
                    timeout_ms,
                )
                .await
            }

            "camera_list" => {
                let node_id = required_string(&params, "node")?;
                self.invoke_command(&node_id, "camera.list", None, timeout_ms)
                    .await
            }

            "camera_clip" => {
                let node_id = required_string(&params, "node")?;
                let facing =
                    optional_string(&params, "facing").unwrap_or_else(|| "back".to_string());
                let duration =
                    optional_string(&params, "duration").unwrap_or_else(|| "10s".to_string());

                self.invoke_command(
                    &node_id,
                    "camera.clip",
                    Some(serde_json::json!({ "facing": facing, "duration": duration })),
                    timeout_ms,
                )
                .await
            }

            "screen_record" => {
                let node_id = required_string(&params, "node")?;
                let duration =
                    optional_string(&params, "duration").unwrap_or_else(|| "10s".to_string());

                self.invoke_command(
                    &node_id,
                    "screen.record",
                    Some(serde_json::json!({ "duration": duration })),
                    timeout_ms,
                )
                .await
            }

            "location_get" => {
                let node_id = required_string(&params, "node")?;
                self.invoke_command(&node_id, "location.get", None, timeout_ms)
                    .await
            }

            "run" => {
                let node_id = required_string(&params, "node")?;
                let command_arr = params.get("command").cloned().ok_or_else(|| {
                    ToolError::InvalidParams("command array required for run action".to_string())
                })?;
                let cwd = optional_string(&params, "cwd");

                let mut run_params = serde_json::json!({ "command": command_arr });
                if let Some(ref dir) = cwd {
                    run_params
                        .as_object_mut()
                        .unwrap()
                        .insert("cwd".to_string(), serde_json::Value::String(dir.clone()));
                }

                self.invoke_command(&node_id, "system.run", Some(run_params), timeout_ms)
                    .await
            }

            "invoke" => {
                let node_id = required_string(&params, "node")?;
                let command = required_string(&params, "invoke_command")?;
                let invoke_params = params.get("invoke_params").cloned();

                self.invoke_command(&node_id, &command, invoke_params, timeout_ms)
                    .await
            }

            _ => Err(ToolError::InvalidParams(format!(
                "Unknown action: {}. Use status, describe, notify, camera_snap, camera_list, \
                 camera_clip, screen_record, location_get, run, or invoke.",
                action
            ))),
        }
    }
}

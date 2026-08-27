use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::tools::impls::web::control_orgii::{execute_gui_action_with_timeout, ActionBridge};
use crate::tools::names as tool_names;
use crate::tools::traits::{Tool, ToolError};

const SPOTLIGHT_TIMEOUT_SECS: u64 = 10;

pub struct SpotlightTool {
    bridge: Arc<ActionBridge>,
}

impl SpotlightTool {
    pub fn new(bridge: Arc<ActionBridge>) -> Self {
        Self { bridge }
    }
}

#[async_trait]
impl Tool for SpotlightTool {
    fn name(&self) -> &str {
        tool_names::SPOTLIGHT
    }

    fn category(&self) -> &str {
        crate::tools::categories::WEB
    }

    fn description(&self) -> &str {
        "Open and control ORGII Spotlight directly. Use this for command palette, file search, workspace picker, branch picker, Agent session search, or opening/closing Spotlight."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "operation": {
                    "type": "string",
                    "enum": [
                        "open",
                        "close",
                        "toggle",
                        "workspace_picker",
                        "branch_picker",
                        "file_search",
                        "command_palette",
                        "agent_session_search"
                    ],
                    "description": "Spotlight operation to perform."
                },
                "mode": {
                    "type": "string",
                    "enum": ["switch", "open", "add", "create"],
                    "description": "Workspace picker mode. Only used with operation=workspace_picker."
                }
            },
            "required": ["operation"]
        })
    }

    async fn execute_text(
        &self,
        params: Value,
        ctx: &crate::tools::traits::CallContext,
    ) -> Result<String, ToolError> {
        ctx.require_tool_authority(self.name())?;
        let operation = params
            .get("operation")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidParams("Missing operation".to_string()))?;

        let (action, action_params) = match operation {
            "open" => ("spotlight.open", json!({})),
            "close" => ("spotlight.close", json!({})),
            "toggle" => ("spotlight.toggle", json!({})),
            "workspace_picker" => {
                let mode = params
                    .get("mode")
                    .and_then(Value::as_str)
                    .unwrap_or("switch");
                (
                    "spotlight.openWorkspacePicker",
                    json!({
                        "mode": mode,
                    }),
                )
            }
            "branch_picker" => ("spotlight.openBranchPicker", json!({})),
            "file_search" => ("spotlight.openEditorFile", json!({})),
            "command_palette" => ("spotlight.openEditorCommand", json!({})),
            "agent_session_search" => ("spotlight.openAgentSessionSearch", json!({})),
            other => {
                return Err(ToolError::InvalidParams(format!(
                    "Unsupported spotlight operation: {other}"
                )))
            }
        };

        execute_gui_action_with_timeout(
            &self.bridge,
            tool_names::SPOTLIGHT,
            json!({
                "action": action,
                "params": action_params,
            }),
            SPOTLIGHT_TIMEOUT_SECS,
        )
        .await
    }
}

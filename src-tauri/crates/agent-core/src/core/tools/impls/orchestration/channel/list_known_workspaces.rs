//! `list_known_workspaces` tool — list recently-used workspace paths.

use async_trait::async_trait;
use serde_json::Value;

use crate::persistence::session_snapshots::list_known_workspace_paths;
use crate::tools::names as tool_names;
use crate::tools::traits::{Tool, ToolError};

/// List recently-used workspace paths so the LLM can match a user's
/// "let's look at the yoyo workspace" style reference to a concrete absolute
/// path.
pub struct ListKnownWorkspacesTool;

impl ListKnownWorkspacesTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for ListKnownWorkspacesTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Tool for ListKnownWorkspacesTool {
    fn name(&self) -> &str {
        tool_names::LIST_KNOWN_WORKSPACES
    }

    fn category(&self) -> &str {
        crate::tools::categories::CHANNEL
    }

    fn description(&self) -> &str {
        "List workspace paths recently used by any agent session. Useful for matching \
         user references like \"the yoyo workspace\" to a concrete absolute path before \
         spawning a coding subagent or adding the directory to the session workspace."
    }

    fn parameters(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "limit": {
                    "type": "integer",
                    "description": "Maximum number of paths to return (default 20)."
                }
            }
        })
    }

    async fn execute_text(
        &self,
        params: Value,
        ctx: &crate::tools::traits::CallContext,
    ) -> Result<String, ToolError> {
        ctx.require_tool_authority(self.name())?;
        let limit = params
            .get("limit")
            .and_then(|v| v.as_u64())
            .unwrap_or(20)
            .min(100) as usize;
        let paths = tokio::task::spawn_blocking(move || list_known_workspace_paths(limit))
            .await
            .map_err(|err| ToolError::ExecutionFailed(format!("DB task join error: {}", err)))?
            .map_err(|err| ToolError::ExecutionFailed(format!("DB query failed: {}", err)))?;
        if paths.is_empty() {
            return Ok("No known workspace paths on record yet.".to_string());
        }
        let mut out = String::from("Known workspace paths (most recent first):\n");
        for path in paths {
            out.push_str(&format!("  - {}\n", path));
        }
        Ok(out)
    }
}

//! `remove_workspace_directory` tool — revoke a previously granted directory.

use async_trait::async_trait;
use serde_json::Value;
use tauri::Manager;
use tracing::info;

use super::{has_ctx, make_cell, resolve_target_session_id, ChannelCtxCell};
use crate::tools::names as tool_names;
use crate::tools::registration::ChannelContext;
use crate::tools::traits::{required_string, Tool, ToolError};

pub struct RemoveWorkspaceDirectoryTool {
    app_handle: tauri::AppHandle,
    channel_ctx: ChannelCtxCell,
}

impl RemoveWorkspaceDirectoryTool {
    pub fn new(app_handle: tauri::AppHandle, channel_ctx: Option<ChannelContext>) -> Self {
        Self {
            app_handle,
            channel_ctx: make_cell(channel_ctx),
        }
    }
}

#[async_trait]
impl Tool for RemoveWorkspaceDirectoryTool {
    fn name(&self) -> &str {
        tool_names::REMOVE_WORKSPACE_DIRECTORY
    }

    fn category(&self) -> &str {
        crate::tools::categories::CHANNEL
    }

    fn description(&self) -> &str {
        "Silently revoke a directory previously granted via `add_workspace_directory`. Invoke \
         when the user indicates they're no longer interested in a path (\"drop that one\", \
         \"cancel X\"). Do NOT surface this operation to the user using workspace / directory \
         jargon — acknowledge the change in natural language only."
    }

    fn is_ready(&self) -> bool {
        has_ctx(&self.channel_ctx)
    }

    fn not_ready_reason(&self) -> Option<&str> {
        if self.is_ready() {
            None
        } else {
            Some("channel context unavailable")
        }
    }

    fn parameters(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Absolute path to remove from the session's additional directories."
                },
                "target_session_id": {
                    "type": "string",
                    "description": "Optional. Override the current session. Defaults to the per-chat session for this channel."
                }
            },
            "required": ["path"]
        })
    }

    async fn execute_text(
        &self,
        params: Value,
        ctx: &crate::tools::traits::CallContext,
    ) -> Result<String, ToolError> {
        ctx.require_tool_authority(self.name())?;
        let path_str = required_string(&params, "path")?;
        let path = std::path::PathBuf::from(&path_str);

        let sid = resolve_target_session_id(&self.app_handle, &params, &self.channel_ctx).await?;

        let state = self.app_handle.state::<crate::state::AgentAppState>();
        let removed =
            crate::state::commands::session::workspace_remove_directory(&state, &sid, &path)
                .await
                .map_err(ToolError::ExecutionFailed)?;

        info!(
            "[channel] remove_workspace_directory: session={} path={} removed={}",
            sid, path_str, removed
        );

        Ok(format!(
            "ok: session=`{}` path=`{}` removed={}",
            sid, path_str, removed
        ))
    }

    async fn set_context(&self, channel: &str, chat_id: &str, sender_id: &str) {
        let mut guard = self.channel_ctx.write();
        *guard = Some(ChannelContext {
            channel: channel.to_string(),
            chat_id: chat_id.to_string(),
            sender_id: sender_id.to_string(),
        });
    }
}

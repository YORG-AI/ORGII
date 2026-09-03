//! `add_workspace_directory` tool — silently grant the current session
//! access to an additional local directory.

use async_trait::async_trait;
use serde_json::Value;
use tauri::Manager;
use tracing::info;

use super::{has_ctx, make_cell, resolve_target_session_id, ChannelCtxCell};
use crate::tools::names as tool_names;
use crate::tools::registration::ChannelContext;
use crate::tools::traits::{required_string, Tool, ToolError};

pub struct AddWorkspaceDirectoryTool {
    app_handle: tauri::AppHandle,
    channel_ctx: ChannelCtxCell,
}

impl AddWorkspaceDirectoryTool {
    pub fn new(app_handle: tauri::AppHandle, channel_ctx: Option<ChannelContext>) -> Self {
        Self {
            app_handle,
            channel_ctx: make_cell(channel_ctx),
        }
    }
}

#[async_trait]
impl Tool for AddWorkspaceDirectoryTool {
    fn name(&self) -> &str {
        tool_names::ADD_WORKSPACE_DIRECTORY
    }

    fn category(&self) -> &str {
        crate::tools::categories::CHANNEL
    }

    fn description(&self) -> &str {
        "Silently grant the current session access to an additional local directory when the \
         user mentions a new path in conversation (e.g. \"also take a look at `/tmp/foo`\"). \
         Do NOT ask the user for permission and do NOT use the words \"workspace\" or \
         \"directory\" in your visible reply — the user should feel as if you just understood \
         which paths are relevant. `path` must be absolute. The grant persists with this \
         session (it survives app restarts of the same session) and can be revoked via \
         `remove_workspace_directory`."
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
                    "description": "Absolute path to a local directory the session should be able to read/edit."
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
        if !path.is_absolute() {
            return Err(ToolError::InvalidParams(format!(
                "path must be absolute: {}",
                path_str
            )));
        }
        let source = crate::session::workspace::DirectorySource::Session;

        let sid = resolve_target_session_id(&self.app_handle, &params, &self.channel_ctx).await?;

        let state = self.app_handle.state::<crate::state::AgentAppState>();
        let inserted =
            crate::state::commands::session::workspace_add_directory(&state, &sid, path, source)
                .await
                .map_err(ToolError::ExecutionFailed)?;

        info!(
            "[channel] add_workspace_directory: session={} path={} inserted={}",
            sid, path_str, inserted
        );

        Ok(format!(
            "ok: session=`{}` path=`{}` newly_added={}",
            sid, path_str, inserted
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

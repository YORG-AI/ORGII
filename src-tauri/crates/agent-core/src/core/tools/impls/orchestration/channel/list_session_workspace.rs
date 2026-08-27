//! `list_session_workspace` tool — read the bound session's current roots +
//! additional directories.
//!
//! Intended for the LLM's own self-check (e.g. "did I already add this path?")
//! — NOT for rendering back to the user.

use async_trait::async_trait;
use serde_json::Value;
use tauri::Manager;

use super::{has_ctx, make_cell, resolve_target_session_id, ChannelCtxCell};
use crate::tools::names as tool_names;
use crate::tools::registration::ChannelContext;
use crate::tools::traits::{Tool, ToolError};

pub struct ListSessionWorkspaceTool {
    app_handle: tauri::AppHandle,
    channel_ctx: ChannelCtxCell,
}

impl ListSessionWorkspaceTool {
    pub fn new(app_handle: tauri::AppHandle, channel_ctx: Option<ChannelContext>) -> Self {
        Self {
            app_handle,
            channel_ctx: make_cell(channel_ctx),
        }
    }
}

#[async_trait]
impl Tool for ListSessionWorkspaceTool {
    fn name(&self) -> &str {
        tool_names::LIST_SESSION_WORKSPACE
    }

    fn category(&self) -> &str {
        crate::tools::categories::CHANNEL
    }

    fn description(&self) -> &str {
        "Inspect the current session's roots and additional directories. Useful for deciding \
         whether `add_workspace_directory` would be redundant (the path is already granted). \
         The result is LLM-only bookkeeping — NEVER paste this into your reply to the user."
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
                "target_session_id": {
                    "type": "string",
                    "description": "Optional. Override the current session. Defaults to the per-chat session for this channel."
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
        let sid = resolve_target_session_id(&self.app_handle, &params, &self.channel_ctx).await?;
        let state = self.app_handle.state::<crate::state::AgentAppState>();
        let view = crate::state::commands::session::workspace_list(&state, &sid)
            .await
            .map_err(ToolError::ExecutionFailed)?;

        let mut out = format!(
            "session=`{}`\nworkspace_root=`{}`\nworking_dir=`{}` (worktree={})\nadditional:",
            view.session_id,
            view.workspace_root.display(),
            view.working_dir.display(),
            view.is_worktree
        );
        if view.additional_directories.is_empty() {
            out.push_str(" (none)");
        } else {
            for dir in &view.additional_directories {
                let source_tag = match dir.source {
                    crate::session::workspace::DirectorySource::Session => "session",
                    crate::session::workspace::DirectorySource::IdeWorkspace => "ideWorkspace",
                    crate::session::workspace::DirectorySource::LocalSettings => "localSettings",
                    crate::session::workspace::DirectorySource::UserSettings => "userSettings",
                    crate::session::workspace::DirectorySource::CliArg => "cliArg",
                };
                out.push_str(&format!("\n  - `{}` ({})", dir.path.display(), source_tag));
            }
        }
        Ok(out)
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

//! Inbox tool: allows agents to send notifications/summaries to the user's inbox.

use async_trait::async_trait;
use serde_json::Value;
use uuid::Uuid;

use crate::tools::names as tool_names;
use crate::tools::traits::{optional_string, required_string, Tool, ToolError};
use inbox::persistence::{upsert_message, InboxMessage};

#[derive(Default)]
pub struct InboxTool;

impl InboxTool {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl Tool for InboxTool {
    fn name(&self) -> &str {
        tool_names::SEND_TO_INBOX
    }

    fn category(&self) -> &str {
        crate::tools::categories::COMMS
    }

    fn description(&self) -> &str {
        "Send a notification or summary to the user's inbox. Use this to deliver task results, periodic reports, reminders, or any information the user should see later."
    }

    fn parameters(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "title": {
                    "type": "string",
                    "description": "Short title for the inbox message"
                },
                "content": {
                    "type": "string",
                    "description": "Full message content (supports markdown)"
                },
                "category": {
                    "type": "string",
                    "description": "Message category: notification, report, reminder, work_item, git",
                    "enum": ["notification", "report", "reminder", "work_item", "git"],
                    "default": "notification"
                },
                "priority": {
                    "type": "string",
                    "description": "Message priority: none, low, medium, high, urgent",
                    "enum": ["none", "low", "medium", "high", "urgent"],
                    "default": "none"
                }
            },
            "required": ["title", "content"]
        })
    }

    async fn execute_text(
        &self,
        params: Value,
        ctx: &crate::tools::traits::CallContext,
    ) -> Result<String, ToolError> {
        ctx.require_tool_authority(self.name())?;
        let title = required_string(&params, "title")?;
        let content = required_string(&params, "content")?;
        let category =
            optional_string(&params, "category").unwrap_or_else(|| "notification".to_string());
        let priority = optional_string(&params, "priority").unwrap_or_else(|| "none".to_string());

        let now = chrono::Utc::now().to_rfc3339();
        let msg = InboxMessage {
            id: Uuid::new_v4().to_string(),
            title: title.clone(),
            preview: crate::utils::safe_truncate_chars_to_string(&content, 200),
            content,
            category,
            priority,
            status: "unread".to_string(),
            sender_name: Some("Agent".to_string()),
            metadata: "{}".to_string(),
            labels: "[]".to_string(),
            created_at: now.clone(),
            updated_at: now,
        };

        upsert_message(&msg).map_err(|err| {
            ToolError::ExecutionFailed(format!("Failed to write inbox message: {}", err))
        })?;

        Ok(format!("Inbox message \"{}\" sent successfully", title))
    }
}

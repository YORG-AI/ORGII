//! Message tool: send messages to chat channels.

use async_trait::async_trait;
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::bus::AgentMessageBus as MessageBus;
use crate::bus::OutboundMessage;

use crate::tools::names as tool_names;
use crate::tools::traits::{optional_string, required_string, Tool, ToolError};

/// Send a message to a specific chat channel.
pub struct MessageTool {
    bus: Arc<Mutex<MessageBus>>,
    /// Current context: which channel/chat_id to send to by default.
    current_channel: Mutex<Option<String>>,
    current_chat_id: Mutex<Option<String>>,
}

impl MessageTool {
    pub fn new(bus: Arc<Mutex<MessageBus>>) -> Self {
        Self {
            bus,
            current_channel: Mutex::new(None),
            current_chat_id: Mutex::new(None),
        }
    }
}

#[async_trait]
impl Tool for MessageTool {
    fn name(&self) -> &str {
        tool_names::SEND_MESSAGE
    }

    fn category(&self) -> &str {
        crate::tools::categories::COMMS
    }

    async fn set_context(&self, channel: &str, chat_id: &str, _sender_id: &str) {
        *self.current_channel.lock().await = Some(channel.to_string());
        *self.current_chat_id.lock().await = Some(chat_id.to_string());
    }

    fn description(&self) -> &str {
        "Send a message to a specific chat channel. Use this only when you need to send a message to a different channel than the current conversation."
    }

    fn llm_description(&self) -> Option<String> {
        let channel = self.current_channel.try_lock().ok().and_then(|g| g.clone());
        let chat_id = self.current_chat_id.try_lock().ok().and_then(|g| g.clone());
        match (channel, chat_id) {
            (Some(ch), Some(cid)) => Some(format!(
                "Send a message to a chat channel. \
                 Current context: channel={ch}, chat_id={cid}. \
                 Omit channel/chat_id to send to the current conversation."
            )),
            _ => None,
        }
    }

    fn parameters(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "content": {
                    "type": "string",
                    "description": "Message text to send"
                },
                "channel": {
                    "type": "string",
                    "description": "Target channel (telegram, discord, whatsapp, etc.). Defaults to current channel."
                },
                "chat_id": {
                    "type": "string",
                    "description": "Target chat/user ID. Defaults to current chat."
                }
            },
            "required": ["content"]
        })
    }

    async fn execute_text(
        &self,
        params: Value,
        ctx: &crate::tools::traits::CallContext,
    ) -> Result<String, ToolError> {
        ctx.require_tool_authority(self.name())?;
        let content = required_string(&params, "content")?;
        let channel = optional_string(&params, "channel");
        let chat_id = optional_string(&params, "chat_id");

        let resolved_channel =
            match channel {
                Some(ch) => ch,
                None => self.current_channel.lock().await.clone().ok_or_else(|| {
                    ToolError::ExecutionFailed("No channel context set".to_string())
                })?,
            };

        let resolved_chat_id =
            match chat_id {
                Some(id) => id,
                None => self.current_chat_id.lock().await.clone().ok_or_else(|| {
                    ToolError::ExecutionFailed("No chat_id context set".to_string())
                })?,
            };

        let msg = OutboundMessage::new(&resolved_channel, &resolved_chat_id, &content);
        let bus = self.bus.lock().await;
        bus.publish_outbound(msg);

        Ok(format!(
            "Message sent to {}:{}",
            resolved_channel, resolved_chat_id
        ))
    }
}

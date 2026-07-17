use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::tools::impls::web::control_orgii::{execute_gui_action_with_session, ActionBridge};
use crate::tools::names as tool_names;
use crate::tools::traits::{Tool, ToolError};

const REPLY_SESSION_COMMENT_TIMEOUT_SECS: u64 = 30;

fn build_reply_action(comment_id: &str, body: &str) -> Value {
    json!({
        "action": "session.replyComment",
        "params": {
            "commentId": comment_id,
            "body": body,
        },
    })
}

pub struct ReplySessionCommentTool {
    bridge: Arc<ActionBridge>,
}

impl ReplySessionCommentTool {
    pub fn new(bridge: Arc<ActionBridge>) -> Self {
        Self { bridge }
    }
}

#[async_trait]
impl Tool for ReplySessionCommentTool {
    fn name(&self) -> &str {
        tool_names::REPLY_SESSION_COMMENT
    }

    fn category(&self) -> &str {
        crate::tools::categories::WEB
    }

    fn description(&self) -> &str {
        "Post a reply to a review-comment thread on this session. Only use commentId values explicitly given in the current instructions; never invent or reuse ids from elsewhere."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "commentId": {
                    "type": "string",
                    "description": "Id of the comment thread to reply to, exactly as given in the instructions."
                },
                "body": {
                    "type": "string",
                    "description": "The reply text: what you changed (files/commands) or why you pushed back."
                }
            },
            "required": ["commentId", "body"]
        })
    }

    async fn execute_text(
        &self,
        params: Value,
        ctx: &crate::tools::traits::CallContext,
    ) -> Result<String, ToolError> {
        let comment_id = params
            .get("commentId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| ToolError::InvalidParams("Missing commentId".to_string()))?;
        let body = params
            .get("body")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| ToolError::InvalidParams("Missing body".to_string()))?;

        execute_gui_action_with_session(
            &self.bridge,
            tool_names::REPLY_SESSION_COMMENT,
            build_reply_action(comment_id, body),
            REPLY_SESSION_COMMENT_TIMEOUT_SECS,
            &ctx.session_id,
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn params_carry_only_comment_id_and_body_never_session_id() {
        let action = build_reply_action("c-1", "done");
        let params = &action["params"];
        assert_eq!(action["action"], "session.replyComment");
        assert_eq!(params["commentId"], "c-1");
        assert_eq!(params["body"], "done");
        assert!(params.get("localSessionId").is_none());
        assert!(params.get("invokingSessionId").is_none());
    }
}

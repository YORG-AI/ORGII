//! `manage_secrets` — out-of-band capture of sensitive user input.
//!
//! Lets the agent ask the user for a secret (API key, password, OAuth
//! token) through a dedicated frontend modal. The plaintext never enters
//! the LLM transcript: the agent only ever sees an opaque
//! `{{secret:<token>}}` placeholder, which the privileged `write_env_file`
//! tool resolves at write time.
//!
//! See `crate::interaction::secret_broker` for the threat model and
//! storage details. This file is the LLM-facing surface only.

use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::tools::names as tool_names;
use crate::tools::traits::{Tool, ToolError};

use crate::interaction::finalize::{await_with_cancel, FinalizedStatus, InteractionOutcome};
use crate::interaction::secret_broker::{SecretBroker, SecretCapture};

const ACTION_REQUEST: &str = "request";
const ACTION_LIST: &str = "list";
const ACTION_DISCARD: &str = "discard";

/// Shared context (mirrors `QuestionToolContext`) so the tool can reach the
/// session's broker and know which session it is running against.
pub struct SecretToolContext {
    pub session_id: Mutex<Option<String>>,
    pub broker: Arc<SecretBroker>,
}

impl SecretToolContext {
    pub fn new(broker: Arc<SecretBroker>) -> Self {
        Self {
            session_id: Mutex::new(None),
            broker,
        }
    }
}

pub struct SecretTool {
    context: Arc<SecretToolContext>,
}

impl SecretTool {
    pub fn new(context: Arc<SecretToolContext>) -> Self {
        Self { context }
    }
}

#[async_trait]
impl Tool for SecretTool {
    fn name(&self) -> &str {
        tool_names::MANAGE_SECRETS
    }

    fn description(&self) -> &str {
        "Capture sensitive user input (API keys, passwords, OAuth tokens) \
         out-of-band without exposing the plaintext to the model or the chat \
         transcript.\n\n\
         ## Required: `action` field\n\
         Every call MUST include an `action` field as the first key of the \
         arguments object. There is no default. Calling without `action` fails \
         with `missing field 'action'`.\n\n\
         Actions:\n\
         - request: Prompt the user via a secure modal. Blocks until they \
           submit or cancel. Returns an opaque `{{secret:<token>}}` placeholder \
           you can pass to `write_env_file` — do NOT echo the placeholder back \
           to the user, and do NOT ever ask the user to paste a secret into chat.\n\
         - list: Show all currently captured secrets (label, kind, length, \
           expires_in_secs). Never returns the plaintext.\n\
         - discard: Drop a captured secret immediately.\n\n\
         Rules:\n\
         - Always prefer `manage_secrets { action: \"request\" }` over asking \
           the user to paste a value into chat.\n\
         - If the user pastes a secret into chat anyway, do not store it via \
           this tool — instruct them to use the secure prompt instead.\n\
         - The `label` you pass becomes the user-visible field name (e.g. \
           \"OPENAI_API_KEY\"). Use the exact env-var name when relevant.\n\
         - `kind` is one of: api_key | password | oauth_token | other.\n\n\
         ## Examples\n\
         - `{\"action\": \"request\", \"label\": \"OPENAI_API_KEY\", \"kind\": \"api_key\", \"prompt\": \"OpenAI API key for ChatGPT integration\"}`\n\
         - `{\"action\": \"list\"}`\n\
         - `{\"action\": \"discard\", \"token\": \"sec_abc123\"}`"
    }

    fn category(&self) -> &str {
        crate::tools::categories::AGENT
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "required": ["action"],
            "properties": {
                "action": {
                    "type": "string",
                    "enum": [ACTION_REQUEST, ACTION_LIST, ACTION_DISCARD],
                    "description": "Which sub-action to perform."
                },
                "label": {
                    "type": "string",
                    "description": "Human-readable name for the secret (e.g. 'OPENAI_API_KEY'). Required for `request`."
                },
                "kind": {
                    "type": "string",
                    "enum": ["api_key", "password", "oauth_token", "other"],
                    "description": "Coarse-grained category. Required for `request`. Display-only — does not change storage semantics."
                },
                "prompt": {
                    "type": "string",
                    "description": "Short sentence shown to the user in the modal explaining what the secret is for and where it will end up. Required for `request`."
                },
                "token": {
                    "type": "string",
                    "description": "The `{{secret:<...>}}` token (or its bare `secret-<uuid>` form) to discard. Required for `discard`."
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
        let action = params
            .get("action")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ToolError::InvalidParams("Missing 'action'".into()))?;

        match action {
            ACTION_REQUEST => self.handle_request(&params, ctx).await,
            ACTION_LIST => self.handle_list().await,
            ACTION_DISCARD => self.handle_discard(&params).await,
            other => Err(ToolError::InvalidParams(format!(
                "Unknown action '{other}'. Expected one of: request | list | discard."
            ))),
        }
    }

    async fn set_session_key(&self, session_key: &str) {
        *self.context.session_id.lock().await = Some(session_key.to_string());
    }
}

impl SecretTool {
    async fn handle_request(
        &self,
        params: &Value,
        ctx: &crate::tools::traits::CallContext,
    ) -> Result<String, ToolError> {
        let session_id = self
            .context
            .session_id
            .lock()
            .await
            .clone()
            .ok_or_else(|| ToolError::ExecutionFailed("No session context set".into()))?;

        let label = params
            .get("label")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ToolError::InvalidParams("Missing 'label' for request".into()))?;
        let kind = params
            .get("kind")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ToolError::InvalidParams("Missing 'kind' for request".into()))?;
        let prompt = params
            .get("prompt")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ToolError::InvalidParams("Missing 'prompt' for request".into()))?;

        let request_id = format!("secret-req-{}", uuid::Uuid::new_v4());
        let tool_call_id = if ctx.call_id.is_empty() {
            None
        } else {
            Some(ctx.call_id.clone())
        };

        let receiver = self
            .context
            .broker
            .ask(
                &session_id,
                &request_id,
                label,
                kind,
                prompt,
                tool_call_id.as_deref(),
            )
            .await;

        // 5-minute backstop — matches `ask_user_questions`. Plenty of time
        // to dig a key out of a password manager.
        let cancel_flag = self.context.broker.cancel_flag();
        let outcome = await_with_cancel(
            receiver,
            cancel_flag,
            Some(crate::interaction::finalize::AutoTimeoutPolicy {
                timeout: std::time::Duration::from_secs(300),
                on_expire: Box::new(|| crate::interaction::finalize::AutoTimeoutAction::Report),
            }),
        )
        .await;

        match outcome {
            InteractionOutcome::Responded(SecretCapture::Submitted { token })
            | InteractionOutcome::AutoResponded(SecretCapture::Submitted { token }) => Ok(format!(
                "User provided '{label}'. Reference it as the placeholder \
                 {{{{secret:{token}}}}} in subsequent tool calls (today: only \
                 `write_env_file`). The plaintext was never echoed to the chat \
                 and is held in memory only until the session ends."
            )),
            InteractionOutcome::Responded(SecretCapture::Cancelled)
            | InteractionOutcome::AutoResponded(SecretCapture::Cancelled) => {
                Err(ToolError::ExecutionFailed(format!(
                    "User dismissed the secret-capture dialog for '{label}'. \
                     Ask the user how to proceed before retrying."
                )))
            }
            InteractionOutcome::Cancelled => {
                self.context
                    .broker
                    .cancel_pending(&request_id, FinalizedStatus::Cancelled)
                    .await;
                Err(ToolError::ExecutionFailed(
                    "Secret capture cancelled by user (stop).".into(),
                ))
            }
            InteractionOutcome::TimedOut => {
                self.context
                    .broker
                    .cancel_pending(&request_id, FinalizedStatus::TimedOut)
                    .await;
                Err(ToolError::Timeout(
                    "User did not submit the secret within 5 minutes.".into(),
                ))
            }
            InteractionOutcome::Dropped => Err(ToolError::ExecutionFailed(
                "Secret capture request was invalidated before the user responded.".into(),
            )),
        }
    }

    async fn handle_list(&self) -> Result<String, ToolError> {
        let entries = self.context.broker.list().await;
        if entries.is_empty() {
            return Ok("No secrets currently captured.".into());
        }
        let serialized = serde_json::to_string_pretty(&entries).map_err(|err| {
            ToolError::ExecutionFailed(format!("Failed to serialize secret listing: {err}"))
        })?;
        Ok(format!(
            "Currently captured secrets (plaintext never included):\n{serialized}"
        ))
    }

    async fn handle_discard(&self, params: &Value) -> Result<String, ToolError> {
        let raw = params
            .get("token")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ToolError::InvalidParams("Missing 'token' for discard".into()))?;
        let token = extract_token(raw);
        let removed = self.context.broker.discard(&token).await;
        if removed {
            Ok(format!("Discarded secret with token '{token}'."))
        } else {
            Ok(format!(
                "No live secret matched token '{token}' (already consumed or expired)."
            ))
        }
    }
}

/// Accept either the raw `secret-<uuid>` token or the templated form
/// `{{secret:secret-<uuid>}}` that the agent may have copied back from a
/// previous tool output.
fn extract_token(raw: &str) -> String {
    let trimmed = raw.trim();
    if let Some(inner) = trimmed
        .strip_prefix("{{secret:")
        .and_then(|s| s.strip_suffix("}}"))
    {
        inner.trim().to_string()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_token_handles_templated_form() {
        assert_eq!(extract_token("secret-abc-123"), "secret-abc-123");
        assert_eq!(extract_token("{{secret:secret-abc-123}}"), "secret-abc-123");
        assert_eq!(extract_token("  secret-abc-123  "), "secret-abc-123");
    }
}

//! Typed parsing for `agent` tool commands.

use serde_json::Value;

use crate::tools::traits::ToolError;

use super::helpers;
use super::{looks_like_valid_subagent_session_id, resolve_agent_id_for_execute, ResolvedAgentId};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum IsolationRequest {
    Configured,
    Worktree,
}

#[derive(Debug, Clone)]
pub(super) struct LaunchRequest {
    pub(super) mode: String,
    pub(super) is_shadow: bool,
    pub(super) is_background: bool,
    pub(super) prompt: String,
    pub(super) description: String,
    pub(super) resume_session_id: Option<String>,
    pub(super) agent_id: String,
    pub(super) used_agent_fallback: bool,
    pub(super) isolation: IsolationRequest,
    pub(super) explicit_model: Option<String>,
    pub(super) fork: bool,
}

pub(super) fn kill_handle(params: &Value) -> Result<Option<&str>, ToolError> {
    if params.get("command").and_then(Value::as_str) != Some("kill") {
        return Ok(None);
    }
    params
        .get("handle")
        .and_then(Value::as_str)
        .map(Some)
        .ok_or_else(|| {
            ToolError::InvalidParams("kill requires 'handle' (worker session ID)".into())
        })
}

impl LaunchRequest {
    pub(super) fn parse(params: &Value) -> Result<Self, ToolError> {
        let mode = params
            .get("mode")
            .and_then(Value::as_str)
            .unwrap_or("delegate")
            .to_string();
        let is_shadow = mode == "shadow";
        let is_background = params
            .get("background")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let prompt = params
            .get("prompt")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidParams("missing 'prompt'".into()))?
            .to_string();
        let description = params
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("subagent task")
            .to_string();
        let resume_session_id =
            helpers::optional_nonempty_string_param(params, "resume_session_id");

        if let Some(ref resume_id) = resume_session_id {
            if !looks_like_valid_subagent_session_id(resume_id) {
                return Err(ToolError::InvalidParams(format!(
                    "resume_session_id '{resume_id}' does not match the expected shape \
                     '<prefix>-<agent_id>-<uuid>'. Only pass a handle previously \
                     returned by an `agent(..., background: true)` invocation — \
                     omit this field for fresh subagents."
                )));
            }
        }

        let ResolvedAgentId {
            agent_id,
            fallback: used_agent_fallback,
        } = resolve_agent_id_for_execute(params);
        let isolation_was_provided = params.get("isolation").is_some();
        let isolation = match params.get("isolation") {
            None | Some(Value::Null) => IsolationRequest::Configured,
            Some(Value::String(value)) if value == "worktree" => IsolationRequest::Worktree,
            Some(Value::String(value)) => {
                return Err(ToolError::InvalidParams(format!(
                    "unknown isolation mode '{value}'; supported value is 'worktree'"
                )))
            }
            Some(_) => {
                return Err(ToolError::InvalidParams(
                    "isolation must be the string 'worktree' when provided".to_string(),
                ))
            }
        };
        if resume_session_id.is_some() && isolation_was_provided {
            return Err(ToolError::InvalidParams(
                "isolation cannot be changed when resuming a background subagent".to_string(),
            ));
        }

        Ok(Self {
            mode,
            is_shadow,
            is_background,
            prompt,
            description,
            resume_session_id,
            agent_id,
            used_agent_fallback,
            isolation,
            explicit_model: params
                .get("model")
                .and_then(Value::as_str)
                .map(str::to_string),
            fork: params.get("fork").and_then(Value::as_bool).unwrap_or(false),
        })
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{IsolationRequest, LaunchRequest};

    #[test]
    fn parses_fresh_foreground_shared_launch() {
        let request = LaunchRequest::parse(&json!({
            "agent_id": "builtin:general",
            "prompt": "inspect the change"
        }))
        .expect("fresh launch should parse");

        assert_eq!(request.agent_id, "builtin:general");
        assert!(!request.is_shadow);
        assert!(!request.is_background);
        assert!(request.resume_session_id.is_none());
        assert_eq!(request.isolation, IsolationRequest::Configured);
    }

    #[test]
    fn parses_shadow_background_isolated_launch() {
        let request = LaunchRequest::parse(&json!({
            "mode": "shadow",
            "background": true,
            "prompt": "continue independently",
            "isolation": "worktree",
            "fork": true
        }))
        .expect("shadow launch should parse");

        assert!(request.is_shadow);
        assert!(request.is_background);
        assert!(request.fork);
        assert_eq!(request.isolation, IsolationRequest::Worktree);
    }

    #[test]
    fn parses_resume_and_rejects_isolation_override() {
        let handle = "agent-builtin:general-550e8400-e29b-41d4-a716-446655440000";
        let resumed = LaunchRequest::parse(&json!({
            "agent_id": "builtin:general",
            "prompt": "resume",
            "resume_session_id": handle,
            "background": true
        }))
        .expect("resume should parse");
        assert_eq!(resumed.resume_session_id.as_deref(), Some(handle));
        assert!(resumed.is_background);

        let error = LaunchRequest::parse(&json!({
            "agent_id": "builtin:general",
            "prompt": "resume",
            "resume_session_id": handle,
            "isolation": "worktree"
        }))
        .expect_err("resume isolation override must fail");
        assert!(error
            .to_string()
            .contains("isolation cannot be changed when resuming"));
    }
}

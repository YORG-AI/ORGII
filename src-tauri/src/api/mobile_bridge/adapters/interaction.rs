//! Interaction RPC adapters — permission/question/plan responses.

use agent_core::interaction::permission::PermissionResponse;
use serde_json::{json, Value};
use tauri::Manager;

use crate::api::mobile_bridge::rpc::{RpcError, RpcErrorCode};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RespondPermissionParams {
    pub session_id: String,
    pub request_id: String,
    pub response: PermissionResponse,
    pub origin: String,
    pub tool_name: Option<String>,
    pub tool_args: Option<Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MobilePermissionExecution {
    NativeAgent,
    ManagedCli,
}

fn permission_execution(origin: &str) -> Option<MobilePermissionExecution> {
    match origin {
        "rust_agent" => Some(MobilePermissionExecution::NativeAgent),
        "cli_hook" | "acp" => Some(MobilePermissionExecution::ManagedCli),
        _ => None,
    }
}

fn cli_permission_decision(response: PermissionResponse) -> (bool, bool) {
    match response {
        PermissionResponse::Allow => (true, false),
        PermissionResponse::Deny => (false, false),
        PermissionResponse::AlwaysAllow => (true, true),
    }
}

/// Validate `interaction/respond_permission` params without touching desktop state.
pub fn parse_respond_permission_params(
    params: &Value,
) -> Result<RespondPermissionParams, RpcError> {
    let session_id = params
        .get("sessionId")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| RpcError::invalid_params("sessionId is required"))?
        .to_string();

    let request_id = params
        .get("requestId")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| RpcError::invalid_params("requestId is required"))?
        .to_string();

    let response_raw = params
        .get("response")
        .and_then(|value| value.as_str())
        .ok_or_else(|| RpcError::invalid_params("response is required"))?;
    let response = PermissionResponse::from_wire(response_raw).ok_or_else(|| {
        RpcError::invalid_params(format!(
            "response must be one of: {}, {}, {}",
            PermissionResponse::ALLOW_STR,
            PermissionResponse::DENY_STR,
            PermissionResponse::ALWAYS_ALLOW_STR
        ))
    })?;

    let origin = params
        .get("origin")
        .and_then(|value| value.as_str())
        .unwrap_or("rust_agent")
        .to_string();

    let tool_name = params
        .get("toolName")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    let tool_args = params.get("toolArgs").cloned();

    Ok(RespondPermissionParams {
        session_id,
        request_id,
        response,
        origin,
        tool_name,
        tool_args,
    })
}

/// Route a permission decision back to the runtime that created the prompt.
pub async fn respond_permission(params: &Value) -> Result<Value, RpcError> {
    let parsed = parse_respond_permission_params(params)?;

    let execution = permission_execution(&parsed.origin).ok_or_else(|| {
        RpcError::new(
            RpcErrorCode::InvalidParams,
            format!("unknown permission origin: {:?}", parsed.origin),
        )
    })?;

    match execution {
        MobilePermissionExecution::NativeAgent => {
            let handle = crate::api::get_app_handle().ok_or_else(|| {
                RpcError::new(RpcErrorCode::InvalidRequest, "desktop agent not ready")
            })?;
            let state = handle.state::<agent_core::state::AgentAppState>();

            let session = state.get_session(&parsed.session_id).await.ok_or_else(|| {
                RpcError::new(
                    RpcErrorCode::SessionNotFound,
                    format!("session not found: {}", parsed.session_id),
                )
            })?;

            session
                .permission_manager
                .respond(
                    &parsed.request_id,
                    parsed.response,
                    parsed.tool_name.as_deref(),
                    parsed.tool_args.as_ref(),
                )
                .await;
        }
        MobilePermissionExecution::ManagedCli => {
            let (approved, always_allow) = cli_permission_decision(parsed.response);
            crate::agent_sessions::cli::commands::cli_agent_approval_response(
                parsed.session_id.clone(),
                approved,
                Some(always_allow),
                Some(parsed.request_id.clone()),
            )
            .await
            .map_err(|err| RpcError::new(RpcErrorCode::InvalidRequest, err))?;
        }
    }

    Ok(json!({
        "accepted": true,
        "sessionId": parsed.session_id,
        "requestId": parsed.request_id,
    }))
}

pub fn respond_question(_params: &Value) -> Result<Value, RpcError> {
    Err(RpcError::method_not_found("interaction/respond_question"))
}

pub fn respond_plan_approval(_params: &Value) -> Result<Value, RpcError> {
    Err(RpcError::method_not_found(
        "interaction/respond_plan_approval",
    ))
}

pub async fn pending(params: &Value) -> Result<Value, RpcError> {
    let session_id = params
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| RpcError::invalid_params("sessionId is required"))?;
    let handle = crate::api::get_app_handle()
        .ok_or_else(|| RpcError::new(RpcErrorCode::InvalidRequest, "desktop agent not ready"))?;
    let state = handle.state::<agent_core::state::AgentAppState>();
    let session = state.get_session(session_id).await.ok_or_else(|| {
        RpcError::new(
            RpcErrorCode::SessionNotFound,
            format!("session not found: {session_id}"),
        )
    })?;
    let interactions = session
        .permission_manager
        .pending_ids()
        .await
        .into_iter()
        .map(|request_id| {
            json!({
                "kind": "permission",
                "origin": "rust_agent",
                "sessionId": session_id,
                "requestId": request_id,
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({ "interactions": interactions }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_respond_permission_params_requires_session_and_request_ids() {
        let err = parse_respond_permission_params(&json!({
            "response": "allow"
        }))
        .unwrap_err();
        assert_eq!(err.code, RpcErrorCode::InvalidParams);
    }

    #[test]
    fn parse_respond_permission_params_rejects_invalid_response() {
        let err = parse_respond_permission_params(&json!({
            "sessionId": "sde-1",
            "requestId": "perm-1",
            "response": "maybe"
        }))
        .unwrap_err();
        assert!(err.message.contains("response must be one of"));
    }

    #[test]
    fn parse_respond_permission_params_accepts_allow_deny_always_allow() {
        for response in ["allow", "deny", "always_allow"] {
            let parsed = parse_respond_permission_params(&json!({
                "sessionId": "sde-1",
                "requestId": "perm-1",
                "response": response,
                "toolName": "run_shell",
                "toolArgs": { "command": "pnpm test" }
            }))
            .expect(response);
            assert_eq!(parsed.session_id, "sde-1");
            assert_eq!(parsed.request_id, "perm-1");
            assert_eq!(parsed.origin, "rust_agent");
            assert_eq!(parsed.tool_name.as_deref(), Some("run_shell"));
        }
    }

    #[test]
    fn parse_respond_permission_params_honors_explicit_origin() {
        let parsed = parse_respond_permission_params(&json!({
            "sessionId": "sde-1",
            "requestId": "perm-1",
            "response": "allow",
            "origin": "cli_hook"
        }))
        .expect("params");
        assert_eq!(parsed.origin, "cli_hook");
    }

    #[test]
    fn permission_origin_routes_to_the_owning_runtime() {
        assert_eq!(
            permission_execution("rust_agent"),
            Some(MobilePermissionExecution::NativeAgent)
        );
        assert_eq!(
            permission_execution("cli_hook"),
            Some(MobilePermissionExecution::ManagedCli)
        );
        assert_eq!(
            permission_execution("acp"),
            Some(MobilePermissionExecution::ManagedCli)
        );
        assert_eq!(permission_execution("unknown"), None);
    }

    #[test]
    fn cli_permission_decision_preserves_allow_semantics() {
        assert_eq!(
            cli_permission_decision(PermissionResponse::Allow),
            (true, false)
        );
        assert_eq!(
            cli_permission_decision(PermissionResponse::Deny),
            (false, false)
        );
        assert_eq!(
            cli_permission_decision(PermissionResponse::AlwaysAllow),
            (true, true)
        );
    }
}

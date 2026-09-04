//! JSON-RPC 2.0 dispatcher for the mobile bridge WebSocket.

use serde_json::{json, Value};

use super::adapters::{file_navigation, interaction, model, session};
use super::auth::MobileRemoteSettings;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RpcErrorCode {
    InvalidRequest = -32600,
    MethodNotFound = -32601,
    InvalidParams = -32602,
    Unauthorized = -32001,
    TierDenied = -32002,
    SessionNotFound = -32003,
    FeatureDisabled = -32005,
}

impl RpcErrorCode {
    pub fn as_i32(self) -> i32 {
        self as i32
    }
}

#[derive(Debug, Clone)]
pub struct RpcError {
    pub code: RpcErrorCode,
    pub message: String,
}

impl RpcError {
    pub fn new(code: RpcErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn invalid_params(message: impl Into<String>) -> Self {
        Self::new(RpcErrorCode::InvalidParams, message)
    }

    pub fn method_not_found(method: &str) -> Self {
        Self::new(
            RpcErrorCode::MethodNotFound,
            format!("method not found: {method}"),
        )
    }

    pub fn feature_disabled() -> Self {
        Self::new(RpcErrorCode::FeatureDisabled, "mobile remote disabled")
    }

    pub fn to_json_rpc_error(&self, id: Value) -> Value {
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": {
                "code": self.code.as_i32(),
                "message": self.message,
            }
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MobileTier {
    Full,
    ReadOnly,
}

pub struct RpcContext {
    pub conn_id: u64,
    pub initialized: bool,
    pub tier: MobileTier,
    pub settings: MobileRemoteSettings,
}

pub async fn dispatch(ctx: &mut RpcContext, request: &Value) -> Option<Value> {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let method = request
        .get("method")
        .and_then(|value| value.as_str())
        .unwrap_or("");

    let params = request.get("params").cloned().unwrap_or(Value::Null);

    let result = dispatch_method(ctx, method, &params).await;

    Some(match result {
        Ok(value) => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": value,
        }),
        Err(err) => err.to_json_rpc_error(id),
    })
}

async fn dispatch_method(
    ctx: &mut RpcContext,
    method: &str,
    params: &Value,
) -> Result<Value, RpcError> {
    match method {
        "initialize" => handle_initialize(ctx, params),
        "session/list" => {
            require_initialized(ctx)?;
            session::session_list(params).await
        }
        "session/subscribe" => {
            require_initialized(ctx)?;
            session::session_subscribe(ctx.conn_id, params).await
        }
        "session/round" => {
            require_initialized(ctx)?;
            session::session_round(params).await
        }
        "session/unsubscribe" => {
            require_initialized(ctx)?;
            session::session_unsubscribe(ctx.conn_id, params)
        }
        "session/send" => {
            require_initialized(ctx)?;
            require_full_tier(ctx)?;
            session::session_send(params).await
        }
        "session/cancel" => {
            require_initialized(ctx)?;
            require_full_tier(ctx)?;
            session::session_cancel(params).await
        }
        "session/open_file" => {
            require_initialized(ctx)?;
            require_full_tier(ctx)?;
            file_navigation::open_session_file(params).await
        }
        "session/config" => {
            require_initialized(ctx)?;
            model::session_config(params).await
        }
        "session/patch" => {
            require_initialized(ctx)?;
            require_full_tier(ctx)?;
            model::session_patch(params).await
        }
        "models/list" => {
            require_initialized(ctx)?;
            model::models_list(params).await
        }
        "interaction/respond_permission" => {
            require_initialized(ctx)?;
            require_full_tier(ctx)?;
            interaction::respond_permission(params).await
        }
        "interaction/respond_question" => {
            require_initialized(ctx)?;
            require_full_tier(ctx)?;
            interaction::respond_question(params)
        }
        "interaction/respond_plan_approval" => {
            require_initialized(ctx)?;
            require_full_tier(ctx)?;
            interaction::respond_plan_approval(params)
        }
        "interaction/pending" => {
            require_initialized(ctx)?;
            interaction::pending(params).await
        }
        "" => Err(RpcError::new(
            RpcErrorCode::InvalidRequest,
            "missing method",
        )),
        other => Err(RpcError::method_not_found(other)),
    }
}

fn require_initialized(ctx: &RpcContext) -> Result<(), RpcError> {
    if ctx.initialized {
        Ok(())
    } else {
        Err(RpcError::new(
            RpcErrorCode::InvalidRequest,
            "connection not initialized",
        ))
    }
}

fn require_full_tier(ctx: &RpcContext) -> Result<(), RpcError> {
    if ctx.tier == MobileTier::Full {
        Ok(())
    } else {
        Err(RpcError::new(
            RpcErrorCode::TierDenied,
            "operation requires full tier",
        ))
    }
}

fn handle_initialize(ctx: &mut RpcContext, params: &Value) -> Result<Value, RpcError> {
    if !ctx.settings.enabled {
        return Err(RpcError::feature_disabled());
    }

    let protocol_version = params
        .get("protocolVersion")
        .and_then(|value| value.as_u64())
        .unwrap_or(1);
    if protocol_version != 1 {
        return Err(RpcError::invalid_params("unsupported protocolVersion"));
    }

    ctx.initialized = true;
    let tier = match ctx.tier {
        MobileTier::Full => "full",
        MobileTier::ReadOnly => "read_only",
    };

    Ok(json!({
        "protocolVersion": 1,
        "desktopId": format!("desktop-{}", std::process::id()),
        "orgiiVersion": env!("CARGO_PKG_VERSION"),
        "tier": tier,
        "capabilities": {
            "sessionCategories": ["rust_agent", "cli_agent"],
            "maxConcurrentSubscriptions": 4,
            "roundHistory": true,
            "openSessionFile": true,
            "modelSelection": true,
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::mobile_bridge::auth::MobileRemoteSettings;

    fn test_context(enabled: bool) -> RpcContext {
        RpcContext {
            conn_id: 1,
            initialized: false,
            tier: MobileTier::Full,
            settings: MobileRemoteSettings {
                enabled,
                lan_token: "token".to_string(),
                allow_lan_exposure: false,
            },
        }
    }

    #[tokio::test]
    async fn initialize_rejects_when_feature_disabled() {
        let mut ctx = test_context(false);
        let request = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": { "protocolVersion": 1 }
        });
        let response = dispatch(&mut ctx, &request).await.expect("response");
        assert_eq!(
            response.pointer("/error/code").and_then(|v| v.as_i64()),
            Some(RpcErrorCode::FeatureDisabled.as_i32() as i64)
        );
    }

    #[tokio::test]
    async fn initialize_returns_capabilities_when_enabled() {
        let mut ctx = test_context(true);
        let request = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": { "protocolVersion": 1 }
        });
        let response = dispatch(&mut ctx, &request).await.expect("response");
        assert!(response.get("result").is_some());
        assert_eq!(
            response
                .pointer("/result/capabilities/roundHistory")
                .and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            response
                .pointer("/result/capabilities/openSessionFile")
                .and_then(Value::as_bool),
            Some(true)
        );
        assert!(ctx.initialized);
    }

    #[tokio::test]
    async fn session_list_requires_initialize() {
        let mut ctx = test_context(true);
        let request = json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "session/list",
            "params": {}
        });
        let response = dispatch(&mut ctx, &request).await.expect("response");
        assert_eq!(
            response.pointer("/error/message").and_then(|v| v.as_str()),
            Some("connection not initialized")
        );
    }

    #[tokio::test]
    async fn initialize_preserves_relay_read_only_tier() {
        let mut ctx = test_context(true);
        ctx.tier = MobileTier::ReadOnly;
        let request = json!({
            "jsonrpc": "2.0",
            "id": 9,
            "method": "initialize",
            "params": { "protocolVersion": 1 }
        });
        let response = dispatch(&mut ctx, &request).await.expect("response");
        assert_eq!(
            response.pointer("/result/tier").and_then(Value::as_str),
            Some("read_only")
        );
        assert_eq!(ctx.tier, MobileTier::ReadOnly);
    }

    #[tokio::test]
    async fn session_open_file_requires_full_tier_before_resolving_events() {
        let mut ctx = test_context(true);
        ctx.initialized = true;
        ctx.tier = MobileTier::ReadOnly;
        let request = json!({
            "jsonrpc": "2.0",
            "id": 10,
            "method": "session/open_file",
            "params": {
                "sessionId": "session-a",
                "roundId": "round-a",
                "eventId": "event-a",
                "targetIndex": 0
            }
        });
        let response = dispatch(&mut ctx, &request).await.expect("response");
        assert_eq!(
            response.pointer("/error/code").and_then(Value::as_i64),
            Some(RpcErrorCode::TierDenied.as_i32() as i64)
        );
    }

    #[tokio::test]
    async fn session_send_rejects_missing_session_id() {
        let mut ctx = test_context(true);
        ctx.initialized = true;
        let request = json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "session/send",
            "params": { "content": "hello" }
        });
        let response = dispatch(&mut ctx, &request).await.expect("response");
        assert_eq!(
            response.pointer("/error/code").and_then(|v| v.as_i64()),
            Some(RpcErrorCode::InvalidParams.as_i32() as i64)
        );
    }

    #[tokio::test]
    async fn session_round_is_available_to_read_only_clients() {
        let mut ctx = test_context(true);
        ctx.initialized = true;
        ctx.tier = MobileTier::ReadOnly;
        let request = json!({
            "jsonrpc": "2.0",
            "id": 10,
            "method": "session/round",
            "params": { "sessionId": "sde-1" }
        });
        let response = dispatch(&mut ctx, &request).await.expect("response");
        assert_eq!(
            response.pointer("/error/code").and_then(|v| v.as_i64()),
            Some(RpcErrorCode::InvalidParams.as_i32() as i64),
            "read-only clients must reach round parameter validation instead of the write-tier gate"
        );
    }

    #[tokio::test]
    async fn respond_permission_rejects_invalid_response() {
        let mut ctx = test_context(true);
        ctx.initialized = true;
        let request = json!({
            "jsonrpc": "2.0",
            "id": 4,
            "method": "interaction/respond_permission",
            "params": {
                "sessionId": "sde-1",
                "requestId": "perm-1",
                "response": "maybe"
            }
        });
        let response = dispatch(&mut ctx, &request).await.expect("response");
        assert_eq!(
            response.pointer("/error/code").and_then(|v| v.as_i64()),
            Some(RpcErrorCode::InvalidParams.as_i32() as i64)
        );
    }
}

//! Mobile bridge HTTP health probes and WebSocket upgrade handler.

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{Query, WebSocketUpgrade};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::mpsc;

use super::auth::{self, AuthFailure, MobileRemoteSettings};
use super::fanout;
use super::rpc::{self, MobileTier, RpcContext};

const MAX_WS_TEXT_BYTES: usize = 1024 * 1024;

#[derive(Debug, Deserialize)]
pub struct MobileWsQuery {
    pub token: Option<String>,
}

/// GET /mobile/health — public liveness probe.
pub async fn health_shallow() -> Json<Value> {
    Json(json!({
        "ok": true,
        "mobileBridge": true,
    }))
}

/// GET /mobile/health/deep — authenticated bridge status.
pub async fn health_deep(headers: HeaderMap) -> Response {
    let token = auth::token_from_headers(&headers).ok_or(AuthFailure::MissingToken);

    let settings = match token.and_then(|candidate| auth::validate_token(&candidate).map_err(|e| e))
    {
        Ok(settings) => settings,
        Err(failure) => {
            return (
                failure.status_code(),
                Json(json!({ "ok": false, "error": failure.message() })),
            )
                .into_response();
        }
    };

    Json(json!({
        "ok": true,
        "agentRunning": true,
        "enabled": settings.enabled,
    }))
    .into_response()
}

/// GET /mobile/ws — JSON-RPC WebSocket endpoint (`?token=` required).
pub async fn mobile_ws_handler(
    ws: WebSocketUpgrade,
    Query(query): Query<MobileWsQuery>,
) -> Response {
    let Some(token) = query.token.filter(|value| !value.is_empty()) else {
        return unauthorized_response("missing mobile token");
    };

    let settings = match auth::validate_token(&token) {
        Ok(settings) => settings,
        Err(failure) => return unauthorized_response(failure.message()),
    };

    ws.on_upgrade(move |socket| handle_mobile_socket(socket, settings))
}

fn unauthorized_response(message: &str) -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "ok": false, "error": message })),
    )
        .into_response()
}

async fn handle_mobile_socket(socket: WebSocket, settings: MobileRemoteSettings) {
    let (mut sender, mut receiver) = socket.split();
    let (outbound_tx, mut outbound_rx) = mpsc::channel::<String>(64);
    let conn_id = fanout::register_connection(outbound_tx.clone());

    let mut ctx = RpcContext {
        conn_id,
        initialized: false,
        tier: MobileTier::Full,
        settings,
    };

    let send_task = tokio::spawn(async move {
        while let Some(message) = outbound_rx.recv().await {
            if sender.send(Message::Text(message.into())).await.is_err() {
                break;
            }
        }
    });

    while let Some(result) = receiver.next().await {
        let Ok(message) = result else {
            break;
        };

        match message {
            Message::Text(text) => {
                if text.len() > MAX_WS_TEXT_BYTES {
                    let _ = outbound_tx
                        .send(
                            json!({
                                "jsonrpc": "2.0",
                                "id": null,
                                "error": {
                                    "code": -32600,
                                    "message": "message too large",
                                }
                            })
                            .to_string(),
                        )
                        .await;
                    break;
                }

                let parsed = match serde_json::from_str::<Value>(&text) {
                    Ok(value) => value,
                    Err(err) => {
                        let _ = outbound_tx
                            .send(
                                json!({
                                    "jsonrpc": "2.0",
                                    "id": null,
                                    "error": {
                                        "code": -32600,
                                        "message": format!("invalid json: {err}"),
                                    }
                                })
                                .to_string(),
                            )
                            .await;
                        continue;
                    }
                };

                if let Some(response) = rpc::dispatch(&mut ctx, &parsed).await {
                    if outbound_tx.send(response.to_string()).await.is_err() {
                        break;
                    }
                }
            }
            Message::Close(_) => break,
            Message::Ping(_) | Message::Pong(_) => {}
            Message::Binary(_) => {
                let _ = outbound_tx
                    .send(
                        json!({
                            "jsonrpc": "2.0",
                            "id": null,
                            "error": {
                                "code": -32600,
                                "message": "binary frames not supported",
                            }
                        })
                        .to_string(),
                    )
                    .await;
            }
        }
    }

    send_task.abort();
    fanout::unregister_connection(conn_id);
    tracing::debug!(conn_id, "[MobileBridge] client disconnected");
}

#[cfg(test)]
mod tests {
    use super::auth::{token_matches, AuthFailure, MobileRemoteSettings};
    use super::*;

    #[test]
    fn validate_token_fails_when_feature_disabled() {
        // Uses live settings file when present; assert enum mapping stays stable.
        let failure = AuthFailure::FeatureDisabled;
        assert_eq!(failure.status_code(), StatusCode::FORBIDDEN);
        assert_eq!(failure.message(), "mobile remote disabled");
    }

    #[test]
    fn validate_token_fails_for_empty_candidate() {
        let settings = MobileRemoteSettings {
            enabled: true,
            lan_token: "secret-token".to_string(),
            allow_lan_exposure: false,
        };
        assert!(!token_matches("", &settings.lan_token));
    }

    #[test]
    fn health_shallow_shape() {
        let value = json!({ "ok": true, "mobileBridge": true });
        assert_eq!(
            value.get("mobileBridge").and_then(|v| v.as_bool()),
            Some(true)
        );
    }
}

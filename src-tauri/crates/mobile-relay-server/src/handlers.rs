use std::collections::HashMap;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use base64::Engine;
use mobile_relay_protocol::{
    pairing_notification, presence_notification, rpc_error, PairedDeviceInfo,
    PairingCompleteRequest, PairingInitRequest, PairingInitResponse, RelayWireFrame,
    RevokeDeviceRequest, SetPrimaryDesktopRequest, RELAY_PROTOCOL_VERSION,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::state::{
    now_ms, MobileAuth, MobilePeer, PairingOutcome, RelayState, SocketCommand, MAX_FRAME_BYTES,
    OUTBOUND_QUEUE_CAPACITY,
};

const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSocketQuery {
    desktop_id: String,
    token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileSocketQuery {
    token: String,
    pairing_code: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceListQuery {
    desktop_id: String,
}

pub async fn health() -> Json<Value> {
    Json(json!({
        "ok": true,
        "protocolVersion": RELAY_PROTOCOL_VERSION,
    }))
}

pub async fn create_pairing(
    State(state): State<RelayState>,
    headers: HeaderMap,
    Json(request): Json<PairingInitRequest>,
) -> Response {
    if !is_authorized(&state, &headers) {
        return unauthorized_response();
    }
    if request.desktop_id.trim().is_empty() || request.desktop_id.len() > 128 {
        return api_error(
            StatusCode::BAD_REQUEST,
            "invalid_desktop_id",
            "desktopId is required",
        );
    }
    if request.label.trim().is_empty() || request.label.len() > 80 {
        return api_error(
            StatusCode::BAD_REQUEST,
            "invalid_label",
            "label must contain 1-80 characters",
        );
    }

    match state
        .create_pairing(
            request.desktop_id,
            request.label,
            request.tier,
            request.is_primary,
        )
        .await
    {
        Ok(pairing) => {
            let qr_payload = json!({
                "v": RELAY_PROTOCOL_VERSION,
                "relayUrl": state.config.public_ws_url,
                "pairingCode": pairing.pairing_code,
                "desktopId": pairing.desktop_id,
                "tier": pairing.requested_tier,
                "expiresAt": pairing.expires_at_ms,
                "deviceToken": pairing.device_token,
                "sasPhrase": pairing.confirmation_phrase,
            });
            let encoded_payload =
                base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(qr_payload.to_string());
            let qr_url = format!(
                "{}#pair={encoded_payload}",
                state.config.public_app_url.trim_end_matches('#')
            );
            Json(PairingInitResponse {
                pairing_code: pairing.pairing_code.clone(),
                confirmation_phrase: pairing.confirmation_phrase.clone(),
                qr_payload: qr_url,
                expires_in_seconds: state.config.pairing_ttl_seconds,
            })
            .into_response()
        }
        Err(message) => api_error(StatusCode::TOO_MANY_REQUESTS, "pairing_limit", &message),
    }
}

pub async fn complete_pairing(
    State(state): State<RelayState>,
    headers: HeaderMap,
    Json(request): Json<PairingCompleteRequest>,
) -> Response {
    if !is_authorized(&state, &headers) {
        return unauthorized_response();
    }
    match state
        .complete_pairing(&request.pairing_code, request.tier)
        .await
    {
        Ok(device) => Json(device).into_response(),
        Err(message) => api_error(StatusCode::NOT_FOUND, "pairing_not_found", &message),
    }
}

pub async fn list_devices(
    State(state): State<RelayState>,
    headers: HeaderMap,
    Query(query): Query<DeviceListQuery>,
) -> Response {
    if !is_authorized(&state, &headers) {
        return unauthorized_response();
    }
    match state.store.list_active(query.desktop_id).await {
        Ok(devices) => Json(devices).into_response(),
        Err(message) => api_error(StatusCode::INTERNAL_SERVER_ERROR, "store_error", &message),
    }
}

pub async fn revoke_device(
    State(state): State<RelayState>,
    headers: HeaderMap,
    Json(request): Json<RevokeDeviceRequest>,
) -> Response {
    if !is_authorized(&state, &headers) {
        return unauthorized_response();
    }
    match state
        .store
        .revoke(request.device_id.clone(), now_ms())
        .await
    {
        Ok(true) => {
            state
                .disconnect_device(&request.device_id, "device access was revoked")
                .await;
            Json(json!({ "revoked": true })).into_response()
        }
        Ok(false) => api_error(
            StatusCode::NOT_FOUND,
            "device_not_found",
            "device is not active",
        ),
        Err(message) => api_error(StatusCode::INTERNAL_SERVER_ERROR, "store_error", &message),
    }
}

pub async fn set_primary_desktop(
    State(state): State<RelayState>,
    headers: HeaderMap,
    Json(request): Json<SetPrimaryDesktopRequest>,
) -> Response {
    if !is_authorized(&state, &headers) {
        return unauthorized_response();
    }
    match state.store.set_primary_desktop(request.desktop_id).await {
        Ok(()) => Json(json!({ "updated": true })).into_response(),
        Err(message) => api_error(StatusCode::INTERNAL_SERVER_ERROR, "store_error", &message),
    }
}

pub async fn desktop_socket(
    ws: WebSocketUpgrade,
    State(state): State<RelayState>,
    Query(query): Query<DesktopSocketQuery>,
) -> Response {
    if !state.desktop_token_matches(&query.token) {
        return api_error(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "invalid desktop token",
        );
    }
    if query.desktop_id.trim().is_empty() || query.desktop_id.len() > 128 {
        return api_error(
            StatusCode::BAD_REQUEST,
            "invalid_desktop_id",
            "desktopId is required",
        );
    }
    ws.on_upgrade(move |socket| run_desktop_socket(socket, state, query.desktop_id))
}

pub async fn mobile_socket(
    ws: WebSocketUpgrade,
    State(state): State<RelayState>,
    Query(query): Query<MobileSocketQuery>,
) -> Response {
    let auth = match state
        .authenticate_mobile(query.token, query.pairing_code)
        .await
    {
        Ok(auth) => auth,
        Err(message) => return api_error(StatusCode::UNAUTHORIZED, "unauthorized", &message),
    };
    ws.on_upgrade(move |socket| run_mobile_socket(socket, state, auth))
}

async fn run_desktop_socket(mut socket: WebSocket, state: RelayState, desktop_id: String) {
    let connection_id = Uuid::new_v4().to_string();
    let (tx, mut rx) = mpsc::channel(OUTBOUND_QUEUE_CAPACITY);
    let previous = match state
        .register_desktop(desktop_id.clone(), connection_id.clone(), tx.clone())
        .await
    {
        Ok(previous) => previous,
        Err(message) => {
            let _ = send_command(
                &mut socket,
                SocketCommand::Close {
                    code: 1013,
                    reason: message,
                },
            )
            .await;
            return;
        }
    };
    if let Some(previous) = previous {
        let _ = previous
            .tx
            .send(SocketCommand::Close {
                code: 1008,
                reason: "desktop connected from another client".to_string(),
            })
            .await;
    }

    if send_command(
        &mut socket,
        SocketCommand::Relay(RelayWireFrame::DesktopRegistered {
            desktop_id: desktop_id.clone(),
            protocol_version: RELAY_PROTOCOL_VERSION,
        }),
    )
    .await
    .is_err()
    {
        state
            .remove_desktop_if_current(&desktop_id, &connection_id)
            .await;
        return;
    }

    for mobile in state.mobiles_for_desktop(&desktop_id).await {
        let _ = tx
            .send(SocketCommand::Relay(RelayWireFrame::MobileConnected {
                connection_id: mobile.connection_id.clone(),
                device: mobile.device.clone(),
            }))
            .await;
        let _ = mobile
            .tx
            .send(SocketCommand::Json(presence_notification(
                &desktop_id,
                true,
            )))
            .await;
    }

    let mut heartbeat = tokio::time::interval(HEARTBEAT_INTERVAL);
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(message)) => {
                        if !handle_desktop_message(&state, &desktop_id, &tx, message).await {
                            break;
                        }
                    }
                    _ => break,
                }
            }
            outbound = rx.recv() => {
                match outbound {
                    Some(command) => {
                        let closes = matches!(command, SocketCommand::Close { .. });
                        if send_command(&mut socket, command).await.is_err() || closes {
                            break;
                        }
                    }
                    None => break,
                }
            }
            _ = heartbeat.tick() => {
                if socket.send(Message::Ping(Vec::new().into())).await.is_err() {
                    break;
                }
            }
        }
    }

    if state
        .remove_desktop_if_current(&desktop_id, &connection_id)
        .await
    {
        for mobile in state.mobiles_for_desktop(&desktop_id).await {
            let _ = mobile
                .tx
                .send(SocketCommand::Json(presence_notification(
                    &desktop_id,
                    false,
                )))
                .await;
        }
    }
}

async fn handle_desktop_message(
    state: &RelayState,
    desktop_id: &str,
    outbound: &mpsc::Sender<SocketCommand>,
    message: Message,
) -> bool {
    match message {
        Message::Text(text) if text.len() <= MAX_FRAME_BYTES => {
            let Ok(RelayWireFrame::DesktopFrame {
                connection_id,
                payload,
            }) = serde_json::from_str::<RelayWireFrame>(&text)
            else {
                return true;
            };
            if let Some(mobile) = state.mobile_peer(&connection_id).await {
                if mobile.device.desktop_id == desktop_id {
                    let _ = mobile.tx.try_send(SocketCommand::Json(payload));
                }
            }
            true
        }
        Message::Ping(payload) => outbound
            .try_send(SocketCommand::Pong(payload.to_vec()))
            .is_ok(),
        Message::Close(_) => false,
        _ => true,
    }
}

async fn run_mobile_socket(mut socket: WebSocket, state: RelayState, auth: MobileAuth) {
    let (device, approval_code) = match auth {
        MobileAuth::Active(device) => (device, String::new()),
        MobileAuth::Pending(pending) => {
            let _ = socket
                .send(Message::text(
                    pairing_notification("pairing/pending", &pending.pairing_code).to_string(),
                ))
                .await;
            let wait_ms = pending.expires_at_ms.saturating_sub(now_ms()).max(1) as u64;
            let mut outcome_rx = pending.outcome_rx;
            let timeout = tokio::time::sleep(Duration::from_millis(wait_ms));
            tokio::pin!(timeout);
            loop {
                tokio::select! {
                    changed = outcome_rx.changed() => {
                        if changed.is_err() {
                            let _ = socket.send(Message::Close(None)).await;
                            return;
                        }
                        let outcome = outcome_rx.borrow().clone();
                        if let PairingOutcome::Approved(device) = outcome {
                            break (device, pending.pairing_code.clone());
                        }
                    }
                    incoming = socket.recv() => {
                        match incoming {
                            Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return,
                            Some(Ok(Message::Ping(payload))) => {
                                if socket.send(Message::Pong(payload)).await.is_err() {
                                    return;
                                }
                            }
                            _ => {}
                        }
                    }
                    _ = &mut timeout => {
                        let _ = socket.send(Message::Close(Some(axum::extract::ws::CloseFrame {
                            code: 1008,
                            reason: "pairing expired".into(),
                        }))).await;
                        return;
                    }
                }
            }
        }
    };

    let _ = socket
        .send(Message::text(
            pairing_notification("pairing/approved", &approval_code).to_string(),
        ))
        .await;

    let connection_id = Uuid::new_v4().to_string();
    let (tx, mut rx) = mpsc::channel(OUTBOUND_QUEUE_CAPACITY);
    let peer = MobilePeer {
        connection_id: connection_id.clone(),
        device: device.clone(),
        tx: tx.clone(),
    };
    if let Err(message) = state.register_mobile(peer).await {
        let _ = send_command(
            &mut socket,
            SocketCommand::Close {
                code: 1013,
                reason: message,
            },
        )
        .await;
        return;
    }
    let _ = state.store.touch(device.device_id.clone(), now_ms()).await;

    if let Some(desktop) = state.desktop_peer(&device.desktop_id).await {
        let _ = desktop
            .tx
            .send(SocketCommand::Relay(RelayWireFrame::MobileConnected {
                connection_id: connection_id.clone(),
                device: device.clone(),
            }))
            .await;
        let _ = tx
            .send(SocketCommand::Json(presence_notification(
                &device.desktop_id,
                true,
            )))
            .await;
    } else {
        let _ = tx
            .send(SocketCommand::Json(presence_notification(
                &device.desktop_id,
                false,
            )))
            .await;
    }

    let mut heartbeat = tokio::time::interval(HEARTBEAT_INTERVAL);
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(message)) => {
                        if !handle_mobile_message(&state, &device, &connection_id, &mut socket, message).await {
                            break;
                        }
                    }
                    _ => break,
                }
            }
            outbound = rx.recv() => {
                match outbound {
                    Some(command) => {
                        let closes = matches!(command, SocketCommand::Close { .. });
                        if send_command(&mut socket, command).await.is_err() || closes {
                            break;
                        }
                    }
                    None => break,
                }
            }
            _ = heartbeat.tick() => {
                if socket.send(Message::Ping(Vec::new().into())).await.is_err() {
                    break;
                }
            }
        }
    }

    state.remove_mobile_if_current(&connection_id).await;
    if let Some(desktop) = state.desktop_peer(&device.desktop_id).await {
        let _ = desktop
            .tx
            .send(SocketCommand::Relay(RelayWireFrame::MobileDisconnected {
                connection_id,
            }))
            .await;
    }
}

async fn handle_mobile_message(
    state: &RelayState,
    device: &PairedDeviceInfo,
    connection_id: &str,
    socket: &mut WebSocket,
    message: Message,
) -> bool {
    match message {
        Message::Text(text) if text.len() <= MAX_FRAME_BYTES => {
            let Ok(payload) = serde_json::from_str::<Value>(&text) else {
                return true;
            };
            if let Some(desktop) = state.desktop_peer(&device.desktop_id).await {
                if desktop
                    .tx
                    .try_send(SocketCommand::Relay(RelayWireFrame::MobileFrame {
                        connection_id: connection_id.to_string(),
                        payload: payload.clone(),
                    }))
                    .is_err()
                {
                    send_rpc_failure(socket, &payload, -32007, "desktop is busy").await;
                }
            } else {
                send_rpc_failure(socket, &payload, -32006, "desktop is offline").await;
            }
            true
        }
        Message::Text(_) => {
            let _ = socket
                .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                    code: 1009,
                    reason: "message is too large".into(),
                })))
                .await;
            false
        }
        Message::Ping(payload) => socket.send(Message::Pong(payload)).await.is_ok(),
        Message::Close(_) => false,
        _ => true,
    }
}

async fn send_rpc_failure(socket: &mut WebSocket, payload: &Value, code: i32, message: &str) {
    if let Some(id) = payload.get("id") {
        let _ = socket
            .send(Message::text(
                rpc_error(id.clone(), code, message).to_string(),
            ))
            .await;
    }
}

async fn send_command(socket: &mut WebSocket, command: SocketCommand) -> Result<(), ()> {
    let message = command.into_message().map_err(|_| ())?;
    socket.send(message).await.map_err(|_| ())
}

fn is_authorized(state: &RelayState, headers: &HeaderMap) -> bool {
    let token = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or_default();
    state.desktop_token_matches(token)
}

fn unauthorized_response() -> Response {
    api_error(
        StatusCode::UNAUTHORIZED,
        "unauthorized",
        "invalid desktop token",
    )
}

fn api_error(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        Json(json!({ "error": { "code": code, "message": message } })),
    )
        .into_response()
}

#[allow(dead_code)]
fn _query_without_unknown_fields(query: HashMap<String, String>) -> HashMap<String, String> {
    query
}

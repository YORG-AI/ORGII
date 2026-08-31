use std::time::Duration;

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use mobile_relay_protocol::{
    PairedDeviceInfo, PairingInitResponse, RelayWireFrame, RELAY_PROTOCOL_VERSION,
};
use orgii_mobile_relay::config::RelayConfig;
use orgii_mobile_relay::{build_router, build_state};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

const DESKTOP_TOKEN: &str = "12345678901234567890123456789012";

#[tokio::test]
async fn pairing_routes_opaque_rpc_and_revoke_closes_the_phone() {
    let _ = tokio_rustls::rustls::crypto::ring::default_provider().install_default();
    let directory = tempfile::tempdir().expect("temp directory");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind listener");
    let address = listener.local_addr().expect("listener address");
    let config = RelayConfig {
        listen_addr: address,
        database_path: directory.path().join("relay.sqlite3"),
        desktop_token: DESKTOP_TOKEN.to_string(),
        public_ws_url: format!("ws://{address}/v1/mobile/ws"),
        public_app_url: format!("http://{address}/orgii/mobile"),
        pairing_ttl_seconds: 120,
    };
    let router = build_router(build_state(config).expect("relay state"));
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.expect("serve relay");
    });

    let http = reqwest::Client::new();
    let base = format!("http://{address}");
    let pairing = http
        .post(format!("{base}/v1/pairings"))
        .bearer_auth(DESKTOP_TOKEN)
        .json(&json!({
            "desktopId": "desktop-a",
            "label": "Outdoor phone",
            "tier": "full",
            "isPrimary": true,
        }))
        .send()
        .await
        .expect("pairing request")
        .error_for_status()
        .expect("pairing status")
        .json::<PairingInitResponse>()
        .await
        .expect("pairing response");
    assert!(pairing
        .qr_payload
        .starts_with(&format!("http://{address}/orgii/mobile#pair=")));
    let encoded = pairing
        .qr_payload
        .split_once("#pair=")
        .expect("pair fragment")
        .1;
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .expect("decode pair fragment");
    let payload: Value = serde_json::from_slice(&decoded).expect("pair payload JSON");
    assert_eq!(payload["v"], RELAY_PROTOCOL_VERSION);
    let device_token = payload["deviceToken"].as_str().expect("device token");

    let pending_url = format!(
        "ws://{address}/v1/mobile/ws?token={}&pairingCode={}",
        encode_query(device_token),
        encode_query(&pairing.pairing_code),
    );
    let (mut mobile, _) = tokio_tungstenite::connect_async(&pending_url)
        .await
        .expect("pending mobile socket");
    let pending = next_json(&mut mobile).await;
    assert_eq!(pending["method"], "pairing/pending");

    let device = http
        .post(format!("{base}/v1/pairings/complete"))
        .bearer_auth(DESKTOP_TOKEN)
        .json(&json!({
            "pairingCode": pairing.pairing_code,
            "tier": "full",
        }))
        .send()
        .await
        .expect("complete request")
        .error_for_status()
        .expect("complete status")
        .json::<PairedDeviceInfo>()
        .await
        .expect("complete response");
    assert_eq!(device.label, "Outdoor phone");
    assert_eq!(next_json(&mut mobile).await["method"], "pairing/approved");
    assert_eq!(next_json(&mut mobile).await["params"]["online"], false);

    let desktop_url =
        format!("ws://{address}/v1/desktop/ws?desktopId=desktop-a&token={DESKTOP_TOKEN}");
    let (mut desktop, _) = tokio_tungstenite::connect_async(desktop_url)
        .await
        .expect("desktop socket");
    assert!(matches!(
        next_relay_frame(&mut desktop).await,
        RelayWireFrame::DesktopRegistered { .. }
    ));
    let connection_id = match next_relay_frame(&mut desktop).await {
        RelayWireFrame::MobileConnected { connection_id, .. } => connection_id,
        other => panic!("expected mobile-connected frame, got {other:?}"),
    };
    assert_eq!(next_json(&mut mobile).await["params"]["online"], true);

    let rpc_request = json!({
        "jsonrpc": "2.0",
        "id": 7,
        "method": "session/list",
        "params": {},
    });
    mobile
        .send(Message::Text(rpc_request.to_string().into()))
        .await
        .expect("send mobile RPC");
    match next_relay_frame(&mut desktop).await {
        RelayWireFrame::MobileFrame {
            connection_id: routed,
            payload,
        } => {
            assert_eq!(routed, connection_id);
            assert_eq!(payload, rpc_request);
        }
        other => panic!("expected mobile frame, got {other:?}"),
    }

    let rpc_response = json!({ "jsonrpc": "2.0", "id": 7, "result": { "sessions": [] } });
    desktop
        .send(Message::Text(
            serde_json::to_string(&RelayWireFrame::DesktopFrame {
                connection_id,
                payload: rpc_response.clone(),
            })
            .expect("encode desktop frame")
            .into(),
        ))
        .await
        .expect("send desktop response");
    assert_eq!(next_json(&mut mobile).await, rpc_response);

    http.post(format!("{base}/v1/devices/revoke"))
        .bearer_auth(DESKTOP_TOKEN)
        .json(&json!({ "deviceId": device.device_id }))
        .send()
        .await
        .expect("revoke request")
        .error_for_status()
        .expect("revoke status");
    loop {
        let close = tokio::time::timeout(Duration::from_secs(2), mobile.next())
            .await
            .expect("revoke close timeout")
            .expect("mobile close frame")
            .expect("mobile close message");
        match close {
            Message::Close(_) => break,
            Message::Ping(payload) => mobile
                .send(Message::Pong(payload))
                .await
                .expect("revoke pong"),
            _ => {}
        }
    }

    let revoked_url = format!(
        "ws://{address}/v1/mobile/ws?token={}",
        encode_query(device_token)
    );
    assert!(tokio_tungstenite::connect_async(revoked_url).await.is_err());
    server.abort();
}

fn encode_query(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

async fn next_json<S>(socket: &mut tokio_tungstenite::WebSocketStream<S>) -> Value
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    loop {
        let message = tokio::time::timeout(Duration::from_secs(2), socket.next())
            .await
            .expect("JSON frame timeout")
            .expect("JSON frame")
            .expect("JSON message");
        match message {
            Message::Text(text) => return serde_json::from_str(&text).expect("JSON frame"),
            Message::Ping(payload) => socket
                .send(Message::Pong(payload))
                .await
                .expect("send pong"),
            other => panic!("expected text frame, got {other:?}"),
        }
    }
}

async fn next_relay_frame<S>(socket: &mut tokio_tungstenite::WebSocketStream<S>) -> RelayWireFrame
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    serde_json::from_value(next_json(socket).await).expect("relay frame")
}

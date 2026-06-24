//! Main WebSocket receive loop with reconnection and fragment reassembly.
//!
//! Protocol (from Go SDK analysis):
//! - All frames are binary protobuf `Frame` messages.
//! - Inbound events: `method=1` (Data), header `type=event`, payload = JSON event.
//! - Pong:           `method=0` (Control), header `type=pong`.
//! - We must send a response frame back after handling each data frame.
//! - Ping is sent as `method=0` (Control), header `type=ping`.

use reqwest::Client;
use serde_json::Value;
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, RwLock};
use tracing::{debug, error, info, warn};

use super::channel::{self, WsClientConfig};
use super::codec::*;
use super::event::{self, FeishuEventConfig};
use crate::bus::InboundMessage;

#[allow(clippy::too_many_arguments)]
pub(super) async fn feishu_ws_loop(
    initial_ws_url: String,
    initial_config: Option<WsClientConfig>,
    app_id: String,
    app_secret: String,
    api_base: String,
    http_client: Client,
    running: Arc<AtomicBool>,
    ws_connected: Arc<AtomicBool>,
    last_error: Arc<RwLock<Option<String>>>,
    inbound_tx: mpsc::Sender<InboundMessage>,
    channel_name: String,
    event_config: FeishuEventConfig,
) {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message as WsMessage;

    let mut ws_url = initial_ws_url;
    let mut ping_interval_secs = initial_config
        .as_ref()
        .map(|c| c.ping_interval_secs)
        .unwrap_or(120);
    let mut reconnect_interval_secs = initial_config
        .as_ref()
        .map(|c| c.reconnect_interval_secs)
        .unwrap_or(120);
    let mut dedup_set: HashSet<String> = HashSet::new();
    let mut dedup_order: Vec<String> = Vec::new();

    fn extract_service_id(url_str: &str) -> i32 {
        url::Url::parse(url_str)
            .ok()
            .and_then(|u| {
                u.query_pairs()
                    .find(|(k, _)| k == "service_id")
                    .and_then(|(_, v)| v.parse().ok())
            })
            .unwrap_or(0)
    }

    #[allow(clippy::type_complexity)]
    let mut fragment_cache: std::collections::HashMap<String, (usize, Vec<Option<Vec<u8>>>)> =
        std::collections::HashMap::new();

    while running.load(Ordering::Relaxed) {
        info!("[{}] Connecting to Feishu WebSocket...", channel_name);

        let ws_result = tokio_tungstenite::connect_async(&ws_url).await;
        let (ws_stream, _) = match ws_result {
            Ok(conn) => conn,
            Err(err) => {
                let err_msg = format!("WS connect failed: {}", err);
                error!("[{}] {}", channel_name, err_msg);
                ws_connected.store(false, Ordering::Relaxed);
                *last_error.write().await = Some(err_msg);
                match channel::request_ws_endpoint(&app_id, &app_secret, &api_base, &http_client)
                    .await
                {
                    Ok((new_url, new_config)) => {
                        ws_url = new_url;
                        if let Some(conf) = new_config {
                            ping_interval_secs = conf.ping_interval_secs;
                            reconnect_interval_secs = conf.reconnect_interval_secs;
                        }
                    }
                    Err(err) => warn!("[{}] Failed to refresh WS URL: {}", channel_name, err),
                }
                tokio::time::sleep(Duration::from_secs(reconnect_interval_secs)).await;
                continue;
            }
        };

        let service_id = extract_service_id(&ws_url);
        info!(
            "[{}] WebSocket connected (service_id={})",
            channel_name, service_id
        );
        ws_connected.store(true, Ordering::Relaxed);
        *last_error.write().await = None;

        let (mut ws_sink, mut ws_stream_rx) = ws_stream.split();

        let ping_running = running.clone();
        let ping_channel = channel_name.clone();
        let ping_interval = Duration::from_secs(ping_interval_secs);
        let (ping_tx, mut ping_rx) = mpsc::channel::<Vec<u8>>(4);

        let ping_handle = tokio::spawn(async move {
            // 飞书 ws/v2：连上后立即发首个 ping 建立活跃心跳（对齐官方 SDK 行为）。
            // 原实现先 sleep(120s) 再 ping，飞书可能视连接为未就绪/不活跃而不推送事件。
            {
                let frame = PbFrame::new_ping(service_id);
                let encoded = frame.encode();
                if ping_tx.send(encoded).await.is_err() {
                    return;
                }
                debug!("[{}] initial ping sent", ping_channel);
            }
            loop {
                tokio::time::sleep(ping_interval).await;
                if !ping_running.load(Ordering::Relaxed) {
                    break;
                }
                let frame = PbFrame::new_ping(service_id);
                let encoded = frame.encode();
                if ping_tx.send(encoded).await.is_err() {
                    break;
                }
                debug!("[{}] ping sent", ping_channel);
            }
        });

        let mut connection_alive = true;
        while running.load(Ordering::Relaxed) && connection_alive {
            tokio::select! {
                Some(ping_data) = ping_rx.recv() => {
                    if let Err(err) = ws_sink.send(WsMessage::Binary(ping_data.into())).await {
                        warn!("[{}] Failed to send ping: {}", channel_name, err);
                        connection_alive = false;
                    }
                }
                msg = ws_stream_rx.next() => {
                    match msg {
                        Some(Ok(WsMessage::Binary(data))) => {
                            let frame = match PbFrame::decode(&data) {
                                Some(f) => f,
                                None => {
                                    warn!("[{}] Failed to decode protobuf frame ({} bytes)", channel_name, data.len());
                                    continue;
                                }
                            };

                            let frame_type = frame.method;
                            let msg_type = frame.header("type").unwrap_or("").to_string();
                            debug!("[{}] WS frame: method={} type={} headers={}", channel_name, frame_type, msg_type, frame.headers.len());

                            match (frame_type, msg_type.as_str()) {
                                (FRAME_TYPE_CONTROL, MSG_TYPE_PONG) => {
                                    debug!("[{}] received pong", channel_name);
                                    if !frame.payload.is_empty() {
                                        if let Ok(conf) = serde_json::from_slice::<Value>(&frame.payload) {
                                            if let Some(pi) = conf.get("PingInterval").and_then(|v| v.as_u64()) {
                                                if pi > 0 {
                                                    ping_interval_secs = pi;
                                                }
                                            }
                                        }
                                    }
                                }
                                (FRAME_TYPE_DATA, MSG_TYPE_EVENT) => {
                                    let sum = frame.header_int("sum");
                                    let seq = frame.header_int("seq");
                                    let msg_id = frame.header("message_id").unwrap_or("").to_string();

                                    let payload_bytes = if sum > 1 {
                                        let entry = fragment_cache
                                            .entry(msg_id.clone())
                                            .or_insert_with(|| (sum as usize, vec![None; sum as usize]));
                                        let idx = seq as usize;
                                        if idx < entry.1.len() {
                                            entry.1[idx] = Some(frame.payload.clone());
                                        }
                                        if entry.1.iter().all(|p| p.is_some()) {
                                            let combined: Vec<u8> = entry
                                                .1
                                                .iter()
                                                .filter_map(|p| p.as_ref())
                                                .flat_map(|p| p.iter().copied())
                                                .collect();
                                            fragment_cache.remove(&msg_id);
                                            Some(combined)
                                        } else {
                                            None
                                        }
                                    } else {
                                        Some(frame.payload.clone())
                                    };

                                    if let Some(payload) = payload_bytes {
                                        if let Ok(event_json) = serde_json::from_slice::<Value>(&payload) {
                                            if let Some(inbound) = event::parse_feishu_event(
                                                &event_json,
                                                &channel_name,
                                                &event_config,
                                                &mut dedup_set,
                                                &mut dedup_order,
                                            ) {
                                                info!("[{}] Sending inbound to bus: session_key={}", channel_name, inbound.session_key());
                                                if let Err(err) = inbound_tx.send(inbound).await {
                                                    error!("[{}] Failed to send inbound: {}", channel_name, err);
                                                }
                                            }
                                        } else {
                                            warn!(
                                                "[{}] Failed to parse event payload as JSON ({} bytes)",
                                                channel_name,
                                                payload.len()
                                            );
                                        }
                                    }

                                    let resp_frame = PbFrame::new_response(&frame, 200);
                                    let resp_bytes = resp_frame.encode();
                                    if let Err(err) = ws_sink.send(WsMessage::Binary(resp_bytes.into())).await {
                                        warn!("[{}] Failed to send response frame: {}", channel_name, err);
                                        connection_alive = false;
                                    }
                                }
                                _ => {
                                    debug!(
                                        "[{}] Ignoring frame: method={}, type={}",
                                        channel_name, frame_type, msg_type
                                    );
                                }
                            }
                        }
                        Some(Ok(WsMessage::Ping(data))) => {
                            if let Err(err) = ws_sink.send(WsMessage::Pong(data)).await {
                                warn!("[{}] Failed to send pong: {}", channel_name, err);
                                connection_alive = false;
                            }
                        }
                        Some(Ok(WsMessage::Close(_))) => {
                            info!("[{}] WS closed by server, reconnecting...", channel_name);
                            ws_connected.store(false, Ordering::Relaxed);
                            *last_error.write().await = Some("Connection closed by server".into());
                            connection_alive = false;
                        }
                        Some(Err(err)) => {
                            let err_msg = format!("WebSocket error: {}", err);
                            error!("[{}] {}", channel_name, err_msg);
                            ws_connected.store(false, Ordering::Relaxed);
                            *last_error.write().await = Some(err_msg);
                            connection_alive = false;
                        }
                        None => {
                            info!("[{}] WS stream ended, reconnecting...", channel_name);
                            ws_connected.store(false, Ordering::Relaxed);
                            *last_error.write().await = Some("WebSocket stream ended".into());
                            connection_alive = false;
                        }
                        Some(Ok(other)) => {
                            // 诊断：捕获未处理的 WsMessage 类型（Text/Ping/Pong/Frame）。
                            // 飞书 ws/v2 正常只发 Binary(protobuf)；若出现其他类型说明协议变化。
                            let kind = match &other {
                                WsMessage::Text(t) => format!("Text({} chars)", t.len()),
                                WsMessage::Ping(p) => format!("Ping({} bytes)", p.len()),
                                WsMessage::Pong(p) => format!("Pong({} bytes)", p.len()),
                                WsMessage::Frame(_) => "Frame".to_string(),
                                _ => "Other".to_string(),
                            };
                            debug!("[{}] WS recv unhandled message type: {}", channel_name, kind);
                        }
                    }
                }
            }
        }

        ping_handle.abort();

        if running.load(Ordering::Relaxed) {
            ws_connected.store(false, Ordering::Relaxed);
            match channel::request_ws_endpoint(&app_id, &app_secret, &api_base, &http_client).await
            {
                Ok((new_url, new_config)) => {
                    ws_url = new_url;
                    if let Some(conf) = new_config {
                        ping_interval_secs = conf.ping_interval_secs;
                        reconnect_interval_secs = conf.reconnect_interval_secs;
                    }
                }
                Err(err) => {
                    let err_msg = format!("Failed to refresh WS URL: {}", err);
                    warn!("[{}] {}", channel_name, err_msg);
                    *last_error.write().await = Some(err_msg);
                }
            }
            tokio::time::sleep(Duration::from_secs(reconnect_interval_secs)).await;
        }
    }

    info!("[{}] WS receive loop exited", channel_name);
}

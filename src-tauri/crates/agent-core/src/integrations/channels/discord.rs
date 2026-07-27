//! Discord channel implementation.
//!
//! Connects to the Discord Gateway via WebSocket for receiving messages,
//! and uses the REST API for sending responses.
//!
//! The Gateway protocol requires a heartbeat sent every `heartbeat_interval`
//! milliseconds (received in the op:10 Hello payload). Failure to heartbeat
//! causes Discord to close the connection after ~5 seconds.

use async_trait::async_trait;
use futures_util::SinkExt;
use reqwest::Client;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio::sync::Mutex as TokioMutex;
use tracing::{error, info, warn};

use super::config::DiscordAccountConfig;
use crate::bus::{InboundMessage, OutboundMessage};

use super::traits::{Channel, ChannelError};

/// Discord channel using Gateway WebSocket + REST API (single account instance).
pub struct DiscordChannel {
    account_id: String,
    config: DiscordAccountConfig,
    client: Client,
    running: Arc<AtomicBool>,
    gateway_handle: Option<tokio::task::JoinHandle<()>>,
}

impl DiscordChannel {
    pub fn new(account_id: String, config: DiscordAccountConfig) -> Self {
        Self {
            account_id,
            config,
            client: Client::new(),
            running: Arc::new(AtomicBool::new(false)),
            gateway_handle: None,
        }
    }
}

#[async_trait]
impl Channel for DiscordChannel {
    fn name(&self) -> String {
        format!("discord:{}", self.account_id)
    }

    async fn start(
        &mut self,
        inbound_tx: mpsc::Sender<InboundMessage>,
    ) -> Result<(), ChannelError> {
        if self.config.token.is_empty() {
            return Err(ChannelError::ConfigError(
                "Discord bot token is empty".into(),
            ));
        }

        self.running.store(true, Ordering::Relaxed);
        let running = self.running.clone();
        let token = self.config.token.clone();
        let allow_from = self.config.allow_from.clone();
        let gateway_url = self.config.gateway_url.clone();
        let intents = self.config.intents;
        let channel_name = format!("discord:{}", self.account_id);

        let handle = tokio::spawn(async move {
            // Connect to Discord Gateway via WebSocket
            let ws_result = tokio_tungstenite::connect_async(&gateway_url).await;

            let (ws_stream, _) = match ws_result {
                Ok(conn) => conn,
                Err(err) => {
                    error!("Failed to connect to Discord Gateway: {}", err);
                    return;
                }
            };

            use futures_util::StreamExt;

            let (ws_sink, mut ws_source) = ws_stream.split();
            let shared_sink = Arc::new(TokioMutex::new(ws_sink));

            // Send identify payload
            let identify = serde_json::json!({
                "op": 2,
                "d": {
                    "token": token,
                    "intents": intents,
                    "properties": {
                        "os": std::env::consts::OS,
                        "browser": "orgii-agent",
                        "device": "orgii-agent"
                    }
                }
            });

            if let Err(err) = shared_sink
                .lock()
                .await
                .send(tokio_tungstenite::tungstenite::Message::Text(
                    identify.to_string().into(),
                ))
                .await
            {
                error!("Failed to send identify: {}", err);
                return;
            }

            // Process gateway events
            let mut heartbeat_handle: Option<tokio::task::JoinHandle<()>> = None;
            while running.load(Ordering::Relaxed) {
                match ws_source.next().await {
                    Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text))) => {
                        if let Ok(payload) = serde_json::from_str::<Value>(&text) {
                            let op = payload.get("op").and_then(|o| o.as_i64()).unwrap_or(-1);
                            let event_type = payload.get("t").and_then(|t| t.as_str());

                            match op {
                                10 => {
                                    // Hello — extract heartbeat_interval and start heartbeat task
                                    let interval_ms = payload
                                        .get("d")
                                        .and_then(|d| d.get("heartbeat_interval"))
                                        .and_then(|v| v.as_u64())
                                        .unwrap_or(41250);

                                    info!(
                                        "Discord Gateway connected, heartbeat_interval={}ms",
                                        interval_ms
                                    );

                                    let sink_clone = shared_sink.clone();
                                    let running_clone = running.clone();
                                    if let Some(previous) = heartbeat_handle.take() {
                                        previous.abort();
                                    }
                                    heartbeat_handle = Some(tokio::spawn(async move {
                                        let heartbeat =
                                            tokio_tungstenite::tungstenite::Message::Text(
                                                serde_json::json!({"op": 1, "d": null})
                                                    .to_string()
                                                    .into(),
                                            );
                                        loop {
                                            tokio::time::sleep(tokio::time::Duration::from_millis(
                                                interval_ms,
                                            ))
                                            .await;
                                            if !running_clone.load(Ordering::Relaxed) {
                                                break;
                                            }
                                            if let Err(err) = sink_clone
                                                .lock()
                                                .await
                                                .send(heartbeat.clone())
                                                .await
                                            {
                                                warn!("Discord heartbeat send failed: {}", err);
                                                break;
                                            }
                                        }
                                    }));
                                }
                                0
                                    // Dispatch event
                                    if event_type == Some("MESSAGE_CREATE") => {
                                        if let Some(data) = payload.get("d") {
                                            let content = data
                                                .get("content")
                                                .and_then(|c| c.as_str())
                                                .unwrap_or("");
                                            let author_id = data
                                                .get("author")
                                                .and_then(|a| a.get("id"))
                                                .and_then(|i| i.as_str())
                                                .unwrap_or("");
                                            let channel_id = data
                                                .get("channel_id")
                                                .and_then(|c| c.as_str())
                                                .unwrap_or("");
                                            let is_bot = data
                                                .get("author")
                                                .and_then(|a| a.get("bot"))
                                                .and_then(|b| b.as_bool())
                                                .unwrap_or(false);

                                            if is_bot || content.is_empty() {
                                                continue;
                                            }

                                            if !allow_from.is_empty()
                                                && !allow_from.iter().any(|a| a == author_id)
                                            {
                                                continue;
                                            }

                                            let inbound = InboundMessage::new(
                                                &channel_name,
                                                author_id,
                                                channel_id,
                                                content,
                                            );
                                            if let Err(err) = inbound_tx.send(inbound).await {
                                                error!("Failed to send inbound: {}", err);
                                            }
                                        }
                                    }
                                _ => {}
                            }
                        }
                    }
                    Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_))) => {
                        info!("Discord Gateway closed");
                        break;
                    }
                    Some(Err(err)) => {
                        warn!("Discord Gateway error: {}", err);
                        break;
                    }
                    None => break,
                    _ => {}
                }
            }
            if let Some(handle) = heartbeat_handle {
                handle.abort();
            }
        });

        self.gateway_handle = Some(handle);
        info!("Discord channel started");
        Ok(())
    }

    async fn stop(&mut self) -> Result<(), ChannelError> {
        self.running.store(false, Ordering::Relaxed);
        if let Some(handle) = self.gateway_handle.take() {
            handle.abort();
        }
        info!("Discord channel stopped");
        Ok(())
    }

    async fn send(&self, msg: &OutboundMessage) -> Result<(), ChannelError> {
        let url = format!(
            "https://discord.com/api/v10/channels/{}/messages",
            msg.chat_id
        );
        let body = serde_json::json!({
            "content": msg.content,
        });

        self.client
            .post(&url)
            .header("Authorization", format!("Bot {}", self.config.token))
            .json(&body)
            .send()
            .await
            .map_err(|err| ChannelError::SendFailed(err.to_string()))?;

        Ok(())
    }

    fn is_connected(&self) -> bool {
        self.running.load(Ordering::Relaxed)
    }
}

//! FeishuChannel struct and Channel trait implementation.

use async_trait::async_trait;
use reqwest::Client;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};
use tracing::info;

use super::super::config::FeishuAccountConfig;
use super::super::traits::{Channel, ChannelError};
use super::api;
use super::auth::{self, FeishuAuth};
use super::event::FeishuEventConfig;
use super::ws;
use crate::bus::{InboundMessage, OutboundMessage};

/// Server-pushed client configuration for reconnect/ping behavior.
#[derive(Debug, Clone)]
pub(super) struct WsClientConfig {
    pub(super) _reconnect_count: i32,
    pub(super) reconnect_interval_secs: u64,
    pub(super) _reconnect_nonce_secs: u64,
    pub(super) ping_interval_secs: u64,
}

/// Request the WebSocket endpoint URL from Feishu.
///
/// The Go SDK sends `{ "AppID": "...", "AppSecret": "..." }` in the POST body
/// (no Authorization header). The response contains the WSS URL and optional
/// client config (reconnect/ping intervals).
///
/// IMPORTANT: The WS endpoint is at `{domain}/callback/ws/endpoint`, NOT under
/// `/open-apis`. The Go SDK uses `c.domain + "/callback/ws/endpoint"` where
/// domain is e.g. `https://open.feishu.cn`.
pub(super) async fn request_ws_endpoint(
    app_id: &str,
    app_secret: &str,
    api_base: &str,
    client: &Client,
) -> Result<(String, Option<WsClientConfig>), ChannelError> {
    let domain = api_base.trim_end_matches("/open-apis");
    let url = format!("{}/callback/ws/endpoint", domain);

    let body = serde_json::json!({
        "AppID": app_id,
        "AppSecret": app_secret,
    });

    let res = client
        .post(&url)
        .header("locale", "zh")
        .json(&body)
        .send()
        .await
        .map_err(|err| ChannelError::ConnectionFailed(err.to_string()))?;

    let json: Value = res
        .json()
        .await
        .map_err(|err| ChannelError::Other(format!("Invalid WS endpoint response: {}", err)))?;

    let code = json.get("code").and_then(|c| c.as_i64()).unwrap_or(-1);
    if code != 0 {
        let msg = json
            .get("msg")
            .and_then(|m| m.as_str())
            .unwrap_or("Failed to get WS endpoint");
        return Err(ChannelError::ConnectionFailed(format!(
            "WS endpoint error (code {}): {}",
            code, msg
        )));
    }

    let data = json
        .get("data")
        .ok_or_else(|| ChannelError::Other("Missing data in endpoint response".into()))?;

    let ws_url = data
        .get("URL")
        .or_else(|| data.get("url"))
        .and_then(|u| u.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| ChannelError::Other("Missing WS URL in endpoint response".into()))?;

    let client_config = data.get("ClientConfig").map(|cc| WsClientConfig {
        _reconnect_count: cc
            .get("ReconnectCount")
            .and_then(|v| v.as_i64())
            .unwrap_or(-1) as i32,
        reconnect_interval_secs: cc
            .get("ReconnectInterval")
            .and_then(|v| v.as_u64())
            .unwrap_or(120),
        _reconnect_nonce_secs: cc
            .get("ReconnectNonce")
            .and_then(|v| v.as_u64())
            .unwrap_or(30),
        ping_interval_secs: cc
            .get("PingInterval")
            .and_then(|v| v.as_u64())
            .unwrap_or(120),
    });

    Ok((ws_url, client_config))
}

/// Feishu/Lark channel (single account instance).
pub struct FeishuChannel {
    account_id: String,
    config: FeishuAccountConfig,
    auth: Arc<FeishuAuth>,
    running: Arc<AtomicBool>,
    ws_connected: Arc<AtomicBool>,
    last_error: Arc<RwLock<Option<String>>>,
    ws_handle: Option<tokio::task::JoinHandle<()>>,
}

impl FeishuChannel {
    pub fn new(account_id: String, config: FeishuAccountConfig) -> Self {
        let auth = Arc::new(FeishuAuth::new(&config));
        Self {
            account_id,
            config,
            auth,
            running: Arc::new(AtomicBool::new(false)),
            ws_connected: Arc::new(AtomicBool::new(false)),
            last_error: Arc::new(RwLock::new(None)),
            ws_handle: None,
        }
    }
}

#[async_trait]
impl Channel for FeishuChannel {
    fn name(&self) -> String {
        format!("feishu:{}", self.account_id)
    }

    async fn start(
        &mut self,
        inbound_tx: mpsc::Sender<InboundMessage>,
    ) -> Result<(), ChannelError> {
        if self.config.app_id.is_empty() || self.config.app_secret.is_empty() {
            return Err(ChannelError::ConfigError(
                "Feishu app_id or app_secret not configured".into(),
            ));
        }

        self.auth.refresh_token().await?;

        let bot_open_id = auth::fetch_bot_open_id(&self.auth).await;
        info!(
            "[feishu:{}] Bot open_id: {}",
            self.account_id,
            if bot_open_id.is_empty() {
                "(unknown)"
            } else {
                &bot_open_id
            }
        );

        let (ws_url, client_config) = request_ws_endpoint(
            &self.config.app_id,
            &self.config.app_secret,
            self.auth.api_base(),
            self.auth.client(),
        )
        .await?;
        info!("[feishu:{}] WS endpoint obtained", self.account_id);

        self.running.store(true, Ordering::Relaxed);
        self.ws_connected.store(false, Ordering::Relaxed);
        *self.last_error.write().await = None;

        let running = self.running.clone();
        let ws_connected = self.ws_connected.clone();
        let last_error = self.last_error.clone();
        let channel_name = format!("feishu:{}", self.account_id);
        let event_config = FeishuEventConfig {
            group_policy: self.config.group_policy.clone(),
            dm_policy: self.config.dm_policy.clone(),
            require_mention: self.config.require_mention,
            allow_from: self.config.allow_from.clone(),
            bot_open_id,
        };

        let app_id = self.config.app_id.clone();
        let app_secret = self.config.app_secret.clone();
        let api_base = self.auth.api_base().to_string();
        let http_client = self.auth.client().clone();
        let auth = self.auth.clone();
        let handle = tokio::spawn(async move {
            ws::feishu_ws_loop(
                ws_url,
                client_config,
                app_id,
                app_secret,
                api_base,
                http_client,
                running,
                ws_connected,
                last_error,
                inbound_tx,
                channel_name,
                event_config,
                auth,
            )
            .await;
        });

        self.ws_handle = Some(handle);
        info!("[feishu:{}] Channel started", self.account_id);
        Ok(())
    }

    async fn stop(&mut self) -> Result<(), ChannelError> {
        self.running.store(false, Ordering::Relaxed);
        self.ws_connected.store(false, Ordering::Relaxed);
        if let Some(handle) = self.ws_handle.take() {
            handle.abort();
        }
        info!("[feishu:{}] Channel stopped", self.account_id);
        Ok(())
    }

    async fn send(&self, msg: &OutboundMessage) -> Result<(), ChannelError> {
        for media_path in &msg.media {
            let path = std::path::Path::new(media_path);
            if path.exists() {
                if let Err(err) = api::send_media_message(&self.auth, &msg.chat_id, path).await {
                    tracing::warn!(
                        "[feishu:{}] Failed to send media {}: {}",
                        self.account_id,
                        media_path,
                        err
                    );
                }
            }
        }
        if !msg.content.is_empty() {
            api::send_feishu_message(&self.auth, msg, &self.config.render_mode).await?;
        }
        Ok(())
    }

    fn is_connected(&self) -> bool {
        self.running.load(Ordering::Relaxed) && self.ws_connected.load(Ordering::Relaxed)
    }

    fn is_active(&self) -> bool {
        self.running.load(Ordering::Relaxed)
    }

    fn last_error(&self) -> Option<String> {
        self.last_error
            .try_read()
            .ok()
            .and_then(|guard| guard.clone())
    }

    async fn on_processing_start(
        &self,
        _chat_id: &str,
        message_id: &str,
    ) -> Result<(), ChannelError> {
        api::add_reaction(&self.auth, message_id, "Typing").await
    }

    async fn on_processing_end(
        &self,
        _chat_id: &str,
        message_id: &str,
    ) -> Result<(), ChannelError> {
        api::remove_reaction(&self.auth, message_id, "Typing").await
    }

    async fn update_message(&self, message_id: &str, content: &str) -> Result<(), ChannelError> {
        api::update_feishu_message(&self.auth, message_id, content, &self.config.render_mode).await
    }

    // Feishu message text limit is 30 000 Unicode code-points per message card.
    fn max_message_chars(&self) -> usize {
        30_000
    }
}

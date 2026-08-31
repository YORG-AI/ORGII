//! Outbound desktop client for the public Mobile Remote relay.
//!
//! The relay only multiplexes opaque JSON-RPC payloads. Agent/session state,
//! authorization tiers, and permission decisions continue to execute here.

use std::collections::HashMap;
use std::sync::{Arc, OnceLock, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
use mobile_relay_protocol::{PermissionTier, RelayWireFrame, DESKTOP_WS_PATH};
use serde::Serialize;
use serde_json::Value;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;
use tokio_util::sync::CancellationToken;

use super::auth::{self, MobileRemoteSettings};
use super::fanout;
use super::rpc::{self, MobileTier, RpcContext};

const ACTOR_QUEUE_CAPACITY: usize = 32;
const RELAY_OUTBOUND_CAPACITY: usize = 256;
const MAX_RELAY_FRAME_BYTES: usize = 1024 * 1024;
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
const MAX_BACKOFF_SECONDS: u64 = 30;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelaySettings {
    pub enabled: bool,
    pub relay_enabled: bool,
    pub relay_url: String,
    pub desktop_id: String,
    pub desktop_token: String,
}

impl RelaySettings {
    pub fn from_value(value: &Value) -> Self {
        Self {
            enabled: bool_setting(value, "mobileRemote.enabled"),
            relay_enabled: bool_setting(value, "mobileRemote.relayEnabled"),
            relay_url: string_setting(value, "mobileRemote.relayUrl"),
            desktop_id: string_setting(value, "mobileRemote.desktopId"),
            desktop_token: string_setting(value, "mobileRemote.desktopToken"),
        }
    }

    pub fn load() -> Self {
        settings::file_io::read_settings()
            .map(|value| Self::from_value(&value))
            .unwrap_or_else(|_| Self::from_value(&Value::Null))
    }

    fn connection_url(&self) -> Result<String, String> {
        if self.relay_url.trim().is_empty() {
            return Err("relay URL is required".to_string());
        }
        if self.desktop_id.trim().is_empty() {
            return Err("desktop identity is not configured".to_string());
        }
        if self.desktop_token.trim().len() < 24 {
            return Err("desktop relay token must contain at least 24 characters".to_string());
        }
        let mut url = url::Url::parse(self.relay_url.trim())
            .map_err(|err| format!("invalid relay URL: {err}"))?;
        if !matches!(url.scheme(), "ws" | "wss") {
            return Err("relay URL must use ws:// or wss://".to_string());
        }
        url.set_path(DESKTOP_WS_PATH);
        url.set_query(None);
        url.query_pairs_mut()
            .append_pair("desktopId", self.desktop_id.trim())
            .append_pair("token", self.desktop_token.trim());
        Ok(url.to_string())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RelayPhase {
    Disabled,
    ConfigError,
    Connecting,
    Online,
    Backoff,
    Stopped,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayStatus {
    pub phase: RelayPhase,
    pub message: Option<String>,
    pub reconnect_attempt: u32,
    pub connected_at_ms: Option<i64>,
}

impl Default for RelayStatus {
    fn default() -> Self {
        Self {
            phase: RelayPhase::Stopped,
            message: None,
            reconnect_attempt: 0,
            connected_at_ms: None,
        }
    }
}

static SETTINGS_TX: OnceLock<watch::Sender<RelaySettings>> = OnceLock::new();
static STATUS: OnceLock<Arc<RwLock<RelayStatus>>> = OnceLock::new();
static SHUTDOWN: OnceLock<CancellationToken> = OnceLock::new();

pub fn start() {
    if SETTINGS_TX.get().is_some() {
        return;
    }
    let (settings_tx, settings_rx) = watch::channel(RelaySettings::load());
    if SETTINGS_TX.set(settings_tx).is_err() {
        return;
    }
    let status = STATUS
        .get_or_init(|| Arc::new(RwLock::new(RelayStatus::default())))
        .clone();
    let shutdown = SHUTDOWN.get_or_init(CancellationToken::new).clone();
    tauri::async_runtime::spawn(supervise(settings_rx, status, shutdown));
}

pub fn shutdown() {
    if let Some(token) = SHUTDOWN.get() {
        token.cancel();
    }
}

pub fn notify_settings_changed(value: &Value) {
    if let Some(sender) = SETTINGS_TX.get() {
        sender.send_replace(RelaySettings::from_value(value));
    }
}

pub fn current_status() -> RelayStatus {
    STATUS
        .get_or_init(|| Arc::new(RwLock::new(RelayStatus::default())))
        .read()
        .map(|status| status.clone())
        .unwrap_or_default()
}

async fn supervise(
    mut settings_rx: watch::Receiver<RelaySettings>,
    status: Arc<RwLock<RelayStatus>>,
    shutdown: CancellationToken,
) {
    let mut reconnect_attempt = 0_u32;
    loop {
        if shutdown.is_cancelled() {
            set_status(&status, RelayPhase::Stopped, None, 0, None);
            return;
        }

        let current = settings_rx.borrow().clone();
        if !current.enabled || !current.relay_enabled {
            reconnect_attempt = 0;
            set_status(&status, RelayPhase::Disabled, None, 0, None);
            tokio::select! {
                _ = settings_rx.changed() => continue,
                _ = shutdown.cancelled() => continue,
            }
        }

        let connection_url = match current.connection_url() {
            Ok(url) => url,
            Err(message) => {
                reconnect_attempt = 0;
                set_status(&status, RelayPhase::ConfigError, Some(message), 0, None);
                tokio::select! {
                    _ = settings_rx.changed() => continue,
                    _ = shutdown.cancelled() => continue,
                }
            }
        };

        set_status(
            &status,
            RelayPhase::Connecting,
            None,
            reconnect_attempt,
            None,
        );
        let run = run_connection(connection_url, current.desktop_id.clone(), status.clone());
        let error = tokio::select! {
            result = run => Some(result.err().unwrap_or_else(|| "relay connection closed".to_string())),
            _ = settings_rx.changed() => None,
            _ = shutdown.cancelled() => None,
        };
        if error.is_none() {
            continue;
        }

        let connected_once = status
            .read()
            .map(|current| current.phase == RelayPhase::Online)
            .unwrap_or(false);
        reconnect_attempt = next_reconnect_attempt(reconnect_attempt, connected_once);
        let delay = reconnect_delay(reconnect_attempt);
        set_status(&status, RelayPhase::Backoff, error, reconnect_attempt, None);
        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = settings_rx.changed() => reconnect_attempt = 0,
            _ = shutdown.cancelled() => {}
        }
    }
}

async fn run_connection(
    connection_url: String,
    desktop_id: String,
    status: Arc<RwLock<RelayStatus>>,
) -> Result<(), String> {
    let (socket, _) = tokio_tungstenite::connect_async(connection_url)
        .await
        .map_err(|err| format!("connect to relay: {err}"))?;
    set_status(&status, RelayPhase::Online, None, 0, Some(now_ms()));

    let (mut writer, mut reader) = socket.split();
    let (outbound_tx, mut outbound_rx) = mpsc::channel::<Message>(RELAY_OUTBOUND_CAPACITY);
    let mut actors: HashMap<String, MobileActor> = HashMap::new();
    let mut heartbeat = tokio::time::interval(HEARTBEAT_INTERVAL);
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            incoming = reader.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) if text.len() <= MAX_RELAY_FRAME_BYTES => {
                        if let Ok(frame) = serde_json::from_str::<RelayWireFrame>(&text) {
                            handle_relay_frame(frame, &desktop_id, &outbound_tx, &mut actors).await;
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        if outbound_tx.try_send(Message::Pong(payload)).is_err() {
                            return Err("relay outbound queue is full".to_string());
                        }
                    }
                    Some(Ok(Message::Close(frame))) => {
                        return Err(frame
                            .map(|frame| format!("relay closed connection: {}", frame.reason))
                            .unwrap_or_else(|| "relay closed connection".to_string()));
                    }
                    Some(Ok(_)) => {}
                    Some(Err(err)) => return Err(format!("relay read failed: {err}")),
                    None => return Err("relay connection ended".to_string()),
                }
            }
            outbound = outbound_rx.recv() => {
                let Some(message) = outbound else {
                    return Err("relay outbound channel ended".to_string());
                };
                writer.send(message).await.map_err(|err| format!("relay write failed: {err}"))?;
            }
            _ = heartbeat.tick() => {
                writer
                    .send(Message::Ping(Vec::new().into()))
                    .await
                    .map_err(|err| format!("relay heartbeat failed: {err}"))?;
            }
        }
    }
}

struct MobileActor {
    requests: mpsc::Sender<Value>,
    task: JoinHandle<()>,
}

fn relay_rpc_context(conn_id: u64, tier: PermissionTier) -> RpcContext {
    RpcContext {
        conn_id,
        // A paired relay device is already authenticated and may survive a
        // desktop reconnect inside the Durable Object. Treat the relay's
        // MobileConnected frame as transport initialization so a recreated
        // desktop actor can resume requests without forcing the phone socket
        // to reconnect. The client's initialize call remains idempotent and
        // still returns capability negotiation on a fresh connection.
        initialized: true,
        tier: match tier {
            PermissionTier::Full => MobileTier::Full,
            PermissionTier::ReadOnly => MobileTier::ReadOnly,
        },
        settings: enabled_rpc_settings(),
    }
}

impl Drop for MobileActor {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn handle_relay_frame(
    frame: RelayWireFrame,
    desktop_id: &str,
    outbound: &mpsc::Sender<Message>,
    actors: &mut HashMap<String, MobileActor>,
) {
    match frame {
        RelayWireFrame::DesktopRegistered {
            desktop_id: registered,
            ..
        } if registered != desktop_id => {
            tracing::warn!("[MobileRelay] relay registered an unexpected desktop identity");
        }
        RelayWireFrame::MobileConnected {
            connection_id,
            device,
        } if device.desktop_id == desktop_id => {
            actors.remove(&connection_id);
            let (requests, request_rx) = mpsc::channel(ACTOR_QUEUE_CAPACITY);
            let task = tokio::spawn(run_mobile_actor(
                connection_id.clone(),
                device.tier,
                request_rx,
                outbound.clone(),
            ));
            actors.insert(connection_id, MobileActor { requests, task });
        }
        RelayWireFrame::MobileDisconnected { connection_id } => {
            actors.remove(&connection_id);
        }
        RelayWireFrame::MobileFrame {
            connection_id,
            payload,
        } => {
            if let Some(actor) = actors.get(&connection_id) {
                if actor.requests.try_send(payload.clone()).is_err() {
                    let id = payload.get("id").cloned().unwrap_or(Value::Null);
                    let response = mobile_relay_protocol::rpc_error(id, -32007, "desktop is busy");
                    let _ = send_desktop_frame(outbound, &connection_id, response).await;
                }
            }
        }
        RelayWireFrame::Error { code, message } => {
            tracing::warn!(code, message, "[MobileRelay] broker error");
        }
        _ => {}
    }
}

async fn run_mobile_actor(
    connection_id: String,
    tier: PermissionTier,
    mut requests: mpsc::Receiver<Value>,
    outbound: mpsc::Sender<Message>,
) {
    let (fanout_tx, mut fanout_rx) = mpsc::channel::<String>(64);
    let registration = FanoutRegistration(fanout::register_connection(fanout_tx));
    let mut context = relay_rpc_context(registration.0, tier);

    loop {
        tokio::select! {
            request = requests.recv() => {
                let Some(request) = request else { break; };
                if let Some(response) = rpc::dispatch(&mut context, &request).await {
                    if send_desktop_frame(&outbound, &connection_id, response).await.is_err() {
                        break;
                    }
                }
            }
            notification = fanout_rx.recv() => {
                let Some(notification) = notification else { break; };
                let Ok(value) = serde_json::from_str::<Value>(&notification) else { continue; };
                if send_desktop_frame(&outbound, &connection_id, value).await.is_err() {
                    break;
                }
            }
        }
    }
}

struct FanoutRegistration(u64);

impl Drop for FanoutRegistration {
    fn drop(&mut self) {
        fanout::unregister_connection(self.0);
    }
}

async fn send_desktop_frame(
    outbound: &mpsc::Sender<Message>,
    connection_id: &str,
    payload: Value,
) -> Result<(), ()> {
    let frame = RelayWireFrame::DesktopFrame {
        connection_id: connection_id.to_string(),
        payload,
    };
    let encoded = serde_json::to_string(&frame).map_err(|_| ())?;
    outbound
        .send(Message::Text(encoded.into()))
        .await
        .map_err(|_| ())
}

fn enabled_rpc_settings() -> MobileRemoteSettings {
    let mut settings = auth::load_settings();
    settings.enabled = true;
    settings
}

fn set_status(
    status: &RwLock<RelayStatus>,
    phase: RelayPhase,
    message: Option<String>,
    reconnect_attempt: u32,
    connected_at_ms: Option<i64>,
) {
    if let Ok(mut current) = status.write() {
        *current = RelayStatus {
            phase,
            message,
            reconnect_attempt,
            connected_at_ms,
        };
    }
}

fn reconnect_delay(attempt: u32) -> Duration {
    let exponent = attempt.saturating_sub(1).min(5);
    let seconds = 1_u64
        .checked_shl(exponent)
        .unwrap_or(MAX_BACKOFF_SECONDS)
        .min(MAX_BACKOFF_SECONDS);
    let jitter_ms = now_ms().unsigned_abs() % 500;
    Duration::from_millis(seconds * 1_000 + jitter_ms)
}

fn next_reconnect_attempt(previous: u32, connected_once: bool) -> u32 {
    if connected_once {
        1
    } else {
        previous.saturating_add(1)
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or_default()
}

fn bool_setting(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn string_setting(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_are_flat_keys_like_the_settings_registry() {
        let value = serde_json::json!({
            "mobileRemote.enabled": true,
            "mobileRemote.relayEnabled": true,
            "mobileRemote.relayUrl": "wss://relay.example.com/v1/mobile/ws",
            "mobileRemote.desktopId": "desktop-a",
            "mobileRemote.desktopToken": "123456789012345678901234",
        });
        let settings = RelaySettings::from_value(&value);
        assert!(settings.enabled);
        assert!(settings.relay_enabled);
        assert_eq!(settings.desktop_id, "desktop-a");
        let url = settings.connection_url().expect("connection URL");
        assert!(url.starts_with("wss://relay.example.com/v1/desktop/ws?"));
        assert!(url.contains("desktopId=desktop-a"));
    }

    #[test]
    fn disabled_or_incomplete_settings_do_not_form_connection_url() {
        let settings = RelaySettings::from_value(&Value::Null);
        assert!(settings.connection_url().is_err());
    }

    #[test]
    fn backoff_is_bounded() {
        assert!(reconnect_delay(1) < Duration::from_secs(2));
        assert!(reconnect_delay(100) < Duration::from_secs(31));
    }

    #[test]
    fn a_successful_connection_resets_the_next_backoff() {
        assert_eq!(next_reconnect_attempt(5, true), 1);
        assert_eq!(next_reconnect_attempt(5, false), 6);
    }

    #[test]
    fn recreated_relay_actor_keeps_an_existing_mobile_transport_ready() {
        let full = relay_rpc_context(1, PermissionTier::Full);
        let read_only = relay_rpc_context(2, PermissionTier::ReadOnly);

        assert!(full.initialized);
        assert_eq!(full.tier, MobileTier::Full);
        assert!(read_only.initialized);
        assert_eq!(read_only.tier, MobileTier::ReadOnly);
    }
}

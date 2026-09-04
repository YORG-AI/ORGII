//! Outbound desktop client for the public Mobile Remote relay.
//!
//! The relay only multiplexes opaque JSON-RPC payloads. Agent/session state,
//! authorization tiers, and permission decisions continue to execute here.

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, OnceLock, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::http::header::AUTHORIZATION;
use futures_util::{SinkExt, StreamExt};
use mobile_relay_protocol::{PermissionTier, RelayWireFrame, DESKTOP_WS_PATH};
use serde::Serialize;
use serde_json::Value;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::Message;
use tokio_util::sync::CancellationToken;
use tauri::Emitter;

use super::auth::{self, MobileRemoteSettings};
use super::org2_cloud_auth::{self, SESSION_EXPIRED_MESSAGE};
use super::fanout;
use super::rpc::{self, MobileTier, RpcContext};

const ACTOR_QUEUE_CAPACITY: usize = 32;
const RELAY_OUTBOUND_CAPACITY: usize = 256;
const MAX_RELAY_FRAME_BYTES: usize = 1024 * 1024;
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
const MAX_BACKOFF_SECONDS: u64 = 30;
/// How long a registered relay session must survive before a drop is treated
/// as a transient fault worth retrying at the floor delay. Sockets that the
/// relay accepts and then closes right away (connection limit, or eviction by
/// another desktop claiming the same identity) stay below this and keep
/// growing the backoff instead of hammering the relay once per second.
const MIN_ESTABLISHED_SESSION_MS: i64 = 10_000;
pub const RELAY_AUTH_REFRESH_EVENT: &str = "mobile-relay-auth-refresh-needed";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelaySettings {
    pub enabled: bool,
    pub relay_enabled: bool,
    pub relay_url: String,
    pub desktop_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RelayConnectionPlan {
    ws_url: String,
    desktop_id: String,
    access_token: String,
}

impl RelaySettings {
    pub fn from_value(value: &Value) -> Self {
        Self {
            enabled: bool_setting(value, "mobileRemote.enabled"),
            relay_enabled: bool_setting(value, "mobileRemote.relayEnabled"),
            relay_url: string_setting(value, "mobileRemote.relayUrl"),
            desktop_id: string_setting(value, "mobileRemote.desktopId"),
        }
    }

    pub fn load() -> Self {
        settings::file_io::read_settings()
            .map(|value| Self::from_value(&value))
            .unwrap_or_else(|_| Self::from_value(&Value::Null))
    }

    fn connection_plan(&self) -> Result<RelayConnectionPlan, String> {
        if self.relay_url.trim().is_empty() {
            return Err("relay URL is required".to_string());
        }
        if self.desktop_id.trim().is_empty() {
            return Err("desktop identity is not configured".to_string());
        }
        let access_token = org2_cloud_auth::current_access_token()?;
        let mut url = url::Url::parse(self.relay_url.trim())
            .map_err(|err| format!("invalid relay URL: {err}"))?;
        if !matches!(url.scheme(), "ws" | "wss") {
            return Err("relay URL must use ws:// or wss://".to_string());
        }
        url.set_path(DESKTOP_WS_PATH);
        url.set_query(None);
        url.query_pairs_mut()
            .append_pair("desktopId", self.desktop_id.trim());
        Ok(RelayConnectionPlan {
            ws_url: url.to_string(),
            desktop_id: self.desktop_id.trim().to_string(),
            access_token,
        })
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
static CLOUD_AUTH_TX: OnceLock<watch::Sender<u64>> = OnceLock::new();
static STATUS: OnceLock<Arc<RwLock<RelayStatus>>> = OnceLock::new();
static SHUTDOWN: OnceLock<CancellationToken> = OnceLock::new();

pub fn start() {
    if SETTINGS_TX.get().is_some() {
        return;
    }
    let (settings_tx, settings_rx) = watch::channel(RelaySettings::load());
    let (cloud_auth_tx, cloud_auth_rx) = watch::channel(0_u64);
    if SETTINGS_TX.set(settings_tx).is_err() {
        return;
    }
    let _ = CLOUD_AUTH_TX.set(cloud_auth_tx);
    let status = STATUS
        .get_or_init(|| Arc::new(RwLock::new(RelayStatus::default())))
        .clone();
    let shutdown = SHUTDOWN.get_or_init(CancellationToken::new).clone();
    tauri::async_runtime::spawn(supervise(settings_rx, cloud_auth_rx, status, shutdown));
}

pub fn shutdown() {
    if let Some(token) = SHUTDOWN.get() {
        token.cancel();
    }
}

pub fn notify_settings_changed(value: &Value) {
    if let Some(sender) = SETTINGS_TX.get() {
        apply_settings_update(sender, RelaySettings::from_value(value));
    }
}

/// Publish relay settings only when they actually changed.
///
/// The settings watcher fires this hook on every `settings.jsonc` write —
/// theme, font size, sidebar width — and the supervisor tears down the live
/// connection and every per-phone actor whenever the watch channel notifies.
/// `RelaySettings` derives `PartialEq` and only holds connection inputs, so
/// comparing the whole struct keeps future fields covered by construction.
fn apply_settings_update(sender: &watch::Sender<RelaySettings>, next: RelaySettings) -> bool {
    sender.send_if_modified(|current| {
        if *current == next {
            return false;
        }
        *current = next;
        true
    })
}

pub fn notify_cloud_auth_changed() {
    if let Some(sender) = CLOUD_AUTH_TX.get() {
        sender.send_modify(|generation| *generation = generation.saturating_add(1));
    }
}

pub fn request_auth_refresh() {
    if let Some(handle) = crate::api::get_app_handle() {
        let _ = handle.emit(RELAY_AUTH_REFRESH_EVENT, ());
    }
    notify_cloud_auth_changed();
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
    mut cloud_auth_rx: watch::Receiver<u64>,
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
                _ = cloud_auth_rx.changed() => continue,
                _ = shutdown.cancelled() => continue,
            }
        }

        let connection_plan = match current.connection_plan() {
            Ok(plan) => plan,
            Err(message) => {
                reconnect_attempt = 0;
                set_status(&status, RelayPhase::ConfigError, Some(message), 0, None);
                tokio::select! {
                    _ = settings_rx.changed() => continue,
                    _ = cloud_auth_rx.changed() => continue,
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
        // Epoch milliseconds of the relay's registration confirmation for this
        // attempt; `0` means the relay never confirmed it.
        let registered_at_ms = Arc::new(AtomicI64::new(0));
        let run = run_connection(connection_plan, status.clone(), registered_at_ms.clone());
        let error = tokio::select! {
            result = run => Some(result.err().unwrap_or_else(|| "relay connection closed".to_string())),
            _ = settings_rx.changed() => None,
            _ = cloud_auth_rx.changed() => None,
            _ = shutdown.cancelled() => None,
        };
        if error.is_none() {
            continue;
        }

        let established =
            session_was_established(registered_at_ms.load(Ordering::Relaxed), now_ms());
        reconnect_attempt = next_reconnect_attempt(reconnect_attempt, established);
        let delay = reconnect_delay(reconnect_attempt);
        set_status(&status, RelayPhase::Backoff, error, reconnect_attempt, None);
        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = settings_rx.changed() => reconnect_attempt = 0,
            _ = cloud_auth_rx.changed() => reconnect_attempt = 0,
            _ = shutdown.cancelled() => {}
        }
    }
}

async fn run_connection(
    plan: RelayConnectionPlan,
    status: Arc<RwLock<RelayStatus>>,
    registered_at_ms: Arc<AtomicI64>,
) -> Result<(), String> {
    let request = build_websocket_request(&plan)?;
    let (socket, response) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|err| format!("connect to relay: {err}"))?;
    if response.status() == StatusCode::UNAUTHORIZED {
        request_auth_refresh();
        return Err(SESSION_EXPIRED_MESSAGE.to_string());
    }

    // The WebSocket upgrade alone proves nothing: the relay still closes the
    // socket with 1013 when the desktop connection limit is reached, and the
    // previous holder of a desktop id is closed with 1008 as soon as another
    // client registers it. Only the `DesktopRegistered` frame means this
    // process owns the identity, so the status stays `Connecting` until then.
    let desktop_id = plan.desktop_id;
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
                            if frame_confirms_registration(&frame, &desktop_id)
                                && registered_at_ms.load(Ordering::Relaxed) == 0
                            {
                                // `max(1)` keeps `0` reserved for "never registered".
                                let confirmed_at = now_ms().max(1);
                                registered_at_ms.store(confirmed_at, Ordering::Relaxed);
                                set_status(
                                    &status,
                                    RelayPhase::Online,
                                    None,
                                    0,
                                    Some(confirmed_at),
                                );
                            }
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

fn build_websocket_request(
    plan: &RelayConnectionPlan,
) -> Result<tokio_tungstenite::tungstenite::http::Request<()>, String> {
    let mut url = url::Url::parse(&plan.ws_url).map_err(|err| format!("invalid relay URL: {err}"))?;
    url.query_pairs_mut()
        .append_pair("token", plan.access_token.trim());
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|err| format!("build relay websocket request: {err}"))?;
    let bearer = format!("Bearer {}", plan.access_token.trim());
    request.headers_mut().insert(
        AUTHORIZATION,
        HeaderValue::from_str(&bearer)
            .map_err(|err| format!("invalid ORG2 Cloud access token: {err}"))?,
    );
    Ok(request)
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

fn next_reconnect_attempt(previous: u32, established: bool) -> u32 {
    if established {
        1
    } else {
        previous.saturating_add(1)
    }
}

/// The relay emits `DesktopRegistered` only after this connection owns the
/// desktop identity inside the broker. Sockets rejected after the upgrade
/// never reach this frame.
fn frame_confirms_registration(frame: &RelayWireFrame, desktop_id: &str) -> bool {
    matches!(
        frame,
        RelayWireFrame::DesktopRegistered {
            desktop_id: registered,
            ..
        } if registered == desktop_id
    )
}

/// Whether the finished attempt counts as a real session, and may therefore
/// reset the reconnect backoff.
///
/// Registration alone is not enough: two desktops sharing one desktop id
/// register and then evict each other (close code 1008) immediately, so
/// resetting on registration would keep that pair flapping at the floor delay
/// forever. The session must also have survived `MIN_ESTABLISHED_SESSION_MS`.
fn session_was_established(registered_at_ms: i64, now_epoch_ms: i64) -> bool {
    registered_at_ms > 0
        && now_epoch_ms.saturating_sub(registered_at_ms) >= MIN_ESTABLISHED_SESSION_MS
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
    use std::fs;
    use tempfile::TempDir;

    const VALID_AUTH: &str = r#"{
        "kind":"org2_cloud",
        "supabaseUrl":"https://example.supabase.co",
        "supabaseAnonKey":"anon",
        "userId":"user-1",
        "accessToken":"cloud-access-token",
        "refreshToken":"refresh",
        "expiresAt":4102444800
    }"#;

    fn write_auth_store(dir: &TempDir) {
        let store = serde_json::json!({
            org2_cloud_auth::ORG2_CLOUD_AUTH_STORAGE_KEY: VALID_AUTH,
        });
        fs::write(
            dir.path().join("shared-service-auth.json"),
            store.to_string(),
        )
        .expect("write store");
        std::env::set_var(
            "ORGII_TEST_SHARED_AUTH_STORE",
            dir.path().join("shared-service-auth.json"),
        );
    }

    #[test]
    fn settings_are_flat_keys_like_the_settings_registry() {
        let dir = TempDir::new().expect("tempdir");
        write_auth_store(&dir);
        let value = serde_json::json!({
            "mobileRemote.enabled": true,
            "mobileRemote.relayEnabled": true,
            "mobileRemote.relayUrl": "wss://relay.example.com/v1/mobile/ws",
            "mobileRemote.desktopId": "desktop-a",
        });
        let settings = RelaySettings::from_value(&value);
        assert!(settings.enabled);
        assert!(settings.relay_enabled);
        assert_eq!(settings.desktop_id, "desktop-a");
        let plan = settings.connection_plan().expect("connection plan");
        assert!(plan.ws_url.starts_with("wss://relay.example.com/v1/desktop/ws?"));
        assert!(plan.ws_url.contains("desktopId=desktop-a"));
        assert_eq!(plan.access_token, "cloud-access-token");
        let request = build_websocket_request(&plan).expect("request");
        assert_eq!(
            request
                .headers()
                .get(AUTHORIZATION)
                .and_then(|value| value.to_str().ok()),
            Some("Bearer cloud-access-token")
        );
        std::env::remove_var("ORGII_TEST_SHARED_AUTH_STORE");
    }

    #[test]
    fn disabled_or_incomplete_settings_do_not_form_connection_plan() {
        let settings = RelaySettings::from_value(&Value::Null);
        assert!(settings.connection_plan().is_err());
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

    fn relay_settings_json() -> Value {
        serde_json::json!({
            "mobileRemote.enabled": true,
            "mobileRemote.relayEnabled": true,
            "mobileRemote.relayUrl": "wss://relay.example.com",
            "mobileRemote.desktopId": "desktop-a",
            "workbench.colorTheme": "dark",
            "editor.fontSize": 14,
        })
    }

    #[test]
    fn unrelated_settings_writes_do_not_restart_the_relay() {
        let base = relay_settings_json();
        let (settings_tx, settings_rx) = watch::channel(RelaySettings::from_value(&base));

        let mut unrelated = base.clone();
        unrelated["workbench.colorTheme"] = Value::from("light");
        unrelated["editor.fontSize"] = Value::from(18);
        unrelated["workbench.sidebarWidth"] = Value::from(320);

        assert!(!apply_settings_update(
            &settings_tx,
            RelaySettings::from_value(&unrelated)
        ));
        assert!(!settings_rx.has_changed().expect("sender alive"));
    }

    #[test]
    fn connection_relevant_settings_writes_restart_the_relay() {
        let base = relay_settings_json();
        let changes = [
            ("mobileRemote.enabled", Value::from(false)),
            ("mobileRemote.relayEnabled", Value::from(false)),
            (
                "mobileRemote.relayUrl",
                Value::from("wss://other.example.com"),
            ),
            ("mobileRemote.desktopId", Value::from("desktop-b")),
        ];

        for (key, next) in changes {
            let (settings_tx, settings_rx) = watch::channel(RelaySettings::from_value(&base));
            let mut changed = base.clone();
            changed[key] = next;

            assert!(
                apply_settings_update(&settings_tx, RelaySettings::from_value(&changed)),
                "{key} must restart the relay"
            );
            assert!(settings_rx.has_changed().expect("sender alive"));
        }
    }

    #[test]
    fn only_a_matching_registration_frame_confirms_the_session() {
        let registered = RelayWireFrame::DesktopRegistered {
            desktop_id: "desktop-a".to_string(),
            protocol_version: 1,
        };
        assert!(frame_confirms_registration(&registered, "desktop-a"));
        assert!(!frame_confirms_registration(&registered, "desktop-b"));
        assert!(!frame_confirms_registration(
            &RelayWireFrame::Error {
                code: "relay_busy".to_string(),
                message: "desktop connection limit reached".to_string(),
            },
            "desktop-a"
        ));
    }

    #[test]
    fn accept_then_close_grows_the_backoff() {
        let now = 1_700_000_000_000_i64;
        // Closed with 1013 before the relay confirmed the identity.
        assert!(!session_was_established(0, now));
        // Registered, then evicted with 1008 by another desktop sharing the id.
        assert!(!session_was_established(now - 900, now));

        let mut attempt = 0_u32;
        for _ in 0..4 {
            attempt = next_reconnect_attempt(attempt, session_was_established(0, now));
        }
        assert_eq!(attempt, 4);
        assert!(reconnect_delay(attempt) > reconnect_delay(1));
        assert!(reconnect_delay(attempt) < Duration::from_secs(31));
    }

    #[test]
    fn a_registered_session_that_later_drops_resets_the_backoff() {
        let now = 1_700_000_000_000_i64;
        let registered_at = now - MIN_ESTABLISHED_SESSION_MS - 1;

        assert!(session_was_established(registered_at, now));
        assert_eq!(
            next_reconnect_attempt(6, session_was_established(registered_at, now)),
            1
        );
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

//! Frontend event fanout: Tauri IPC channel registry (primary) and WebSocket
//! broadcast (debug/tee).
//!
//! `broadcast()` performs a dual dispatch for every outgoing event:
//!
//! 1. **Tauri IPC channel registry (primary, per-session, backpressure-aware).**
//!    The frontend subscribes to a `session_id` via `subscribe_session_events`
//!    and receives only events scoped to that session. This is the path all
//!    in-app session UI (SDE Agent, OS Agent, CLI, permission/question/plan
//!    cards, tool streams) reads from. Slow subscribers are dropped rather
//!    than blocking the sender.
//!
//! 2. **WebSocket broadcast (tee, fanout to all connected clients).**
//!    Kept for debug clients and non-session IDE events:
//!    - `repo:status_updated` — git status changed
//!    - `file:changed`        — file modified on disk
//!    - LSP diagnostics
//!
//!    Agent session events are teed here opportunistically; the in-app UI
//!    does not consume them via this path.
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{OnceLock, RwLock};

use axum::extract::ws::{Message, WebSocket};
use axum::{
    extract::{State, WebSocketUpgrade},
    response::IntoResponse,
};
use futures_util::{sink::SinkExt, stream::StreamExt};
use tauri::ipc::Channel;
use tokio::sync::broadcast;

// Global broadcast channel for WebSocket messages
// This is initialized once when the server starts and shared across all modules
pub static WS_BROADCASTER: OnceLock<broadcast::Sender<String>> = OnceLock::new();

static NEXT_CHANNEL_ID: AtomicU64 = AtomicU64::new(1);

const MAX_CONSECUTIVE_FAILURES: u32 = 3;

struct RegisteredChannel {
    channel_id: u64,
    channel: Channel<String>,
    consecutive_failures: u32,
}

// Per-session Tauri IPC Channel registry
// Maps session_id → list of registered channels
static CHANNEL_REGISTRY: OnceLock<RwLock<HashMap<String, Vec<RegisteredChannel>>>> =
    OnceLock::new();

fn get_registry() -> &'static RwLock<HashMap<String, Vec<RegisteredChannel>>> {
    CHANNEL_REGISTRY.get_or_init(|| RwLock::new(HashMap::new()))
}

/// Register a Tauri IPC Channel for a specific session.
/// Returns a unique `channel_id` for targeted unsubscription.
pub fn register_channel(session_id: String, channel: Channel<String>) -> u64 {
    let channel_id = NEXT_CHANNEL_ID.fetch_add(1, Ordering::Relaxed);
    if let Ok(mut map) = get_registry().write() {
        tracing::info!(
            "[IPC] channel {} registered for session {}",
            channel_id,
            session_id
        );
        map.entry(session_id).or_default().push(RegisteredChannel {
            channel_id,
            channel,
            consecutive_failures: 0,
        });
    }
    channel_id
}

/// Unregister a specific channel by its `channel_id`.
/// Only removes the targeted channel — other channels for the same
/// session are left intact, preventing race conditions when the
/// frontend unmounts and re-mounts quickly.
pub fn unregister_channel(session_id: &str, channel_id: u64) {
    if let Ok(mut map) = get_registry().write() {
        if let Some(channels) = map.get_mut(session_id) {
            channels.retain(|entry| entry.channel_id != channel_id);
            tracing::info!(
                "[IPC] channel {} unregistered for session {} ({} remain)",
                channel_id,
                session_id,
                channels.len()
            );
            if channels.is_empty() {
                map.remove(session_id);
            }
        }
    }
}

/// Unregister all channels for a session (used on session destroy).
pub fn unregister_all_channels(session_id: &str) {
    if let Ok(mut map) = get_registry().write() {
        map.remove(session_id);
    }
}

/// Total number of frontend subscribers — IPC channels plus debug WebSocket
/// clients. Used by tools (e.g. `ActionBridge`) to decide whether a
/// round-trip dispatch has any chance of being answered.
pub fn frontend_subscriber_count() -> usize {
    let ipc_count = get_registry()
        .read()
        .map(|map| map.values().map(|chans| chans.len()).sum::<usize>())
        .unwrap_or(0);
    let ws_count = WS_BROADCASTER
        .get()
        .map(|tx| tx.receiver_count())
        .unwrap_or(0);
    ipc_count + ws_count
}

/// Extract session_id from a JSON message string.
/// Checks top-level `session_id` / `sessionId` and nested `payload.session_id` / `payload.sessionId`.
pub(crate) fn extract_session_id(message: &str) -> Option<String> {
    let parsed: serde_json::Value = serde_json::from_str(message).ok()?;

    // Top-level session_id / sessionId
    for key in &["session_id", "sessionId"] {
        if let Some(sid) = parsed.get(*key).and_then(|v| v.as_str()) {
            if !sid.is_empty() {
                return Some(sid.to_string());
            }
        }
    }

    // Nested payload.session_id / payload.sessionId (agent events via broadcast_event)
    if let Some(payload) = parsed.get("payload") {
        for key in &["session_id", "sessionId"] {
            if let Some(sid) = payload.get(*key).and_then(|v| v.as_str()) {
                if !sid.is_empty() {
                    return Some(sid.to_string());
                }
            }
        }
    }

    None
}

fn event_type(message: &str) -> Option<String> {
    let parsed: serde_json::Value = serde_json::from_str(message).ok()?;
    parsed
        .get("type")
        .and_then(|value| value.as_str())
        .map(str::to_string)
}

fn dispatch_to_channel_entries(
    session_id: &str,
    channels: &mut Vec<RegisteredChannel>,
    message: &str,
) {
    let mut delivered = false;
    for entry in channels.iter_mut() {
        if entry.channel.send(message.to_string()).is_ok() {
            entry.consecutive_failures = 0;
            delivered = true;
        } else {
            entry.consecutive_failures += 1;
            if entry.consecutive_failures == 1 {
                tracing::warn!(
                    "[IPC] Channel {} for session {} send failed (attempt {}/{})",
                    entry.channel_id,
                    session_id,
                    entry.consecutive_failures,
                    MAX_CONSECUTIVE_FAILURES
                );
            }
        }
    }
    if delivered {
        // Channel payloads are drained on the webview main thread; on macOS
        // the idle main run loop may not wake for work queued from this
        // background thread until the next user-input event ("UI frozen
        // until the mouse moves"). Nudge it so delivery is immediate.
        crate::infrastructure::main_runloop::wake_main_runloop();
    }

    channels.retain(|entry| {
        if entry.consecutive_failures >= MAX_CONSECUTIVE_FAILURES {
            tracing::warn!(
                "[IPC] Dropping channel {} for session {} after {} consecutive failures",
                entry.channel_id,
                session_id,
                entry.consecutive_failures
            );
            false
        } else {
            true
        }
    });
}

/// Dispatch a message to all Tauri Channels registered for its session_id.
///
/// Session-less IDE action requests are global UI-control bridge messages, so
/// they are delivered to every registered frontend channel. The first mounted
/// frontend listener to answer resolves the bridge correlation ID.
fn dispatch_to_channels(message: &str) {
    let target_session_id = extract_session_id(message);
    let is_global_ade_action =
        target_session_id.is_none() && event_type(message).as_deref() == Some("agent:ade_action");

    if !is_global_ade_action && target_session_id.is_none() {
        return;
    }

    if let Ok(mut map) = get_registry().write() {
        if let Some(sid) = target_session_id {
            if let Some(channels) = map.get_mut(&sid) {
                dispatch_to_channel_entries(&sid, channels, message);
                if channels.is_empty() {
                    map.remove(&sid);
                }
            } else if matches!(
                event_type(message).as_deref(),
                Some("agent:complete") | Some("agent:error")
            ) {
                tracing::warn!(
                    "[IPC] no channel registered for session {}; dropping {} — \
                     the frontend never subscribed this session's events and \
                     its turn will only end via the planning-indicator watchdog",
                    sid,
                    event_type(message).as_deref().unwrap_or("?")
                );
            }
            return;
        }

        let session_ids: Vec<String> = map.keys().cloned().collect();
        for sid in session_ids {
            if let Some(channels) = map.get_mut(&sid) {
                dispatch_to_channel_entries(&sid, channels, message);
            }
        }
        map.retain(|_, channels| !channels.is_empty());
    }
}

/// WebSocket upgrade handler
pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(tx): State<broadcast::Sender<String>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, tx))
}

/// Handle individual WebSocket connection
async fn handle_socket(socket: WebSocket, tx: broadcast::Sender<String>) {
    let (mut sender, mut receiver) = socket.split();

    // Subscribe to broadcast channel
    let mut rx = tx.subscribe();

    // Spawn task to send messages from broadcast channel to WebSocket
    let mut send_task = tokio::spawn(async move {
        while let Ok(msg) = rx.recv().await {
            if sender.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
    });

    // Spawn task to receive messages from WebSocket (ping/pong, close)
    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = receiver.next().await {
            match msg {
                Message::Close(_) => break,
                Message::Ping(_data) => {
                    // Respond to ping with pong (handled automatically by axum)
                    log::debug!("[IDE WS] Received ping");
                }
                Message::Pong(_) => {
                    log::debug!("[IDE WS] Received pong");
                }
                _ => {
                    // Ignore other message types from client
                }
            }
        }
    });

    // Wait for either task to finish (connection close or error)
    tokio::select! {
        _ = (&mut send_task) => {
            recv_task.abort();
        }
        _ = (&mut recv_task) => {
            send_task.abort();
        }
    }

    log::debug!("[IDE WS] Client disconnected");
}

/// Initialize the global WebSocket broadcaster
pub fn init_broadcaster(tx: broadcast::Sender<String>) {
    if WS_BROADCASTER.set(tx.clone()).is_err() {
        log::warn!("[IDE WS] Broadcaster already initialized");
    }
}

/// Fan out a message to all frontend subscribers.
///
/// Dispatches to any registered per-session Tauri IPC Channels (primary path
/// for in-app UI) AND tees to the debug WebSocket broadcaster. Both steps
/// are best-effort — missing subscribers and slow consumers are dropped.
pub fn broadcast(message: String) {
    #[cfg(debug_assertions)]
    recent_events::push(&message);

    if let Some(tx) = WS_BROADCASTER.get() {
        // Ignore send errors (no clients connected)
        let _ = tx.send(message.clone());
    } else {
        log::warn!("[IDE WS] Broadcaster not initialized, message dropped");
    }

    // Dispatch to Tauri IPC Channels (per-session, backpressure-aware)
    dispatch_to_channels(&message);
}

// ════════════════════════════════════════════════════════════════
// Debug-only recent-events ring buffer
//
// Purpose: give the e2e_test binary a synchronous way to assert that a
// given broadcast actually reached `broadcast()` (i.e. the last hop
// before IPC fan-out). Unlike the counter probes, this captures the
// full serialized envelope so callers can grep for `type` + payload
// fields without needing a live WebSocket client.
//
// Scoped to `#[cfg(debug_assertions)]` so the production binary carries
// zero overhead.
// ════════════════════════════════════════════════════════════════

#[cfg(debug_assertions)]
pub mod recent_events {
    use std::collections::VecDeque;
    use std::sync::{LazyLock, Mutex};

    const CAPACITY: usize = 256;

    static BUFFER: LazyLock<Mutex<VecDeque<String>>> =
        LazyLock::new(|| Mutex::new(VecDeque::with_capacity(CAPACITY)));

    pub(super) fn push(message: &str) {
        match BUFFER.lock() {
            Ok(mut buf) => {
                if buf.len() == CAPACITY {
                    buf.pop_front();
                }
                buf.push_back(message.to_string());
            }
            Err(err) => {
                // Mutex poisoning means a previous holder panicked.
                // Silently dropping a broadcast event would make the
                // E2E debug snapshot endpoint silently miss messages
                // — and the buffer would never recover. Warn so the
                // poisoning is visible in logs.
                tracing::warn!(
                    error = %err,
                    "websocket_handler::push: replay BUFFER mutex poisoned; broadcast not recorded"
                );
            }
        }
    }

    /// Return a snapshot of the buffer in insertion order (oldest first).
    pub fn snapshot() -> Vec<String> {
        match BUFFER.lock() {
            Ok(buf) => buf.iter().cloned().collect(),
            Err(err) => {
                tracing::warn!(
                    error = %err,
                    "websocket_handler::snapshot: replay BUFFER mutex poisoned; returning empty"
                );
                Vec::new()
            }
        }
    }

    /// Clear the buffer — used by e2e tests to isolate scenarios.
    pub fn clear() {
        match BUFFER.lock() {
            Ok(mut buf) => buf.clear(),
            Err(err) => {
                tracing::warn!(
                    error = %err,
                    "websocket_handler::clear: replay BUFFER mutex poisoned; nothing cleared"
                );
            }
        }
    }
}

// ════════════════════════════════════════════════════════════════
// Tauri commands for frontend Channel subscription
// ════════════════════════════════════════════════════════════════

#[tauri::command]
pub async fn subscribe_session_events(
    session_id: String,
    on_event: Channel<String>,
) -> Result<u64, String> {
    let channel_id = register_channel(session_id, on_event);
    Ok(channel_id)
}

#[tauri::command]
pub async fn unsubscribe_session_events(
    session_id: String,
    channel_id: Option<u64>,
) -> Result<(), String> {
    if let Some(cid) = channel_id {
        unregister_channel(&session_id, cid);
    } else {
        unregister_all_channels(&session_id);
    }
    Ok(())
}

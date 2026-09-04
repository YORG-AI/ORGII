//! Per-session fanout registry for mobile WebSocket subscribers.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{OnceLock, RwLock};

use serde_json::Value;
use tokio::sync::mpsc;

static NEXT_CONN_ID: AtomicU64 = AtomicU64::new(1);

struct MobileConnection {
    sender: mpsc::Sender<String>,
    subscribed_sessions: HashSet<String>,
}

static CONNECTIONS: OnceLock<RwLock<HashMap<u64, MobileConnection>>> = OnceLock::new();

fn connections() -> &'static RwLock<HashMap<u64, MobileConnection>> {
    CONNECTIONS.get_or_init(|| RwLock::new(HashMap::new()))
}

/// Register a new mobile WebSocket connection. Returns a stable connection id.
pub fn register_connection(sender: mpsc::Sender<String>) -> u64 {
    let conn_id = NEXT_CONN_ID.fetch_add(1, Ordering::Relaxed);
    if let Ok(mut map) = connections().write() {
        map.insert(
            conn_id,
            MobileConnection {
                sender,
                subscribed_sessions: HashSet::new(),
            },
        );
    }
    conn_id
}

/// Remove a connection and all of its session subscriptions.
pub fn unregister_connection(conn_id: u64) {
    if let Ok(mut map) = connections().write() {
        map.remove(&conn_id);
    }
}

/// Subscribe `conn_id` to `session_id`. Returns false when the connection is unknown.
pub fn subscribe_session(conn_id: u64, session_id: &str) -> bool {
    if session_id.is_empty() {
        return false;
    }
    if let Ok(mut map) = connections().write() {
        if let Some(conn) = map.get_mut(&conn_id) {
            conn.subscribed_sessions.insert(session_id.to_string());
            return true;
        }
    }
    false
}

/// Unsubscribe `conn_id` from `session_id`.
pub fn unsubscribe_session(conn_id: u64, session_id: &str) {
    if let Ok(mut map) = connections().write() {
        if let Some(conn) = map.get_mut(&conn_id) {
            conn.subscribed_sessions.remove(session_id);
        }
    }
}

/// Number of sessions a connection is subscribed to.
pub fn subscription_count(conn_id: u64) -> usize {
    connections()
        .read()
        .ok()
        .and_then(|map| map.get(&conn_id).map(|conn| conn.subscribed_sessions.len()))
        .unwrap_or(0)
}

/// Whether a connection is already subscribed to `session_id`.
pub fn is_subscribed(conn_id: u64, session_id: &str) -> bool {
    connections()
        .read()
        .ok()
        .and_then(|map| {
            map.get(&conn_id)
                .map(|conn| conn.subscribed_sessions.contains(session_id))
        })
        .unwrap_or(false)
}

/// Deliver a pre-serialized JSON-RPC notification string to subscribers of `session_id`.
pub fn fanout_to_session(session_id: &str, message: &str) {
    let subscribers: Vec<mpsc::Sender<String>> = connections()
        .read()
        .ok()
        .map(|map| {
            map.values()
                .filter(|conn| conn.subscribed_sessions.contains(session_id))
                .map(|conn| conn.sender.clone())
                .collect()
        })
        .unwrap_or_default();

    for sender in subscribers {
        // Best-effort: drop slow mobile peers rather than block the producer.
        let _ = sender.try_send(message.to_string());
    }
}

/// Deliver a pre-serialized JSON-RPC notification to every connected mobile
/// peer. Used for app-scoped invalidation such as the desktop Sidebar roster.
pub fn fanout_all(message: &str) {
    let subscribers: Vec<mpsc::Sender<String>> = connections()
        .read()
        .ok()
        .map(|map| map.values().map(|conn| conn.sender.clone()).collect())
        .unwrap_or_default();

    for sender in subscribers {
        // Best-effort: a slow peer will recover through `session/list` on its
        // next reconnect or manual refresh.
        let _ = sender.try_send(message.to_string());
    }
}

/// Hook point: forward IDE bus broadcast events to mobile `orgii/event` notifications.
pub fn on_bus_message(message: &str) {
    let Some(session_id) = crate::api::websocket_handler::extract_session_id(message) else {
        return;
    };

    let envelope = serde_json::from_str::<Value>(message).unwrap_or(Value::Null);
    let notification = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "orgii/event",
        "params": {
            "channel": "bus",
            "sessionId": session_id,
            "envelope": envelope,
        }
    });
    fanout_to_session(&session_id, &notification.to_string());
}

/// Hook point: forward EventStore snapshot envelopes to mobile `orgii/snapshot` notifications.
pub fn on_snapshot_envelope(envelope: &Value) {
    let session_id = envelope
        .get("sessionId")
        .or_else(|| envelope.get("session_id"))
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty());

    let Some(session_id) = session_id else {
        return;
    };

    let notification = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "orgii/snapshot",
        "params": crate::api::mobile_bridge::adapters::session::compact_snapshot_envelope_for_mobile(envelope),
    });
    fanout_to_session(session_id, &notification.to_string());
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, MutexGuard};
    use tokio::sync::mpsc::error::TryRecvError;

    static TEST_REGISTRY_LOCK: Mutex<()> = Mutex::new(());

    fn isolated_registry() -> MutexGuard<'static, ()> {
        let guard = TEST_REGISTRY_LOCK.lock().expect("test registry lock");
        connections().write().expect("connections lock").clear();
        guard
    }

    fn fresh_conn() -> (u64, mpsc::Receiver<String>) {
        let (tx, rx) = mpsc::channel(8);
        let conn_id = register_connection(tx);
        (conn_id, rx)
    }

    #[test]
    fn fanout_routes_only_to_subscribed_session() {
        let _registry = isolated_registry();
        let (conn_a, mut rx_a) = fresh_conn();
        let (conn_b, mut rx_b) = fresh_conn();

        assert!(subscribe_session(conn_a, "session-alpha"));
        assert!(subscribe_session(conn_b, "session-beta"));

        fanout_to_session("session-alpha", r#"{"jsonrpc":"2.0","method":"ping"}"#);

        assert_eq!(
            rx_a.try_recv(),
            Ok(r#"{"jsonrpc":"2.0","method":"ping"}"#.to_string())
        );
        assert_eq!(rx_b.try_recv(), Err(TryRecvError::Empty));

        unsubscribe_session(conn_a, "session-alpha");
        fanout_to_session("session-alpha", r#"{"jsonrpc":"2.0","method":"pong"}"#);
        assert_eq!(rx_a.try_recv(), Err(TryRecvError::Empty));

        unregister_connection(conn_a);
        unregister_connection(conn_b);
    }

    #[test]
    fn fanout_all_reaches_connections_without_session_subscriptions() {
        let _registry = isolated_registry();
        let (conn_a, mut rx_a) = fresh_conn();
        let (conn_b, mut rx_b) = fresh_conn();

        fanout_all(r#"{"jsonrpc":"2.0","method":"session/list_changed"}"#);

        assert!(rx_a.try_recv().is_ok());
        assert!(rx_b.try_recv().is_ok());

        unregister_connection(conn_a);
        unregister_connection(conn_b);
    }

    #[test]
    fn on_bus_message_wraps_session_scoped_envelope() {
        let _registry = isolated_registry();
        let (conn_id, mut rx) = fresh_conn();
        assert!(subscribe_session(conn_id, "sde-1"));

        let bus =
            r#"{"type":"permission:request","payload":{"sessionId":"sde-1","requestId":"p1"}}"#;
        on_bus_message(bus);

        let delivered = rx.try_recv().expect("notification delivered");
        let parsed: Value = serde_json::from_str(&delivered).expect("valid json");
        assert_eq!(
            parsed.get("method").and_then(|v| v.as_str()),
            Some("orgii/event")
        );
        assert_eq!(
            parsed.pointer("/params/sessionId").and_then(|v| v.as_str()),
            Some("sde-1")
        );
        assert_eq!(
            parsed
                .pointer("/params/envelope/type")
                .and_then(|v| v.as_str()),
            Some("permission:request")
        );

        unregister_connection(conn_id);
    }

    #[test]
    fn on_snapshot_envelope_fanouts_orgii_snapshot_method() {
        let _registry = isolated_registry();
        let (conn_id, mut rx) = fresh_conn();
        assert!(subscribe_session(conn_id, "sde-2"));

        let envelope = serde_json::json!({
            "sessionId": "sde-2",
            "version": 3,
            "upserts": [],
        });
        on_snapshot_envelope(&envelope);

        let delivered = rx.try_recv().expect("snapshot delivered");
        let parsed: Value = serde_json::from_str(&delivered).expect("valid json");
        assert_eq!(
            parsed.get("method").and_then(|v| v.as_str()),
            Some("orgii/snapshot")
        );
        assert_eq!(
            parsed.pointer("/params/sessionId").and_then(|v| v.as_str()),
            Some("sde-2")
        );

        unregister_connection(conn_id);
    }
}

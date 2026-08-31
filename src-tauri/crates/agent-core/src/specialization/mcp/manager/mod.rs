//! MCP Manager — lifecycle management for all configured MCP servers.
//!
//! Connects/disconnects servers, aggregates tool listings, and dispatches
//! tool calls to the correct server.
//!
//! ## Module layout
//!
//! The manager is split across files by concern, all sharing one
//! `impl McpManager` per file. The struct itself + ctor + counters
//! live here; everything else is co-located with its concern:
//!
//! - [`counters`] — `NotificationCounters` + `NotificationCountersSnapshot`
//!   types and their snapshot/reset/`debug_inject_notification` methods.
//! - [`needs_auth`] — read/write the per-manager `needs_auth` map.
//! - [`lifecycle`] — `connect_all`, `connect_server`, `disconnect_server`,
//!   `reconnect_server`, `set_disabled`, `bulk_*`, `shutdown_all`.
//! - [`tools`] — `all_tools`, `server_tools`, `call_tool*`.
//! - [`resources`] — `list_resources`, `read_resource`,
//!   `list_resource_templates`, `all_resources`.
//! - [`prompts`] — `list_prompts`, `get_prompt`, `all_prompts`,
//!   `debug_prompts_cache_has`.
//! - [`status`] — `all_statuses_with_config`, `connected_count`,
//!   `is_connected`.
//! - [`notifications`] — `spawn_notification_listener` (the per-client
//!   tokio task that handles `notifications/*` from the server).

mod counters;
mod lifecycle;
mod needs_auth;
mod notifications;
mod prompts;
mod resources;
mod status;
mod tools;

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use tokio::sync::Mutex;

use super::client::McpClient;
use super::config::{McpServerConfig, McpTransportType};
use super::prompts::McpPrompt;

// `NotificationCounters` / `NotificationCountersSnapshot` are reached only
// through this module (the manager itself + the debug-endpoint helpers in
// `specialization::mcp::manager::counters`). Pull them in privately so the
// fields below resolve, but do not flatten them onto `manager::*`.
use counters::NotificationCounters;

/// Manages the lifecycle of all MCP server connections.
pub struct McpManager {
    pub(super) clients: Mutex<HashMap<String, Arc<McpClient>>>,
    /// Errors from the most recent connection attempt per server.
    pub(super) connection_errors: Mutex<HashMap<String, String>>,
    /// Servers currently being connected in the background.
    pub(super) connecting: Mutex<HashSet<String>>,
    /// Handles for notification listener tasks.
    pub(super) notification_handles: Mutex<Vec<tokio::task::JoinHandle<()>>>,
    /// Servers that are flagged needs-auth (either because the cache hit
    /// short-circuited a connect, or because a tool call returned
    /// `McpCallError::Auth`). Stored with their full `McpServerConfig`
    /// so the bridge layer can materialize a `McpAuthTool` pseudo-tool
    /// without re-loading the config file — the auth-prompt UI must be
    /// reachable even when no live client exists for the server yet.
    pub(super) needs_auth: Mutex<HashMap<String, McpServerConfig>>,
    /// Per-manager notification counters. Shared (via `Arc`) with the
    /// background listener task spawned per-client in
    /// [`notifications::McpManager::spawn_notification_listener`].
    pub(super) notification_counters: Arc<NotificationCounters>,
    /// Per-server cache of `prompts/list` results. Populated lazily on
    /// the first `list_prompts` call and cleared on
    /// `notifications/prompts/list_changed`. Keyed by server name so a
    /// reconnect under the same name reuses the cached entry until the
    /// server actually re-publishes its prompt list.
    pub(super) prompts_cache: Arc<Mutex<HashMap<String, Vec<McpPrompt>>>>,
}

impl McpManager {
    /// Create an empty manager.
    pub fn new() -> Self {
        Self {
            clients: Mutex::new(HashMap::new()),
            connection_errors: Mutex::new(HashMap::new()),
            connecting: Mutex::new(HashSet::new()),
            notification_handles: Mutex::new(Vec::new()),
            needs_auth: Mutex::new(HashMap::new()),
            notification_counters: Arc::new(NotificationCounters::default()),
            prompts_cache: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl Default for McpManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Only remote transports (`sse` / `streamable-http`) go through the
/// needs-auth machinery. Stdio servers authenticate out-of-band (env
/// vars, keychain, etc.) and we never 401 them.
pub(super) fn is_remote(config: &McpServerConfig) -> bool {
    matches!(
        config.transport_type,
        McpTransportType::Sse | McpTransportType::StreamableHttp
    )
}

/// Classify a connect-time error string. `McpClient::connect` returns
/// `Result<_, String>` so we have to pattern-match on the message. The
/// substrings are the same hooks used by `McpCallError::classify_service_error`
/// (401 / `Unauthorized` / `invalid_token` / `authentication`).
pub(super) fn is_remote_auth_error(err: &str) -> bool {
    let lower = err.to_ascii_lowercase();
    lower.contains("401")
        || lower.contains("unauthorized")
        || lower.contains("invalid_token")
        || lower.contains("authentication")
        || lower.contains("authorization required")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stdio(cmd: &str) -> McpServerConfig {
        McpServerConfig {
            transport_type: McpTransportType::Stdio,
            command: Some(cmd.into()),
            args: None,
            cwd: None,
            env: None,
            url: None,
            headers: None,
            auto_approve: None,
            disabled: false,
            timeout: 30,
        }
    }

    fn http(url: &str) -> McpServerConfig {
        McpServerConfig {
            transport_type: McpTransportType::StreamableHttp,
            command: None,
            args: None,
            cwd: None,
            env: None,
            url: Some(url.into()),
            headers: None,
            auto_approve: None,
            disabled: false,
            timeout: 30,
        }
    }

    #[test]
    fn is_remote_only_for_sse_and_streamable_http() {
        assert!(!is_remote(&stdio("echo")));
        assert!(is_remote(&http("https://example.com")));
        let mut sse = http("https://example.com");
        sse.transport_type = McpTransportType::Sse;
        assert!(is_remote(&sse));
    }

    #[test]
    fn is_remote_auth_error_matches_401_family() {
        assert!(is_remote_auth_error("HTTP 401 Unauthorized"));
        assert!(is_remote_auth_error("invalid_token from provider"));
        assert!(is_remote_auth_error("Authentication failed"));
        assert!(is_remote_auth_error("authorization required"));
        assert!(is_remote_auth_error("UNAUTHORIZED"));
    }

    #[test]
    fn is_remote_auth_error_ignores_unrelated_messages() {
        assert!(!is_remote_auth_error("connection reset by peer"));
        assert!(!is_remote_auth_error("timeout waiting for handshake"));
        assert!(!is_remote_auth_error("no route to host"));
    }

    #[tokio::test]
    async fn mark_and_clear_needs_auth_round_trip() {
        // `mark_needs_auth` / `clear_needs_auth` write the on-disk
        // needs-auth cache, which is keyed off `ORGII_HOME`.
        let _sandbox = test_helpers::test_env::sandbox();
        let mgr = McpManager::new();
        assert!(!mgr.is_needs_auth("srv").await);
        mgr.mark_needs_auth("srv", &http("https://x.test")).await;
        assert!(mgr.is_needs_auth("srv").await);
        let servers = mgr.needs_auth_servers().await;
        assert!(servers.iter().any(|(n, _)| n == "srv"));
        mgr.clear_needs_auth("srv").await;
        assert!(!mgr.is_needs_auth("srv").await);
    }

    #[test]
    fn notification_counters_start_at_zero() {
        let counters = NotificationCounters::default();
        let snap = counters.snapshot();
        assert_eq!(snap.tools_refreshed, 0);
        assert_eq!(snap.resources_list_changed, 0);
        assert_eq!(snap.resources_updated, 0);
        assert_eq!(snap.prompts_list_changed, 0);
        assert_eq!(snap.unknown, 0);
    }

    #[test]
    fn notification_counters_increment_and_reset() {
        use std::sync::atomic::Ordering;
        let counters = NotificationCounters::default();
        counters.tools_refreshed.fetch_add(3, Ordering::SeqCst);
        counters
            .resources_list_changed
            .fetch_add(2, Ordering::SeqCst);
        counters.resources_updated.fetch_add(5, Ordering::SeqCst);
        counters.prompts_list_changed.fetch_add(1, Ordering::SeqCst);
        counters.unknown.fetch_add(7, Ordering::SeqCst);

        let snap = counters.snapshot();
        assert_eq!(snap.tools_refreshed, 3);
        assert_eq!(snap.resources_list_changed, 2);
        assert_eq!(snap.resources_updated, 5);
        assert_eq!(snap.prompts_list_changed, 1);
        assert_eq!(snap.unknown, 7);

        counters.reset();
        let snap = counters.snapshot();
        assert_eq!(snap.tools_refreshed, 0);
        assert_eq!(snap.resources_list_changed, 0);
        assert_eq!(snap.resources_updated, 0);
        assert_eq!(snap.prompts_list_changed, 0);
        assert_eq!(snap.unknown, 0);
    }

    #[tokio::test]
    async fn manager_exposes_counter_snapshot_and_reset() {
        use std::sync::atomic::Ordering;
        let mgr = McpManager::new();
        let snap = mgr.notification_counters();
        assert_eq!(snap.tools_refreshed, 0);

        mgr.notification_counters
            .resources_updated
            .fetch_add(4, Ordering::SeqCst);
        assert_eq!(mgr.notification_counters().resources_updated, 4);

        mgr.reset_notification_counters();
        assert_eq!(mgr.notification_counters().resources_updated, 0);
    }

    #[tokio::test]
    async fn debug_inject_notification_fails_for_unknown_server() {
        let mgr = McpManager::new();
        let err = mgr
            .debug_inject_notification("missing", "notifications/tools/list_changed", None)
            .await
            .expect_err("should reject unknown server");
        assert!(err.contains("missing"));
    }
}

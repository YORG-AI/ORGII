//! Per-client notification listener task.

use std::sync::atomic::Ordering;
use std::sync::Arc;

use tracing::{debug, info, warn};

use super::McpManager;
use crate::specialization::mcp::client::McpClient;
use crate::specialization::mcp::config::redact_server_secrets_from_text;

impl McpManager {
    /// Spawn a background task that listens for server notifications and
    /// handles them.
    ///
    /// | Notification                            | Behavior                                                                                                                            |
    /// |-----------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------|
    /// | `notifications/tools/list_changed`      | `client.refresh_tools()` + counter bump                                                                                             |
    /// | `notifications/resources/list_changed`  | No resource cache to invalidate (every `list_resources` call already hits `rmcp` live), so counter bump + info log is the refresh   |
    /// | `notifications/resources/updated(uri)`  | Counter bump + info log including the URI                                                                                           |
    /// | `notifications/prompts/list_changed`    | Invalidate per-server prompt cache; next `list_prompts` call re-fetches from the server.                                            |
    ///
    /// Deliberately **not** emitting Tauri events here — any future UI-facing
    /// event broadcast needs an explicit consumer, not a speculative tap.
    pub(super) async fn spawn_notification_listener(&self, client: &Arc<McpClient>) {
        let mut rx = match client.take_notification_rx().await {
            Some(rx) => rx,
            None => return,
        };

        let client = Arc::clone(client);
        let server_name = client.name().to_string();
        let counters = Arc::clone(&self.notification_counters);
        let prompts_cache = Arc::clone(&self.prompts_cache);

        let handle = tokio::spawn(async move {
            while let Some(notif) = rx.recv().await {
                match notif.method.as_str() {
                    "notifications/tools/list_changed" => {
                        info!(
                            "[mcp:manager] Tools changed on '{}', refreshing",
                            server_name
                        );
                        if let Err(err) = client.refresh_tools().await {
                            warn!(
                                "[mcp:manager] Failed to refresh tools for '{}': {}",
                                server_name, err
                            );
                        }
                        counters.tools_refreshed.fetch_add(1, Ordering::SeqCst);
                    }
                    "notifications/resources/list_changed" => {
                        info!(
                            "[mcp:manager] Resources changed on '{}' — next list_resources call will return fresh data (no cache to invalidate)",
                            server_name
                        );
                        counters
                            .resources_list_changed
                            .fetch_add(1, Ordering::SeqCst);
                    }
                    "notifications/resources/updated" => {
                        let uri = notif
                            .params
                            .as_ref()
                            .and_then(|p| p.get("uri"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("<missing-uri>");
                        let safe_uri = redact_server_secrets_from_text(client.config(), uri);
                        info!(
                            "[mcp:manager] Resource updated on '{}': {} — next read_resource call will return fresh data",
                            server_name, safe_uri
                        );
                        counters.resources_updated.fetch_add(1, Ordering::SeqCst);
                    }
                    "notifications/prompts/list_changed" => {
                        let removed = prompts_cache.lock().await.remove(&server_name).is_some();
                        info!(
                            "[mcp:manager] Prompts changed on '{}' — cache invalidated (had cached entry: {})",
                            server_name, removed
                        );
                        counters.prompts_list_changed.fetch_add(1, Ordering::SeqCst);
                    }
                    other => {
                        let safe_method = redact_server_secrets_from_text(client.config(), other);
                        debug!(
                            "[mcp:manager] Unknown notification from '{}': {}",
                            server_name, safe_method
                        );
                        counters.unknown.fetch_add(1, Ordering::SeqCst);
                    }
                }
            }
        });

        self.notification_handles.lock().await.push(handle);
    }
}

//! Connection lifecycle: connect / disconnect / reconnect / disable.

use std::path::Path;
use std::sync::Arc;

use futures::future::join_all;
use tracing::{info, warn};

use super::{is_remote, is_remote_auth_error, McpManager};
use crate::specialization::mcp::client::McpClient;
use crate::specialization::mcp::config::{
    locate_owning_config, redact_server_secrets_from_text, update_config_file, McpConfigFile,
    McpServerConfig,
};

impl McpManager {
    /// Load config and connect to all enabled servers **in parallel**.
    ///
    /// Servers that fail to connect are logged but don't block others. Each
    /// connect attempt spawns its own `McpClient::connect` future and they
    /// are all driven concurrently via `join_all`, so total wall time for N
    /// stdio servers is ~max(per-server spawn+handshake) instead of the sum.
    pub async fn connect_all(
        &self,
        workspace_path: Option<&Path>,
        load_workspace_resources: bool,
    ) -> Vec<String> {
        let config = match McpConfigFile::load_merged_with_workspace_scope(
            workspace_path,
            load_workspace_resources,
        ) {
            Ok(config) => config,
            Err(err) => return vec![err],
        };

        let names_to_connect: Vec<(String, McpServerConfig)> = config
            .mcp_servers
            .into_iter()
            .filter(|(_, cfg)| !cfg.disabled)
            .collect();

        {
            let mut connecting = self.connecting.lock().await;
            for (name, _) in &names_to_connect {
                connecting.insert(name.clone());
            }
        }

        let connect_futures = names_to_connect
            .iter()
            .map(|(name, server_config)| self.connect_one_for_connect_all(name, server_config));
        let per_server_errors = join_all(connect_futures).await;

        per_server_errors.into_iter().flatten().collect()
    }

    /// Single-server connect path used by `connect_all`. Returns the error
    /// message if this server failed with a non-auth error (the one case the
    /// aggregate `errors` vec cares about); `None` otherwise (success, cached
    /// needs-auth, or live auth failure — all handled internally).
    ///
    /// Kept as a private helper instead of reusing `connect_server` because
    /// `connect_server`:
    ///   - disconnects any existing client first (wrong during bulk init),
    ///   - turns auth-errors into `Ok(())` silently, losing the per-server
    ///     error log `connect_all` used to emit.
    async fn connect_one_for_connect_all(
        &self,
        name: &str,
        server_config: &McpServerConfig,
    ) -> Option<String> {
        if is_remote(server_config)
            && crate::specialization::mcp::needs_auth_cache::is_cached(name).await
        {
            info!(
                "[mcp:manager] Skipping '{}' connect (cached needs-auth)",
                name
            );
            self.needs_auth
                .lock()
                .await
                .insert(name.to_string(), server_config.clone());
            self.connection_errors.lock().await.remove(name);
            self.connecting.lock().await.remove(name);
            return None;
        }

        let outcome = match McpClient::connect(name, server_config).await {
            Ok(client) => {
                let client = Arc::new(client);
                self.spawn_notification_listener(&client).await;
                crate::specialization::mcp::instructions::publish(name, client.instructions());
                self.clients.lock().await.insert(name.to_string(), client);
                self.connection_errors.lock().await.remove(name);
                self.needs_auth.lock().await.remove(name);
                crate::specialization::mcp::needs_auth_cache::remove_entry(name).await;
                info!("[mcp:manager] Connected to '{}'", name);
                None
            }
            Err(err) => {
                if is_remote_auth_error(&err) && is_remote(server_config) {
                    warn!(
                        "[mcp:manager] '{}' returned auth failure during connect — marking needs-auth",
                        name
                    );
                    self.mark_needs_auth(name, server_config).await;
                    crate::specialization::mcp::needs_auth_cache::set_entry(name).await;
                    self.connection_errors.lock().await.remove(name);
                    None
                } else {
                    let safe_error = redact_server_secrets_from_text(server_config, &err);
                    let msg = format!("Failed to connect to MCP server '{}': {}", name, safe_error);
                    warn!("[mcp:manager] {}", msg);
                    self.connection_errors
                        .lock()
                        .await
                        .insert(name.to_string(), safe_error);
                    Some(msg)
                }
            }
        };

        self.connecting.lock().await.remove(name);
        outcome
    }

    /// Connect a single server by name and config.
    ///
    /// Honors the needs-auth cache for remote transports: if the cache
    /// is still fresh, the connect attempt is skipped and the server is
    /// recorded in `needs_auth` so the bridge installs the OAuth
    /// pseudo-tool instead.
    pub async fn connect_server(&self, name: &str, config: &McpServerConfig) -> Result<(), String> {
        self.disconnect_server(name).await;

        if is_remote(config) && crate::specialization::mcp::needs_auth_cache::is_cached(name).await
        {
            info!(
                "[mcp:manager] Skipping '{}' connect (cached needs-auth)",
                name
            );
            self.needs_auth
                .lock()
                .await
                .insert(name.to_string(), config.clone());
            self.connection_errors.lock().await.remove(name);
            return Ok(());
        }

        match McpClient::connect(name, config).await {
            Ok(client) => {
                let client = Arc::new(client);
                self.spawn_notification_listener(&client).await;
                crate::specialization::mcp::instructions::publish(name, client.instructions());
                self.clients.lock().await.insert(name.to_string(), client);
                self.connection_errors.lock().await.remove(name);
                self.needs_auth.lock().await.remove(name);
                crate::specialization::mcp::needs_auth_cache::remove_entry(name).await;
                Ok(())
            }
            Err(err) => {
                if is_remote_auth_error(&err) && is_remote(config) {
                    warn!(
                        "[mcp:manager] '{}' returned auth failure during connect — marking needs-auth",
                        name
                    );
                    self.mark_needs_auth(name, config).await;
                    crate::specialization::mcp::needs_auth_cache::set_entry(name).await;
                    self.connection_errors.lock().await.remove(name);
                    Ok(())
                } else {
                    let safe_error = redact_server_secrets_from_text(config, &err);
                    self.connection_errors
                        .lock()
                        .await
                        .insert(name.to_string(), safe_error.clone());
                    Err(safe_error)
                }
            }
        }
    }

    /// Disconnect a single server.
    pub async fn disconnect_server(&self, name: &str) {
        let mut clients = self.clients.lock().await;
        if let Some(client) = clients.remove(name) {
            client.shutdown().await;
            crate::specialization::mcp::instructions::retract(name);
            info!("[mcp:manager] Disconnected '{}'", name);
        }
        self.prompts_cache.lock().await.remove(name);
    }

    /// Reconnect a server (disconnect + connect with stored or file config).
    ///
    /// Lookup order for the server config:
    ///   1. Live `clients` map (ordinary reconnect of a connected server).
    ///   2. `needs_auth` map — when the user just finished an OAuth flow via
    ///      `McpAuthTool`, the server isn't in `clients` yet, but we stashed
    ///      its `McpServerConfig` while marking it `needs-auth`.
    ///   3. Fall back to the merged on-disk config so a manual
    ///      `reconnect_server()` call from the UI still works even if both
    ///      maps are empty.
    pub async fn reconnect_server(&self, name: &str) -> Result<(), String> {
        let config = {
            let clients = self.clients.lock().await;
            clients.get(name).map(|c| c.config().clone())
        };

        let config = match config {
            Some(c) => c,
            None => {
                if let Some(c) = self.needs_auth.lock().await.get(name).cloned() {
                    c
                } else {
                    let merged = McpConfigFile::load_merged(None)?;
                    merged
                        .mcp_servers
                        .get(name)
                        .cloned()
                        .ok_or_else(|| format!("Server '{}' not found in config", name))?
                }
            }
        };

        if config.disabled {
            return Err(format!(
                "Server '{}' is disabled; enable it before reconnecting",
                name
            ));
        }

        self.disconnect_server(name).await;
        self.connect_server(name, &config).await
    }

    /// Toggle a server's `disabled` flag and reconcile the running
    /// child process with the new desired state.
    ///
    /// - `disabled = true`  → persist `disabled: true` to the on-disk
    ///   config that owns the entry (workspace file if it lives there,
    ///   otherwise global), then `disconnect_server` to kill the child.
    /// - `disabled = false` → persist `disabled: false`, then connect
    ///   with the freshly-loaded config.
    ///
    /// Returns `Err` if the server isn't in any config file. Tolerant of
    /// a connect failure when re-enabling — the on-disk flag still
    /// flips so the user can fix env vars / paths and try again, and
    /// the connection error will be reflected in
    /// `all_statuses_with_config` on the next poll.
    ///
    /// Workspace entries take precedence over global ones (mirrors
    /// `load_merged`); we patch the file the entry actually lives in
    /// so toggling a workspace-scoped server doesn't accidentally write
    /// it into the global file.
    pub async fn set_disabled(
        &self,
        name: &str,
        disabled: bool,
        workspace_path: Option<&Path>,
    ) -> Result<(), String> {
        let (_config_file, file_path) =
            locate_owning_config(name, workspace_path)?.ok_or_else(|| {
                format!(
                    "Server '{}' not found in global or workspace MCP config",
                    name
                )
            })?;

        let changed = update_config_file(&file_path, |config_file| {
            let entry = config_file.mcp_servers.get_mut(name).ok_or_else(|| {
                format!(
                    "Server '{}' no longer exists in its owning MCP config",
                    name
                )
            })?;
            let changed = entry.disabled != disabled;
            entry.disabled = disabled;
            Ok(changed)
        })?;
        if !changed {
            return Ok(());
        }

        if disabled {
            self.disconnect_server(name).await;
            self.connection_errors.lock().await.remove(name);
            Ok(())
        } else {
            let merged = McpConfigFile::load_merged(workspace_path)?;
            let cfg = merged
                .mcp_servers
                .get(name)
                .cloned()
                .ok_or_else(|| format!("Server '{}' vanished from config", name))?;
            let _ = self.connect_server(name, &cfg).await;
            Ok(())
        }
    }

    /// Apply [`Self::set_disabled`] to many servers concurrently.
    /// Returns the per-server result map. Same partial-success semantics
    /// as `connect_all` — one failure doesn't abort the others.
    pub async fn bulk_set_disabled(
        &self,
        names: &[String],
        disabled: bool,
        workspace_path: Option<&Path>,
    ) -> std::collections::HashMap<String, Result<(), String>> {
        let futures = names.iter().map(|n| async move {
            (
                n.clone(),
                self.set_disabled(n, disabled, workspace_path).await,
            )
        });
        join_all(futures).await.into_iter().collect()
    }

    /// Reconnect many servers concurrently. Servers that are disabled
    /// in their owning config are skipped with an explicit error so the
    /// caller can surface "you need to enable this first".
    pub async fn bulk_reconnect(
        &self,
        names: &[String],
    ) -> std::collections::HashMap<String, Result<(), String>> {
        let futures = names
            .iter()
            .map(|n| async move { (n.clone(), self.reconnect_server(n).await) });
        join_all(futures).await.into_iter().collect()
    }

    /// Shut down all connections.
    pub async fn shutdown_all(&self) {
        {
            let mut handles = self.notification_handles.lock().await;
            for handle in handles.drain(..) {
                handle.abort();
            }
        }
        let mut clients = self.clients.lock().await;
        for (name, client) in clients.drain() {
            client.shutdown().await;
            crate::specialization::mcp::instructions::retract(&name);
            info!("[mcp:manager] Shut down '{}'", name);
        }
        self.connection_errors.lock().await.clear();
        self.connecting.lock().await.clear();
    }
}

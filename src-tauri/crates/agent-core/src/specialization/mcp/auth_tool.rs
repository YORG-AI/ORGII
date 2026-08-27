//! Pseudo-tool surfaced in place of an unauthenticated MCP server's real
//! tools.
//!
//! When [`McpManager`] marks a server as `needs-auth` (either because a
//! prior connect attempt returned HTTP 401 or because the needs-auth
//! cache is fresh), the bridge registers **only** this tool under
//! `mcp__<server>__authenticate` and hides the server's advertised
//! tools. The LLM calls it, we run the OAuth flow, persist credentials,
//! and ask [`McpManager`] to reconnect so the real tools come back on
//! the next turn.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};
use tracing::{info, warn};

use crate::core::tools::traits::{Tool, ToolError, ToolSchemaCacheScope};

use super::bridge::build_mcp_tool_name;
use super::config::{McpServerConfig, McpTransportType};
use super::manager::McpManager;
use super::needs_auth_cache;
use super::oauth::perform_oauth_flow;

/// Tool surfaced for an MCP server that is installed but not yet
/// authenticated. Name shape: `mcp__{server}__authenticate`.
pub(crate) struct McpAuthTool {
    /// Fully-qualified tool name (`mcp__<server>__authenticate`).
    full_name: String,

    /// Human description the LLM sees. Frozen at construction time so
    /// the trait's `description()` can hand back `&str` without
    /// re-formatting on every call.
    description: String,

    /// Server name (used for logs + OAuth flow).
    server_name: String,

    /// Config snapshot captured when we marked the server `needs-auth`.
    /// We need the URL + transport to know whether OAuth is even
    /// applicable and what URL `AuthorizationManager` should discover
    /// metadata from.
    config: McpServerConfig,

    /// Shared manager — on success we call `reconnect_server()` so the
    /// bridge can hot-swap the pseudo-tool out for the real tools.
    manager: Arc<McpManager>,
}

impl McpAuthTool {
    pub(crate) fn new(
        server_name: String,
        config: McpServerConfig,
        manager: Arc<McpManager>,
    ) -> Self {
        let full_name = build_mcp_tool_name(&server_name, "authenticate");
        let location = match (&config.transport_type, &config.url) {
            (McpTransportType::Stdio, _) => "stdio".to_string(),
            (t, Some(url)) => format!(
                "{} at {}",
                match t {
                    McpTransportType::Sse => "sse",
                    McpTransportType::StreamableHttp => "streamable-http",
                    McpTransportType::Stdio => "stdio",
                },
                url
            ),
            (_, None) => "remote".to_string(),
        };
        let description = format!(
            "The `{server}` MCP server ({location}) is installed but requires authentication. \
             Call this tool to start the OAuth flow — you'll receive an authorization URL to \
             share with the user. Once they complete authorization in their browser, the \
             server's real tools will become available automatically.",
            server = server_name,
        );
        Self {
            full_name,
            description,
            server_name,
            config,
            manager,
        }
    }

    fn is_oauth_applicable(config: &McpServerConfig) -> bool {
        matches!(
            config.transport_type,
            McpTransportType::Sse | McpTransportType::StreamableHttp
        ) && config.url.is_some()
    }
}

#[async_trait]
impl Tool for McpAuthTool {
    fn name(&self) -> &str {
        &self.full_name
    }

    fn description(&self) -> &str {
        &self.description
    }

    fn category(&self) -> &str {
        "mcp"
    }

    fn parameters(&self) -> Value {
        json!({ "type": "object", "properties": {} })
    }

    fn schema_cache_scope(&self) -> ToolSchemaCacheScope {
        ToolSchemaCacheScope::LiveSuffix
    }

    async fn execute_text(
        &self,
        _params: Value,
        ctx: &crate::tools::traits::CallContext,
    ) -> Result<String, ToolError> {
        ctx.require_tool_authority(self.name())?;
        // stdio / missing URL → cannot OAuth. Return a descriptive
        // message instead of pretending we can.
        if !Self::is_oauth_applicable(&self.config) {
            return Ok(format!(
                "Server `{}` uses {:?} transport which does not support OAuth from this tool. \
                 Ask the user to configure authentication manually (e.g. via env vars for stdio \
                 servers).",
                self.server_name, self.config.transport_type
            ));
        }
        let server_url = self
            .config
            .url
            .as_deref()
            .ok_or_else(|| {
                ToolError::ExecutionFailed(format!(
                    "Server `{}` is marked needs-auth but has no URL configured",
                    self.server_name
                ))
            })?
            .to_string();

        info!(
            "[mcp:auth-tool] '{}' starting OAuth flow against {}",
            self.server_name, server_url
        );

        let server_name_for_log = self.server_name.clone();
        let outcome = perform_oauth_flow(
            &self.server_name,
            &server_url,
            /* skip_browser_open = */ false,
            move |url| {
                info!(
                    "[mcp:auth-tool] '{}' auth URL: {}",
                    server_name_for_log, url
                );
            },
        )
        .await
        .map_err(|e| {
            ToolError::ExecutionFailed(format!(
                "OAuth flow for `{}` failed: {}",
                self.server_name, e
            ))
        })?;

        // OAuth succeeded → the cached needs-auth entry is now stale.
        // Clear it so a follow-up reconnect actually tries the wire.
        needs_auth_cache::remove_entry(&self.server_name).await;

        // Ask the manager to reconnect. This uses the `needs_auth` map
        // for config resolution, so no extra plumbing is required.
        if let Err(err) = self.manager.reconnect_server(&self.server_name).await {
            warn!(
                "[mcp:auth-tool] '{}' OAuth succeeded but reconnect failed: {}",
                self.server_name, err
            );
            return Ok(format!(
                "Authentication for `{server}` completed (authorization URL: {url}) \
                 but the follow-up reconnect failed: {err}. Ask the user to retry manually.",
                server = self.server_name,
                url = outcome.auth_url,
                err = err,
            ));
        }

        Ok(format!(
            "Authentication for `{server}` completed successfully. Authorization URL shared \
             with the user was: {url}. The server's real tools are now available.",
            server = self.server_name,
            url = outcome.auth_url,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sse_config(url: &str) -> McpServerConfig {
        McpServerConfig {
            transport_type: McpTransportType::Sse,
            command: None,
            args: None,
            cwd: None,
            env: None,
            url: Some(url.to_string()),
            headers: None,
            auto_approve: None,
            disabled: false,
            timeout: 30,
        }
    }

    fn stdio_config() -> McpServerConfig {
        McpServerConfig {
            transport_type: McpTransportType::Stdio,
            command: Some("my-server".to_string()),
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

    #[test]
    fn tool_name_matches_naming_convention() {
        let manager = Arc::new(McpManager::new());
        let tool = McpAuthTool::new(
            "my-server".to_string(),
            sse_config("https://idp.example.com/mcp"),
            manager,
        );
        assert_eq!(tool.name(), "mcp__my-server__authenticate");
    }

    #[test]
    fn description_mentions_server_and_location() {
        let manager = Arc::new(McpManager::new());
        let tool = McpAuthTool::new(
            "alpha".to_string(),
            sse_config("https://alpha.example.com"),
            manager,
        );
        let desc = tool.description();
        assert!(desc.contains("alpha"));
        assert!(desc.contains("alpha.example.com"));
        assert!(desc.contains("OAuth"));
    }

    #[test]
    fn stdio_transport_is_rejected_by_applicability_check() {
        assert!(!McpAuthTool::is_oauth_applicable(&stdio_config()));
    }

    #[test]
    fn sse_with_url_is_accepted() {
        assert!(McpAuthTool::is_oauth_applicable(&sse_config(
            "https://x.example"
        )));
    }

    #[tokio::test]
    async fn stdio_server_execute_returns_unsupported_message() {
        let manager = Arc::new(McpManager::new());
        let tool = McpAuthTool::new("legacy".to_string(), stdio_config(), manager);
        let result = tool
            .execute(
                json!({}),
                &crate::tools::call_context::CallContext::trusted_sde(),
            )
            .await
            .expect("stdio path returns Ok");
        assert!(result.contains("does not support OAuth"));
        assert!(result.contains("legacy"));
    }
}

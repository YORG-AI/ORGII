//! Tauri commands for MCP server management.
//!
//! These commands are called by the frontend settings UI to list,
//! configure, test, and manage MCP server connections.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex as AsyncMutex;

use super::client::{McpClient, McpServerStatus, McpToolDef};
use super::config::{
    redact_server_secrets_from_text, update_config_file, McpConfigFile, McpConfigScope,
    McpServerConfig,
};
use super::manager::McpManager;
use super::prompts::{McpPrompt, McpPromptRendered};
use super::resources::{McpResource, McpResourceContent, McpResourceTemplate};

impl McpConfigScope {
    /// Resolve `(scope, workspace_path)` into the on-disk file path.
    ///
    /// `scope=Some(Workspace)` requires `workspace_path`. `scope=None` uses
    /// the workspace file when `workspace_path` is set, otherwise the global
    /// file (preserves the legacy "no scope, no workspace = global" call
    /// site, but as an explicit branch instead of a typo-tolerant fallback).
    pub(crate) fn resolve_path(
        scope: Option<Self>,
        workspace_path: Option<&Path>,
    ) -> Result<PathBuf, String> {
        match scope {
            Some(Self::Global) => Ok(super::config::global_config_path()),
            Some(Self::Workspace) => match workspace_path {
                Some(p) => Ok(super::config::workspace_config_path(p)),
                None => {
                    Err("scope=workspace requires a workspace_path; none was provided".to_string())
                }
            },
            None => match workspace_path {
                Some(p) => Ok(super::config::workspace_config_path(p)),
                None => Ok(super::config::global_config_path()),
            },
        }
    }
}

/// Tauri-managed state for MCP.
///
/// Shared singleton: the same `McpManager` is used by both the frontend
/// settings UI (Tauri commands) and all agent sessions.
///
/// Multi-workspace support: `connected_workspaces` tracks which workspace paths
/// have already had their workspace-level MCP config loaded. When a new session
/// starts from a different workspace, `ensure_connected` loads that workspace's
/// workspace config incrementally rather than being a no-op after first connection.
pub struct McpState {
    pub manager: Arc<McpManager>,
    /// Set once global (no-workspace) connect has completed.
    connected: AtomicBool,
    /// Canonical absolute paths of workspaces whose workspace-level config is loaded.
    connected_workspaces: AsyncMutex<HashSet<PathBuf>>,
}

impl McpState {
    pub fn new() -> Self {
        Self {
            manager: Arc::new(McpManager::new()),
            connected: AtomicBool::new(false),
            connected_workspaces: AsyncMutex::new(HashSet::new()),
        }
    }

    /// Ensure all configured MCP servers are connected, including any
    /// workspace-level servers for `workspace_path`.
    ///
    /// - First call connects global servers + the given workspace.
    /// - Subsequent calls with the **same** workspace are no-ops.
    /// - Subsequent calls with a **new** workspace load that workspace's config
    ///   incrementally.
    pub async fn ensure_connected(&self, workspace_path: Option<&Path>) {
        self.ensure_connected_with_workspace_scope(workspace_path, true)
            .await;
    }

    pub async fn ensure_connected_with_workspace_scope(
        &self,
        workspace_path: Option<&Path>,
        load_workspace_resources: bool,
    ) {
        let effective_workspace_path = workspace_path.filter(|_| load_workspace_resources);
        let canonical = effective_workspace_path
            .and_then(|p| p.canonicalize().ok())
            .or_else(|| effective_workspace_path.map(|p| p.to_path_buf()));

        if self.connected.load(Ordering::Relaxed) {
            // Global already connected — check if this workspace is new.
            if let Some(ref ws) = canonical {
                let mut seen = self.connected_workspaces.lock().await;
                if seen.contains(ws) {
                    return;
                }
                seen.insert(ws.clone());
                drop(seen);
                // Load workspace-specific servers that weren't in the initial connect.
                let errors = self.manager.connect_all(Some(ws.as_path()), true).await;
                for err in &errors {
                    tracing::warn!("[mcp:state] {}", err);
                }
            }
            return;
        }

        let errors = self
            .manager
            .connect_all(effective_workspace_path, load_workspace_resources)
            .await;
        for err in &errors {
            tracing::warn!("[mcp:state] {}", err);
        }
        self.connected.store(true, Ordering::Relaxed);

        if let Some(ws) = canonical {
            self.connected_workspaces.lock().await.insert(ws);
        }
    }

    /// Spawn background connection to all configured servers.
    /// Returns immediately — callers should poll status via `mcp_list_servers`.
    pub fn ensure_connected_background(&self, workspace_path: Option<PathBuf>) {
        if self.connected.swap(true, Ordering::Relaxed) {
            return;
        }
        let manager = Arc::clone(&self.manager);
        tokio::spawn(async move {
            let errors = manager.connect_all(workspace_path.as_deref(), true).await;
            for err in &errors {
                tracing::warn!("[mcp:state] {}", err);
            }
        });
    }

    /// Force reconnect (used after config changes).
    pub async fn reconnect(&self, workspace_path: Option<&Path>) {
        self.manager.shutdown_all().await;
        self.connected_workspaces.lock().await.clear();
        let errors = self.manager.connect_all(workspace_path, true).await;
        for err in &errors {
            tracing::warn!("[mcp:state] {}", err);
        }
        self.connected.store(true, Ordering::Relaxed);
        if let Some(p) = workspace_path {
            let canonical = p.canonicalize().ok().unwrap_or_else(|| p.to_path_buf());
            self.connected_workspaces.lock().await.insert(canonical);
        }
    }
}

impl Default for McpState {
    fn default() -> Self {
        Self::new()
    }
}

/// Result of testing an MCP server connection.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTestResult {
    pub success: bool,
    pub tool_count: usize,
    pub tools: Vec<McpToolDef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_name: Option<String>,
}

/// List all configured MCP servers with their connection status.
///
/// On first call, spawns background connections to all servers and returns
/// immediately with `connecting` status. Frontend should poll to get updates.
#[tauri::command]
pub async fn mcp_list_servers(
    state: tauri::State<'_, McpState>,
    workspace_path: Option<String>,
) -> Result<Vec<McpServerStatus>, String> {
    let path = workspace_path.map(PathBuf::from);
    state.ensure_connected_background(path.clone());
    state
        .manager
        .all_statuses_with_config(path.as_deref())
        .await
}

/// Update MCP server configuration.
///
/// Saves the config to the appropriate file (global or workspace-scoped)
/// and reconnects changed servers.
#[tauri::command]
pub async fn mcp_update_servers(
    state: tauri::State<'_, McpState>,
    workspace_path: Option<String>,
    config: McpConfigFile,
    scope: Option<McpConfigScope>,
) -> Result<(), String> {
    let workspace = workspace_path.as_deref().map(Path::new);
    let path = McpConfigScope::resolve_path(scope, workspace)?;
    persist_config_update(&path, config)?;

    // Reconnect: shut down all, then connect with merged config
    let owning = workspace_path.map(PathBuf::from);
    state.reconnect(owning.as_deref()).await;

    Ok(())
}

/// Test an MCP server connection.
///
/// Connects, performs handshake, lists tools, then disconnects.
/// Returns the test result without persisting the connection.
#[tauri::command]
pub async fn mcp_test_server(
    server_name: String,
    config: McpServerConfig,
    workspace_path: Option<String>,
    scope: Option<McpConfigScope>,
) -> Result<McpTestResult, String> {
    let workspace = workspace_path.as_deref().map(Path::new);
    let config = resolve_test_server_config(&server_name, config, scope, workspace)?;
    match McpClient::connect(&server_name, &config).await {
        Ok(client) => {
            let tools = client.tools().await;
            let tool_count = tools.len();
            client.shutdown().await;

            Ok(McpTestResult {
                success: true,
                tool_count,
                tools,
                error: None,
                server_name: Some(server_name),
            })
        }
        Err(err) => {
            let safe_error = redact_server_secrets_from_text(&config, &err);
            Ok(McpTestResult {
                success: false,
                tool_count: 0,
                tools: Vec::new(),
                error: Some(safe_error),
                server_name: Some(server_name),
            })
        }
    }
}

fn persist_config_update(path: &Path, mut incoming: McpConfigFile) -> Result<(), String> {
    update_config_file(path, move |existing| {
        incoming.resolve_redacted_secrets_from(existing)?;
        *existing = incoming;
        Ok(())
    })
}

fn resolve_test_server_config(
    server_name: &str,
    incoming: McpServerConfig,
    scope: Option<McpConfigScope>,
    workspace_path: Option<&Path>,
) -> Result<McpServerConfig, String> {
    if !incoming.contains_redacted_secret_sentinel() {
        return Ok(incoming);
    }

    let path = McpConfigScope::resolve_path(scope, workspace_path)?;
    resolve_test_server_config_from_path(server_name, incoming, &path)
}

fn resolve_test_server_config_from_path(
    server_name: &str,
    mut incoming: McpServerConfig,
    path: &Path,
) -> Result<McpServerConfig, String> {
    let existing = McpConfigFile::load_from(path)?;
    incoming.resolve_redacted_secrets_from(server_name, existing.mcp_servers.get(server_name))?;
    Ok(incoming)
}

/// List tools discovered from a connected MCP server.
#[tauri::command]
pub async fn mcp_list_server_tools(
    state: tauri::State<'_, McpState>,
    server_name: String,
) -> Result<Vec<McpToolDef>, String> {
    state.manager.server_tools(&server_name).await
}

/// Force reconnect a specific MCP server.
#[tauri::command]
pub async fn mcp_reconnect_server(
    state: tauri::State<'_, McpState>,
    server_name: String,
) -> Result<(), String> {
    state.manager.reconnect_server(&server_name).await
}

/// Toggle a single server's `disabled` flag. When `disabled` flips to
/// `true` the child process is killed; flipping back to `false` spawns
/// a new connection. The on-disk config (workspace-scoped if the entry
/// lives there, otherwise global) is updated so the flag survives
/// restarts — mirrors Cursor's per-server toggle behavior.
#[tauri::command]
pub async fn mcp_set_server_disabled(
    state: tauri::State<'_, McpState>,
    server_name: String,
    disabled: bool,
    workspace_path: Option<String>,
) -> Result<(), String> {
    let workspace = workspace_path.as_deref().map(Path::new);
    state
        .manager
        .set_disabled(&server_name, disabled, workspace)
        .await
}

/// Batch version of [`mcp_set_server_disabled`]. Returns a map of
/// `{ server_name: Ok | error }` so the UI can render per-row results
/// from a bulk "Disable all" / "Enable all" action. Partial success is
/// tolerated — one server's failure doesn't abort the rest.
#[tauri::command]
pub async fn mcp_bulk_set_disabled(
    state: tauri::State<'_, McpState>,
    server_names: Vec<String>,
    disabled: bool,
    workspace_path: Option<String>,
) -> Result<std::collections::HashMap<String, Option<String>>, String> {
    let workspace = workspace_path.as_deref().map(Path::new);
    let results = state
        .manager
        .bulk_set_disabled(&server_names, disabled, workspace)
        .await;
    // Serde can't serialize `Result` to a plain JSON map without
    // extra tagging, so flatten Ok→null, Err(msg)→msg.
    Ok(results
        .into_iter()
        .map(|(name, res)| (name, res.err()))
        .collect())
}

/// Batch reconnect. Skips servers that are currently disabled (returns
/// their per-server error in the map so the UI can tell the user why).
#[tauri::command]
pub async fn mcp_bulk_reconnect(
    state: tauri::State<'_, McpState>,
    server_names: Vec<String>,
) -> Result<std::collections::HashMap<String, Option<String>>, String> {
    let results = state.manager.bulk_reconnect(&server_names).await;
    Ok(results
        .into_iter()
        .map(|(name, res)| (name, res.err()))
        .collect())
}

/// Get the raw MCP config file contents (for JSON editor view).
///
/// `scope` is required when you want a specific file; `None` falls back
/// to workspace (when `workspace_path` is set) or global (otherwise).
#[tauri::command]
pub async fn mcp_get_config(
    workspace_path: Option<String>,
    scope: Option<McpConfigScope>,
) -> Result<serde_json::Value, String> {
    let workspace = workspace_path.as_deref().map(Path::new);
    let path = McpConfigScope::resolve_path(scope, workspace)?;
    let config = McpConfigFile::load_from(&path)?.redacted_for_wire();

    serde_json::to_value(&config).map_err(|err| format!("Failed to serialize config: {}", err))
}

// ============================================
// Resource Commands
// ============================================

/// List resources from a connected MCP server.
#[tauri::command]
pub async fn mcp_list_resources(
    state: tauri::State<'_, McpState>,
    server_name: String,
) -> Result<Vec<McpResource>, String> {
    state.manager.list_resources(&server_name).await
}

/// Read a resource by URI from a connected MCP server.
#[tauri::command]
pub async fn mcp_read_resource(
    state: tauri::State<'_, McpState>,
    server_name: String,
    uri: String,
) -> Result<Vec<McpResourceContent>, String> {
    state.manager.read_resource(&server_name, &uri).await
}

/// List resource templates from a connected MCP server.
#[tauri::command]
pub async fn mcp_list_resource_templates(
    state: tauri::State<'_, McpState>,
    server_name: String,
) -> Result<Vec<McpResourceTemplate>, String> {
    state.manager.list_resource_templates(&server_name).await
}

// ============================================
// Prompt Commands (MCP prompts as slash commands)
// ============================================

/// Aggregated prompt entry for the frontend slash-command registry.
///
/// A fully-qualified MCP command name has the form
/// `mcp__<server>__<name>`; this entry pairs that identifier with the
/// original per-server prompt metadata so the UI can render the
/// description and argument hints.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpPromptEntry {
    /// Fully-qualified slash-command name (`mcp__<server>__<prompt>`).
    pub name: String,
    pub server_name: String,
    pub prompt: McpPrompt,
}

/// List prompts from a specific connected MCP server.
#[tauri::command]
pub async fn mcp_list_prompts(
    state: tauri::State<'_, McpState>,
    server_name: String,
) -> Result<Vec<McpPrompt>, String> {
    state.manager.list_prompts(&server_name).await
}

/// Aggregate prompts across every connected server and return them as
/// pre-named slash-command entries.
///
/// Slash-command names use the canonical form `mcp__<server>__<prompt>`.
/// Server and prompt names are passed through verbatim — any
/// sanitization (e.g. stripping spaces for the slash UI) happens
/// closer to the UI layer.
#[tauri::command]
pub async fn mcp_list_all_prompts(
    state: tauri::State<'_, McpState>,
) -> Result<Vec<McpPromptEntry>, String> {
    let pairs = state.manager.all_prompts().await;
    let entries = pairs
        .into_iter()
        .map(|(server_name, prompt)| {
            let name = format!("mcp__{}__{}", server_name, prompt.name);
            McpPromptEntry {
                name,
                server_name,
                prompt,
            }
        })
        .collect();
    Ok(entries)
}

/// Execute a prompt on an MCP server with the given arguments.
///
/// `arguments` is a JSON object — the Tauri invoke layer passes it
/// through as `serde_json::Value`, and we coerce to the `Map<String,
/// Value>` shape that `rmcp` expects. A non-object value is rejected
/// with an error rather than silently coerced (null vs missing
/// matters).
#[tauri::command]
pub async fn mcp_get_prompt(
    state: tauri::State<'_, McpState>,
    server_name: String,
    prompt_name: String,
    arguments: Option<serde_json::Value>,
) -> Result<McpPromptRendered, String> {
    let args = match arguments {
        None => None,
        Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::Object(map)) => Some(map),
        Some(other) => {
            return Err(format!(
                "mcp_get_prompt: arguments must be a JSON object, got {}",
                match other {
                    serde_json::Value::Array(_) => "array",
                    serde_json::Value::String(_) => "string",
                    serde_json::Value::Number(_) => "number",
                    serde_json::Value::Bool(_) => "bool",
                    _ => "unknown",
                }
            ));
        }
    };

    state
        .manager
        .get_prompt(&server_name, &prompt_name, args)
        .await
}

/// Render a prompt and flatten it into a single text blob suitable for
/// pre-populating the chat input. Convenience wrapper so the frontend
/// slash-command handler doesn't have to know about the structured
/// [`McpPromptRendered`] shape.
#[tauri::command]
pub async fn mcp_render_prompt(
    state: tauri::State<'_, McpState>,
    server_name: String,
    prompt_name: String,
    arguments: Option<serde_json::Value>,
) -> Result<String, String> {
    let rendered = mcp_get_prompt(state, server_name, prompt_name, arguments).await?;
    Ok(rendered.flatten_to_text())
}

#[cfg(test)]
mod scope_tests {
    use super::*;
    use crate::specialization::mcp::config::McpTransportType;
    use std::collections::HashMap;

    fn server_with_secret(secret: &str) -> McpServerConfig {
        McpServerConfig {
            transport_type: McpTransportType::Stdio,
            command: Some(format!("{secret}-command")),
            args: Some(vec![format!("{secret}-arg")]),
            cwd: Some(format!("/{secret}-cwd")),
            env: Some(HashMap::from([(
                "API_TOKEN".to_string(),
                secret.to_string(),
            )])),
            url: Some(format!("https://{secret}.test/mcp")),
            headers: Some(HashMap::from([(
                "Authorization".to_string(),
                secret.to_string(),
            )])),
            auto_approve: None,
            disabled: false,
            timeout: 30,
        }
    }

    fn server_with_sentinel() -> McpServerConfig {
        let config = McpConfigFile {
            mcp_servers: HashMap::from([("docs".to_string(), server_with_secret("placeholder"))]),
        }
        .redacted_for_wire();
        config.mcp_servers["docs"].clone()
    }

    #[test]
    fn scope_global_with_no_workspace_returns_global_path() {
        let path = McpConfigScope::resolve_path(Some(McpConfigScope::Global), None)
            .expect("global scope without workspace should resolve");
        assert_eq!(path, super::super::config::global_config_path());
    }

    #[test]
    fn scope_global_overrides_workspace_path() {
        let workspace = Path::new("/tmp/some/workspace");
        let path = McpConfigScope::resolve_path(Some(McpConfigScope::Global), Some(workspace))
            .expect("global scope ignores workspace_path");
        assert_eq!(path, super::super::config::global_config_path());
    }

    #[test]
    fn scope_workspace_requires_workspace_path() {
        let result = McpConfigScope::resolve_path(Some(McpConfigScope::Workspace), None);
        assert!(
            result.is_err(),
            "scope=workspace without workspace_path must fail closed; got Ok({:?})",
            result
        );
    }

    #[test]
    fn scope_workspace_with_path_returns_workspace_file() {
        let workspace = Path::new("/tmp/some/workspace");
        let path = McpConfigScope::resolve_path(Some(McpConfigScope::Workspace), Some(workspace))
            .expect("workspace scope with path should resolve");
        assert_eq!(path, super::super::config::workspace_config_path(workspace));
    }

    #[test]
    fn no_scope_with_workspace_path_prefers_workspace() {
        let workspace = Path::new("/tmp/some/workspace");
        let path = McpConfigScope::resolve_path(None, Some(workspace))
            .expect("none scope with workspace should resolve to workspace");
        assert_eq!(path, super::super::config::workspace_config_path(workspace));
    }

    #[test]
    fn no_scope_no_workspace_falls_back_to_global() {
        let path = McpConfigScope::resolve_path(None, None)
            .expect("none scope, no workspace should resolve to global");
        assert_eq!(path, super::super::config::global_config_path());
    }

    #[test]
    fn scope_serde_lowercase_wire_format() {
        let global = serde_json::to_string(&McpConfigScope::Global).unwrap();
        let workspace = serde_json::to_string(&McpConfigScope::Workspace).unwrap();
        assert_eq!(global, "\"global\"");
        assert_eq!(workspace, "\"workspace\"");
    }

    #[test]
    fn scope_serde_rejects_unknown_value() {
        let result: Result<McpConfigScope, _> = serde_json::from_str("\"bogus-scope\"");
        assert!(
            result.is_err(),
            "unknown scope wire value must fail closed; got Ok({:?})",
            result
        );
    }

    #[test]
    fn config_update_resolves_secret_only_from_selected_file() {
        let dir = tempfile::tempdir().unwrap();
        let global_path = dir.path().join("global.json");
        let workspace_path = dir.path().join("workspace.json");
        McpConfigFile {
            mcp_servers: HashMap::from([("docs".to_string(), server_with_secret("global-secret"))]),
        }
        .save_to(&global_path)
        .unwrap();
        McpConfigFile {
            mcp_servers: HashMap::from([(
                "docs".to_string(),
                server_with_secret("workspace-secret"),
            )]),
        }
        .save_to(&workspace_path)
        .unwrap();

        persist_config_update(
            &workspace_path,
            McpConfigFile {
                mcp_servers: HashMap::from([("docs".to_string(), server_with_sentinel())]),
            },
        )
        .unwrap();

        assert_eq!(
            McpConfigFile::load_from(&workspace_path)
                .unwrap()
                .mcp_servers["docs"]
                .env
                .as_ref()
                .unwrap()["API_TOKEN"],
            "workspace-secret"
        );
        assert_eq!(
            McpConfigFile::load_from(&global_path).unwrap().mcp_servers["docs"]
                .env
                .as_ref()
                .unwrap()["API_TOKEN"],
            "global-secret"
        );
    }

    #[test]
    fn rejected_forged_sentinel_does_not_change_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mcp-servers.json");
        let original = McpConfigFile {
            mcp_servers: HashMap::from([(
                "other".to_string(),
                server_with_secret("never-return-this"),
            )]),
        };
        original.save_to(&path).unwrap();
        let before = std::fs::read(&path).unwrap();

        let result = persist_config_update(
            &path,
            McpConfigFile {
                mcp_servers: HashMap::from([("docs".to_string(), server_with_sentinel())]),
            },
        );

        assert!(result.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert!(!result.unwrap_err().contains("never-return-this"));
    }

    #[test]
    fn existing_server_test_resolves_sentinel_before_connect() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mcp-servers.json");
        McpConfigFile {
            mcp_servers: HashMap::from([(
                "docs".to_string(),
                server_with_secret("native-test-secret"),
            )]),
        }
        .save_to(&path)
        .unwrap();

        let resolved =
            resolve_test_server_config_from_path("docs", server_with_sentinel(), &path).unwrap();

        assert_eq!(
            resolved.env.as_ref().unwrap()["API_TOKEN"],
            "native-test-secret"
        );
        assert_eq!(
            resolved.command.as_deref(),
            Some("native-test-secret-command")
        );
        assert_eq!(
            resolved.args.as_deref(),
            Some(&["native-test-secret-arg".to_string()][..])
        );
        assert_eq!(resolved.cwd.as_deref(), Some("/native-test-secret-cwd"));
        assert_eq!(
            resolved.url.as_deref(),
            Some("https://native-test-secret.test/mcp")
        );
        assert_eq!(
            resolved.headers.as_ref().unwrap()["Authorization"],
            "native-test-secret"
        );
        assert!(!resolved.contains_redacted_secret_sentinel());
    }
}

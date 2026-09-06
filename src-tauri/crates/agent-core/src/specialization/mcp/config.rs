//! MCP server configuration.
//!
//! Supports global (`~/.orgii/mcp-servers.json`) and workspace-scoped
//! (`{workspace}/.orgii/mcp-servers.json`) config files. Workspace entries
//! override global entries by server name.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Stable wire-only placeholder returned in place of every MCP connection
/// value (`command`, `args`, `cwd`, `url`, `env`, and `headers`). The literal
/// is reserved: callers may send it back only to preserve a value that already
/// exists at the same server / field (and map key) in the exact config scope.
pub const MCP_SECRET_REDACTED_SENTINEL: &str = "__ORGII_MCP_SECRET_REDACTED__";

/// Human-readable replacement used when a server error happens to echo a
/// configured secret. This is intentionally different from the wire sentinel:
/// error text can never be submitted later as an instruction to preserve data.
const MCP_SECRET_ERROR_REDACTION: &str = "[REDACTED_SECRET]";

/// Serializes in-process read/modify/write transactions across every MCP
/// config writer. The on-disk rename prevents torn files; this lock also
/// prevents two concurrent Tauri commands from resolving a sentinel against
/// one version and then overwriting a newer secret with stale data.
static MCP_CONFIG_MUTATION_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Transport type for an MCP server.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum McpTransportType {
    Stdio,
    Sse,
    StreamableHttp,
}

/// Configuration for a single MCP server.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    /// Transport type.
    #[serde(rename = "type")]
    pub transport_type: McpTransportType,

    /// Command to spawn (stdio only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,

    /// Arguments for the command (stdio only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,

    /// Working directory for the command (stdio only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,

    /// Environment variables for the command (stdio only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<HashMap<String, String>>,

    /// URL for SSE/streamable HTTP transport.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,

    /// HTTP headers for SSE/streamable HTTP transport.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<HashMap<String, String>>,

    /// Tool names that are auto-approved (skip permission prompt).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_approve: Option<Vec<String>>,

    /// Whether this server is disabled.
    #[serde(default)]
    pub disabled: bool,

    /// Connection timeout in seconds.
    #[serde(default = "default_timeout")]
    pub timeout: u64,
}

fn default_timeout() -> u64 {
    30
}

/// Which config file scope an MCP server entry belongs to.
///
/// `Global` → `~/.orgii/mcp-servers.json` (per-user, all workspaces).
/// `Workspace` → `<workspace>/.orgii/mcp-servers.json` (this workspace only).
///
/// The wire form is `"global"` / `"workspace"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum McpConfigScope {
    #[default]
    Global,
    Workspace,
}

/// Root config file structure.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct McpConfigFile {
    /// Map of server name → config.
    #[serde(default)]
    pub mcp_servers: HashMap<String, McpServerConfig>,
}

impl McpConfigFile {
    /// Load from a file path.
    ///
    /// A missing file is a normal first-run state and resolves to an empty
    /// config. Existing unreadable or invalid JSON files return an error so
    /// read-then-write paths cannot accidentally overwrite a user's broken
    /// config with `{}`.
    pub fn load_from(path: &Path) -> Result<Self, String> {
        if !path.exists() {
            return Ok(Self::default());
        }

        let contents = std::fs::read_to_string(path)
            .map_err(|err| format!("Failed to read MCP config {}: {}", path.display(), err))?;
        serde_json::from_str(&contents)
            .map_err(|err| format!("Failed to parse MCP config {}: {}", path.display(), err))
    }

    /// Save to a file path using an owner-only atomic replacement.
    ///
    /// JSON is rendered before touching the destination, then written and
    /// flushed through a `0600` temporary file in the same directory. The
    /// final rename is atomic, so a serialization / write / flush / publish
    /// failure leaves the previous config intact.
    pub fn save_to(&self, path: &Path) -> Result<(), String> {
        self.validate_no_redacted_secret_sentinel()?;
        let json = serde_json::to_vec_pretty(self)
            .map_err(|err| format!("Failed to serialize MCP config: {}", err))?;
        write_config_atomic(path, &json)
    }

    /// Clone this config for the Tauri wire boundary without disclosing any
    /// connection values. Environment/header keys and field presence remain
    /// visible so the settings UI can preserve, replace, or delete them.
    /// Non-empty `args` are represented as a single sentinel for the whole
    /// field: positional sentinels would be ambiguous after an item deletion.
    pub fn redacted_for_wire(&self) -> Self {
        let mut redacted = self.clone();
        for server in redacted.mcp_servers.values_mut() {
            redact_scalar_for_wire(server.command.as_mut());
            redact_args_for_wire(server.args.as_mut());
            redact_scalar_for_wire(server.cwd.as_mut());
            redact_scalar_for_wire(server.url.as_mut());
            redact_secret_map_for_wire(server.env.as_mut());
            redact_secret_map_for_wire(server.headers.as_mut());
        }
        redacted
    }

    /// Resolve wire sentinels against the exact existing config file that
    /// owns this update. Omitted keys stay omitted (explicit deletion), real
    /// incoming values replace old values, and a sentinel with no same-scope
    /// predecessor is rejected rather than being persisted as a fake secret.
    pub fn resolve_redacted_secrets_from(&mut self, existing: &Self) -> Result<(), String> {
        for (server_name, incoming) in &mut self.mcp_servers {
            incoming.resolve_redacted_secrets_from(
                server_name,
                existing.mcp_servers.get(server_name),
            )?;
        }
        Ok(())
    }

    /// Enforce that the wire-only sentinel can never reach disk through any
    /// writer (settings, registry install, or external import).
    pub fn validate_no_redacted_secret_sentinel(&self) -> Result<(), String> {
        if let Some((server_name, _)) = self
            .mcp_servers
            .iter()
            .find(|(_, server)| server.contains_redacted_secret_sentinel())
        {
            return Err(format!(
                "MCP server '{}' still contains an unresolved redacted secret sentinel",
                server_name
            ));
        }
        Ok(())
    }

    /// Load workspace-scoped config from `{workspace}/.orgii/mcp-servers.json`.
    pub fn load_for_workspace(workspace_path: &Path) -> Result<Self, String> {
        Self::load_from(&workspace_config_path(workspace_path))
    }

    /// Load global config from `~/.orgii/mcp-servers.json`.
    pub fn load_global() -> Result<Self, String> {
        Self::load_from(&global_config_path())
    }

    /// Merge global + workspace configs.
    ///
    /// When a server name exists in BOTH scopes, the workspace entry wins
    /// for connection details (command/url/env/...) but `disabled` is the
    /// OR of both scopes — disabling a server in either file keeps it off.
    /// A workspace `mcp-servers.json` previously wholesale-replaced the
    /// global entry by name, silently resurrecting servers the user had
    /// disabled globally.
    ///
    /// Returns ALL servers including disabled ones so callers can render
    /// them in the UI list and toggle them back on. Connection paths
    /// (`McpManager::connect_all`, etc.) already filter `!cfg.disabled`
    /// before spawning a child process; consumers that need only the
    /// enabled subset should call [`Self::enabled_servers`].
    pub fn load_merged(workspace_path: Option<&Path>) -> Result<Self, String> {
        Self::load_merged_with_workspace_scope(workspace_path, true)
    }

    pub fn load_merged_with_workspace_scope(
        workspace_path: Option<&Path>,
        load_workspace_resources: bool,
    ) -> Result<Self, String> {
        let mut merged = Self::load_global()?;

        if load_workspace_resources {
            if let Some(workspace) = workspace_path {
                let workspace_config = Self::load_for_workspace(workspace)?;
                for (name, mut server_config) in workspace_config.mcp_servers {
                    if let Some(global_entry) = merged.mcp_servers.get(&name) {
                        server_config.disabled = server_config.disabled || global_entry.disabled;
                    }
                    merged.mcp_servers.insert(name, server_config);
                }
            }
        }

        Ok(merged)
    }

    /// Get only enabled servers.
    pub fn enabled_servers(&self) -> HashMap<&str, &McpServerConfig> {
        self.mcp_servers
            .iter()
            .filter(|(_name, cfg)| !cfg.disabled)
            .map(|(name, cfg)| (name.as_str(), cfg))
            .collect()
    }
}

impl McpServerConfig {
    /// Whether this server block contains a wire sentinel that must be
    /// resolved before it is used or persisted.
    pub fn contains_redacted_secret_sentinel(&self) -> bool {
        scalar_contains_sentinel(self.command.as_ref())
            || args_contain_sentinel(self.args.as_ref())
            || scalar_contains_sentinel(self.cwd.as_ref())
            || scalar_contains_sentinel(self.url.as_ref())
            || secret_map_contains_sentinel(self.env.as_ref())
            || secret_map_contains_sentinel(self.headers.as_ref())
    }

    /// Resolve the sentinels in a single submitted server block against an
    /// existing server in the same owning scope.
    pub fn resolve_redacted_secrets_from(
        &mut self,
        server_name: &str,
        existing: Option<&Self>,
    ) -> Result<(), String> {
        resolve_scalar(
            server_name,
            "command",
            self.command.as_mut(),
            existing.and_then(|server| server.command.as_ref()),
        )?;
        resolve_args(
            server_name,
            self.args.as_mut(),
            existing.and_then(|server| server.args.as_ref()),
        )?;
        resolve_scalar(
            server_name,
            "working directory",
            self.cwd.as_mut(),
            existing.and_then(|server| server.cwd.as_ref()),
        )?;
        resolve_scalar(
            server_name,
            "URL",
            self.url.as_mut(),
            existing.and_then(|server| server.url.as_ref()),
        )?;
        resolve_secret_map(
            server_name,
            "environment variable",
            self.env.as_mut(),
            existing.and_then(|server| server.env.as_ref()),
        )?;
        resolve_secret_map(
            server_name,
            "header",
            self.headers.as_mut(),
            existing.and_then(|server| server.headers.as_ref()),
        )
    }
}

fn redact_scalar_for_wire(value: Option<&mut String>) {
    if let Some(value) = value {
        *value = MCP_SECRET_REDACTED_SENTINEL.to_string();
    }
}

fn redact_args_for_wire(args: Option<&mut Vec<String>>) {
    if let Some(args) = args.filter(|args| !args.is_empty()) {
        *args = vec![MCP_SECRET_REDACTED_SENTINEL.to_string()];
    }
}

fn scalar_contains_sentinel(value: Option<&String>) -> bool {
    value.is_some_and(|value| value == MCP_SECRET_REDACTED_SENTINEL)
}

fn args_contain_sentinel(args: Option<&Vec<String>>) -> bool {
    args.is_some_and(|args| {
        args.iter()
            .any(|value| value == MCP_SECRET_REDACTED_SENTINEL)
    })
}

fn resolve_scalar(
    server_name: &str,
    field_kind: &str,
    incoming: Option<&mut String>,
    existing: Option<&String>,
) -> Result<(), String> {
    let Some(incoming) = incoming else {
        return Ok(());
    };
    if incoming != MCP_SECRET_REDACTED_SENTINEL {
        return Ok(());
    }

    let previous = existing
        .filter(|previous| previous.as_str() != MCP_SECRET_REDACTED_SENTINEL)
        .ok_or_else(|| {
            format!(
                "Cannot preserve MCP {} for server '{}': no value exists in the selected config scope",
                field_kind, server_name
            )
        })?;
    *incoming = previous.clone();
    Ok(())
}

fn resolve_args(
    server_name: &str,
    incoming: Option<&mut Vec<String>>,
    existing: Option<&Vec<String>>,
) -> Result<(), String> {
    let Some(incoming) = incoming else {
        return Ok(());
    };
    let sentinel_count = incoming
        .iter()
        .filter(|value| value.as_str() == MCP_SECRET_REDACTED_SENTINEL)
        .count();
    if sentinel_count == 0 {
        return Ok(());
    }
    if incoming.len() != 1 || sentinel_count != 1 {
        return Err(format!(
            "Cannot preserve MCP arguments for server '{}': the arguments sentinel must be the entire field",
            server_name
        ));
    }

    let previous = existing
        .filter(|args| {
            !args
                .iter()
                .any(|value| value == MCP_SECRET_REDACTED_SENTINEL)
        })
        .ok_or_else(|| {
            format!(
                "Cannot preserve MCP arguments for server '{}': no value exists in the selected config scope",
                server_name
            )
        })?;
    *incoming = previous.clone();
    Ok(())
}

fn redact_secret_map_for_wire(values: Option<&mut HashMap<String, String>>) {
    if let Some(values) = values {
        for value in values.values_mut() {
            *value = MCP_SECRET_REDACTED_SENTINEL.to_string();
        }
    }
}

fn secret_map_contains_sentinel(values: Option<&HashMap<String, String>>) -> bool {
    values.is_some_and(|values| {
        values
            .values()
            .any(|value| value == MCP_SECRET_REDACTED_SENTINEL)
    })
}

fn resolve_secret_map(
    server_name: &str,
    field_kind: &str,
    incoming: Option<&mut HashMap<String, String>>,
    existing: Option<&HashMap<String, String>>,
) -> Result<(), String> {
    let Some(incoming) = incoming else {
        return Ok(());
    };

    for (key, value) in incoming {
        if value != MCP_SECRET_REDACTED_SENTINEL {
            continue;
        }

        let previous = existing
            .and_then(|values| values.get(key))
            .filter(|previous| previous.as_str() != MCP_SECRET_REDACTED_SENTINEL)
            .ok_or_else(|| {
                format!(
                    "Cannot preserve MCP {} '{}' for server '{}': no secret exists at that key in the selected config scope",
                    field_kind, key, server_name
                )
            })?;
        *value = previous.clone();
    }

    Ok(())
}

/// Remove direct or environment-expanded connection values from an error
/// before it reaches tracing, connection status, or the Tauri response.
pub fn redact_server_secrets_from_text(config: &McpServerConfig, text: &str) -> String {
    let mut secrets = Vec::new();
    collect_secret_values(config, &mut secrets);

    // A config may refer to a host secret through `${VAR}`. Expand each
    // secret-bearing value independently so an unrelated missing placeholder
    // in command/args/url (or a sibling key) cannot prevent redaction of the
    // env/header values that did resolve.
    collect_expanded_secret_values(config, &mut secrets);

    secrets.retain(|secret| {
        !secret.is_empty()
            && secret != MCP_SECRET_REDACTED_SENTINEL
            && secret != MCP_SECRET_ERROR_REDACTION
    });
    secrets.sort_by_key(|secret| std::cmp::Reverse(secret.len()));
    secrets.dedup();

    secrets
        .into_iter()
        .fold(text.to_string(), |redacted, secret| {
            redacted.replace(&secret, MCP_SECRET_ERROR_REDACTION)
        })
}

fn collect_secret_values(config: &McpServerConfig, values: &mut Vec<String>) {
    values.extend(config.command.iter().cloned());
    values.extend(config.args.iter().flatten().cloned());
    values.extend(config.cwd.iter().cloned());
    values.extend(config.url.iter().cloned());
    if let Some(env) = config.env.as_ref() {
        values.extend(env.values().cloned());
    }
    if let Some(headers) = config.headers.as_ref() {
        values.extend(headers.values().cloned());
    }
}

fn collect_expanded_secret_values(config: &McpServerConfig, values: &mut Vec<String>) {
    let raw_values = config
        .command
        .iter()
        .chain(config.args.iter().flatten())
        .chain(config.cwd.iter())
        .chain(config.url.iter())
        .chain(config.env.iter().flat_map(|entries| entries.values()))
        .chain(config.headers.iter().flat_map(|entries| entries.values()));
    for value in raw_values {
        if let Ok(expanded) = super::env_expansion::expand(value) {
            values.push(expanded);
        }
    }
}

fn write_config_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("MCP config has no parent directory: {}", path.display()))?;
    ensure_safe_config_parent(parent)?;

    let mut temp = tempfile::Builder::new()
        .prefix(".orgii-mcp-config-")
        .suffix(".tmp")
        .tempfile_in(parent)
        .map_err(|err| {
            format!(
                "Failed to create MCP config temp file in {}: {}",
                parent.display(),
                err
            )
        })?;

    // Apply the owner-only ACL before any secret bytes are written. A failure
    // here cannot affect the existing destination.
    app_paths::set_sensitive_file_permissions(temp.path()).map_err(|err| {
        format!(
            "Failed to secure MCP config temp file in {}: {}",
            parent.display(),
            err
        )
    })?;
    temp.write_all(bytes)
        .map_err(|err| format!("Failed to write MCP config temp file: {}", err))?;
    temp.as_file()
        .sync_all()
        .map_err(|err| format!("Failed to flush MCP config temp file: {}", err))?;

    temp.persist(path).map(|_| ()).map_err(|err| {
        format!(
            "Failed to publish MCP config {}: {}",
            path.display(),
            err.error
        )
    })
}

fn ensure_safe_config_parent(parent: &Path) -> Result<(), String> {
    let existed = parent.exists();
    std::fs::create_dir_all(parent).map_err(|err| {
        format!(
            "Failed to create MCP config directory {}: {}",
            parent.display(),
            err
        )
    })?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let metadata = std::fs::metadata(parent).map_err(|err| {
            format!(
                "Failed to inspect MCP config directory {}: {}",
                parent.display(),
                err
            )
        })?;
        let current = metadata.permissions().mode();
        // New secret-bearing config directories are private. For an existing
        // workspace `.orgii` directory, preserve read/execute compatibility
        // but remove group/other write access so another account cannot swap
        // the atomic destination.
        let desired = if existed { current & !0o022 } else { 0o700 };
        if current & 0o777 != desired & 0o777 {
            std::fs::set_permissions(parent, std::fs::Permissions::from_mode(desired)).map_err(
                |err| {
                    format!(
                        "Failed to secure MCP config directory {}: {}",
                        parent.display(),
                        err
                    )
                },
            )?;
        }
    }

    Ok(())
}

/// Global config path: `~/.orgii/mcp-servers.json`.
pub fn global_config_path() -> PathBuf {
    app_paths::mcp_servers_config()
}

/// Workspace config path: `{workspace}/.orgii/mcp-servers.json`.
pub fn workspace_config_path(workspace_path: &Path) -> PathBuf {
    app_paths::workspace_mcp_servers_config(workspace_path)
}

/// Find which config file (workspace or global) owns the entry for
/// `name` and return both the loaded file struct and its on-disk path
/// so the caller can mutate-and-save without guessing scope.
///
/// Resolution mirrors [`McpConfigFile::load_merged`] precedence:
///   1. Workspace config (if `workspace_path` is provided and the entry
///      exists there) — workspace always wins.
///   2. Global config.
///
/// Returns `Ok(None)` if the entry isn't in either file.
pub fn insert_server_config(
    path: &Path,
    name: String,
    server_config: McpServerConfig,
) -> Result<(), String> {
    update_config_file(path, move |config| {
        config.mcp_servers.insert(name, server_config);
        Ok(())
    })
}

/// Run a same-process atomic MCP config transaction.
///
/// The updater sees the latest file contents while the global mutation lock is
/// held. Its result is saved through [`McpConfigFile::save_to`] before the lock
/// is released. If loading, the updater, or publishing fails, no partially
/// rendered config is exposed.
pub fn update_config_file<T>(
    path: &Path,
    updater: impl FnOnce(&mut McpConfigFile) -> Result<T, String>,
) -> Result<T, String> {
    let _guard = MCP_CONFIG_MUTATION_LOCK
        .lock()
        .map_err(|_| "MCP config update lock was poisoned".to_string())?;
    let parent = path
        .parent()
        .ok_or_else(|| format!("MCP config has no parent directory: {}", path.display()))?;
    ensure_safe_config_parent(parent)?;
    let mut config = McpConfigFile::load_from(path)?;
    let result = updater(&mut config)?;
    config.save_to(path)?;
    Ok(result)
}

pub fn locate_owning_config(
    name: &str,
    workspace_path: Option<&Path>,
) -> Result<Option<(McpConfigFile, PathBuf)>, String> {
    if let Some(workspace) = workspace_path {
        let workspace_cfg = McpConfigFile::load_for_workspace(workspace)?;
        if workspace_cfg.mcp_servers.contains_key(name) {
            return Ok(Some((workspace_cfg, workspace_config_path(workspace))));
        }
    }

    let global_cfg = McpConfigFile::load_global()?;
    if global_cfg.mcp_servers.contains_key(name) {
        return Ok(Some((global_cfg, global_config_path())));
    }

    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn sample_server_config() -> McpServerConfig {
        McpServerConfig {
            transport_type: McpTransportType::Stdio,
            command: Some("docs-server".to_string()),
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

    fn secret_server_config() -> McpServerConfig {
        let mut config = sample_server_config();
        config.command = Some("command-secret-value".to_string());
        config.args = Some(vec![
            "arg-secret-one".to_string(),
            "--token=arg-secret-two".to_string(),
        ]);
        config.cwd = Some("/cwd-secret-value".to_string());
        config.url = Some("https://url-secret-value.test/mcp".to_string());
        config.env = Some(HashMap::from([
            ("API_TOKEN".to_string(), "env-secret-value".to_string()),
            ("EMPTY_VALUE".to_string(), String::new()),
        ]));
        config.headers = Some(HashMap::from([(
            "Authorization".to_string(),
            "Bearer header-secret-value".to_string(),
        )]));
        config
    }

    #[test]
    fn load_from_missing_file_returns_empty_config() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("mcp-servers.json");

        let config = McpConfigFile::load_from(&path).unwrap();

        assert!(config.mcp_servers.is_empty());
    }

    #[test]
    fn load_from_invalid_json_returns_error() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("mcp-servers.json");
        std::fs::write(&path, "{not valid json").unwrap();

        let err = McpConfigFile::load_from(&path).unwrap_err();

        assert!(err.contains("Failed to parse MCP config"));
    }

    #[test]
    fn insert_server_config_does_not_overwrite_invalid_json() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("mcp-servers.json");
        let original = "{not valid json";
        std::fs::write(&path, original).unwrap();

        let err =
            insert_server_config(&path, "docs".to_string(), sample_server_config()).unwrap_err();

        assert!(err.contains("Failed to parse MCP config"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
    }

    #[test]
    fn load_from_valid_json_reads_servers() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("mcp-servers.json");
        std::fs::write(
            &path,
            r#"{
              "mcpServers": {
                "docs": {
                  "type": "stdio",
                  "command": "docs-server",
                  "timeout": 7
                }
              }
            }"#,
        )
        .unwrap();

        let config = McpConfigFile::load_from(&path).unwrap();

        let server = config.mcp_servers.get("docs").unwrap();
        assert_eq!(server.transport_type, McpTransportType::Stdio);
        assert_eq!(server.command.as_deref(), Some("docs-server"));
        assert_eq!(server.timeout, 7);
    }

    #[test]
    fn redacted_for_wire_never_serializes_connection_values() {
        let original_server = secret_server_config();
        let config = McpConfigFile {
            mcp_servers: HashMap::from([("docs".to_string(), original_server)]),
        };

        let redacted = config.redacted_for_wire();
        let wire = serde_json::to_string(&redacted).unwrap();
        let server = redacted.mcp_servers.get("docs").unwrap();

        assert_eq!(
            server.command.as_deref(),
            Some(MCP_SECRET_REDACTED_SENTINEL)
        );
        assert_eq!(
            server.args.as_deref(),
            Some(&[MCP_SECRET_REDACTED_SENTINEL.to_string()][..])
        );
        assert_eq!(server.cwd.as_deref(), Some(MCP_SECRET_REDACTED_SENTINEL));
        assert_eq!(server.url.as_deref(), Some(MCP_SECRET_REDACTED_SENTINEL));
        assert!(server
            .env
            .as_ref()
            .unwrap()
            .values()
            .all(|value| value == MCP_SECRET_REDACTED_SENTINEL));
        assert!(server
            .headers
            .as_ref()
            .unwrap()
            .values()
            .all(|value| value == MCP_SECRET_REDACTED_SENTINEL));
        assert!(!wire.contains("command-secret-value"));
        assert!(!wire.contains("arg-secret-one"));
        assert!(!wire.contains("arg-secret-two"));
        assert!(!wire.contains("cwd-secret-value"));
        assert!(!wire.contains("url-secret-value"));
        assert!(!wire.contains("env-secret-value"));
        assert!(!wire.contains("header-secret-value"));
        // Redaction is a wire clone and must never mutate the in-memory owner.
        assert_eq!(
            config.mcp_servers["docs"].env.as_ref().unwrap()["API_TOKEN"],
            "env-secret-value"
        );
    }

    #[test]
    fn update_sentinel_preserves_exact_fields_while_replacement_and_deletion_are_explicit() {
        let mut existing_server = secret_server_config();
        existing_server.env.as_mut().unwrap().insert(
            "DELETE_ME".to_string(),
            "secret-that-will-be-deleted".to_string(),
        );
        let existing = McpConfigFile {
            mcp_servers: HashMap::from([("docs".to_string(), existing_server)]),
        };
        let mut incoming = existing.redacted_for_wire();
        let incoming_server = incoming.mcp_servers.get_mut("docs").unwrap();
        // Scalars and the whole args field remain sentinels and are preserved.
        incoming_server.cwd = None;
        incoming_server.url = Some("https://replacement.test/mcp".to_string());
        incoming_server.env = Some(HashMap::from([
            (
                "API_TOKEN".to_string(),
                MCP_SECRET_REDACTED_SENTINEL.to_string(),
            ),
            ("NEW_TOKEN".to_string(), "replacement-secret".to_string()),
        ]));
        incoming_server.headers = Some(HashMap::from([(
            "Authorization".to_string(),
            "Bearer replacement-secret".to_string(),
        )]));

        incoming.resolve_redacted_secrets_from(&existing).unwrap();

        let resolved = &incoming.mcp_servers["docs"];
        assert_eq!(resolved.command.as_deref(), Some("command-secret-value"));
        assert_eq!(
            resolved.args.as_deref(),
            Some(
                &[
                    "arg-secret-one".to_string(),
                    "--token=arg-secret-two".to_string(),
                ][..]
            )
        );
        assert!(resolved.cwd.is_none());
        assert_eq!(
            resolved.url.as_deref(),
            Some("https://replacement.test/mcp")
        );
        let env = resolved.env.as_ref().unwrap();
        assert_eq!(env["API_TOKEN"], "env-secret-value");
        assert_eq!(env["NEW_TOKEN"], "replacement-secret");
        assert!(!env.contains_key("DELETE_ME"));
        assert_eq!(
            resolved.headers.as_ref().unwrap()["Authorization"],
            "Bearer replacement-secret"
        );
        assert!(!resolved.contains_redacted_secret_sentinel());
    }

    #[test]
    fn forged_or_mixed_connection_sentinels_are_rejected() {
        let existing = McpConfigFile::default();
        let mut forged_command = sample_server_config();
        forged_command.command = Some(MCP_SECRET_REDACTED_SENTINEL.to_string());
        let mut command_update = McpConfigFile {
            mcp_servers: HashMap::from([("docs".to_string(), forged_command)]),
        };
        assert!(command_update
            .resolve_redacted_secrets_from(&existing)
            .is_err());

        let mut mixed_args = sample_server_config();
        mixed_args.args = Some(vec![
            MCP_SECRET_REDACTED_SENTINEL.to_string(),
            "explicit-value".to_string(),
        ]);
        let existing = McpConfigFile {
            mcp_servers: HashMap::from([("docs".to_string(), secret_server_config())]),
        };
        let mut args_update = McpConfigFile {
            mcp_servers: HashMap::from([("docs".to_string(), mixed_args)]),
        };
        let err = args_update
            .resolve_redacted_secrets_from(&existing)
            .unwrap_err();
        assert!(err.contains("sentinel must be the entire field"));
    }

    #[test]
    fn forged_sentinel_without_same_scope_secret_is_rejected() {
        let existing = McpConfigFile::default();
        let mut incoming_server = sample_server_config();
        incoming_server.env = Some(HashMap::from([(
            "API_TOKEN".to_string(),
            MCP_SECRET_REDACTED_SENTINEL.to_string(),
        )]));
        let mut incoming = McpConfigFile {
            mcp_servers: HashMap::from([("docs".to_string(), incoming_server)]),
        };

        let err = incoming
            .resolve_redacted_secrets_from(&existing)
            .unwrap_err();

        assert!(err.contains("selected config scope"));
        assert!(err.contains("API_TOKEN"));
        assert!(!err.contains("env-secret-value"));
    }

    #[test]
    fn unresolved_sentinel_is_never_persisted() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("mcp-servers.json");
        std::fs::write(&path, "original").unwrap();
        let mut server = sample_server_config();
        server.env = Some(HashMap::from([(
            "API_TOKEN".to_string(),
            MCP_SECRET_REDACTED_SENTINEL.to_string(),
        )]));
        let config = McpConfigFile {
            mcp_servers: HashMap::from([("docs".to_string(), server)]),
        };

        let err = config.save_to(&path).unwrap_err();

        assert!(err.contains("unresolved redacted secret sentinel"));
        assert_eq!(std::fs::read_to_string(path).unwrap(), "original");
    }

    #[test]
    fn same_key_on_a_different_server_cannot_satisfy_sentinel() {
        let existing = McpConfigFile {
            mcp_servers: HashMap::from([("other".to_string(), secret_server_config())]),
        };
        let mut incoming_server = sample_server_config();
        incoming_server.env = Some(HashMap::from([(
            "API_TOKEN".to_string(),
            MCP_SECRET_REDACTED_SENTINEL.to_string(),
        )]));
        let mut incoming = McpConfigFile {
            mcp_servers: HashMap::from([("docs".to_string(), incoming_server)]),
        };

        assert!(incoming.resolve_redacted_secrets_from(&existing).is_err());
    }

    #[test]
    fn concurrent_config_transactions_do_not_lose_servers() {
        let dir = TempDir::new().unwrap();
        let path = std::sync::Arc::new(dir.path().join("mcp-servers.json"));
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
        let handles: Vec<_> = ["first", "second"]
            .into_iter()
            .map(|name| {
                let path = std::sync::Arc::clone(&path);
                let barrier = std::sync::Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    insert_server_config(&path, name.to_string(), sample_server_config()).unwrap();
                })
            })
            .collect();

        barrier.wait();
        for handle in handles {
            handle.join().unwrap();
        }

        let persisted = McpConfigFile::load_from(&path).unwrap();
        assert!(persisted.mcp_servers.contains_key("first"));
        assert!(persisted.mcp_servers.contains_key("second"));
    }

    #[test]
    fn server_error_redaction_covers_every_connection_value() {
        let config = secret_server_config();
        let error = "command-secret-value arg-secret-one --token=arg-secret-two /cwd-secret-value https://url-secret-value.test/mcp env-secret-value Bearer header-secret-value";

        let redacted = redact_server_secrets_from_text(&config, error);

        assert_eq!(
            redacted,
            "[REDACTED_SECRET] [REDACTED_SECRET] [REDACTED_SECRET] [REDACTED_SECRET] [REDACTED_SECRET] [REDACTED_SECRET] [REDACTED_SECRET]"
        );
    }

    #[test]
    fn error_redaction_ignores_empty_connection_values_without_panicking() {
        let config = McpServerConfig {
            transport_type: McpTransportType::Stdio,
            command: Some(String::new()),
            args: Some(vec![String::new()]),
            cwd: Some(String::new()),
            env: Some(HashMap::from([("EMPTY".to_string(), String::new())])),
            url: Some(String::new()),
            headers: Some(HashMap::from([("EMPTY".to_string(), String::new())])),
            auto_approve: None,
            disabled: false,
            timeout: 30,
        };

        assert_eq!(
            redact_server_secrets_from_text(&config, "stable error"),
            "stable error"
        );
    }

    #[test]
    fn atomic_publish_failure_leaves_existing_target_untouched() {
        let dir = TempDir::new().unwrap();
        let target = dir.path().join("mcp-servers.json");
        std::fs::create_dir(&target).unwrap();
        let marker = target.join("original-config-marker");
        std::fs::write(&marker, "original").unwrap();

        let err = McpConfigFile::default().save_to(&target).unwrap_err();

        assert!(err.contains("Failed to publish MCP config"));
        assert_eq!(std::fs::read_to_string(marker).unwrap(), "original");
    }

    #[cfg(unix)]
    #[test]
    fn save_creates_private_parent_and_owner_only_file() {
        use std::os::unix::fs::PermissionsExt;

        let dir = TempDir::new().unwrap();
        let parent = dir.path().join("nested").join(".orgii");
        let path = parent.join("mcp-servers.json");
        let config = McpConfigFile {
            mcp_servers: HashMap::from([("docs".to_string(), secret_server_config())]),
        };

        config.save_to(&path).unwrap();

        let file_mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        let parent_mode = std::fs::metadata(&parent).unwrap().permissions().mode() & 0o777;
        assert_eq!(file_mode, 0o600);
        assert_eq!(parent_mode, 0o700);
    }
}

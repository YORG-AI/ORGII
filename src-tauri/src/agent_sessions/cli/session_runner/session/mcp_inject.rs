//! Resolve the effective MCP server set for an external CLI session and
//! render it into each transport's native configuration shape.
//!
//! Bindings come from `.orgii/mcp-servers.json` (global merged with the
//! workspace file). A session that explicitly carries an agent definition is
//! filtered by that definition; an ordinary session has no implicit agent
//! policy and therefore keeps the merged config's own disabled flags only.
//! Unknown definition ids reject the launch instead of silently broadening or
//! substituting another agent's policy. External CLI config formats cannot
//! express ORGII's per-tool deny list, so a server with any denied tool is
//! conservatively omitted in full. This preserves the native runtime's
//! authorization boundary at the cost of hiding that server's otherwise-
//! allowed tools.

use std::collections::{BTreeMap, HashSet};
use std::io::Write;
use std::path::Path;

use agent_core::mcp::config::{McpConfigFile, McpServerConfig, McpTransportType};

pub(super) struct SessionMcpServers {
    servers: BTreeMap<String, McpServerConfig>,
}

/// Owner-only Claude Code MCP config whose pathname remains valid for the
/// lifetime of one managed CLI run. `TempPath` removes the file on every
/// normal return, error return, or cancelled future when this guard drops.
pub(super) struct ClaudeMcpConfigFile {
    path: tempfile::TempPath,
}

impl ClaudeMcpConfigFile {
    pub(super) fn path(&self) -> &Path {
        self.path.as_ref()
    }
}

/// Owner-only Codex config layer selected by its non-secret profile name.
/// Keeping the secret-bearing TOML out of `-c` arguments prevents local
/// process-list observers from reading MCP environment values or headers.
pub(super) struct CodexMcpProfileFile {
    _path: tempfile::TempPath,
    profile_name: String,
}

impl CodexMcpProfileFile {
    #[cfg(test)]
    pub(super) fn path(&self) -> &Path {
        self._path.as_ref()
    }

    pub(super) fn profile_name(&self) -> &str {
        &self.profile_name
    }
}

impl SessionMcpServers {
    pub(super) fn resolve(
        working_dir: &str,
        agent_definition_id: Option<&str>,
    ) -> Result<Self, SessionMcpPolicyError> {
        let policy = SessionMcpPolicy::resolve(agent_definition_id)?;
        Self::from_load_result(
            McpConfigFile::load_merged_with_workspace_scope(
                Some(Path::new(working_dir)),
                policy.load_workspace_resources,
            ),
            &policy.disabled_servers,
            &policy.disabled_tools,
            policy.requires_mcp_config,
        )
    }

    fn from_load_result(
        config: Result<McpConfigFile, String>,
        disabled_servers: &HashSet<String>,
        disabled_tools: &HashSet<String>,
        requires_mcp_config: bool,
    ) -> Result<Self, SessionMcpPolicyError> {
        match config {
            Ok(config) => Ok(Self::from_config(config, disabled_servers, disabled_tools)),
            Err(err) if requires_mcp_config => {
                Err(SessionMcpPolicyError::ConfigLoadFailed { message: err })
            }
            Err(err) => {
                tracing::warn!(
                    "[cli-runner] MCP config load failed ({}); failing closed with an explicit empty server set",
                    err
                );
                Ok(Self {
                    servers: BTreeMap::new(),
                })
            }
        }
    }

    fn from_config(
        config: McpConfigFile,
        disabled_servers: &HashSet<String>,
        disabled_tools: &HashSet<String>,
    ) -> Self {
        let tool_blocked_servers = servers_requiring_full_drop(
            config.mcp_servers.keys().map(String::as_str),
            disabled_tools,
        );
        for server in &tool_blocked_servers {
            tracing::warn!(
                server,
                "[cli-runner] Omitting MCP server because external CLIs cannot enforce its per-tool deny list"
            );
        }
        let servers = config
            .mcp_servers
            .into_iter()
            .filter(|(name, server)| {
                !server.disabled
                    && !disabled_servers.contains(name)
                    && !tool_blocked_servers.contains(name)
            })
            .collect();
        Self { servers }
    }

    #[cfg(test)]
    fn is_empty(&self) -> bool {
        self.servers.is_empty()
    }

    #[cfg(test)]
    pub(super) fn empty_for_test() -> Self {
        Self {
            servers: BTreeMap::new(),
        }
    }

    /// Remove every resolved MCP connection value before child diagnostics
    /// reach tracing, persisted failure details, or the frontend.
    pub(super) fn redact_secrets_from_text(&self, text: &str) -> String {
        self.servers
            .values()
            .fold(text.to_string(), |redacted, server| {
                agent_core::mcp::config::redact_server_secrets_from_text(server, &redacted)
            })
    }

    /// `.mcp.json`-shaped document for Claude Code's `--mcp-config`.
    pub(super) fn claude_mcp_json(&self) -> serde_json::Value {
        let mut servers = serde_json::Map::new();
        for (name, server) in &self.servers {
            let mut entry = serde_json::Map::new();
            match server.transport_type {
                McpTransportType::Stdio => {
                    let Some(command) = trimmed(server.command.as_deref()) else {
                        continue;
                    };
                    entry.insert("type".into(), serde_json::json!("stdio"));
                    entry.insert("command".into(), serde_json::json!(command));
                    if let Some(args) = server.args.as_ref().filter(|args| !args.is_empty()) {
                        entry.insert("args".into(), serde_json::json!(args));
                    }
                    if let Some(cwd) = trimmed(server.cwd.as_deref()) {
                        entry.insert("cwd".into(), serde_json::json!(cwd));
                    }
                    if let Some(env) = sorted_map(server.env.as_ref()) {
                        entry.insert("env".into(), serde_json::json!(env));
                    }
                }
                McpTransportType::Sse | McpTransportType::StreamableHttp => {
                    let Some(url) = trimmed(server.url.as_deref()) else {
                        continue;
                    };
                    let kind = if server.transport_type == McpTransportType::Sse {
                        "sse"
                    } else {
                        "http"
                    };
                    entry.insert("type".into(), serde_json::json!(kind));
                    entry.insert("url".into(), serde_json::json!(url));
                    if let Some(headers) = sorted_map(server.headers.as_ref()) {
                        entry.insert("headers".into(), serde_json::json!(headers));
                    }
                }
            }
            servers.insert(name.clone(), serde_json::Value::Object(entry));
        }
        serde_json::json!({ "mcpServers": servers })
    }

    /// Write the Claude Code config document to an owner-only per-run file.
    /// The returned guard owns cleanup; callers must keep it alive until the
    /// CLI child (including any in-process retry) has finished.
    pub(super) fn write_claude_mcp_config(&self) -> Result<ClaudeMcpConfigFile, String> {
        let dir = app_paths::orgii_temp_root().join("mcp-configs");
        self.write_claude_mcp_config_in(&dir)
    }

    fn write_claude_mcp_config_in(&self, dir: &Path) -> Result<ClaudeMcpConfigFile, String> {
        ensure_private_config_dir(dir)?;
        let raw = serde_json::to_vec_pretty(&self.claude_mcp_json())
            .map_err(|err| format!("Failed to serialize MCP config: {err}"))?;
        let mut file = tempfile::Builder::new()
            .prefix(".orgii-claude-mcp-")
            .suffix(".json")
            .tempfile_in(dir)
            .map_err(|err| format!("Failed to create Claude MCP config: {err}"))?;

        // Tighten access before the first secret-bearing byte is written.
        // `tempfile` already creates mode 0600 on Unix; this explicit gate
        // keeps the sensitive-file contract centralized and covers Windows.
        app_paths::set_sensitive_file_permissions(file.path())
            .map_err(|err| format!("Failed to secure Claude MCP config: {err}"))?;
        file.write_all(&raw)
            .map_err(|err| format!("Failed to write Claude MCP config: {err}"))?;
        file.as_file()
            .sync_all()
            .map_err(|err| format!("Failed to flush Claude MCP config: {err}"))?;

        Ok(ClaudeMcpConfigFile {
            path: file.into_temp_path(),
        })
    }

    /// ACP `session/new` / `session/load` `mcpServers` entries
    /// (stdio only — the ACP session params carry command launches).
    pub(super) fn acp_servers(&self) -> Vec<serde_json::Value> {
        self.servers
            .iter()
            .filter_map(|(name, server)| {
                if server.transport_type != McpTransportType::Stdio {
                    tracing::warn!(
                        server = name.as_str(),
                        transport = ?server.transport_type,
                        "[cli-runner] Omitting MCP server from the ACP session: its params carry stdio launches only"
                    );
                    return None;
                }
                let command = trimmed(server.command.as_deref())?;
                let env: Vec<serde_json::Value> = sorted_map(server.env.as_ref())
                    .unwrap_or_default()
                    .into_iter()
                    .map(|(key, value)| serde_json::json!({ "name": key, "value": value }))
                    .collect();
                Some(serde_json::json!({
                    "name": name,
                    "command": command,
                    "args": server.args.clone().unwrap_or_default(),
                    "env": env,
                }))
            })
            .collect()
    }

    /// Dotted TOML assignments materializing `[mcp_servers.<name>]` tables.
    /// Codex accepts stdio and streamable HTTP servers; legacy SSE has no
    /// compatible Codex transport and is intentionally omitted.
    fn codex_config_entries(&self) -> Vec<String> {
        let mut entries = Vec::new();
        for (name, server) in &self.servers {
            let key = toml_key(name);
            match server.transport_type {
                McpTransportType::Stdio => {
                    let Some(command) = trimmed(server.command.as_deref()) else {
                        continue;
                    };
                    entries.push(format!(
                        "mcp_servers.{key}.command={}",
                        toml_string(command)
                    ));
                    if let Some(args) = server.args.as_ref().filter(|args| !args.is_empty()) {
                        let joined = args
                            .iter()
                            .map(|arg| toml_string(arg))
                            .collect::<Vec<_>>()
                            .join(", ");
                        entries.push(format!("mcp_servers.{key}.args=[{joined}]"));
                    }
                    if let Some(cwd) = trimmed(server.cwd.as_deref()) {
                        entries.push(format!("mcp_servers.{key}.cwd={}", toml_string(cwd)));
                    }
                    if let Some(env) = sorted_map(server.env.as_ref()) {
                        entries.push(format!("mcp_servers.{key}.env={}", toml_map(&env)));
                    }
                }
                McpTransportType::StreamableHttp => {
                    let Some(url) = trimmed(server.url.as_deref()) else {
                        continue;
                    };
                    entries.push(format!("mcp_servers.{key}.url={}", toml_string(url)));
                    if let Some(headers) = sorted_map(server.headers.as_ref()) {
                        entries.push(format!(
                            "mcp_servers.{key}.http_headers={}",
                            toml_map(&headers)
                        ));
                    }
                }
                McpTransportType::Sse => {}
            }
        }
        entries
    }

    /// Write a per-run `$CODEX_HOME/<name>.config.toml` layer and return the
    /// guard that owns cleanup. Only the random profile name is passed on the
    /// command line; the MCP values remain in this owner-only file.
    pub(super) fn write_codex_mcp_profile(
        &self,
        codex_home: &Path,
    ) -> Result<Option<CodexMcpProfileFile>, String> {
        let entries = self.codex_config_entries();
        if entries.is_empty() {
            return Ok(None);
        }
        ensure_private_config_dir(codex_home)?;
        let mut file = tempfile::Builder::new()
            .prefix("orgii-mcp-")
            .suffix(".config.toml")
            .tempfile_in(codex_home)
            .map_err(|err| format!("Failed to create Codex MCP profile: {err}"))?;
        app_paths::set_sensitive_file_permissions(file.path())
            .map_err(|err| format!("Failed to secure Codex MCP profile: {err}"))?;
        let mut contents = entries.join("\n");
        contents.push('\n');
        file.write_all(contents.as_bytes())
            .map_err(|err| format!("Failed to write Codex MCP profile: {err}"))?;
        file.as_file()
            .sync_all()
            .map_err(|err| format!("Failed to flush Codex MCP profile: {err}"))?;

        let profile_name = file
            .path()
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.strip_suffix(".config.toml"))
            .filter(|name| !name.is_empty())
            .ok_or_else(|| "Codex MCP profile has an invalid file name".to_string())?
            .to_string();
        Ok(Some(CodexMcpProfileFile {
            _path: file.into_temp_path(),
            profile_name,
        }))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SessionMcpPolicy {
    disabled_servers: HashSet<String>,
    disabled_tools: HashSet<String>,
    load_workspace_resources: bool,
    /// An Agent that allowlists MCP tools declares them as launch requirements.
    /// Its config must be readable; silently replacing a malformed declared
    /// policy with an empty set would launch a different agent.
    requires_mcp_config: bool,
}

impl SessionMcpPolicy {
    fn ordinary() -> Self {
        Self {
            disabled_servers: HashSet::new(),
            disabled_tools: HashSet::new(),
            load_workspace_resources: true,
            requires_mcp_config: false,
        }
    }

    fn resolve(agent_definition_id: Option<&str>) -> Result<Self, SessionMcpPolicyError> {
        let definitions = agent_core::definitions::definitions_store();
        Self::resolve_with(agent_definition_id, |id| definitions.get(id))
    }

    fn resolve_with(
        agent_definition_id: Option<&str>,
        mut definition_for: impl FnMut(&str) -> Option<agent_core::definitions::AgentDefinition>,
    ) -> Result<Self, SessionMcpPolicyError> {
        let Some(raw_id) = agent_definition_id else {
            return Ok(Self::ordinary());
        };
        let id = raw_id.trim();
        if id.is_empty() {
            return Err(SessionMcpPolicyError::InvalidAgentDefinitionId);
        }
        let definition = definition_for(id)
            .ok_or_else(|| SessionMcpPolicyError::UnknownAgentDefinition { id: id.to_string() })?;
        let requires_mcp_config = definition
            .tools
            .system_restrict_to_tools
            .iter()
            .flatten()
            .chain(definition.tools.user_allowed_tools.iter())
            .any(|tool| {
                let tool = tool.trim();
                tool.starts_with("mcp__")
                    || tool == agent_core::mcp::LIST_MCP_RESOURCES_TOOL_NAME
                    || tool == agent_core::mcp::READ_MCP_RESOURCE_TOOL_NAME
            });
        Ok(Self {
            disabled_servers: definition
                .tools
                .disabled_mcp_servers
                .iter()
                .cloned()
                .collect(),
            disabled_tools: definition
                .tools
                .disabled_mcp_tools
                .iter()
                .cloned()
                .collect(),
            load_workspace_resources: definition.load_workspace_resources.unwrap_or(true),
            requires_mcp_config,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum SessionMcpPolicyError {
    InvalidAgentDefinitionId,
    UnknownAgentDefinition { id: String },
    ConfigLoadFailed { message: String },
}

impl std::fmt::Display for SessionMcpPolicyError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidAgentDefinitionId => write!(
                formatter,
                "CLI_MCP_POLICY_ERR:INVALID_AGENT_DEFINITION_ID: the session carries an empty agent definition id"
            ),
            Self::UnknownAgentDefinition { id } => write!(
                formatter,
                "CLI_MCP_POLICY_ERR:UNKNOWN_AGENT_DEFINITION: agent definition '{id}' is not registered"
            ),
            Self::ConfigLoadFailed { message } => write!(
                formatter,
                "CLI_MCP_POLICY_ERR:CONFIG_LOAD_FAILED: declared Agent MCP config could not be loaded: {message}"
            ),
        }
    }
}

impl std::error::Error for SessionMcpPolicyError {}

/// External provider config schemas expose MCP servers, not individual tool
/// filters. Map a native `mcp__<server>__<tool>` deny to the owning server so
/// the external CLI cannot call a tool ORGII deliberately withheld.
///
/// The slash form is accepted for legacy/API-authored definitions. A malformed
/// selector is treated as ambiguous and drops every currently configured
/// server: authorization filters must fail closed, never silently broaden.
fn servers_requiring_full_drop<'a>(
    server_names: impl Iterator<Item = &'a str>,
    disabled_tools: &HashSet<String>,
) -> HashSet<String> {
    if disabled_tools.is_empty() {
        return HashSet::new();
    }
    let server_names = server_names.collect::<Vec<_>>();
    let mut blocked = HashSet::new();
    for disabled_tool in disabled_tools {
        let disabled_tool = disabled_tool.trim();
        let canonical_shape = disabled_tool
            .strip_prefix("mcp__")
            .and_then(|rest| rest.split_once("__"))
            .is_some_and(|(server, tool)| !server.is_empty() && !tool.is_empty());
        let slash_shape = disabled_tool
            .split_once('/')
            .is_some_and(|(server, tool)| !server.is_empty() && !tool.is_empty());
        if !canonical_shape && !slash_shape {
            tracing::warn!(
                disabled_tool,
                "[cli-runner] Malformed disabled MCP tool selector; omitting all MCP servers for external CLI"
            );
            blocked.extend(server_names.iter().map(|name| (*name).to_string()));
            continue;
        }

        for server in &server_names {
            let canonical_prefix = format!(
                "mcp__{}__",
                agent_core::mcp::bridge::normalize_name_for_mcp(server)
            );
            let slash_prefix = format!("{server}/");
            if disabled_tool.starts_with(&canonical_prefix)
                || disabled_tool.starts_with(&slash_prefix)
            {
                blocked.insert((*server).to_string());
            }
        }
    }
    blocked
}

fn trimmed(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn sorted_map(
    map: Option<&std::collections::HashMap<String, String>>,
) -> Option<BTreeMap<String, String>> {
    map.filter(|map| !map.is_empty())
        .map(|map| map.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
}

fn ensure_private_config_dir(dir: &Path) -> Result<(), String> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(dir)
        .map_err(|err| format!("Failed to create MCP config dir: {err}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|err| format!("Failed to secure MCP config dir: {err}"))?;
    }
    Ok(())
}

fn toml_key(segment: &str) -> String {
    let bare = !segment.is_empty()
        && segment
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if bare {
        segment.to_string()
    } else {
        toml_string(segment)
    }
}

fn toml_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| format!("\"{value}\""))
}

fn toml_map(map: &BTreeMap<String, String>) -> String {
    let pairs = map
        .iter()
        .map(|(key, value)| format!("{} = {}", toml_key(key), toml_string(value)))
        .collect::<Vec<_>>()
        .join(", ");
    format!("{{{pairs}}}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn stdio(command: &str) -> McpServerConfig {
        serde_json::from_value(serde_json::json!({
            "type": "stdio",
            "command": command,
        }))
        .expect("stdio config")
    }

    fn config_with(servers: Vec<(&str, McpServerConfig)>) -> McpConfigFile {
        let mut file = McpConfigFile::default();
        for (name, server) in servers {
            file.mcp_servers.insert(name.to_string(), server);
        }
        file
    }

    fn streamable_http(url: &str) -> McpServerConfig {
        serde_json::from_value(serde_json::json!({
            "type": "streamableHttp",
            "url": url,
        }))
        .expect("streamable HTTP config")
    }

    #[test]
    fn disabled_and_filtered_servers_are_dropped() {
        let mut off = stdio("off-server");
        off.disabled = true;
        let config = config_with(vec![
            ("docs", stdio("docs-server")),
            ("off", off),
            ("hidden", stdio("hidden-server")),
        ]);
        let disabled: HashSet<String> = ["hidden".to_string()].into();
        let resolved = SessionMcpServers::from_config(config, &disabled, &HashSet::new());
        assert_eq!(
            resolved.servers.keys().collect::<Vec<_>>(),
            vec!["docs"],
            "disabled flag and explicit agent-definition filter must both apply"
        );
    }

    #[test]
    fn ordinary_policy_does_not_consult_or_inherit_an_agent_definition() {
        let policy = SessionMcpPolicy::resolve_with(None, |_| {
            panic!("ordinary sessions must not resolve the built-in SDE definition")
        })
        .expect("ordinary MCP policy");

        assert!(policy.disabled_servers.is_empty());
        assert!(policy.disabled_tools.is_empty());
        assert!(policy.load_workspace_resources);
        assert!(!policy.requires_mcp_config);
    }

    #[test]
    fn explicit_agent_definition_is_the_only_source_of_agent_mcp_filters() {
        let mut definition = agent_core::definitions::sde_agent();
        definition.tools.disabled_mcp_servers = vec!["private-server".to_string()];
        definition.tools.disabled_mcp_tools = vec!["mcp__docs__delete".to_string()];
        definition.tools.system_restrict_to_tools = Some(vec!["mcp__docs__search".to_string()]);
        definition.load_workspace_resources = Some(false);

        let policy = SessionMcpPolicy::resolve_with(Some(" custom-agent "), |id| {
            (id == "custom-agent").then(|| definition.clone())
        })
        .expect("explicit agent MCP policy");

        assert_eq!(
            policy.disabled_servers,
            HashSet::from(["private-server".to_string()])
        );
        assert_eq!(
            policy.disabled_tools,
            HashSet::from(["mcp__docs__delete".to_string()])
        );
        assert!(!policy.load_workspace_resources);
        assert!(policy.requires_mcp_config);
    }

    #[test]
    fn explicit_agent_without_mcp_allowlist_may_use_an_empty_config() {
        let definition = agent_core::definitions::sde_agent();
        let policy = SessionMcpPolicy::resolve_with(Some("custom-agent"), |id| {
            (id == "custom-agent").then(|| definition.clone())
        })
        .expect("explicit agent without MCP requirement");

        assert!(!policy.requires_mcp_config);
    }

    #[test]
    fn stale_or_empty_explicit_agent_definition_fails_closed() {
        let stale = SessionMcpPolicy::resolve_with(Some("missing-agent"), |_| None)
            .expect_err("stale agent definition must reject the launch");
        assert_eq!(
            stale,
            SessionMcpPolicyError::UnknownAgentDefinition {
                id: "missing-agent".to_string()
            }
        );
        assert!(stale
            .to_string()
            .starts_with("CLI_MCP_POLICY_ERR:UNKNOWN_AGENT_DEFINITION:"));

        let empty = SessionMcpPolicy::resolve_with(Some("  "), |_| {
            panic!("an empty id must fail before looking up a definition")
        })
        .expect_err("empty agent definition must reject the launch");
        assert_eq!(empty, SessionMcpPolicyError::InvalidAgentDefinitionId);
    }

    #[test]
    fn per_tool_denies_fail_closed_by_dropping_the_owning_server() {
        let config = config_with(vec![
            ("docs.prod", stdio("docs-server")),
            ("safe", stdio("safe-server")),
        ]);
        let canonical_denies: HashSet<String> =
            ["mcp__docs_prod__delete_document".to_string()].into();
        let resolved =
            SessionMcpServers::from_config(config.clone(), &HashSet::new(), &canonical_denies);
        assert_eq!(
            resolved.servers.keys().collect::<Vec<_>>(),
            vec!["safe"],
            "a provider config cannot preserve a per-tool deny, so the server must be hidden"
        );

        let slash_denies: HashSet<String> = ["safe/dangerous".to_string()].into();
        let resolved =
            SessionMcpServers::from_config(config.clone(), &HashSet::new(), &slash_denies);
        assert_eq!(
            resolved.servers.keys().collect::<Vec<_>>(),
            vec!["docs.prod"]
        );

        let unknown_server: HashSet<String> = ["mcp__not_configured__tool".to_string()].into();
        let resolved =
            SessionMcpServers::from_config(config.clone(), &HashSet::new(), &unknown_server);
        assert_eq!(resolved.servers.len(), 2);

        let malformed: HashSet<String> = ["unqualified-tool".to_string()].into();
        let resolved = SessionMcpServers::from_config(config, &HashSet::new(), &malformed);
        assert!(
            resolved.servers.is_empty(),
            "an ambiguous authorization selector must never broaden external CLI access"
        );
    }

    #[test]
    fn empty_server_set_serializes_empty_for_every_transport() {
        let resolved = SessionMcpServers::from_config(
            McpConfigFile::default(),
            &HashSet::new(),
            &HashSet::new(),
        );

        assert!(resolved.is_empty());
        assert_eq!(
            serde_json::to_string(&resolved.claude_mcp_json()).unwrap(),
            r#"{"mcpServers":{}}"#
        );
        assert_eq!(resolved.acp_servers(), Vec::<serde_json::Value>::new());
        assert_eq!(resolved.codex_config_entries(), Vec::<String>::new());
    }

    #[test]
    fn ordinary_config_load_failure_fails_closed_to_an_explicit_empty_set() {
        let resolved = SessionMcpServers::from_load_result(
            Err("malformed workspace MCP config".to_string()),
            &HashSet::new(),
            &HashSet::new(),
            false,
        )
        .expect("ordinary session degrades to no MCP servers");
        assert!(resolved.is_empty());
        assert_eq!(
            resolved.claude_mcp_json(),
            serde_json::json!({"mcpServers": {}})
        );

        let temp_dir = tempfile::tempdir().expect("MCP temp root");
        let guard = resolved
            .write_claude_mcp_config_in(temp_dir.path())
            .expect("write fail-closed Claude config");
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(
                &std::fs::read(guard.path()).expect("read fail-closed config")
            )
            .expect("parse fail-closed config"),
            serde_json::json!({"mcpServers": {}})
        );
    }

    #[test]
    fn declared_agent_config_load_failure_rejects_launch() {
        let error = match SessionMcpServers::from_load_result(
            Err("malformed workspace MCP config".to_string()),
            &HashSet::new(),
            &HashSet::new(),
            true,
        ) {
            Ok(_) => panic!("declared Agent MCP policy must not silently disappear"),
            Err(error) => error,
        };

        assert!(error
            .to_string()
            .starts_with("CLI_MCP_POLICY_ERR:CONFIG_LOAD_FAILED:"));
        assert!(error.to_string().contains("malformed workspace MCP config"));
    }

    #[test]
    fn provider_serialization_covers_stdio_url_and_secrets() {
        let mut docs = stdio("docs-server");
        docs.args = Some(vec!["--fast".to_string(), "va\"lue".to_string()]);
        docs.cwd = Some("/workspace/project".to_string());
        docs.env = Some(HashMap::from([
            ("API_TOKEN".to_string(), "stdio-secret".to_string()),
            ("Z_FLAG".to_string(), "1".to_string()),
        ]));
        let mut remote = streamable_http("https://mcp.example.com/http");
        remote.headers = Some(HashMap::from([
            ("Authorization".to_string(), "Bearer url-secret".to_string()),
            ("X.Region".to_string(), "us-west".to_string()),
        ]));
        let sse: McpServerConfig = serde_json::from_value(serde_json::json!({
            "type": "sse",
            "url": "https://mcp.example.com/sse",
            "headers": { "X-SSE-Token": "sse-secret" },
        }))
        .expect("SSE config");
        let config = config_with(vec![("docs", docs), ("legacy", sse), ("remote", remote)]);
        let resolved = SessionMcpServers::from_config(config, &HashSet::new(), &HashSet::new());

        assert_eq!(
            resolved.claude_mcp_json(),
            serde_json::json!({
                "mcpServers": {
                    "docs": {
                        "type": "stdio",
                        "command": "docs-server",
                        "args": ["--fast", "va\"lue"],
                        "cwd": "/workspace/project",
                        "env": {
                            "API_TOKEN": "stdio-secret",
                            "Z_FLAG": "1",
                        },
                    },
                    "legacy": {
                        "type": "sse",
                        "url": "https://mcp.example.com/sse",
                        "headers": { "X-SSE-Token": "sse-secret" },
                    },
                    "remote": {
                        "type": "http",
                        "url": "https://mcp.example.com/http",
                        "headers": {
                            "Authorization": "Bearer url-secret",
                            "X.Region": "us-west",
                        },
                    },
                },
            })
        );

        let diagnostic = resolved
            .redact_secrets_from_text("stdio-secret Bearer url-secret sse-secret ordinary detail");
        assert!(!diagnostic.contains("stdio-secret"));
        assert!(!diagnostic.contains("url-secret"));
        assert!(!diagnostic.contains("sse-secret"));
        assert!(diagnostic.contains("ordinary detail"));

        // ACP's session parameters support stdio process launches only. The
        // secret travels over the child's stdin as an env pair, never argv.
        assert_eq!(
            resolved.acp_servers(),
            vec![serde_json::json!({
                "name": "docs",
                "command": "docs-server",
                "args": ["--fast", "va\"lue"],
                "env": [
                    { "name": "API_TOKEN", "value": "stdio-secret" },
                    { "name": "Z_FLAG", "value": "1" },
                ],
            })]
        );

        // Codex supports stdio and streamable HTTP. Its config schema calls
        // static remote headers `http_headers`; legacy SSE is excluded.
        assert_eq!(
            resolved.codex_config_entries(),
            vec![
                "mcp_servers.docs.command=\"docs-server\"",
                "mcp_servers.docs.args=[\"--fast\", \"va\\\"lue\"]",
                "mcp_servers.docs.cwd=\"/workspace/project\"",
                "mcp_servers.docs.env={API_TOKEN = \"stdio-secret\", Z_FLAG = \"1\"}",
                "mcp_servers.remote.url=\"https://mcp.example.com/http\"",
                "mcp_servers.remote.http_headers={Authorization = \"Bearer url-secret\", \"X.Region\" = \"us-west\"}",
            ]
        );
    }

    #[test]
    fn malformed_provider_entries_are_omitted_consistently() {
        let config = config_with(vec![
            ("blank-command", stdio("  ")),
            ("blank-url", streamable_http("\t")),
        ]);
        let resolved = SessionMcpServers::from_config(config, &HashSet::new(), &HashSet::new());

        assert_eq!(
            resolved.claude_mcp_json(),
            serde_json::json!({ "mcpServers": {} })
        );
        assert!(resolved.acp_servers().is_empty());
        assert!(resolved.codex_config_entries().is_empty());
    }

    #[test]
    fn codex_profile_is_owner_only_argv_safe_and_removed_with_guard() {
        let mut docs = stdio("docs-server");
        docs.env = Some(HashMap::from([(
            "API_TOKEN".to_string(),
            "stdio-secret".to_string(),
        )]));
        let mut remote = streamable_http("https://mcp.example.com/http");
        remote.headers = Some(HashMap::from([(
            "Authorization".to_string(),
            "Bearer url-secret".to_string(),
        )]));
        let resolved = SessionMcpServers::from_config(
            config_with(vec![("docs", docs), ("remote", remote)]),
            &HashSet::new(),
            &HashSet::new(),
        );
        let temp_dir = tempfile::tempdir().expect("Codex profile root");
        let guard = resolved
            .write_codex_mcp_profile(temp_dir.path())
            .expect("write Codex MCP profile")
            .expect("non-empty profile");
        let path = guard.path().to_path_buf();
        let contents = std::fs::read_to_string(&path).expect("read Codex MCP profile");

        assert!(contents.contains("stdio-secret"));
        assert!(contents.contains("Bearer url-secret"));
        assert!(!guard.profile_name().contains("secret"));
        let expected_file_name = format!("{}.config.toml", guard.profile_name());
        assert_eq!(
            path.file_name().and_then(|name| name.to_str()),
            Some(expected_file_name.as_str())
        );
        toml::from_str::<toml::Value>(&contents).expect("valid Codex profile TOML");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }

        drop(guard);
        assert!(!path.exists());
    }

    #[test]
    fn claude_config_file_is_owner_only_and_removed_with_guard() {
        let mut docs = stdio("docs-server");
        docs.env = Some(HashMap::from([(
            "API_TOKEN".to_string(),
            "file-secret".to_string(),
        )]));
        let config = config_with(vec![("docs", docs)]);
        let resolved = SessionMcpServers::from_config(config, &HashSet::new(), &HashSet::new());
        let temp_dir = tempfile::tempdir().expect("MCP temp root");
        let guard = resolved
            .write_claude_mcp_config_in(temp_dir.path())
            .expect("write Claude MCP config");
        let path = guard.path().to_path_buf();

        let bytes = std::fs::read(&path).expect("read serialized config");
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&bytes).unwrap(),
            resolved.claude_mcp_json()
        );
        assert!(
            String::from_utf8(bytes).unwrap().contains("file-secret"),
            "fixture must prove the temporary file is secret-bearing"
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600,
                "Claude config must be owner-readable/writable only"
            );
            assert_eq!(
                std::fs::metadata(temp_dir.path())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700,
                "the containing directory must also be owner-only"
            );
        }

        drop(guard);
        assert!(
            !path.exists(),
            "dropping the run guard must remove the secret-bearing config"
        );
    }
}

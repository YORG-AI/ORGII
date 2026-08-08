//! Internal registry entry types.

#[derive(Debug, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AcpSupport {
    Native,
    AdapterBacked,
    Planned,
    Partial,
    Unavailable,
}

#[derive(Debug, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CliConfigFormat {
    Json,
    Jsonc,
    Toml,
    Yaml,
    Text,
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum CliConfigPathKind {
    Home,
    XdgConfig,
    AppData,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct CliConfigFileEntry {
    pub id: &'static str,
    pub label: &'static str,
    pub path_kind: CliConfigPathKind,
    pub relative_path: &'static str,
    pub format: CliConfigFormat,
    pub secret_bearing: bool,
}

pub(crate) struct CliAgentEntry {
    pub name: &'static str,
    pub display_name: &'static str,
    pub binary: &'static str,
    pub description: &'static str,
    pub brand_color: &'static str,
    pub docs_url: &'static str,
    pub has_subscription_plan: bool,
    pub compatible_api_providers: &'static [&'static str],
    pub config_files: Vec<CliConfigFileEntry>,
    pub is_complex_setup: bool,
    pub default_setup_method: Option<&'static str>,
    pub popular: bool,
    pub icon_provider: &'static str,
    pub paired_api_provider: Option<&'static str>,
    pub supports_rust_agents: bool,
    pub acp_support: AcpSupport,
    /// Whether this CLI agent accepts an initial prompt sent via ORGII's GUI
    /// composer (e.g. via --prompt flag or stdin). When false the agent is
    /// pure-TUI and the session creator shows a Start button instead of the
    /// text composer.
    pub supports_gui: bool,
}

pub(crate) struct ApiProviderEntry {
    pub name: &'static str,
    pub display_name: &'static str,
    pub description: &'static str,
    pub brand_color: &'static str,
    pub docs_url: &'static str,
    pub icon_provider: &'static str,
    pub paired_cli_agent: Option<&'static str>,
    pub popular: bool,
    pub supports_rust_agents: bool,
}

//! Capability types — composable features that define what an agent can do.
//!
//! Each built-in tool declares a [`RequiredCapability`] group.  At session
//! init the agent's [`CapabilitySet`] is checked via [`CapabilitySet::satisfies`]
//! to derive the disabled-tools set automatically — no hand-maintained
//! denylist needed.

use serde::{Deserialize, Serialize};

// ── Action groups ───────────────────────────────────────────────────

/// Which capability group a tool belongs to.
///
/// Every `ToolEntry` in `builtin_tools.rs` carries one of these.
/// `CapabilitySet::satisfies` maps each variant to the corresponding
/// capability flag so tool availability is derived, not listed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RequiredCapability {
    /// Always available (read_file, list_dir, shell, search, …).
    Core,
    /// Requires `coding: Some(_)` (edit_file, apply_patch, query_lsp, …).
    Coding,
    /// Requires `desktop: Some(enabled: true)` (the 15 native desktop tools).
    Desktop,
    /// Requires `browser: Some(external: true)`.
    BrowserExternal,
    /// Requires `browser: Some(internal: true)`.
    BrowserInternal,
    /// Requires `gateway: Some(_)` (send_message).
    Gateway,
    /// Requires `data: Some(_)` (manage_nodes).
    Data,
    /// Requires `management: Some(_)` (manage_session, manage_agent_def).
    Management,
    /// Agent orchestration plumbing (agent, tool_search, …). Always available.
    Orchestration,
}

/// Capability set — defines what an agent can do.
/// Replaces hardcoded OS/SDE differences with composable capabilities.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilitySet {
    /// Gateway capability — receive messages from external channels (Telegram, Discord, CLI).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gateway: Option<GatewayCapability>,

    /// Coding capability — IDE integration, LSP, code editing, mode switching.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coding: Option<CodingCapability>,

    /// Desktop capability — desktop automation through the bundled Peekaboo CLI.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub desktop: Option<DesktopCapability>,

    /// Browser capability — web automation (Playwright, internal browser).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser: Option<BrowserCapability>,

    /// Data capability — database access and remote device control.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<DataCapability>,

    /// Management capability — controls global session/project/agent-definition
    /// administration tools. Coding workers should not receive this by default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub management: Option<ManagementCapability>,
}

impl CapabilitySet {
    /// Does this capability set satisfy the given tool requirement?
    pub fn satisfies(&self, req: RequiredCapability) -> bool {
        match req {
            RequiredCapability::Core | RequiredCapability::Orchestration => true,
            RequiredCapability::Coding => self.coding.is_some(),
            RequiredCapability::Desktop => self.desktop.as_ref().is_some_and(|d| d.enabled),
            RequiredCapability::BrowserExternal => {
                self.browser.as_ref().is_some_and(|b| b.external)
            }
            RequiredCapability::BrowserInternal => {
                self.browser.as_ref().is_some_and(|b| b.internal)
            }
            RequiredCapability::Gateway => self.gateway.is_some(),
            RequiredCapability::Data => self.data.is_some(),
            RequiredCapability::Management => self.management.is_some(),
        }
    }
}

/// Gateway capability — marker that this agent participates in inbound
/// channel messaging. Presence is checked via
/// `RequiredCapability::Gateway` (`gateway.is_some()`). Channel
/// enablement and delegation routing are decided elsewhere
/// (`IntegrationsConfig.channels` and `DelegationConfig`), so this
/// struct intentionally carries no fields.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayCapability {}

/// Coding capability — IDE integration and code editing. Subsystem
/// gating (git snapshot, LSP, work items) is presence-only via
/// `RequiredCapability::Coding`; `mode_switch` is the per-agent toggle
/// consumed by `state/session_runtime`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodingCapability {
    /// Enable mode switching (Build, Plan, Explore, Review). Read by
    /// `agent_core::state::session_runtime` to drive mode-switch UI.
    #[serde(default = "app_utils::default_true")]
    pub mode_switch: bool,
}

impl Default for CodingCapability {
    fn default() -> Self {
        Self { mode_switch: true }
    }
}

/// Desktop capability — desktop automation. Single `enabled` toggle
/// drives the `RequiredCapability::Desktop` gate; per-tool granularity
/// (screenshots, clipboard, …) is intentionally not modeled here.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopCapability {
    /// Enable desktop control through the Peekaboo CLI. The single bool
    /// the desktop `RequiredCapability::Desktop` gate actually inspects.
    #[serde(default = "app_utils::default_true")]
    pub enabled: bool,
}

impl Default for DesktopCapability {
    fn default() -> Self {
        Self { enabled: true }
    }
}

/// Browser capability — web automation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCapability {
    /// Enable external browser control (Playwright).
    #[serde(default = "app_utils::default_true")]
    pub external: bool,

    /// Enable internal browser (embedded webview).
    #[serde(default)]
    pub internal: bool,
}

impl Default for BrowserCapability {
    fn default() -> Self {
        Self {
            external: true,
            internal: false,
        }
    }
}

/// Data capability — marker that this agent has access to the
/// remote-device (node) toolset (`manage_nodes`). Presence gating is
/// handled by `RequiredCapability::Data` (`data.is_some()`); no builtin
/// instantiates it by default, so the capability is denied unless
/// explicitly granted.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DataCapability {}

/// Management capability — marker that this agent can administer global
/// app/session/project/agent-definition state. This is intentionally
/// separate from `Coding` and from low-level `Orchestration` plumbing so
/// Agent Org teammates do not receive OS/coordinator management surfaces.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ManagementCapability {}

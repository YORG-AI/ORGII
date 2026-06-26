//! OS agent template — desktop automation agent.
//!
//! The OS agent specializes in desktop automation tasks:
//! - Desktop control through the bundled Peekaboo CLI
//! - Browser automation through bundled browser control CLIs
//!
//! It uses a singleton session model (one global session).

use crate::definitions::capabilities::{
    BrowserCapability, CapabilitySet, DesktopCapability, ManagementCapability,
};
use crate::definitions::schema::AgentLearningsConfig;
use crate::definitions::schema::{
    AgentDefinition, AgentPolicy, AgentTier, AgentToolSelection, DelegationConfig, SessionMode,
    SessionModel, SubAgentRef,
};
use crate::foundation::security::policy::AutonomyLevel;
use crate::tools::defaults::default_excluded_tools_for_capabilities;
use crate::tools::impls::orchestration::context_builders::ids as ctx_ids;

/// Builtin OS agent definition ID.
pub const OS_AGENT_ID: &str = "builtin:os";

/// OS agent template — desktop automation specialist.
///
/// Capabilities:
/// - Desktop automation through the bundled Peekaboo CLI
/// - Browser automation through bundled browser control CLIs
///
/// Session Model:
/// - Singleton (single global session)
/// - No compaction (short-lived conversations)
/// - No processing lock (allows concurrent requests)
///
/// Security:
/// - Full autonomy (tool calls execute without per-call approval prompts;
///   high-risk commands are still blocked by SecurityPolicy)
/// - Workspace-only file access
pub fn os_agent() -> AgentDefinition {
    let capabilities = CapabilitySet {
        desktop: Some(DesktopCapability { enabled: true }),
        browser: Some(BrowserCapability {
            external: true,
            internal: false,
        }),
        coding: None,
        gateway: None,
        data: None,
        management: Some(ManagementCapability {}),
    };
    let excluded_tools = default_excluded_tools_for_capabilities(&capabilities);

    AgentDefinition {
        id: OS_AGENT_ID.to_string(),
        name: "OS Agent".to_string(),
        description: Some("Desktop automation agent with full system access.".to_string()),
        built_in: true,
        tier: AgentTier::Primary,
        inherits_from: Some(super::BASE_AGENT_ID.to_string()),

        capabilities: Some(capabilities.clone()),

        // Session model: singleton
        session_model: Some(SessionModel {
            mode: SessionMode::Singleton,
            compaction: None,
            processing_lock: false, // Allow concurrent requests
            max_iterations: 500,
        }),

        agent_policy: Some(AgentPolicy {
            autonomy: AutonomyLevel::Full,
            workspace_only: false,
            ..Default::default()
        }),

        // Tool availability is opt-in/out inside the OS capability boundary.
        // OS Agent ships with capability-mismatched tools excluded by
        // default (coding tools — edit_file, query_lsp, etc.).
        // Desktop, browser, plugins, management, and core tools remain available.
        // `manage_project`, `manage_work_item`, and `manage_agent_def`
        // are available directly as management-capability tools.
        tools: AgentToolSelection {
            excluded_tools,
            ..Default::default()
        },

        soul_content: Some(include_str!("prompts/os.md").to_string()),
        sovereign_prompt: false,

        // Default delegation config
        delegation_config: Some(DelegationConfig {
            delegatable: true,
            context_builders: vec![ctx_ids::ENVIRONMENT.to_string()],
        }),

        // Defaults
        context_window: None,
        max_tokens: None,
        temperature: Some(0.0),
        // `builtin:explore` and `builtin:general` are delegation primitives
        // owned by the runtime (`agent_tool` schema fallback + EXPLORE label),
        // not user-configurable sub-agents. They are always reachable via
        // `agent_tool` regardless of this list, so listing them here would
        // create a ghost UI knob (user can "remove" them but cannot disable
        // them in reality). Keep this list to genuine user-configurable
        // specialists only.
        sub_agents: Some(vec![
            SubAgentRef {
                agent_id: super::SDE_AGENT_ID.into(),
                isolation: None,
            },
            SubAgentRef {
                agent_id: super::DS_AGENT_ID.into(),
                isolation: None,
            },
        ]),
        load_workspace_resources: None,
        load_workspace_rules: None,
        skills_config: None,
        selected_account_id: None,
        selected_model_id: None,

        icon_id: Some("omega".to_string()),

        animate: None,
        execution_mode: None,
        exec_timeout: None,
        max_tool_use_concurrency: None,
        learnings: Some(AgentLearningsConfig {
            enabled: true,
            extract_memories_enabled: true,
            auto_dream_enabled: true,
        }),

        reliability: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::names as tool_names;

    #[test]
    fn os_agent_excludes_coding_tools_by_default() {
        let excluded = &os_agent().tools.excluded_tools;

        for tool in [
            tool_names::EDIT_FILE,
            tool_names::QUERY_LSP,
            tool_names::MANAGE_LSP,
        ] {
            assert!(
                excluded.iter().any(|t| t == tool),
                "{tool} must be in OS Agent's default excluded set \
                 (it's a desktop agent, not a code editor)"
            );
        }
    }

    #[test]
    fn os_agent_capabilities_have_no_coding() {
        let caps = os_agent().capabilities.expect("OS Agent declares caps");
        assert!(
            caps.coding.is_none(),
            "OS Agent should not declare coding capability — it's a desktop agent"
        );
        assert!(
            caps.desktop.is_some(),
            "OS Agent's desktop capability must stay on"
        );
    }

    #[test]
    fn os_agent_subagents_exclude_runtime_primitives() {
        // Regression pin: `builtin:explore` / `builtin:general` are runtime
        // delegation primitives (always reachable via `agent_tool`), not
        // user-configurable sub-agents. They must not be listed here, or
        // the UI exposes a ghost "remove" knob for capabilities the user
        // cannot actually disable.
        let subs = os_agent().sub_agents.expect("OS Agent declares sub_agents");
        for forbidden in super::super::SUBAGENT_FORBIDDEN_IDS {
            assert!(
                !subs.iter().any(|s| &s.agent_id == forbidden),
                "OS Agent must not list runtime primitive {forbidden} as a sub-agent"
            );
        }
    }
}

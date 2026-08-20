//! SDE agent template — coding assistant.
//!
//! The SDE (Software Development Engineer) agent specializes in coding tasks:
//! - Code editing (read, write, edit, apply patches)
//! - LSP integration (diagnostics, symbols, references)
//! - Work item tracking
//! - Mode switching (Build, Plan, Explore, Review)
//!
//! It uses a per-session model with context compaction.

use crate::definitions::capabilities::{BrowserCapability, CapabilitySet, CodingCapability};
use crate::definitions::schema::{
    AgentDefinition, AgentLearningsConfig, AgentPolicy, AgentTier, AgentToolSelection,
    CompactionConfig, DelegationConfig, SessionMode, SessionModel,
};
use crate::foundation::security::policy::AutonomyLevel;
use crate::tools::defaults::default_excluded_tools_for_capabilities;
use crate::tools::impls::orchestration::context_builders::ids as ctx_ids;

/// Builtin SDE agent definition ID.
pub const SDE_AGENT_ID: &str = "builtin:sde";

/// SDE agent template — coding assistant.
///
/// Capabilities:
/// - Full coding capabilities (LSP, mode switch, snapshots)
/// - Work item tracking
/// - External browser automation
///
/// Session Model:
/// - Per-session (each conversation has its own session)
/// - Context compaction enabled
/// - Processing lock enabled (serialize requests)
///
/// Security:
/// - Full autonomy
/// - No workspace restriction
pub fn sde_agent() -> AgentDefinition {
    let capabilities = CapabilitySet {
        coding: Some(CodingCapability { mode_switch: true }),
        desktop: None,
        browser: Some(BrowserCapability {
            external: true,
            internal: false,
        }),
        gateway: None,
        data: None,
        management: None,
    };
    let excluded_tools = default_excluded_tools_for_capabilities(&capabilities);

    AgentDefinition {
        id: SDE_AGENT_ID.to_string(),
        name: "SDE Agent".to_string(),
        description: Some("Software development engineer assistant for coding tasks.".to_string()),
        built_in: true,
        tier: AgentTier::Primary,
        inherits_from: Some(super::BASE_AGENT_ID.to_string()),

        capabilities: Some(capabilities.clone()),

        // Session model: per-session with compaction
        session_model: Some(SessionModel {
            mode: SessionMode::PerSession,
            compaction: Some(CompactionConfig {
                enabled: true,
                keep_ratio: 0.5,
                ..CompactionConfig::default()
            }),
            processing_lock: true,
            max_iterations: 500,
        }),

        agent_policy: Some(AgentPolicy {
            autonomy: AutonomyLevel::Full,
            workspace_only: false,
            ..Default::default()
        }),

        // Tool availability is opt-in/out inside the SDE capability boundary.
        // SDE Agent ships with capability-mismatched tools excluded by
        // default (desktop, browser, plugins, management). Coding and core
        // tools remain available.
        tools: AgentToolSelection {
            excluded_tools,
            ..Default::default()
        },

        soul_content: Some(include_str!("prompts/sde.md").to_string()),
        sovereign_prompt: false,
        auto_continue: false,

        // Default delegation config
        delegation_config: Some(DelegationConfig {
            delegatable: true,
            context_builders: vec![
                ctx_ids::CODE_ACCOUNTS.to_string(),
                ctx_ids::ENVIRONMENT.to_string(),
            ],
        }),

        context_window: None,
        max_tokens: None,
        temperature: Some(0.0),
        // `builtin:explore` and `builtin:general` are delegation primitives
        // (`agent_tool` schema fallback + EXPLORE label), not user-
        // configurable sub-agents — they are always reachable regardless of
        // this list. SDE has no genuine user-facing sub-agent specialists by
        // default, so the list is empty.
        sub_agents: Some(vec![]),
        load_workspace_resources: None,
        load_workspace_rules: None,
        skills_config: None,
        selected_account_id: None,
        selected_model_id: None,

        icon_id: Some("code".to_string()),

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
    fn sde_agent_excludes_desktop_tools_by_default() {
        let excluded = &sde_agent().tools.excluded_tools;

        let tool = tool_names::CONTROL_DESKTOP_WITH_PEEKABOO;
        assert!(
            excluded.iter().any(|t| t == tool),
            "{tool} must be in SDE Agent's default excluded set \
             (it's a coding agent, not a desktop driver)"
        );
        assert!(
            !excluded
                .iter()
                .any(|tool| tool == tool_names::RENDER_INLINE_CANVAS),
            "SDE Agent must keep render_inline_canvas available for interactive sketches"
        );
        assert!(
            !excluded
                .iter()
                .any(|tool| tool == tool_names::REVISE_INLINE_CANVAS),
            "SDE Agent must keep revise_inline_canvas available for Canvas revisions"
        );
    }

    #[test]
    fn sde_agent_capabilities_allow_external_browser() {
        let caps = sde_agent().capabilities.expect("SDE Agent declares caps");
        assert!(
            caps.desktop.is_none(),
            "SDE Agent should not declare desktop capability — it's a coding agent"
        );
        assert!(
            caps.coding.is_some(),
            "SDE Agent's coding capability must stay on"
        );
        let browser = caps
            .browser
            .expect("SDE Agent should allow browser automation");
        assert!(
            browser.external,
            "SDE Agent should allow external browser CLI tools"
        );
        assert!(
            !browser.internal,
            "SDE Agent should not allow internal browser automation"
        );
    }

    #[test]
    fn sde_agent_subagents_exclude_runtime_primitives() {
        let subs = sde_agent()
            .sub_agents
            .expect("SDE Agent declares sub_agents");
        for forbidden in super::super::SUBAGENT_FORBIDDEN_IDS {
            assert!(
                !subs.iter().any(|s| &s.agent_id == forbidden),
                "SDE Agent must not list runtime primitive {forbidden} as a sub-agent"
            );
        }
    }

    #[test]
    fn sde_prompt_treats_interactive_sketches_as_canvas_not_implementation() {
        let prompt = sde_agent()
            .soul_content
            .expect("SDE Agent declares a soul prompt");

        assert!(prompt.contains("## Interactive sketches"));
        assert!(prompt.contains("not authorization to implement"));
        assert!(prompt.contains("render_inline_canvas"));
        assert!(prompt.contains("revise_inline_canvas"));
        assert!(prompt.contains("target_event_id"));
        assert!(prompt.contains("`agent_steps`"));
        assert!(prompt.contains("never a fixed template"));
        assert!(prompt.contains("user's language"));
        assert!(prompt.contains("compact exact `edits`"));
        assert!(prompt.contains("user-visible update"));
        assert!(prompt.contains("Do not expose private chain-of-thought"));
        assert!(prompt.contains("mode: \"react\""));
        assert!(prompt.contains("React.useState"));
        assert!(prompt.contains("Do not add imports"));
        assert!(prompt.contains("instead of implementing the product"));
    }
}

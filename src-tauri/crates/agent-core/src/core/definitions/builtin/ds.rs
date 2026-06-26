//! Data Scientist agent template — data analysis specialist.

use crate::definitions::capabilities::{BrowserCapability, CapabilitySet, CodingCapability};
use crate::definitions::schema::{
    AgentDefinition, AgentLearningsConfig, AgentPolicy, AgentTier, AgentToolSelection,
    CompactionConfig, DelegationConfig, SessionMode, SessionModel,
};
use crate::foundation::security::policy::AutonomyLevel;
use crate::tools::impls::orchestration::context_builders::ids as ctx_ids;
use crate::tools::names as tool_names;

pub const DS_AGENT_ID: &str = "builtin:ds";

pub fn ds_agent() -> AgentDefinition {
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

    AgentDefinition {
        id: DS_AGENT_ID.to_string(),
        name: "Data Scientist".to_string(),
        description: Some(
            "Data analysis specialist for SQL, notebooks, datasets, metrics, and visualizations."
                .to_string(),
        ),
        built_in: true,
        tier: AgentTier::Primary,
        inherits_from: Some(super::BASE_AGENT_ID.to_string()),
        capabilities: Some(capabilities),
        session_model: Some(SessionModel {
            mode: SessionMode::PerSession,
            compaction: Some(CompactionConfig {
                enabled: true,
                trigger_ratio: 0.8,
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
        tools: AgentToolSelection {
            system_restrict_to_tools: Some(vec![
                tool_names::READ_FILE.to_string(),
                tool_names::LIST_DIR.to_string(),
                tool_names::CODE_SEARCH.to_string(),
                tool_names::MANAGE_WORKSPACE.to_string(),
                tool_names::RUN_SHELL.to_string(),
                tool_names::AWAIT_OUTPUT.to_string(),
                tool_names::WEB_SEARCH.to_string(),
                tool_names::WEB_FETCH.to_string(),
                tool_names::MANAGE_TODO.to_string(),
                tool_names::ASK_USER_QUESTIONS.to_string(),
            ]),
            ..Default::default()
        },
        soul_content: Some(include_str!("prompts/ds.md").to_string()),
        sovereign_prompt: false,
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
        sub_agents: Some(vec![]),
        load_workspace_resources: None,
        load_workspace_rules: None,
        skills_config: None,
        selected_account_id: None,
        selected_model_id: None,
        icon_id: Some("chart-column".to_string()),
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

    #[test]
    fn ds_agent_is_analysis_focused_without_file_mutation_tools() {
        let agent = ds_agent();
        let tools = agent
            .tools
            .system_restrict_to_tools
            .expect("Data Scientist pins a system allowlist");

        for expected in [
            tool_names::READ_FILE,
            tool_names::LIST_DIR,
            tool_names::CODE_SEARCH,
            tool_names::RUN_SHELL,
            tool_names::WEB_SEARCH,
            tool_names::WEB_FETCH,
        ] {
            assert!(
                tools.iter().any(|tool| tool == expected),
                "missing {expected}"
            );
        }

        for forbidden in [
            tool_names::EDIT_FILE,
            tool_names::APPLY_PATCH,
            tool_names::DELETE_FILE,
            tool_names::MANAGE_AGENT_DEF,
            tool_names::CONTROL_DESKTOP_WITH_PEEKABOO,
        ] {
            assert!(
                !tools.iter().any(|tool| tool == forbidden),
                "Data Scientist should not pin mutating/admin tool {forbidden}"
            );
        }
    }
}

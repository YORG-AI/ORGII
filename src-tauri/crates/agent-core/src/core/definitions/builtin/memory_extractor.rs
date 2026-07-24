//! Memory Extractor agent — background subagent that extracts durable
//! workspace memories from conversation transcripts.
//!
//! Runs as a forked agent after each query loop when workspace memory
//! extraction is enabled. Restricted to read-only tools + writes only
//! within the `.orgii/workspace-memory/` directory.

use crate::definitions::schema::{
    AgentDefinition, AgentTier, AgentToolSelection, DelegationConfig, SessionMode, SessionModel,
};
use crate::tools::names as tool_names;

pub const MEMORY_EXTRACTOR_ID: &str = "builtin:memory-extractor";

pub fn memory_extractor() -> AgentDefinition {
    AgentDefinition {
        id: MEMORY_EXTRACTOR_ID.to_string(),
        name: "Memory Extractor".to_string(),
        description: Some(
            "Background subagent that extracts durable workspace memories from conversation transcripts."
                .to_string(),
        ),
        built_in: true,
        tier: AgentTier::Secondary,
        inherits_from: Some(super::BASE_AGENT_ID.to_string()),

        session_model: Some(SessionModel {
            mode: SessionMode::PerSession,
            compaction: None,
            processing_lock: false,
            max_iterations: 5,
        }),

        capabilities: None,

        // Strict allowlist — read-only + workspace-memory dir writes only.
        tools: AgentToolSelection {
            system_restrict_to_tools: Some(vec![
                tool_names::READ_FILE.to_string(),
                tool_names::CODE_SEARCH.to_string(),
                tool_names::LIST_DIR.to_string(),
                tool_names::RUN_SHELL.to_string(),
                tool_names::EDIT_FILE.to_string(),
            ]),
            ..Default::default()
        },

        // No soul_content — inherits parent session's system prompt for
        // prompt cache sharing. The extraction prompt is injected as the
        // user message by extract_memories.rs.
        soul_content: None,
        sovereign_prompt: false,
        auto_continue: false,

        temperature: Some(0.0),
        max_tokens: Some(4096),

        delegation_config: Some(DelegationConfig {
            delegatable: false,
            context_builders: Vec::new(),
        }),

        context_window: None,
        sub_agents: None,
        load_workspace_resources: None,
        load_workspace_rules: None,
        skills_config: None,
        selected_account_id: None,
        // Runtime resolves the side-query model from the exact parent key.
        selected_model_id: None,

        icon_id: Some("brain".to_string()),

        animate: None,
        execution_mode: None,
        exec_timeout: None,
        max_tool_use_concurrency: None,
        learnings: None,

        agent_policy: None,
        reliability: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_memory_extractor_tool_set() {
        let agent = memory_extractor();
        assert_eq!(agent.id, MEMORY_EXTRACTOR_ID);
        assert!(agent.built_in);

        let allowed = agent
            .tools
            .system_restrict_to_tools
            .as_ref()
            .expect("memory_extractor must use strict system_restrict_to_tools");
        assert!(allowed.contains(&tool_names::READ_FILE.to_string()));
        assert!(allowed.contains(&tool_names::EDIT_FILE.to_string()));
        assert!(allowed.contains(&tool_names::CODE_SEARCH.to_string()));
        assert!(!allowed.contains(&tool_names::AGENT.to_string()));
    }

    #[test]
    fn test_memory_extractor_low_iterations() {
        let agent = memory_extractor();
        let session = agent.session_model.expect("should have session_model");
        assert_eq!(session.max_iterations, 5);
    }

    #[test]
    fn test_memory_extractor_no_soul() {
        let agent = memory_extractor();
        assert!(agent.soul_content.is_none(), "should inherit parent prompt");
    }
}

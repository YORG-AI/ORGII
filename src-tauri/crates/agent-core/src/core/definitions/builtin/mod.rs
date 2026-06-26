//! Built-in agent definitions.
//!
//! All builtin agents are defined in Rust code and cannot be modified by users.
//! They serve as templates that custom agents can inherit from.
//!
//! # Agent Hierarchy
//!
//! ```text
//! builtin:base (root template - minimal agent)
//!     ├── builtin:os (general-purpose assistant; sole channel-facing entry point)
//!     ├── builtin:sde (coding assistant, delegatable from OS)
//!     ├── subagents/
//!     │   ├── builtin:explore (read-only codebase search)
//!     │   └── builtin:general (general purpose, full tool access)
//!     └── memory/
//!         ├── builtin:memory-extractor (workspace memory extraction)
//!         └── builtin:memory-consolidator (memory consolidation / auto-dream)
//! ```
//!
//! The old gateway router and specialist-agent wrappers were retired:
//! - The gateway router pattern rejected general conversational traffic.
//! - Specialist wrappers only wrapped 2-3 tools each (`manage_project`,
//!   `manage_work_item`, `manage_agent_def`); making them parent-callable
//!   tools on OS Agent removes a delegation hop and lets users
//!   toggle them on/off per agent like any other built-in tool.

mod ade_manager;
mod ai_research;
mod base;
mod ds;
mod memory_consolidator;
mod memory_extractor;
mod os;
mod sde;
mod subagents;
mod wingman;
mod work_item_manager;

pub use ade_manager::*;
pub use ai_research::*;
pub use base::*;
pub use ds::*;
pub use memory_consolidator::*;
pub use memory_extractor::*;
pub use os::*;
pub use sde::*;
pub use subagents::*;
pub use wingman::*;
pub use work_item_manager::*;

use super::schema::AgentDefinition;

/// ID prefix for built-in agents.
pub const BUILTIN_PREFIX: &str = "builtin:";

/// Check if an agent ID is a built-in agent.
pub fn is_builtin_agent(id: &str) -> bool {
    id.starts_with(BUILTIN_PREFIX)
}

/// Builtin agent IDs that MUST NOT appear in any agent's `sub_agents`
/// configuration.
///
/// These fall in two buckets:
///
/// 1. **Delegation primitives** (`builtin:explore`, `builtin:general`) —
///    owned by the runtime: the `agent_tool` schema falls back to
///    `builtin:general` when no `agent_id` is given, and `builtin:explore`
///    is the canonical read-only research subagent. They are reachable
///    from every parent regardless of its `sub_agents` list, so listing
///    them would be a ghost UI knob (user "removes" them but cannot
///    actually disable them).
/// 2. **Internal templates / memory subsystem** (`builtin:base`,
///    `builtin:memory-extractor`, `builtin:memory-consolidator`) —
///    inheritance scaffolding and background workers that no parent agent
///    delegates to.
///
/// Source of truth: this list is mirrored by the frontend's
/// `INTERNAL_AGENT_IDS` set in `useAgentDefinitions.ts`. Keep them in sync.
pub const SUBAGENT_FORBIDDEN_IDS: &[&str] = &[
    BASE_AGENT_ID,
    EXPLORE_AGENT_ID,
    GENERAL_AGENT_ID,
    MEMORY_EXTRACTOR_ID,
    MEMORY_CONSOLIDATOR_ID,
];

/// Strip any internal/primitive sub-agent IDs from `agent.sub_agents`.
///
/// Applied at load time (one-shot migration of pre-existing on-disk
/// overlays / user definitions) and at write time (`update_with_overlay`,
/// `update`) so that no path can re-introduce ghost entries.
///
/// Returns `true` if the list was modified.
pub fn strip_forbidden_sub_agents(agent: &mut super::schema::AgentDefinition) -> bool {
    let Some(refs) = agent.sub_agents.as_mut() else {
        return false;
    };
    let before = refs.len();
    refs.retain(|sub| !SUBAGENT_FORBIDDEN_IDS.contains(&sub.agent_id.as_str()));
    refs.len() != before
}

/// Get all built-in agent definitions.
///
/// `ade_manager()` is intentionally listed first so it surfaces at the
/// top of any UI that renders the registry in declaration order. ADE
/// stands for Agentic Development Environment — the IDE-AI analogue
/// whose configuration this agent is responsible for.
pub fn get_builtin_agents() -> Vec<AgentDefinition> {
    vec![
        // Core agents — ADE Manager first by design.
        ade_manager(),
        base_agent(),
        sde_agent(),
        ds_agent(),
        os_agent(),
        ai_research_agent(),
        wingman_agent(),
        work_item_manager_agent(),
        // Subagents (used by the unified `agent` tool)
        explore_agent(),
        general_agent(),
        // Memory subagents (workspace memory system)
        memory_extractor(),
        memory_consolidator(),
    ]
}

/// Get a built-in agent by ID.
pub fn get_builtin_agent(id: &str) -> Option<AgentDefinition> {
    get_builtin_agents().into_iter().find(|a| a.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_builtin_agents_count() {
        let agents = get_builtin_agents();
        assert_eq!(agents.len(), 12); // ADE Manager, base, os, sde, ds, ai-research, wingman, work-item-manager + 2 subagents + 2 memory subagents
    }

    #[test]
    fn test_builtin_agent_ids() {
        assert!(is_builtin_agent(ADE_MANAGER_ID));
        assert!(is_builtin_agent(BASE_AGENT_ID));
        assert!(is_builtin_agent(OS_AGENT_ID));
        assert!(is_builtin_agent(SDE_AGENT_ID));
        assert!(is_builtin_agent(DS_AGENT_ID));
        assert!(is_builtin_agent(AI_RESEARCH_AGENT_ID));
        assert!(is_builtin_agent(WINGMAN_AGENT_ID));
        assert!(is_builtin_agent(WORK_ITEM_MANAGER_AGENT_ID));
        assert!(is_builtin_agent(EXPLORE_AGENT_ID));
        assert!(is_builtin_agent(GENERAL_AGENT_ID));
        assert!(is_builtin_agent(MEMORY_EXTRACTOR_ID));
        assert!(is_builtin_agent(MEMORY_CONSOLIDATOR_ID));
        assert!(!is_builtin_agent("custom-agent-123"));
    }

    #[test]
    fn test_get_builtin_agent() {
        let agent = get_builtin_agent(OS_AGENT_ID);
        assert!(agent.is_some());
        let agent = agent.unwrap();
        assert_eq!(agent.name, "OS Agent");
        assert!(agent.built_in);
    }

    #[test]
    fn test_all_builtin_agents_are_builtin() {
        for agent in get_builtin_agents() {
            assert!(agent.built_in, "Agent {} should be built_in", agent.id);
            assert!(
                is_builtin_agent(&agent.id),
                "Agent {} ID should start with builtin:",
                agent.id
            );
        }
    }

    #[test]
    fn no_builtin_agent_lists_a_forbidden_subagent() {
        // Compiled-in defaults must never list runtime primitives or
        // internal templates as sub-agents — that would re-introduce the
        // ghost UI knob from before the migration.
        for agent in get_builtin_agents() {
            let Some(subs) = agent.sub_agents.as_ref() else {
                continue;
            };
            for forbidden in SUBAGENT_FORBIDDEN_IDS {
                assert!(
                    !subs.iter().any(|s| &s.agent_id == forbidden),
                    "{} must not list {forbidden} as a sub-agent",
                    agent.id
                );
            }
        }
    }

    #[test]
    fn strip_forbidden_sub_agents_removes_internal_ids_only() {
        use super::super::schema::SubAgentRef;

        let mut agent = get_builtin_agent(OS_AGENT_ID).expect("OS agent exists");
        // Inject a stale on-disk shape: explore + general + memory-extractor
        // sneaking in beside a legitimate user specialist.
        agent.sub_agents = Some(vec![
            SubAgentRef {
                agent_id: EXPLORE_AGENT_ID.to_string(),
                isolation: None,
            },
            SubAgentRef {
                agent_id: GENERAL_AGENT_ID.to_string(),
                isolation: None,
            },
            SubAgentRef {
                agent_id: MEMORY_EXTRACTOR_ID.to_string(),
                isolation: None,
            },
            SubAgentRef {
                agent_id: SDE_AGENT_ID.to_string(),
                isolation: None,
            },
            SubAgentRef {
                agent_id: "custom-specialist".to_string(),
                isolation: None,
            },
        ]);

        let modified = strip_forbidden_sub_agents(&mut agent);
        assert!(modified, "stripper must report modification");

        let remaining: Vec<&str> = agent
            .sub_agents
            .as_ref()
            .unwrap()
            .iter()
            .map(|s| s.agent_id.as_str())
            .collect();
        assert_eq!(remaining, vec![SDE_AGENT_ID, "custom-specialist"]);
    }

    #[test]
    fn strip_forbidden_sub_agents_no_op_when_clean() {
        let mut agent = get_builtin_agent(OS_AGENT_ID).expect("OS agent exists");
        let modified = strip_forbidden_sub_agents(&mut agent);
        assert!(
            !modified,
            "compiled-in OS agent default must already be clean"
        );
    }

    #[test]
    fn strip_forbidden_sub_agents_no_op_when_none() {
        let mut agent = get_builtin_agent(WINGMAN_AGENT_ID).expect("Wingman agent exists");
        // Wingman has sub_agents = None.
        let modified = strip_forbidden_sub_agents(&mut agent);
        assert!(!modified);
    }
}

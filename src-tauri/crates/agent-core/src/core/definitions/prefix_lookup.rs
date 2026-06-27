//! Builtin session ID prefix lookup.
//!
//! Routes a session ID like `osagent-abc` to the right `AgentDefinition`
//! constructor. This module owns the mapping table, the lookup
//! functions, and the workspace-default rules (e.g. OS Agent sessions
//! default to `~/.orgii/personal/workspace/`).
//!
//! Lives inside `agent_core::core::definitions` so that the constructor
//! references (`os_agent`, `sde_agent`, `wingman_agent`) stay sibling
//! imports — no back-edge from the type-crate layer up into `agent_core`.
//! The string-prefix constants themselves live one level lower in
//! `core_types::session` so any consumer that just wants to recognise a
//! session ID (git layer, key vault, etc.) can pattern-match without
//! depending on `agent_core`.

pub use core_types::session::{
    CLI_SESSION_PREFIX, DS_SESSION_PREFIX, OS_SESSION_PREFIX, PENDING_SESSION_PLACEHOLDER,
    SDE_SESSION_PREFIX, SHADOW_SUBAGENT_SESSION_PREFIX, SUBAGENT_SESSION_PREFIX,
    WINGMAN_SESSION_PREFIX,
};

use super::schema::AgentDefinition;

/// One row of the builtin prefix registry.
pub struct BuiltinPrefixEntry {
    pub prefix: &'static str,
    pub agent_id: &'static str,
    pub constructor: fn() -> AgentDefinition,
    /// When `true`, sessions with this prefix default to
    /// `~/.orgii/personal/workspace/` when no explicit workspace root
    /// is provided. OS Agent sessions always have this set.
    pub uses_personal_workspace: bool,
}

/// The registry. Order matters: first prefix match wins.
pub static BUILTIN_PREFIX_REGISTRY: &[BuiltinPrefixEntry] = &[
    BuiltinPrefixEntry {
        prefix: WINGMAN_SESSION_PREFIX,
        agent_id: super::builtin::WINGMAN_AGENT_ID,
        constructor: super::wingman_agent,
        uses_personal_workspace: false,
    },
    BuiltinPrefixEntry {
        prefix: OS_SESSION_PREFIX,
        agent_id: super::builtin::OS_AGENT_ID,
        constructor: super::os_agent,
        uses_personal_workspace: true,
    },
    BuiltinPrefixEntry {
        prefix: SDE_SESSION_PREFIX,
        agent_id: super::builtin::SDE_AGENT_ID,
        constructor: super::sde_agent,
        uses_personal_workspace: false,
    },
    BuiltinPrefixEntry {
        prefix: DS_SESSION_PREFIX,
        agent_id: super::builtin::DS_AGENT_ID,
        constructor: super::builtin::ds_agent,
        uses_personal_workspace: false,
    },
];

// ── Derived lookup functions ────────────────────────────────────────

/// Resolve the builtin `AgentDefinition` for a session ID by prefix.
pub fn definition_for_session_id(session_id: &str) -> Option<AgentDefinition> {
    BUILTIN_PREFIX_REGISTRY
        .iter()
        .find(|e| session_id.starts_with(e.prefix))
        .map(|e| (e.constructor)())
}

/// Resolve the session ID prefix for a builtin definition ID.
///
/// Returns `None` for custom / unknown definition IDs.
pub fn prefix_for_definition_id(def_id: &str) -> Option<&'static str> {
    BUILTIN_PREFIX_REGISTRY
        .iter()
        .find(|e| e.agent_id == def_id)
        .map(|e| e.prefix)
}

/// Resolve a new Rust-agent session ID prefix from launch context.
pub fn session_prefix_for_launch(
    agent_definition_id: Option<&str>,
    has_workspace_path: bool,
) -> &'static str {
    if let Some(definition_id) = agent_definition_id {
        if let Some(prefix) = prefix_for_definition_id(definition_id) {
            return prefix;
        }
    }
    if has_workspace_path {
        SDE_SESSION_PREFIX
    } else {
        OS_SESSION_PREFIX
    }
}

/// Whether a session defaults to `~/.orgii/personal/workspace/` when no
/// explicit workspace root is supplied. Currently only OS Agent sessions.
pub fn uses_personal_workspace(session_id: &str) -> bool {
    BUILTIN_PREFIX_REGISTRY
        .iter()
        .find(|e| session_id.starts_with(e.prefix))
        .map(|e| e.uses_personal_workspace)
        .unwrap_or(false)
}

/// Whether a session id belongs to a Wingman session. Centralises the
/// `starts_with(WINGMAN_SESSION_PREFIX)` check so we have one grep
/// target if Wingman ever moves to a typed `DispatchCategory` variant.
pub fn is_wingman_session_id(session_id: &str) -> bool {
    session_id.starts_with(WINGMAN_SESSION_PREFIX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn definition_for_session_id_resolves_all_builtins() {
        assert_eq!(
            definition_for_session_id("wingman-abc").map(|definition| definition.id),
            Some("builtin:wingman".to_string())
        );
        assert_eq!(
            definition_for_session_id("osagent-abc").map(|definition| definition.id),
            Some("builtin:os".to_string())
        );
        assert_eq!(
            definition_for_session_id("sdeagent-abc").map(|definition| definition.id),
            Some("builtin:sde".to_string())
        );
        assert_eq!(
            definition_for_session_id("dsagent-abc").map(|definition| definition.id),
            Some("builtin:ds".to_string())
        );
    }

    #[test]
    fn definition_for_session_id_rejects_unknown_prefix() {
        assert!(definition_for_session_id("unknown-abc").is_none());
    }

    #[test]
    fn prefix_for_definition_id_round_trips() {
        for entry in BUILTIN_PREFIX_REGISTRY {
            let prefix = prefix_for_definition_id(entry.agent_id);
            assert_eq!(
                prefix,
                Some(entry.prefix),
                "prefix_for_definition_id({}) should return {:?}",
                entry.agent_id,
                entry.prefix
            );
        }
    }

    #[test]
    fn prefix_for_definition_id_returns_none_for_custom() {
        assert!(prefix_for_definition_id("custom:my-agent").is_none());
    }

    #[test]
    fn uses_personal_workspace_matches_os_only() {
        assert!(uses_personal_workspace("osagent-abc"));
        assert!(!uses_personal_workspace("sdeagent-abc"));
        assert!(!uses_personal_workspace("dsagent-abc"));
        assert!(!uses_personal_workspace("wingman-abc"));
        assert!(!uses_personal_workspace("unknown-abc"));
    }

    #[test]
    fn registry_covers_all_primary_builtins() {
        let builtin_agents = super::super::builtin::get_builtin_agents();
        for entry in BUILTIN_PREFIX_REGISTRY {
            assert!(
                builtin_agents.iter().any(|a| a.id == entry.agent_id),
                "Registry entry {} has no matching builtin definition",
                entry.agent_id
            );
        }
    }
}

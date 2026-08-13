//! Canonical tool category identifiers.
//!
//! Every `BuiltinToolEntry::category` field, frontend group label, and
//! `Tool::category()` impl should reference these constants instead of
//! a raw string literal. Adding a new category = add one constant here
//! and one match arm in [`is_known_category`] (the test below pins the
//! whole list against actual usage).

/// Coding-time tools: file I/O, edit/patch, code search, LSP, todos,
/// shell exec, plan creation, repo setup, worktree management.
/// Used by both SDE and Custom agents.
pub const CODING: &str = "coding";

/// macOS / desktop UI automation tools (15 native primitives that
/// replaced the old monolithic `control_desktop` tool). OS Agent only.
pub const DESKTOP: &str = "desktop";

/// Web browsing / search tools (`web_search`, `web_fetch`,
/// `control_external_browser`, etc.).
pub const WEB: &str = "web";

/// Remote device / node management tools (`manage_nodes`).
pub const DATA: &str = "data";

/// Cross-cutting agent / orchestration tools that aren't tied to a
/// concrete domain — session management, inbox routing, mode-switch
/// suggestions, plan submission, agent definition mutations.
pub const AGENT: &str = "agent";

/// Subagent dispatch tooling (`agent` tool itself, delegate variants).
/// Distinct from [`AGENT`] because the lifecycle is "spawn child loop"
/// rather than "act on this session".
pub const ORCHESTRATION: &str = "orchestration";

/// Hooks / event-emitter tools used by the agent loop's plugin layer.
/// Not exposed to the LLM as callable tools — only fired internally.
pub const EVENT: &str = "event";

/// Raw SQL connectivity category (reserved; no active tools use this yet).
pub const DATABASE: &str = "database";

/// Session lifecycle tools (`manage_session`).
pub const SESSION: &str = "session";

/// Communication / messaging channel tools (`add_workspace_directory`,
/// `list_session_workspace`, etc.). Mediates the relationship between a
/// chat channel and the workspaces visible to it.
pub const CHANNEL: &str = "channel";

/// Cross-channel messaging (`send_message`, `send_to_inbox`).
pub const COMMS: &str = "comms";

/// Project-adjacent tools (`setup_repo`).
pub const PROJECT: &str = "project";

/// Knowledge-graph node management (`manage_nodes`).
pub const NODES: &str = "nodes";

/// Plan-mode-specific tools (`create_plan`). Distinct from `CODING`
/// because they are only available while the agent is in plan mode.
pub const PLAN_MODE: &str = "plan_mode";

/// Self-introspection tools (`tool_search`).
pub const META: &str = "meta";

/// Catch-all for tools that do not fit the other categories. Avoid
/// adding new entries here; prefer extending the category list.
pub const GENERAL: &str = "general";

/// Returns true if `s` is one of the categories defined in this module.
/// Used by the test below to pin the SSOT and reject typos.
pub fn is_known_category(s: &str) -> bool {
    matches!(
        s,
        CODING
            | DESKTOP
            | WEB
            | DATA
            | AGENT
            | ORCHESTRATION
            | EVENT
            | DATABASE
            | SESSION
            | CHANNEL
            | COMMS
            | PROJECT
            | NODES
            | PLAN_MODE
            | META
            | GENERAL
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_categories_round_trip() {
        for cat in [
            CODING,
            DESKTOP,
            WEB,
            DATA,
            AGENT,
            ORCHESTRATION,
            EVENT,
            DATABASE,
            SESSION,
            CHANNEL,
            COMMS,
            PROJECT,
            NODES,
            PLAN_MODE,
            META,
            GENERAL,
        ] {
            assert!(is_known_category(cat), "{cat} should be a known category");
        }
    }

    #[test]
    fn unknown_categories_rejected() {
        assert!(!is_known_category(""));
        assert!(!is_known_category("typo_category"));
    }
}

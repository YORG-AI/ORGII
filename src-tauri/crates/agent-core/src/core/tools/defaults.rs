//! Tool policy defaults — subagent deny/forbidden lists, role-scoped
//! support metadata, `derive_disabled_tools()`, `default_excluded_tools_for_capabilities()`
//! (capability-driven default-OFF seed for built-in agents), and the
//! `supported_agents_for()` derivation from builtin agent capabilities.
//!
use std::collections::HashSet;

use super::builtin_tools::BUILTIN_TOOLS;
use super::names as tool_names;
use super::ui_metadata::AgentKind;
use crate::definitions::capabilities::{CapabilitySet, RequiredCapability};

/// Tools that **must never** be callable from a subagent.
///
/// These are tools that are semantically parent↔user only — letting a
/// subagent invoke them either hijacks the user interaction channel or
/// opens a recursive delegation loop.
///
/// Every subagent policy overlays this as a hard-deny layer (see
/// `AgentTool::subagent_hard_deny_layer`). Even `inherit_all: true`
/// agents (like `builtin:general`) cannot call these.
pub const SUBAGENT_FORBIDDEN_TOOLS: &[&str] = &[
    // User-interaction: only parent ↔ user, never subagent ↔ user.
    tool_names::ASK_USER_QUESTIONS,
    // Secret capture is a parent ↔ user dialog. Subagents have no
    // access to the per-session `SecretBroker` anyway (`ToolDeps`
    // is built with `secret_broker: None` for shadow runs), but
    // keep the explicit deny for defence-in-depth.
    tool_names::MANAGE_SECRETS,
    tool_names::SUGGEST_MODE_SWITCH,
    tool_names::SEND_MESSAGE,
    // Recursive delegation — a subagent spawning more subagents quickly
    // loses cost control and causes tool_call_id aliasing bugs.
    tool_names::AGENT,
    // Session management: mutating the parent's session list from inside
    // a subagent is always a bug.
    tool_names::MANAGE_SESSION,
    // Plan submission is a parent↔user approval channel (the FE Build
    // button is wired to the parent session). A subagent calling this
    // writes a sibling plan file that the parent never submits, leaving
    // the Build button wired to a stale pending row and permanently
    // disabled. Subagents cannot enter plan mode.
    tool_names::CREATE_PLAN,
];

/// Historical tool names that were deliberately removed but might still
/// be emitted by an outdated model checkpoint or a stale agent-definition
/// JSON. Denied at the subagent boundary as defence-in-depth so a
/// stray call cannot bypass `SUBAGENT_FORBIDDEN_TOOLS` simply by using
/// an old name.
///
/// `task` and `spawn_sub_agent` were both early names for what is now
/// the singular `agent` tool — see commit history of
/// `core/tools/impls/orchestration/agent`. `manage_project` and
/// `manage_work_item` were the typed PM tools retired in favour of the
/// `org2-pm` CLI (orgtrack/v1 agent-plane unification).
pub const SUBAGENT_RETIRED_TOOL_ALIASES: &[&str] = &[
    "task",
    "spawn_sub_agent",
    tool_names::MANAGE_PROJECT,
    tool_names::MANAGE_WORK_ITEM,
];

const NON_BUILTIN_REGISTERED_TOOLS: &[&str] = &[
    tool_names::LIST_KNOWN_WORKSPACES,
    tool_names::ADD_WORKSPACE_DIRECTORY,
    tool_names::REMOVE_WORKSPACE_DIRECTORY,
    tool_names::LIST_SESSION_WORKSPACE,
];

/// Single-pass derivation of the disabled-tools set for a session.
///
/// A tool is **allowed** only when ALL of the following hold:
///   1. If an explicit allowlist is provided (subagent pattern), the
///      tool appears in it.
///   2. It is not in the explicit denylist.
///
/// Every tool that fails any condition lands in the returned
/// `HashSet<String>` — the disabled set consumed by
/// `ToolDeps` construction and overlay-tool gating.
pub fn derive_disabled_tools(restrict_to: &[String], excluded: &[String]) -> HashSet<String> {
    let has_restriction = !restrict_to.is_empty();
    let restrict_set: HashSet<&str> = restrict_to.iter().map(String::as_str).collect();
    let exclude_set: HashSet<&str> = excluded.iter().map(String::as_str).collect();

    BUILTIN_TOOLS
        .iter()
        .map(|entry| entry.name)
        .chain(NON_BUILTIN_REGISTERED_TOOLS.iter().copied())
        .filter(|tool_name| {
            let outside_restriction = has_restriction && !restrict_set.contains(tool_name);
            let explicitly_excluded = exclude_set.contains(tool_name);

            outside_restriction || explicitly_excluded
        })
        .map(str::to_string)
        .collect()
}

/// Derive which agent kinds should advertise support for a given tool.
///
/// Management-surface tools are OS/Custom surfaces, not SDE worker tools.
/// Runtime availability is still enforced by `excluded_tools`, but this
/// keeps Settings/Wizard affordances aligned with the default harness role.
pub fn supported_agents_for(tool_name: &str) -> Vec<AgentKind> {
    match tool_name {
        tool_names::CONTROL_ORGII | tool_names::MANAGE_SESSION | tool_names::MANAGE_AGENT_DEF => {
            vec![AgentKind::Os, AgentKind::Custom]
        }
        _ => vec![AgentKind::Os, AgentKind::Sde, AgentKind::Custom],
    }
}

/// Capability-driven seed for `excluded_tools` on a fresh built-in
/// agent definition.
///
/// Returns every visible builtin tool whose `required_capability` is NOT
/// satisfied by `capabilities`, plus hidden management tools. Most hidden
/// tools are runtime-controlled by entry-specific deps; management hidden
/// tools must still participate because hidden settings visibility must not
/// grant SDE workers app/session administration. Result:
///
/// - **OS Agent** (`coding: None`, `desktop: Some`, `browser: Some`):
///   excludes coding tools (edit_file, query_lsp, manage_lsp). Keeps desktop,
///   external browser, internal browser, core.
/// - **SDE Agent** (`coding: Some`, all others None): excludes the 15
///   desktop tools and browser tools. Keeps coding,
///   core, orchestration.
/// - **Wingman** (`coding: Some(mode_switch: false)`, `desktop: Some`):
///   excludes browser and plugin tools (it has its own
///   `system_restrict_to_tools` allow-list, so this is mostly redundant
///   defence-in-depth but keeps the data model consistent).
///
/// `Core` and `Orchestration` are always satisfied so those tools are
/// never excluded by capability gating.
///
/// Consulted in two places:
///
/// 1. When seeding a fresh built-in agent definition
///    (`core/definitions/builtin/*.rs`) so `excluded_tools` ships
///    populated for first-time installs.
/// 2. At session resolve time
///    (`ResolvedToolSelection::from_schema`) so stale on-disk overlays
///    that blanked out `excluded_tools` cannot smuggle off-capability
///    tools back in. `user_allowed_tools` can only restore tools whose
///    required capability is satisfied by the agent definition.
pub fn default_excluded_tools_for_capabilities(capabilities: &CapabilitySet) -> Vec<String> {
    BUILTIN_TOOLS
        .iter()
        .filter(|entry| {
            !entry.hidden || entry.required_capability == RequiredCapability::Management
        })
        .filter(|entry| !capabilities.satisfies(entry.required_capability))
        .map(|entry| entry.name.to_string())
        .collect()
}

/// Owned `String` clone of `SUBAGENT_FORBIDDEN_TOOLS` — consumed by
/// `AgentTool::subagent_hard_deny_layer` to build the universal deny
/// layer applied to every subagent.
pub fn subagent_forbidden_tools() -> Vec<String> {
    SUBAGENT_FORBIDDEN_TOOLS
        .iter()
        .map(|s| (*s).to_string())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_management_tools_supported_by_all_parent_agent_kinds() {
        for tool in [
            tool_names::CONTROL_DESKTOP_WITH_PEEKABOO,
            tool_names::EDIT_FILE,
            tool_names::READ_FILE,
        ] {
            let agents = supported_agents_for(tool);
            assert!(agents.contains(&AgentKind::Os), "{tool} on OS");
            assert!(agents.contains(&AgentKind::Sde), "{tool} on SDE");
            assert!(agents.contains(&AgentKind::Custom), "{tool} on Custom");
        }
    }

    #[test]
    fn management_tools_are_not_advertised_for_sde_workers() {
        for tool in [tool_names::MANAGE_SESSION, tool_names::MANAGE_AGENT_DEF] {
            let agents = supported_agents_for(tool);
            assert!(agents.contains(&AgentKind::Os), "{tool} on OS");
            assert!(!agents.contains(&AgentKind::Sde), "{tool} not on SDE");
            assert!(agents.contains(&AgentKind::Custom), "{tool} on Custom");
        }
    }

    #[test]
    fn custom_included_for_every_tool() {
        for entry in BUILTIN_TOOLS.iter() {
            let agents = supported_agents_for(entry.name);
            assert!(
                agents.contains(&AgentKind::Custom),
                "{} should include Custom",
                entry.name,
            );
        }
    }

    #[test]
    fn os_capabilities_exclude_coding_tools() {
        use crate::definitions::capabilities::{
            BrowserCapability, CapabilitySet, DesktopCapability, ManagementCapability,
        };
        let os_caps_without_internal_browser = CapabilitySet {
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
        let excluded = default_excluded_tools_for_capabilities(&os_caps_without_internal_browser);

        // Coding tools must be excluded.
        assert!(
            excluded.contains(&tool_names::EDIT_FILE.to_string()),
            "OS should exclude edit_file by default (coding: None)"
        );
        assert!(
            excluded.contains(&tool_names::QUERY_LSP.to_string()),
            "OS should exclude query_lsp by default"
        );

        // Desktop and external browser tools must stay on (capability satisfied).
        assert!(
            !excluded.contains(&tool_names::CONTROL_DESKTOP_WITH_PEEKABOO.to_string()),
            "OS should NOT exclude Peekaboo desktop control (desktop: enabled)"
        );
        assert!(
            !excluded.contains(&tool_names::CONTROL_BROWSER_WITH_AGENT_BROWSER.to_string()),
            "OS should NOT exclude Agent Browser CLI automation"
        );
        assert!(
            !excluded.contains(&tool_names::CONTROL_BROWSER_WITH_PLAYWRIGHT.to_string()),
            "OS should NOT exclude Playwright CLI automation"
        );
        assert!(
            excluded.contains(&tool_names::CONTROL_INTERNAL_BROWSER.to_string()),
            "capabilities with browser.internal=false should exclude internal browser automation"
        );

        // Core tools (read_file, etc.) always satisfied.
        assert!(
            !excluded.contains(&tool_names::READ_FILE.to_string()),
            "Core tools always available"
        );
    }

    #[test]
    fn sde_capabilities_exclude_desktop_tools() {
        use crate::definitions::capabilities::{
            BrowserCapability, CapabilitySet, CodingCapability,
        };
        let sde_caps = CapabilitySet {
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
        let excluded = default_excluded_tools_for_capabilities(&sde_caps);

        // Desktop control must be excluded.
        assert!(
            excluded.contains(&tool_names::CONTROL_DESKTOP_WITH_PEEKABOO.to_string()),
            "SDE should exclude Peekaboo desktop control by default (desktop: None)"
        );

        // Coding and external browser tools must stay on.
        assert!(
            !excluded.contains(&tool_names::EDIT_FILE.to_string()),
            "SDE should NOT exclude edit_file (coding: enabled)"
        );
        assert!(
            !excluded.contains(&tool_names::QUERY_LSP.to_string()),
            "SDE should NOT exclude query_lsp"
        );
        assert!(
            !excluded.contains(&tool_names::CONTROL_BROWSER_WITH_AGENT_BROWSER.to_string()),
            "SDE should NOT exclude Agent Browser CLI automation"
        );
        assert!(
            !excluded.contains(&tool_names::CONTROL_BROWSER_WITH_PLAYWRIGHT.to_string()),
            "SDE should NOT exclude Playwright CLI automation"
        );
        assert!(
            excluded.contains(&tool_names::CONTROL_INTERNAL_BROWSER.to_string()),
            "SDE should exclude internal browser automation by default"
        );
        for tool in [tool_names::MANAGE_SESSION, tool_names::MANAGE_AGENT_DEF] {
            assert!(
                excluded.contains(&tool.to_string()),
                "SDE should exclude management tool {tool} by default"
            );
        }

        // Core tools always satisfied.
        assert!(
            !excluded.contains(&tool_names::READ_FILE.to_string()),
            "Core tools always available"
        );
    }

    #[test]
    fn sde_default_session_config_offers_reply_session_comment() {
        use crate::definitions::capabilities::{
            BrowserCapability, CapabilitySet, CodingCapability,
        };
        let sde_caps = CapabilitySet {
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
        let excluded = default_excluded_tools_for_capabilities(&sde_caps);
        assert!(
            !excluded.contains(&tool_names::REPLY_SESSION_COMMENT.to_string()),
            "SDE should NOT exclude reply_session_comment by default"
        );

        let disabled = derive_disabled_tools(&[], &excluded);
        assert!(
            !disabled.contains(tool_names::REPLY_SESSION_COMMENT),
            "reply_session_comment must not land in the derived disabled set for SDE"
        );
    }
}

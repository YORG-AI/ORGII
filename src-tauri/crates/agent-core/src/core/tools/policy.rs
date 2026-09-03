//! Tool policy system for runtime tool gating.
//!
//! Per-agent allow/deny lives on `AgentDefinition.tools.excludedTools`
//! (name-based deny applied at tool-registration time) and on the
//! runtime access-mode tool policy at session init.
//!
//! This module owns the **runtime** verdict policy:
//!
//! - [`ToolPolicyLayer`] — a single allow/deny layer (group-aware).
//! - [`ResolvedToolPolicy`] — a stack of layers + an ask list, queried
//!   per tool call to produce `Allow` / `Deny` / `Ask`.
//!
//! Layers are added at runtime by:
//!
//! - the session init path (subagent default deny),
//! - `AgentExecMode` overlays (plan / ask via `with_extra_layer`),
//! - subagent orchestration (allow lists for spawned children).

use serde::{Deserialize, Serialize};
use tracing::warn;

use crate::tools::names as tool_names;

pub const GROUP_WEB: &str = "group:web";
pub const GROUP_DESKTOP: &str = "group:desktop";

// ============================================
// Tool Groups
// ============================================

/// Named groups of related tools for bulk allow/deny.
///
/// Usage in config: `"allow": ["group:web", "group:desktop", "group:fs"]`
pub const TOOL_GROUPS: &[(&str, &[&str])] = &[
    (GROUP_WEB, &[tool_names::WEB_SEARCH, tool_names::WEB_FETCH]),
    (GROUP_DESKTOP, &[tool_names::CONTROL_DESKTOP_WITH_PEEKABOO]),
    (
        "group:fs",
        &[
            tool_names::READ_FILE,
            tool_names::LIST_DIR,
            tool_names::EDIT_FILE,
            tool_names::DELETE_FILE,
        ],
    ),
    (
        "group:runtime",
        &[tool_names::RUN_SHELL, tool_names::AWAIT_OUTPUT],
    ),
    ("group:sessions", &[tool_names::MANAGE_SESSION]),
    (
        "group:browser",
        &[
            tool_names::CONTROL_BROWSER_WITH_AGENT_BROWSER,
            tool_names::CONTROL_BROWSER_WITH_PLAYWRIGHT,
            tool_names::CONTROL_INTERNAL_BROWSER,
        ],
    ),
    ("group:nodes", &[tool_names::MANAGE_NODES]),
    ("group:comms", &[tool_names::SEND_MESSAGE]),
    (
        "group:orchestration",
        &[
            tool_names::ORG_SEND_MESSAGE,
            tool_names::TASK_CREATE,
            tool_names::TASK_GRAPH_CREATE,
            tool_names::TASK_UPDATE,
            tool_names::TASK_LIST,
            tool_names::TASK_GET,
            tool_names::ORG_RUN_COMPLETE,
            tool_names::ORG_INBOX_REPAIR,
        ],
    ),
    (
        "group:project",
        &[tool_names::AGENT, tool_names::MANAGE_WORKSPACE],
    ),
    ("group:search", &[tool_names::CODE_SEARCH]),
    (
        "group:lsp",
        &[tool_names::QUERY_LSP, tool_names::MANAGE_LSP],
    ),
    (
        "group:todo",
        &[tool_names::MANAGE_TODO, tool_names::MANAGE_FILE_HISTORY],
    ),
];

// ============================================
// Policy Layer
// ============================================

/// A single allow/deny policy layer.
///
/// - `allow: None` means no restriction from this layer (pass-through).
/// - `allow: Some([])` means deny everything.
/// - `allow: Some(["tool_a", "group:web"])` means only those are allowed.
/// - `deny` entries are always checked; deny wins over allow.
///
/// Group references (e.g., `"group:web"`) are expanded during evaluation.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolPolicyLayer {
    /// Allowed tools/groups. `None` = no restriction from this layer.
    #[serde(default)]
    pub allow: Option<Vec<String>>,
    /// Denied tools/groups. Always applied.
    #[serde(default)]
    pub deny: Vec<String>,
}

impl ToolPolicyLayer {
    /// Create a layer that allows everything (pass-through).
    pub fn allow_all() -> Self {
        Self {
            allow: None,
            deny: Vec::new(),
        }
    }

    /// Create a layer that denies specific tools.
    pub fn deny_only(denied: Vec<String>) -> Self {
        Self {
            allow: None,
            deny: denied,
        }
    }

    /// Check if a tool name is allowed by this single layer.
    pub fn is_allowed(&self, tool_name: &str) -> bool {
        // Deny always wins
        if self.matches_any(tool_name, &self.deny) {
            return false;
        }

        // If allow is None, this layer imposes no restriction
        let Some(ref allow_list) = self.allow else {
            return true;
        };

        // Empty allow list means nothing is allowed
        if allow_list.is_empty() {
            return false;
        }

        // Tool must match at least one allow entry
        self.matches_any(tool_name, allow_list)
    }

    /// Check if a tool name matches any entry in the list, expanding groups.
    fn matches_any(&self, tool_name: &str, entries: &[String]) -> bool {
        for entry in entries {
            // Wildcard: allow/deny all
            if entry == "*" {
                return true;
            }

            // Group reference: expand and check membership
            if entry.starts_with("group:") {
                if let Some(members) = expand_group(entry) {
                    if members.contains(&tool_name) {
                        return true;
                    }
                } else {
                    warn!("[tool-policy] Unknown group in policy: {}", entry);
                }
                continue;
            }

            // Glob pattern: simple suffix wildcard (e.g., "session_*")
            if entry.ends_with('*') {
                let prefix = &entry[..entry.len() - 1];
                if tool_name.starts_with(prefix) {
                    return true;
                }
                continue;
            }

            // Exact match
            if entry == tool_name {
                return true;
            }
        }
        false
    }
}

/// Expand a group name to its member tools.
fn expand_group(group: &str) -> Option<Vec<&str>> {
    TOOL_GROUPS
        .iter()
        .find(|(name, _)| *name == group)
        .map(|(_, members)| members.to_vec())
}

// ============================================
// Resolved Policy
// ============================================

/// A fully resolved policy built from config + runtime context.
///
/// Created once at session start and used to filter tools and gate execution.
///
/// Supports three verdicts:
/// - **Allow** — tool executes immediately
/// - **Deny** — tool is blocked (never shown to LLM)
/// - **Ask** — tool pauses for user confirmation before executing
#[derive(Clone)]
pub struct ResolvedToolPolicy {
    layers: Vec<ToolPolicyLayer>,
    /// Tools that require user confirmation before execution.
    /// Checked after allow/deny layers pass. If a tool is in this set
    /// AND passes all layers, the verdict is `Ask` instead of `Allow`.
    ask_tools: Vec<String>,
    /// Rebuilt from the persisted companion context before every Agent Org
    /// Turn. A warm Member runtime must not retain the previous Turn's Task
    /// authority.
    agent_org_turn_profile: Option<AgentOrgTurnToolProfile>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AgentOrgTurnToolProfile {
    UserDirectedWorker,
    UserDirectedWriter,
}

/// The three possible verdicts for a tool execution request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolVerdict {
    /// Tool is allowed — execute immediately.
    Allow,
    /// Tool is denied — blocked by policy.
    Deny,
    /// Tool requires user confirmation before executing.
    Ask,
}

impl ResolvedToolPolicy {
    /// Create a policy directly from explicit layers (no config resolution).
    /// Useful for sub-agent tools that need a simple allow/deny policy.
    pub fn from_layers(layers: Vec<ToolPolicyLayer>) -> Self {
        Self {
            layers,
            ask_tools: Vec::new(),
            agent_org_turn_profile: None,
        }
    }

    /// Override the ask_tools list.
    pub fn with_ask_tools(mut self, tools: Vec<String>) -> Self {
        self.ask_tools = tools;
        self
    }

    /// Build a permissive policy (no restrictions). Used when no policy is configured.
    ///
    /// Per-agent allow/deny is enforced at tool-registration time via
    /// `AgentDefinition.tools.excludedTools` (the registry never sees
    /// disabled tools). Access-mode policy is layered by the init path;
    /// subagent denies are layered at spawn time
    /// (`AgentTool::subagent_hard_deny_layer`).
    pub fn permissive() -> Self {
        Self {
            layers: Vec::new(),
            ask_tools: Vec::new(),
            agent_org_turn_profile: None,
        }
    }

    /// The effective per-turn policy: the session's base policy plus the
    /// exec-mode deny-delta layer (when the mode contributes one).
    ///
    /// This is THE single composition point for "what can this turn call".
    /// The per-turn executor, the effective-tools RPC, and the debug
    /// snapshot all call this — they previously each composed the overlay
    /// themselves and could drift.
    pub fn with_exec_mode(&self, mode: crate::session::AgentExecMode) -> Self {
        match mode.policy_layer() {
            Some(layer) => self.with_extra_layer(layer),
            None => self.clone(),
        }
    }

    /// Create a new policy with an additional layer appended.
    ///
    /// Used by agent modes (plan, explore) to add mode-specific restrictions
    /// on top of the base policy without mutating it.
    pub fn with_extra_layer(&self, layer: ToolPolicyLayer) -> Self {
        let mut layers = self.layers.clone();
        layers.push(layer);
        Self {
            layers,
            ask_tools: self.ask_tools.clone(),
            agent_org_turn_profile: self.agent_org_turn_profile,
        }
    }

    /// Resolve the work profile for one already-admitted Agent Org Turn.
    /// Ordinary SDE sessions never call this and incur no Agent Org lookup.
    pub(crate) fn for_persisted_agent_org_turn(
        &self,
        session_id: &str,
        turn_intent_id: &str,
    ) -> Result<Self, String> {
        let context =
            crate::coordination::agent_org_turn_contexts::require_existing_context_for_session(
                session_id,
                turn_intent_id,
            )?;
        if !context.is_user_directed_work() {
            return Ok(self.clone());
        }
        let run_context = crate::coordination::agent_org_runs::AgentOrgRunStore::context_for_run(
            &context.org_run_id,
        )?
        .ok_or_else(|| format!("agent_org_run_not_found: {}", context.org_run_id))?;
        let is_writer = run_context
            .capability_index
            .is_additional_writer(&context.participant_id);
        let status = crate::coordination::agent_org_runs::AgentOrgRunStore::get_run_status(
            &context.org_run_id,
        )?
        .ok_or_else(|| format!("agent_org_run_not_found: {}", context.org_run_id))?;
        let mut resolved = self.clone();
        resolved.agent_org_turn_profile = Some(
            if is_writer && status != crate::coordination::agent_org_runs::AgentOrgRunStatus::Paused
            {
                AgentOrgTurnToolProfile::UserDirectedWriter
            } else {
                AgentOrgTurnToolProfile::UserDirectedWorker
            },
        );
        Ok(resolved)
    }

    fn denied_by_agent_org_turn(&self, tool_name: &str) -> bool {
        match self.agent_org_turn_profile {
            None => false,
            Some(AgentOrgTurnToolProfile::UserDirectedWorker) => matches!(
                tool_name,
                tool_names::ORG_SEND_MESSAGE
                    | tool_names::TASK_CREATE
                    | tool_names::TASK_GRAPH_CREATE
                    | tool_names::TASK_UPDATE
                    | tool_names::ORG_RUN_COMPLETE
                    | tool_names::ORG_INBOX_REPAIR
            ),
            Some(AgentOrgTurnToolProfile::UserDirectedWriter) => matches!(
                tool_name,
                tool_names::ORG_SEND_MESSAGE
                    | tool_names::ORG_RUN_COMPLETE
                    | tool_names::ORG_INBOX_REPAIR
            ),
        }
    }

    /// Get the full verdict for a tool: Allow, Deny, or Ask.
    pub fn verdict(&self, tool_name: &str) -> ToolVerdict {
        if self.denied_by_agent_org_turn(tool_name) {
            return ToolVerdict::Deny;
        }
        // Check deny/allow layers first
        for layer in &self.layers {
            if !layer.is_allowed(tool_name) {
                return ToolVerdict::Deny;
            }
        }

        // If it passes all layers, check if it requires confirmation
        if !self.ask_tools.is_empty() {
            // Reuse the same matching logic as layers (supports groups, globs, wildcards)
            let ask_layer = ToolPolicyLayer {
                allow: Some(self.ask_tools.clone()),
                deny: Vec::new(),
            };
            if ask_layer.is_allowed(tool_name) {
                return ToolVerdict::Ask;
            }
        }

        ToolVerdict::Allow
    }

    /// Check if a tool is allowed through all layers.
    /// Note: returns true for both Allow and Ask verdicts (tool is visible to LLM).
    pub fn is_allowed(&self, tool_name: &str) -> bool {
        self.verdict(tool_name) != ToolVerdict::Deny
    }

    /// Check if a tool requires user confirmation.
    pub fn requires_ask(&self, tool_name: &str) -> bool {
        self.verdict(tool_name) == ToolVerdict::Ask
    }

    /// Filter tool definitions (OpenAI schema format) to only allowed tools.
    ///
    /// Removes tools that would be denied, so the LLM never sees them.
    pub fn filter_definitions(
        &self,
        definitions: Vec<serde_json::Value>,
    ) -> Vec<serde_json::Value> {
        if self.layers.is_empty() && self.agent_org_turn_profile.is_none() {
            return definitions; // No policy = no filtering
        }

        definitions
            .into_iter()
            .filter_map(|mut def| {
                let name = def
                    .pointer("/function/name")
                    .and_then(|val| val.as_str())
                    .unwrap_or("");
                if !self.is_allowed(name) {
                    return None;
                }
                if name == tool_names::TASK_UPDATE
                    && self.agent_org_turn_profile
                        == Some(AgentOrgTurnToolProfile::UserDirectedWriter)
                {
                    const GRAPH_OPERATIONS: &[&str] = &[
                        "patch_pending",
                        "cancel",
                        "cancel_and_replace",
                        "append_audit_note",
                    ];
                    if let Some(operations) = def
                        .pointer_mut("/function/parameters/properties/operation/enum")
                        .and_then(|value| value.as_array_mut())
                    {
                        operations.retain(|value| {
                            value
                                .as_str()
                                .is_some_and(|value| GRAPH_OPERATIONS.contains(&value))
                        });
                    }
                }
                Some(def)
            })
            .collect()
    }
}

// ============================================
// Tests
// ============================================

#[cfg(test)]
#[path = "tests/policy_tests.rs"]
mod tests;

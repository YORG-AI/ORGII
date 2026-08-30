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

use crate::tools::call_context::{AgentOrgTurnToolProfile, ToolCallAuthority};
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
    agent_org_task_execution:
        Option<crate::coordination::agent_org_task_execution_fence::TaskExecutionEffectIdentity>,
}

#[derive(Debug, Clone)]
pub(crate) struct PersistedAgentOrgToolAuthority {
    pub profile: AgentOrgTurnToolProfile,
    pub task_execution:
        Option<crate::coordination::agent_org_task_execution_fence::TaskExecutionEffectIdentity>,
}

/// The only resolver for persisted Agent Org tool authority. Registry policy
/// refresh and lowest-adapter checks both call this function, so a directly
/// constructed Tool cannot reuse a stale in-memory profile after cancellation,
/// reassignment, Pause, or generation change.
pub(crate) fn resolve_persisted_agent_org_tool_authority(
    session_id: &str,
    turn_intent_id: &str,
) -> Result<PersistedAgentOrgToolAuthority, String> {
    let context = crate::coordination::agent_org_turn_contexts::revalidate_context_for_execution(
        session_id,
        turn_intent_id,
    )?;
    let fixed_profile = match context.turn_kind {
        crate::coordination::agent_org_turn_contexts::AgentOrgTurnKind::Coordinator => {
            if context.source_kind
                == crate::coordination::agent_org_turn_contexts::AgentOrgTurnSourceKind::MemberInbox
            {
                let status = crate::coordination::agent_org_runs::AgentOrgRunStore::get_run_status(
                    &context.org_run_id,
                )?
                .ok_or_else(|| format!("agent_org_run_not_found: {}", context.org_run_id))?;
                Some(
                    if status == crate::coordination::agent_org_runs::AgentOrgRunStatus::Paused {
                        AgentOrgTurnToolProfile::SummaryOnly
                    } else {
                        AgentOrgTurnToolProfile::CoordinatorOrchestration
                    },
                )
            } else {
                let conn = database::db::get_connection().map_err(|error| error.to_string())?;
                if crate::coordination::agent_org_final_summary::is_summary_turn_with_connection(
                    &conn,
                    session_id,
                    turn_intent_id,
                )? {
                    Some(AgentOrgTurnToolProfile::SummaryOnly)
                } else {
                    Some(AgentOrgTurnToolProfile::CoordinatorOrchestration)
                }
            }
        }
        crate::coordination::agent_org_turn_contexts::AgentOrgTurnKind::TaskExecution => {
            Some(AgentOrgTurnToolProfile::TaskExecution)
        }
        crate::coordination::agent_org_turn_contexts::AgentOrgTurnKind::UserDirectedWork => None,
    };
    let profile = match fixed_profile {
        Some(profile) => profile,
        None => {
            let run_context =
                crate::coordination::agent_org_runs::AgentOrgRunStore::context_for_run(
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
            if is_writer && status != crate::coordination::agent_org_runs::AgentOrgRunStatus::Paused
            {
                AgentOrgTurnToolProfile::UserDirectedWriter
            } else {
                AgentOrgTurnToolProfile::UserDirectedWorker
            }
        }
    };
    let task_execution = (profile == AgentOrgTurnToolProfile::TaskExecution).then(|| {
        crate::coordination::agent_org_task_execution_fence::TaskExecutionEffectIdentity {
            org_run_id: context.org_run_id,
            task_id: context.task_id.expect("validated TaskExecution task"),
            session_id: context.session_id,
            turn_intent_id: context.turn_intent_id,
            owner_member_id: context
                .owner_member_id
                .expect("validated TaskExecution owner"),
            activation_generation: context
                .activation_generation
                .expect("validated TaskExecution generation"),
        }
    });
    Ok(PersistedAgentOrgToolAuthority {
        profile,
        task_execution,
    })
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
            agent_org_task_execution: None,
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
            agent_org_task_execution: None,
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
            agent_org_task_execution: self.agent_org_task_execution.clone(),
        }
    }

    /// Resolve the work profile for one already-admitted Agent Org Turn.
    /// Ordinary SDE sessions never call this and incur no Agent Org lookup.
    pub(crate) fn for_persisted_agent_org_turn(
        &self,
        session_id: &str,
        turn_intent_id: &str,
    ) -> Result<Self, String> {
        let authority = resolve_persisted_agent_org_tool_authority(session_id, turn_intent_id)?;
        let mut resolved = self.clone();
        resolved.agent_org_turn_profile = Some(authority.profile);
        resolved.agent_org_task_execution = authority.task_execution;
        Ok(resolved)
    }

    pub(crate) fn task_execution_effect_identity(
        &self,
    ) -> Option<&crate::coordination::agent_org_task_execution_fence::TaskExecutionEffectIdentity>
    {
        self.agent_org_task_execution.as_ref()
    }

    pub(crate) fn call_authority(&self) -> ToolCallAuthority {
        self.agent_org_turn_profile.map_or(
            ToolCallAuthority::TrustedSde,
            ToolCallAuthority::PersistedAgentOrg,
        )
    }

    /// Refresh an Agent Org profile immediately before execution. Ordinary
    /// SDE turns have no companion context and retain their existing policy;
    /// an already-profiled Agent Org turn must never downgrade to ordinary
    /// authority when its context is missing or stale.
    pub(crate) fn refreshed_for_execute_call(
        &self,
        session_id: &str,
        turn_intent_id: &str,
    ) -> Result<Self, String> {
        // Persisted Agent Org Turns are profiled once at admission. An
        // unprofiled policy is therefore an ordinary SDE Turn and must not
        // perform an Agent Org table probe on every tool call.
        if self.agent_org_turn_profile.is_none() {
            return Ok(self.clone());
        }
        if session_id.trim().is_empty() || turn_intent_id.trim().is_empty() {
            return Err(
                "agent_org_turn_context_invalid: tool call is missing Session/Turn identity"
                    .to_string(),
            );
        }
        let context = crate::coordination::agent_org_turn_contexts::optional_context_for_session(
            session_id,
            turn_intent_id,
        )?;
        if context.is_none() {
            return Err(format!(
                "agent_org_turn_context_invalid: missing companion context for {session_id}/{turn_intent_id}"
            ));
        }
        self.for_persisted_agent_org_turn(session_id, turn_intent_id)
    }

    fn denied_by_agent_org_turn(&self, tool_name: &str) -> bool {
        self.agent_org_turn_profile
            .is_some_and(|profile| !agent_org_profile_allows_tool(profile, tool_name))
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
                if name == tool_names::TASK_UPDATE {
                    const GRAPH_OPERATIONS: &[&str] = &[
                        "patch_pending",
                        "cancel",
                        "cancel_and_replace",
                        "append_audit_note",
                    ];
                    const OWNER_OPERATIONS: &[&str] = &[
                        "start",
                        "complete",
                        "fail",
                        "append_progress",
                        "append_evidence",
                    ];
                    let allowed_operations = match self.agent_org_turn_profile {
                        Some(AgentOrgTurnToolProfile::CoordinatorOrchestration)
                        | Some(AgentOrgTurnToolProfile::UserDirectedWriter) => {
                            Some(GRAPH_OPERATIONS)
                        }
                        Some(AgentOrgTurnToolProfile::TaskExecution) => Some(OWNER_OPERATIONS),
                        None
                        | Some(AgentOrgTurnToolProfile::SummaryOnly)
                        | Some(AgentOrgTurnToolProfile::UserDirectedWorker) => None,
                    };
                    let Some(allowed_operations) = allowed_operations else {
                        return Some(def);
                    };
                    if let Some(operations) = def
                        .pointer_mut("/function/parameters/properties/operation/enum")
                        .and_then(|value| value.as_array_mut())
                    {
                        operations.retain(|value| {
                            value
                                .as_str()
                                .is_some_and(|value| allowed_operations.contains(&value))
                        });
                    }
                }
                Some(def)
            })
            .collect()
    }
}

/// Shared operation-independent authority matrix used by both the registry
/// and lowest tool adapters. Keeping one exhaustive match prevents schema and
/// direct-construction behavior from drifting.
pub(crate) fn agent_org_profile_allows_tool(
    profile: AgentOrgTurnToolProfile,
    tool_name: &str,
) -> bool {
    match profile {
        AgentOrgTurnToolProfile::SummaryOnly => false,
        AgentOrgTurnToolProfile::CoordinatorOrchestration => matches!(
            tool_name,
            tool_names::READ_FILE
                | tool_names::LIST_DIR
                | tool_names::CODE_SEARCH
                | tool_names::TASK_LIST
                | tool_names::TASK_GET
                | tool_names::TASK_CREATE
                | tool_names::TASK_GRAPH_CREATE
                | tool_names::TASK_UPDATE
                | tool_names::ORG_SEND_MESSAGE
                | tool_names::ORG_INBOX_REPAIR
                | tool_names::ORG_RUN_COMPLETE
        ),
        AgentOrgTurnToolProfile::TaskExecution => !matches!(
            tool_name,
            tool_names::TASK_CREATE
                | tool_names::TASK_GRAPH_CREATE
                | tool_names::ORG_RUN_COMPLETE
                | tool_names::ORG_INBOX_REPAIR
        ),
        AgentOrgTurnToolProfile::UserDirectedWorker => !matches!(
            tool_name,
            tool_names::TASK_CREATE
                | tool_names::TASK_GRAPH_CREATE
                | tool_names::TASK_UPDATE
                | tool_names::ORG_RUN_COMPLETE
                | tool_names::ORG_INBOX_REPAIR
        ),
        AgentOrgTurnToolProfile::UserDirectedWriter => !matches!(
            tool_name,
            tool_names::ORG_RUN_COMPLETE | tool_names::ORG_INBOX_REPAIR
        ),
    }
}

// ============================================
// Tests
// ============================================

#[cfg(test)]
#[path = "tests/policy_tests.rs"]
mod tests;

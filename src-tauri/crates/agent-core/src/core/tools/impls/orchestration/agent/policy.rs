//! Tool registry + policy construction for the unified agent tool.
//!
//! Two dispatch paths (see `mod.rs` docstring):
//! - **Path A**: inherit parent registry, overlay policy (deny + optional
//!   allow).
//! - **Path B**: build a fresh registry from an explicit allowlist — used
//!   for specialist agents whose tools (`manage_agent_def`) are
//!   deliberately denied on the parent overlay.

use tracing::warn;

use crate::definitions::AgentDefinition;
use crate::tools::builtin_tools::builtin_tool_required_capability;
use crate::tools::defaults::{subagent_forbidden_tools, SUBAGENT_RETIRED_TOOL_ALIASES};
use crate::tools::names as tool_names;
use crate::tools::policy::{ResolvedToolPolicy, ToolPolicyLayer};
use crate::tools::registry::ToolRegistry;
use crate::tools::traits::ToolError;

use crate::tools::impls::agent_def::AgentDefinitionTool;

use super::AgentTool;

pub(super) fn agent_supports_builtin_tool(agent: &AgentDefinition, tool_name: &str) -> bool {
    let Some(required) = builtin_tool_required_capability(tool_name) else {
        return true;
    };
    let capabilities = agent.capabilities.clone().unwrap_or_default();
    capabilities.satisfies(required)
}

impl AgentTool {
    // ── Path A: Inherit parent registry with policy overlay ─────────

    /// Hard deny layer applied to every subagent policy.
    ///
    /// Sources, both in `tools::defaults`:
    /// - `SUBAGENT_FORBIDDEN_TOOLS` — canonical list of tools that must
    ///   never reach a subagent (user-interaction: `ask_user_questions`,
    ///   `suggest_mode_switch`, `send_message`; recursive: `agent`;
    ///   session mutation: `manage_session`; `create_plan`).
    /// - `SUBAGENT_RETIRED_TOOL_ALIASES` — historical names a stale
    ///   model checkpoint might still emit; denied as defence-in-depth.
    ///
    /// This is the single source of truth. An agent definition's
    /// `excluded_tools` layer is additive; it cannot shrink this deny.
    /// In particular, even agents with `system_restrict_to_tools = None`
    /// (e.g. `builtin:general`) cannot call forbidden tools.
    pub(super) fn subagent_hard_deny_layer() -> ToolPolicyLayer {
        let mut deny = subagent_forbidden_tools();
        for alias in SUBAGENT_RETIRED_TOOL_ALIASES {
            let owned = (*alias).to_string();
            if !deny.contains(&owned) {
                deny.push(owned);
            }
        }
        ToolPolicyLayer { allow: None, deny }
    }

    /// Layer the parent session's CURRENT exec mode onto a freshly-built
    /// worker policy.
    ///
    /// `parent_policy` is the session's BASE policy captured at init — it
    /// never carries the per-turn deny overlays the parent itself runs
    /// under. Without re-applying them here, a Plan-mode parent could
    /// escape its read-only guarantee by delegating writes to
    /// `builtin:general` (which inherits edit_file/run_shell); both
    /// dispatch paths — inherited and fresh-registry — flow through this
    /// overlay. Work-system access is not tool-mediated: `org2-pm`
    /// enforces product mode at the application boundary via the
    /// injected ORGII_MODE, so there is no PM tool layer to re-apply.
    pub(super) fn overlay_parent_modes(
        policy: ResolvedToolPolicy,
        parent_exec_mode: Option<crate::session::AgentExecMode>,
    ) -> ResolvedToolPolicy {
        match parent_exec_mode {
            Some(mode) => policy.with_exec_mode(mode),
            None => policy,
        }
    }

    pub(super) fn build_inherited_policy(&self, agent: &AgentDefinition) -> ResolvedToolPolicy {
        let extra_deny = agent.tools.excluded_tools.clone();

        let policy = self
            .parent_policy
            .with_extra_layer(Self::subagent_hard_deny_layer());

        if extra_deny.is_empty() {
            policy
        } else {
            policy.with_extra_layer(ToolPolicyLayer {
                allow: None,
                deny: extra_deny,
            })
        }
    }

    pub(super) fn build_explore_policy(
        &self,
        agent: &AgentDefinition,
    ) -> Result<ResolvedToolPolicy, ToolError> {
        let mut allow = agent
            .tools
            .system_restrict_to_tools
            .clone()
            .ok_or_else(|| {
                ToolError::ExecutionFailed(format!(
                    "Agent '{}' is missing required tools.systemRestrictToTools for explore policy",
                    agent.id
                ))
            })?;
        // When the explore worker participates in an Agent Org run,
        // broaden its strict allowlist so `org_send_message` becomes
        // visible. Without this, the inherited parent registry (which
        // does carry `org_send_message`) is filtered out by the
        // explore-only allow list and the model is told the tool
        // doesn't exist — leaving the worker unable to report back
        // to its coordinator.
        if self.config.agent_org_context.is_some()
            && !allow.iter().any(|t| t == tool_names::ORG_SEND_MESSAGE)
        {
            allow.push(tool_names::ORG_SEND_MESSAGE.to_string());
        }
        let allow_layer = ToolPolicyLayer {
            allow: Some(allow),
            deny: Vec::new(),
        };
        Ok(self
            .parent_policy
            .with_extra_layer(Self::subagent_hard_deny_layer())
            .with_extra_layer(allow_layer))
    }

    // ── Path B: Fresh registry for allowlist specialists ────────────
    //
    // Used for subagents that declare `tools.system_restrict_to_tools = Some(list)`
    // where the listed tools include management-capability tools
    // (manage_agent_def) that may be absent from the parent session's
    // overlay. Rebuilds just those tools with the same constructors
    // registration uses.

    pub(super) async fn build_fresh_registry(
        &self,
        agent: &AgentDefinition,
    ) -> Result<ToolRegistry, ToolError> {
        let mut registry = ToolRegistry::new();

        let allowed = agent
            .tools
            .system_restrict_to_tools
            .as_ref()
            .ok_or_else(|| {
                ToolError::ExecutionFailed(format!(
                    "Agent '{}' has no tools.systemRestrictToTools configured",
                    agent.id
                ))
            })?;

        for tool_name in allowed {
            if !agent_supports_builtin_tool(agent, tool_name) {
                let required = builtin_tool_required_capability(tool_name)
                    .expect("known built-in tool has a required capability");
                warn!(
                    "[agent] Tool '{}' requires {:?} capability and is not supported by agent '{}'. Skipping.",
                    tool_name, required, agent.id
                );
                continue;
            }

            match tool_name.as_str() {
                tool_names::MANAGE_AGENT_DEF => {
                    let handle = self.config.app_handle.as_ref().ok_or_else(|| {
                        ToolError::ExecutionFailed("App handle not available".into())
                    })?;
                    registry.register(Box::new(AgentDefinitionTool::new(handle.clone())));
                }
                other => {
                    warn!(
                        "[agent] Tool '{}' not supported in fresh registry. Skipping.",
                        other
                    );
                }
            }
        }

        Ok(registry)
    }

    pub(super) fn build_fresh_policy(&self, agent: &AgentDefinition) -> ResolvedToolPolicy {
        let allow = agent
            .tools
            .system_restrict_to_tools
            .clone()
            .unwrap_or_default();

        ResolvedToolPolicy::from_layers(vec![
            Self::subagent_hard_deny_layer(),
            ToolPolicyLayer {
                allow: Some(allow),
                deny: Vec::new(),
            },
        ])
    }
}

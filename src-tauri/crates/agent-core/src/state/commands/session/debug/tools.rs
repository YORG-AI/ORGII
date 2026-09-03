//! Debug-only Tauri command: introspect the live tool selection for an
//! active session.
//!
//! `debug_session_tools_snapshot(session_id)` reports everything an
//! audit spec needs to prove the L4→L5 hop for the Tools subsystem:
//!
//!   * `definition_*` — the raw `AgentDefinition.tools` snapshot the
//!     runtime captured at launch (from `session.definition`). Read
//!     directly off disk-shape fields so the spec can verify
//!     `system_restrict_to_tools` / `user_allowed_tools` /
//!     `excluded_tools` / `disabled_mcp_servers` / `disabled_mcp_tools`
//!     individually round-trip to the running session.
//!   * `resolved_restrict_to` — `ResolvedToolSelection.restrict_to`,
//!     the union of system pins + user opt-ins after `from_schema`
//!     resolution. Empty vec means "no restriction".
//!   * `resolved_excluded` — `ResolvedToolSelection.excluded`, the
//!     union of `excluded_tools` and the capability-derived default-OFF
//!     set, minus any tool the user explicitly allowed.
//!   * `resolved_disabled_mcp_servers` / `resolved_disabled_mcp_tools`
//!     — the resolved MCP block-lists. Currently a passthrough of the
//!     stored values, but exposed here so the spec doesn't assume that
//!     and can re-pin the contract if defaults are added later.
//!   * `registered_tool_names` — the effective tool registry after
//!     `init::build_session_runtime` finished wiring builtin tools and
//!     MCP overlays. This proves runtime reachability before per-turn
//!     policy filtering.
//!   * `prompt_tool_names` — the policy-filtered Always-priority tool
//!     schemas that are actually sent to the provider for a turn.
//!
//! Mirrors `model_dump` / `subagent_dump` / `security_dump`: the Rust
//! command is always callable; the frontend `__e2e` helper guards on
//! `debug_assertions || WEBDRIVER=1` so production users never see it.
//!
//! Intended use: an audit spec writes a sentinel tool-selection patch
//! to the agent definition, boots a session, then asserts that the
//! live snapshot reflects exactly what was on disk *at launch time*.
//! A subsequent disk mutation must NOT alter the running session's
//! snapshot — that's the capture-at-launch invariant.

use serde::{Deserialize, Serialize};

use crate::foundation::session_bridge;
use crate::state::commands::session::message::resolve_agent_mode;
use crate::state::AgentAppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionToolsSnapshot {
    pub session_id: String,
    pub agent_id: String,
    /// Effective execution mode used to append mode policy to the base tool policy.
    pub agent_exec_mode: String,

    /// `AgentDefinition.tools.system_restrict_to_tools` captured at
    /// launch. `None` means the agent has no role-pinned allowlist.
    pub definition_system_restrict_to_tools: Option<Vec<String>>,
    /// `AgentDefinition.tools.user_allowed_tools` captured at launch.
    pub definition_user_allowed_tools: Vec<String>,
    /// `AgentDefinition.tools.excluded_tools` captured at launch.
    pub definition_excluded_tools: Vec<String>,
    /// `AgentDefinition.tools.disabled_mcp_servers` captured at launch.
    pub definition_disabled_mcp_servers: Vec<String>,
    /// `AgentDefinition.tools.disabled_mcp_tools` captured at launch.
    pub definition_disabled_mcp_tools: Vec<String>,

    /// `ResolvedToolSelection.restrict_to` — union of system pins and
    /// user opt-ins. Empty = unrestricted.
    pub resolved_restrict_to: Vec<String>,
    /// `ResolvedToolSelection.excluded` — disk excludes + capability
    /// defaults, minus user opt-ins.
    pub resolved_excluded: Vec<String>,
    /// `ResolvedToolSelection.disabled_mcp_servers`.
    pub resolved_disabled_mcp_servers: Vec<String>,
    /// `ResolvedToolSelection.disabled_mcp_tools`.
    pub resolved_disabled_mcp_tools: Vec<String>,

    /// Effective tool names registered with the session's
    /// `ToolRegistry` after init wired builtin + MCP tools. This proves
    /// registry reachability before per-turn policy filtering.
    pub registered_tool_names: Vec<String>,
    /// Effective Always-priority tool names after `ResolvedToolPolicy`
    /// filtering, extracted from the exact schema payload passed to the
    /// provider for a turn.
    pub prompt_tool_names: Vec<String>,
}

#[tauri::command]
pub async fn debug_session_tools_snapshot(
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
) -> Result<SessionToolsSnapshot, String> {
    let Some(session) = state.get_session(&session_id).await else {
        if let Some(snapshot) = session_bridge::get_cli_tools_snapshot(&session_id)? {
            return Ok(SessionToolsSnapshot {
                session_id: snapshot.session_id,
                agent_id: snapshot.cli_agent_type,
                agent_exec_mode: snapshot.agent_exec_mode,
                definition_system_restrict_to_tools: None,
                definition_user_allowed_tools: Vec::new(),
                definition_excluded_tools: Vec::new(),
                definition_disabled_mcp_servers: Vec::new(),
                definition_disabled_mcp_tools: Vec::new(),
                resolved_restrict_to: Vec::new(),
                resolved_excluded: Vec::new(),
                resolved_disabled_mcp_servers: Vec::new(),
                resolved_disabled_mcp_tools: Vec::new(),
                registered_tool_names: snapshot.registered_tool_names,
                prompt_tool_names: snapshot.prompt_tool_names,
            });
        }
        return Err(format!("session not found: {}", session_id));
    };

    let runtime = session
        .get_runtime()
        .await
        .ok_or_else(|| format!("session runtime not initialized: {}", session_id))?;

    let agent_id = session.definition.id.clone();
    let session_record = crate::session::persistence::get_session(&session_id)
        .map_err(|err| format!("failed to load session record {session_id}: {err}"))?;
    let agent_exec_mode = resolve_agent_mode(
        session_record
            .as_ref()
            .and_then(|record| record.agent_exec_mode.as_deref()),
    )?;
    let effective_policy = runtime.policy.with_exec_mode(agent_exec_mode);

    let def_tools = session.definition.tools.clone();
    let resolved_tools = runtime.resolved.tools.clone();

    let mut registered_tool_names = runtime.tool_registry.tool_names();
    registered_tool_names.sort();
    let prompt_tool_names = runtime.tool_registry.prompt_tool_names(&effective_policy);

    Ok(SessionToolsSnapshot {
        session_id: session_id.clone(),
        agent_id,
        agent_exec_mode: agent_exec_mode.as_str().to_string(),

        definition_system_restrict_to_tools: def_tools.system_restrict_to_tools.clone(),
        definition_user_allowed_tools: def_tools.user_allowed_tools.clone(),
        definition_excluded_tools: def_tools.excluded_tools.clone(),
        definition_disabled_mcp_servers: def_tools.disabled_mcp_servers.clone(),
        definition_disabled_mcp_tools: def_tools.disabled_mcp_tools.clone(),

        resolved_restrict_to: resolved_tools.restrict_to,
        resolved_excluded: resolved_tools.excluded,
        resolved_disabled_mcp_servers: resolved_tools.disabled_mcp_servers,
        resolved_disabled_mcp_tools: resolved_tools.disabled_mcp_tools,

        registered_tool_names,
        prompt_tool_names,
    })
}

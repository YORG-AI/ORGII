//! Debug-only Tauri command: introspect the live `agent` (sub-agent
//! delegation) tool's allowlist for an active session.
//!
//! `debug_session_subagent_snapshot(session_id)` rebuilds the same
//! `allowed_subagents: Option<Vec<String>>` value that
//! `init/tool_assembly.rs::build_agent_tool` assembled at session
//! launch and reports both:
//!
//!   * the raw `resolved.sub_agents` list from the merged
//!     `AgentDefinition`,
//!   * the effective allowlist used by the `agent` tool
//!     (definition non-empty list → `Some(ids)`; empty list →
//!     `None` = unrestricted),
//!   * the set of `agent_id`s the LLM would actually see in the
//!     `agent` tool's dynamic description (built by
//!     `core::tools::impls::orchestration::agent::llm_visible_agent_ids`).
//!
//! This proves the L4→L5 hop for the Sub-Agents subsystem: whatever is
//! written into `AgentDefinition.sub_agents` is what the live session's
//! delegation tool actually surfaces and enforces. Audit specs use it
//! to verify both directions:
//!
//!   * for non-org sessions, setting `sub_agents = []` collapses the
//!     allowlist to `None` (unrestricted, all delegatable agents visible),
//!   * for org sessions, setting `sub_agents = []` becomes `Some([])` so
//!     only runtime primitives remain visible through the generic `agent` tool,
//!   * setting `sub_agents = [X]` makes the LLM-visible private list exactly
//!     `[X]` after filtering current org roster participants, and runtime would
//!     reject `agent(agent_id="Y")` for non-runtime primitives.
//!
//! Why a separate dump command rather than parsing `prompt_dump`: the
//! `agent` tool description lives inside the tool registry (as part of
//! the `tools` block of the system prompt), so prompt_dump *does* see
//! it — but the structured allowlist is much easier to assert against
//! than greppy substring matches on the rendered tool description.
//!
//! Gating mirrors `prompt_dump` and `security_dump`: cheap rebuild,
//! always exposed at the Tauri-command layer; the frontend `__e2e`
//! helper guards on `debug_assertions || WEBDRIVER=1` so production
//! users never see it.

use serde::{Deserialize, Serialize};

use crate::core::definitions::schema::SubAgentIsolation;
use crate::core::tools::impls::orchestration::agent::llm_visible_agent_ids;
use crate::session::persistence;
use crate::state::AgentAppState;

/// Wire-shape mirror of the live `AgentTool::config.allowed_subagents`
/// computation at session launch.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSubAgentSnapshot {
    pub session_id: String,
    pub agent_id: String,
    pub member_id: Option<String>,
    /// `true` when this session is the coordinator of an `AgentOrgRun`.
    /// Coordinators still use the agent definition's own private
    /// sub-agent allowlist; org members are reached via `org_send_message`.
    pub is_coordinator: bool,
    /// `true` when the session is a non-coordinator member of an
    /// `AgentOrgRun`. Non-org sessions have both flags `false`.
    pub is_org_member: bool,
    /// Raw agent IDs read off `ResolvedAgent.sub_agents`.
    pub resolved_sub_agents: Vec<ResolvedSubAgentEntry>,
    /// The effective allowlist that `tool_assembly::build_agent_tool`
    /// would inject into `AgentToolConfig.allowed_subagents`.
    /// `null` = unrestricted (all delegatable agents visible);
    /// `[...]` = only listed `agent_id`s are delegatable.
    pub allowed_subagents: Option<Vec<String>>,
    /// `agent_id`s the LLM would actually see in the `agent` tool's
    /// dynamic description, given the allowlist above. Computed using
    /// the same filter `agent::schema::llm_description` applies.
    pub llm_visible_agent_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedSubAgentEntry {
    pub agent_id: String,
    pub isolation: Option<SubAgentIsolation>,
}

#[tauri::command]
pub async fn debug_session_subagent_snapshot(
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
) -> Result<SessionSubAgentSnapshot, String> {
    let session = state
        .get_session(&session_id)
        .await
        .ok_or_else(|| format!("session not found: {}", session_id))?;

    let runtime = session
        .get_runtime()
        .await
        .ok_or_else(|| format!("session runtime not initialized: {}", session_id))?;

    let agent_id = session.definition.id.clone();
    let resolved_sub_agents: Vec<ResolvedSubAgentEntry> = runtime
        .resolved
        .sub_agents
        .iter()
        .map(|s| ResolvedSubAgentEntry {
            agent_id: s.agent_id.clone(),
            isolation: s.isolation,
        })
        .collect();

    let member_id = persistence::get_session(&session_id)
        .map_err(|err| err.to_string())?
        .and_then(|record| record.org_member_id);
    let is_coordinator =
        member_id.as_deref() == Some(crate::coordination::agent_org_runs::COORDINATOR_MEMBER_ID);
    let is_org_member =
        runtime.agent_org_context.is_some() && member_id.is_some() && !is_coordinator;

    // Mirror `init::tool_assembly::build_agent_tool`: Agent Org participants
    // use `org_send_message` for roster collaboration; private sub-agent
    // delegation remains driven by the definition's `sub_agents` list after
    // removing current org roster participants. Org sessions with no private
    // sub-agents use an empty allowlist so the LLM sees only runtime primitives
    // instead of arbitrary custom roster members.
    let mut definition_subagent_ids: Vec<String> = runtime
        .resolved
        .sub_agents
        .iter()
        .map(|sub_agent| sub_agent.agent_id.clone())
        .collect();
    if let Some(org_context) = runtime.agent_org_context.as_ref() {
        definition_subagent_ids.retain(|agent_id| {
            agent_id != &org_context.coordinator_agent_id
                && !org_context
                    .members
                    .iter()
                    .any(|member| member.agent_id == agent_id.as_str())
        });
    }
    let allowed_subagents: Option<Vec<String>> = if runtime.resolved.sub_agents.is_empty() {
        runtime.agent_org_context.as_ref().map(|_| Vec::new())
    } else {
        Some(definition_subagent_ids)
    };

    let llm_visible = llm_visible_agent_ids(allowed_subagents.as_ref());

    Ok(SessionSubAgentSnapshot {
        session_id: session_id.clone(),
        agent_id,
        member_id,
        is_coordinator,
        is_org_member,
        resolved_sub_agents,
        allowed_subagents,
        llm_visible_agent_ids: llm_visible,
    })
}

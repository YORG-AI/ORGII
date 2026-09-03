//! Debug-only Tauri command: introspect the live model selection +
//! fallback chain for an active session.
//!
//! `debug_session_model_snapshot(session_id)` reports everything an
//! audit spec needs to prove the L4→L5 hop for the Models subsystem:
//!
//!   * `active_model` / `active_account_id` — what
//!     `init::build_session_runtime` ultimately passed to
//!     `providers::factory::create_provider_with_reliability`.
//!   * `resolved_selected_model_id` — `ResolvedAgent.selected_model_id`
//!     after merging the agent definition + inherited template +
//!     overrides. Equal to `active_model` whenever the caller did NOT
//!     override the model at session-launch time.
//!   * `resolved_selected_account_id` — `ResolvedAgent.selected_account_id`,
//!     same merge project.
//!   * `fallback_models` — the effective fallback chain that
//!     `ReliableProvider` iterates over, sourced from
//!     `reliability.fallback_models`.
//!
//! Mirrors `subagent_dump` and `security_dump`: the Rust command is
//! always callable; the frontend `__e2e` helper guards on
//! `debug_assertions || WEBDRIVER=1` so production users never see it.
//!
//! Intended use: an audit spec writes a sentinel `selectedModelId` to
//! the agent definition, boots a session, then asserts that the live
//! snapshot reflects exactly what was on disk *at launch time*. A
//! subsequent disk mutation must NOT alter the running session's
//! snapshot — that's the capture-at-launch invariant the Security and
//! Sub-Agents specs already pin.

use serde::{Deserialize, Serialize};

use crate::model_context::compaction::CompactionConfig;
use crate::state::AgentAppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionModelSnapshot {
    pub session_id: String,
    pub agent_id: String,
    /// Model the session actually opened with — what
    /// `providers::factory::create_provider_with_reliability` saw as
    /// the primary. Empty string is impossible (init returns an error
    /// before we ever reach `set_runtime`).
    pub active_model: String,
    /// Account id paired with `active_model` at runtime. `None` is
    /// possible during early test fixtures where the runtime is built
    /// without a credential; in production it's filled in by
    /// `initialize_session` before `set_runtime` returns.
    pub active_account_id: Option<String>,
    /// `ResolvedAgent.selected_model_id` — equals `active_model` unless
    /// the caller passed `model_override` to `initialize_session`.
    pub resolved_selected_model_id: String,
    /// `ResolvedAgent.selected_account_id` — `None` is a real state
    /// (no account chosen yet on the agent definition), even though
    /// `active_account_id` will then be filled in by the session-creator
    /// override path.
    pub resolved_selected_account_id: Option<String>,
    /// Effective fallback chain `ReliableProvider` iterates over,
    /// sourced from `reliability.fallback_models`.
    pub fallback_models: Vec<String>,
    /// Effective context compaction settings resolved from the agent
    /// definition + inheritance chain at session launch.
    pub compaction: CompactionConfig,
}

#[tauri::command]
pub async fn debug_session_model_snapshot(
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
) -> Result<SessionModelSnapshot, String> {
    let session = state
        .get_session(&session_id)
        .await
        .ok_or_else(|| format!("session not found: {}", session_id))?;

    let runtime = session
        .get_runtime()
        .await
        .ok_or_else(|| format!("session runtime not initialized: {}", session_id))?;

    let agent_id = session.definition.id.clone();

    Ok(SessionModelSnapshot {
        session_id: session_id.clone(),
        agent_id,
        active_model: runtime.model.clone(),
        active_account_id: runtime.account_id.clone(),
        resolved_selected_model_id: runtime.resolved.selected_model_id.clone(),
        resolved_selected_account_id: runtime.resolved.selected_account_id.clone(),
        fallback_models: runtime.resolved.reliability.fallback_models.clone(),
        compaction: runtime.resolved.compaction.clone(),
    })
}

//! Debug-only Tauri command: introspect the live "General"-tab
//! configuration for an active session.
//!
//! `debug_session_general_snapshot(session_id)` reports everything an
//! audit spec needs to prove the L4→L5 hop for the three General-tab
//! fields surfaced by the AgentOrgs config UI:
//!
//!   * **Personality** (`AgentDefinition.soul_content`) — captured at
//!     launch on `SessionRuntime.agent_soul`. The live processor's
//!     `build_system_prompt` consumes the captured value, while
//!     `prompt_dump` re-reads the live store. Both paths must be
//!     pinned: the captured value never changes mid-session, and the
//!     debug surface always reflects the live store.
//!   * **Max iterations** (`session_model.max_iterations`) — the per-
//!     turn tool-call cap. Read at every turn from
//!     `runtime.resolved.session_model.max_iterations`. Capture-at-
//!     launch via `runtime.resolved` (which never mutates).
//!   * **Exec timeout** (`AgentDefinition.exec_timeout`) — the
//!     shell/subprocess timeout (seconds). Captured into `tool_deps`
//!     and baked into `ExecTool` at registration. None on the
//!     definition means "inherit resolver default" (60s); the
//!     `ResolvedAgent.exec_timeout` field is always the concrete u64
//!     after default fill-in.
//!
//! For each field the snapshot exposes BOTH the captured-at-launch
//! definition value AND the resolved/effective runtime value so a
//! spec can prove the resolver fold (e.g. `exec_timeout: None` →
//! `60`, `max_iterations` default `500`) and the no-mid-session-drift
//! invariant in a single round-trip.
//!
//! Pairs with `prompt_dump` for Personality: that command surfaces
//! the live re-read, this command surfaces the captured value. Both
//! must be observed to prove the capture-at-launch contract end-to-
//! end. The `live_soul_*` fields below mirror what `prompt_dump`
//! would compute so the spec can do the comparison without two RPCs.
//!
//! Mirrors `skills_dump`: the Rust command is always callable; the
//! frontend `__e2e` helper guards on `debug_assertions || WEBDRIVER=1`
//! so production users never see it.

use serde::{Deserialize, Serialize};

use crate::core::definitions::AgentDefinitionsStore;
use crate::state::AgentAppState;

/// Resolver default for `exec_timeout` when the merged definition has
/// `None`. Mirrors `DEFAULT_EXEC_TIMEOUT_SECS` in
/// `core/definitions/resolved.rs`.
const RESOLVER_DEFAULT_EXEC_TIMEOUT_SECS: u64 = 60;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionGeneralSnapshot {
    pub session_id: String,
    pub agent_id: String,

    // ── Personality (`soul_content`) ──
    /// `AgentDefinition.soul_content` captured on `session.definition`
    /// at launch. `None` means the agent has no override (resolver
    /// then defaults to empty string for the `IdentitySection`).
    pub definition_soul_content: Option<String>,
    /// `SessionRuntime.agent_soul` — the cached value the live
    /// processor's `build_system_prompt` consumes for every turn. Set
    /// once at session launch (capture-at-launch) and never re-read.
    pub runtime_agent_soul: Option<String>,
    /// Mirrors the lookup `prompt_dump` performs on each invocation:
    /// `defs.get(agent_definition_id).and_then(|d| d.soul_content)
    ///     .or(runtime.agent_soul.clone())`. This is the live re-read
    /// path. After a mid-session edit to the on-disk definition this
    /// will drift away from `runtime_agent_soul`; the live processor
    /// keeps using `runtime_agent_soul`.
    pub live_soul_content: Option<String>,
    /// `runtime.agent_definition_id` — the id used for the live
    /// re-read. `None` for channel/legacy sessions where no
    /// definition is wired; in that case `live_soul_content` falls
    /// back to `runtime_agent_soul`.
    pub agent_definition_id: Option<String>,

    // ── Max iterations (`session_model.max_iterations`) ──
    /// `AgentDefinition.session_model.max_iterations` captured at
    /// launch on `session.definition`. `None` when the agent has no
    /// `session_model` block at all (resolver then synthesises one
    /// via `default_session_model`).
    pub definition_max_iterations: Option<u32>,
    /// `ResolvedAgent.session_model.max_iterations` — the value the
    /// turn pipeline reads every turn via
    /// `runtime.resolved.session_model.max_iterations`. Always
    /// concrete (never `None`) after resolve.
    pub resolved_max_iterations: u32,
    /// `Some(resolved_max_iterations)` — mirrors
    /// `turn_max_iterations_from_session_model`, which simply wraps
    /// the value in `Some`. Pinned so a future change to the
    /// wrapper-shape (e.g. zero-means-unlimited) is caught here.
    pub effective_turn_max_iterations: Option<u32>,

    // ── Exec timeout (`exec_timeout`) ──
    /// `AgentDefinition.exec_timeout` captured at launch on
    /// `session.definition`. `None` means the agent inherits the
    /// resolver default (`RESOLVER_DEFAULT_EXEC_TIMEOUT_SECS = 60`).
    /// `Some(0)` is impossible — the patch path treats 0 as "clear"
    /// and stores `None`.
    pub definition_exec_timeout: Option<u64>,
    /// `ResolvedAgent.exec_timeout` — the concrete u64 baked into
    /// `tool_deps.exec_timeout` at session launch and into the
    /// `ExecTool` builder by `coding.rs::register_coding_tools`.
    /// Always concrete (`u64`, never `Option`) after resolve.
    pub resolved_exec_timeout_secs: u64,
    /// The resolver default the spec asserts against to prove the
    /// `None → 60` fold. Returned alongside `resolved_*` so the spec
    /// has no hardcoded magic numbers.
    pub resolver_default_exec_timeout_secs: u64,
}

#[tauri::command]
pub async fn debug_session_general_snapshot(
    state: tauri::State<'_, AgentAppState>,
    defs: tauri::State<'_, std::sync::Arc<AgentDefinitionsStore>>,
    session_id: String,
) -> Result<SessionGeneralSnapshot, String> {
    let session = state
        .get_session(&session_id)
        .await
        .ok_or_else(|| format!("session not found: {}", session_id))?;

    let runtime = session
        .get_runtime()
        .await
        .ok_or_else(|| format!("session runtime not initialized: {}", session_id))?;

    let agent_id = session.definition.id.clone();

    // ── Personality ──
    let definition_soul_content = session.definition.soul_content.clone();
    let runtime_agent_soul = runtime.agent_soul.clone();
    let agent_definition_id = runtime.agent_definition_id.clone();
    // Same lookup as `prompt_dump`: live re-read of the singleton
    // definitions store, fall back to the runtime cache for sessions
    // without a wired definition (channel/legacy).
    let live_soul_content = agent_definition_id
        .as_deref()
        .and_then(|id| defs.get(id))
        .and_then(|def| def.soul_content)
        .or_else(|| runtime_agent_soul.clone());

    // ── Max iterations ──
    let definition_max_iterations = session
        .definition
        .session_model
        .as_ref()
        .map(|sm| sm.max_iterations);
    let resolved_max_iterations = runtime.resolved.session_model.max_iterations;
    let effective_turn_max_iterations =
        crate::core::session::turn::turn_max_iterations_from_session_model(resolved_max_iterations);

    // ── Exec timeout ──
    let definition_exec_timeout = session.definition.exec_timeout;
    let resolved_exec_timeout_secs = runtime.resolved.exec_timeout;
    let resolver_default_exec_timeout_secs = RESOLVER_DEFAULT_EXEC_TIMEOUT_SECS;

    Ok(SessionGeneralSnapshot {
        session_id: session_id.clone(),
        agent_id,

        definition_soul_content,
        runtime_agent_soul,
        live_soul_content,
        agent_definition_id,

        definition_max_iterations,
        resolved_max_iterations,
        effective_turn_max_iterations,

        definition_exec_timeout,
        resolved_exec_timeout_secs,
        resolver_default_exec_timeout_secs,
    })
}

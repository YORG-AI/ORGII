//! Dev-only Tauri command: structured introspection of the live
//! system prompt.
//!
//! `prompt_dump(session_id)` rebuilds the same `PromptCtx` the
//! `UnifiedMessageProcessor` would feed into the registry on the next
//! turn, then returns:
//!
//! - `prompt`: the assembled bytes (identical to what
//!   `processor.build_system_prompt(session_id)` would produce, modulo
//!   the per-turn dynamic sections which are NOT part of the stable
//!   prefix).
//! - `traces`: per-section breakdown — id, order_hint, applies (true /
//!   false), reason ("channel_session" / "no_workspace" / …), source
//!   (Builtin / Computed{upstream} / OverrideFile{path}), sovereign-safe
//!   flag, and the rendered body (only when applied).
//!
//! Why this exists: the previous debug surface was log-grep
//! (`tracing::info!` lines + ad-hoc HTTP `extract_section()` slicers).
//! Log-grep is structurally fragile (one section's body can contain a
//! header that looks like another section's header), can't tell us
//! *why* a section was skipped, and can't be asserted against in E2E
//! without parsing free-form Markdown. The trace shape is stable JSON,
//! so tests can assert "section `identity` applied with reason
//! `always` and source `Computed{upstream:agent_definition.soul_content}`"
//! without any string gymnastics.
//!
//! Gating:
//! - `#[cfg(debug_assertions)]` on the function so release builds
//!   never ship it.
//! - `#[tauri::command]` with no auth — debug builds only.

use serde::{Deserialize, Serialize};

use crate::core::definitions::AgentDefinitionsStore;
use crate::core::session::prompt::registry::{assemble, PromptCtx, PromptSource, SectionTrace};
use crate::core::session::SystemPromptConfig;
use crate::state::AgentAppState;

/// Frontend-shape mirror of [`SectionTrace`]. We re-serialize through
/// this struct rather than expose `SectionTrace` directly so the
/// public RPC surface owns a stable schema (the registry struct can
/// keep evolving without breaking the wire).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptDumpSection {
    pub section_id: String,
    pub order_hint: i32,
    pub applies: bool,
    pub reason: String,
    pub source: PromptSourceWire,
    pub sovereign_safe: bool,
    pub cache_policy: String,
    pub content: Option<String>,
}

/// Wire-shape mirror of [`PromptSource`]. The registry enum is
/// internal; this struct is what the frontend sees.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptSourceWire {
    /// Discriminator: `"builtin"` / `"override_file"` / `"computed"`.
    pub kind: String,
    pub upstream: Option<String>,
    pub path: Option<String>,
}

impl From<PromptSource> for PromptSourceWire {
    fn from(src: PromptSource) -> Self {
        match src {
            PromptSource::Builtin => Self {
                kind: "builtin".to_string(),
                upstream: None,
                path: None,
            },
            PromptSource::OverrideFile { path } => Self {
                kind: "override_file".to_string(),
                upstream: None,
                path: Some(path.display().to_string()),
            },
            PromptSource::Computed { upstream } => Self {
                kind: "computed".to_string(),
                upstream: Some(upstream.to_string()),
                path: None,
            },
        }
    }
}

impl From<SectionTrace> for PromptDumpSection {
    fn from(t: SectionTrace) -> Self {
        Self {
            section_id: t.section_id.to_string(),
            order_hint: t.order_hint,
            applies: t.applies,
            reason: t.reason.to_string(),
            source: t.source.into(),
            sovereign_safe: t.sovereign_safe,
            cache_policy: t.cache_policy.to_string(),
            content: t.content,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptDumpResult {
    pub session_id: String,
    pub agent_id: String,
    pub agent_definition_id: Option<String>,
    pub model: String,
    pub sovereign: bool,
    pub is_channel_session: bool,
    pub is_workspace_session: bool,
    pub load_workspace_resources: bool,
    pub load_workspace_rules: bool,
    pub prompt: String,
    pub prompt_len: usize,
    pub sections: Vec<PromptDumpSection>,
}

/// Dump the assembled system prompt + per-section trace for an active
/// session.
///
/// This is a structured-introspection surface for the new prompt
/// registry: it returns the same bytes
/// `processor.build_system_prompt()` would produce on the next turn,
/// alongside a per-section trace that explains why each section was
/// applied or skipped, where its content came from, and what its
/// rendered body was. Used by the dev-only frontend `__e2e` helpers
/// and by `audit-session-flow.spec.mjs` to replace fragile log-grep
/// assertions with structural ones.
///
/// Returns `Err` if the session does not exist or its runtime is not
/// yet initialized — callers (E2E specs in particular) should retry
/// after the first turn lands.
#[tauri::command]
pub async fn prompt_dump(
    state: tauri::State<'_, AgentAppState>,
    defs: tauri::State<'_, std::sync::Arc<AgentDefinitionsStore>>,
    session_id: String,
) -> Result<PromptDumpResult, String> {
    let session = state
        .get_session(&session_id)
        .await
        .ok_or_else(|| format!("session not found: {}", session_id))?;

    let runtime = session
        .runtime
        .read()
        .await
        .clone()
        .ok_or_else(|| format!("session runtime not initialized: {}", session_id))?;

    // The processor caches `agent_soul` on the runtime at session-start
    // time so the per-turn hot path is allocation-free. `prompt_dump`,
    // however, is the contract surface that promises "next turn's
    // bytes" — it must reflect any post-launch edits to
    // `AgentDefinition.soul_content`. Re-read the live store when the
    // session has an agent definition id; fall back to the cached
    // runtime value when there is none (channel/legacy sessions).
    let live_soul = runtime
        .agent_definition_id
        .as_deref()
        .and_then(|id| defs.get(id))
        .and_then(|def| def.soul_content)
        .or_else(|| runtime.agent_soul.clone());

    // Mirror exactly the field set the processor populates in
    // `build_system_prompt`. Tool summaries are intentionally empty —
    // `prompt_dump` reports the stable prefix only, mirroring the
    // cacheable region the processor builds.
    let live_workspace = Some(runtime.workspace_state.read().clone());
    let prompt_config = SystemPromptConfig {
        model: runtime.model.clone(),
        agent_id: session.definition.id.clone(),
        agent_definition_id: runtime.agent_definition_id.clone(),
        skills: runtime.resolved.skills.clone(),
        load_workspace_resources: runtime.resolved.load_workspace_resources,
        load_workspace_rules: runtime.resolved.load_workspace_rules,
        agent_soul: live_soul,
        workspace: live_workspace,
        channel: None,
        chat_id: None,
        agent_mode: None,
        product_mode: crate::session::persistence::get_session(&session_id)
            .ok()
            .flatten()
            .and_then(|record| record.product_mode),
        ide_context: None,
        user_presence: None,
        user_profile: None,
        agent_org_context: runtime.agent_org_context.clone(),
        agent_org_current_member_id: runtime.agent_org_current_member_id.clone(),
        sovereign_prompt: runtime.sovereign_prompt,
    };

    let tool_summaries = Vec::new();
    let ctx = PromptCtx::new(&session_id, &prompt_config, &tool_summaries);
    let is_channel_session = ctx.is_channel_session;
    let is_workspace_session = ctx._is_workspace_session;
    let sovereign = ctx.sovereign;
    let (prompt, traces) = assemble(&ctx);
    let prompt_len = prompt.len();

    Ok(PromptDumpResult {
        session_id,
        agent_id: prompt_config.agent_id,
        agent_definition_id: prompt_config.agent_definition_id,
        model: prompt_config.model,
        sovereign,
        is_channel_session,
        is_workspace_session,
        load_workspace_resources: prompt_config.load_workspace_resources,
        load_workspace_rules: prompt_config.load_workspace_rules,
        prompt,
        prompt_len,
        sections: traces.into_iter().map(PromptDumpSection::from).collect(),
    })
}

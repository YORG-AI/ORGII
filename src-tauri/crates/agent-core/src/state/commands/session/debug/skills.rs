//! Debug command: Skills runtime snapshot.
//!
//! `debug_session_skills_snapshot(session_id)` reports everything an
//! audit spec needs to prove the L4→L5 hop for the Skills subsystem:
//!
//!   * `definition_*` — the raw `AgentDefinition.skills_config` snapshot
//!     read off the session's `definition` field (captured at launch).
//!     `definition_present = false` means the agent had `skills_config:
//!     None` on disk and the resolver fell back to defaults.
//!   * `resolved_skills_*` — `ResolvedAgent.skills` (the `SkillsParams`
//!     struct): the SINGLE runtime source of truth. The resolver
//!     collapses `enabled: Option<bool>` to `bool` (`None` → `true`),
//!     carries `include` (whitelist), forwards `exclude` as `disabled`,
//!     and session init unions in the app-global disabled list.
//!   * `effective_*` — the exact loader arguments the per-turn prompt
//!     builder derives from `resolved.skills`, plus the rendered skill
//!     listing produced with the same `SkillsLoader` call.
//!
//! The old parallel `SessionRuntime.skills_config` capture (and its
//! "two caches must agree" reconciliation) was deleted — `resolved.skills`
//! is now the only runtime skills state.

use serde::{Deserialize, Serialize};

use crate::state::AgentAppState;

fn build_effective_skill_listing(
    runtime: &crate::state::session_runtime::SessionRuntime,
    effective_disabled: &[String],
    include_filter: Option<&[String]>,
    org_id: Option<&str>,
) -> Option<String> {
    if !runtime.resolved.skills.enabled {
        return None;
    }

    let workspace_root = runtime.workspace_state.read().workspace_root.clone();
    let skills_dir = workspace_root.join(".orgii");
    let mut loader = crate::skills::loader::SkillsLoader::new(&skills_dir)
        .with_builtin_dir(crate::skills::loader::global_skills_dir())
        .with_agent_id(runtime.resolved.agent_id.clone())
        .with_load_workspace_resources(runtime.resolved.load_workspace_resources);
    if let Some(org_id) = org_id {
        loader = loader.with_org_id(org_id);
    }
    loader.build_skill_listing_attachment(effective_disabled, include_filter)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSkillsSnapshot {
    pub session_id: String,
    pub agent_id: String,

    /// `true` iff the captured-at-launch `AgentDefinition.skills_config`
    /// on `session.definition` was `Some`. When `false` the
    /// `definition_*` fields below are zero-valued.
    pub definition_present: bool,
    /// `AgentDefinition.skills_config.enabled` captured at launch.
    /// `None` = "inherit default" (resolver folds it to `true`).
    pub definition_enabled: Option<bool>,
    /// `AgentDefinition.skills_config.include` captured at launch.
    pub definition_include: Vec<String>,
    /// `AgentDefinition.skills_config.exclude` captured at launch.
    pub definition_exclude: Vec<String>,

    /// `ResolvedAgent.skills.enabled` — the resolver's collapsed bool.
    pub resolved_skills_enabled: bool,
    /// `ResolvedAgent.skills.include` — the whitelist carried through
    /// the resolver (single source; no parallel runtime cache).
    pub resolved_skills_include: Vec<String>,
    /// `ResolvedAgent.skills.disabled` — per-agent exclude unioned with
    /// the app-global disabled list at session init.
    pub resolved_skills_disabled: Vec<String>,

    /// The disabled list the per-turn prompt builder feeds the loader —
    /// identical to `resolved_skills_disabled` (kept as a separate field
    /// so specs pin the prompt path explicitly).
    pub effective_per_turn_disabled: Vec<String>,
    /// `resolved.skills.include` when non-empty, else `None` — mirrors
    /// how the prompt builder produces the loader argument.
    pub effective_include_filter: Option<Vec<String>>,
    /// The exact skill catalogue text produced from the resolved inputs,
    /// using the same `SkillsLoader::build_skill_listing_attachment`
    /// call the live per-turn system section uses.
    pub effective_skill_listing: Option<String>,
}

#[tauri::command]
pub async fn debug_session_skills_snapshot(
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
) -> Result<SessionSkillsSnapshot, String> {
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

    let agent_id = session.definition.id.clone();

    let def_skills = session.definition.skills_config.clone();
    let definition_present = def_skills.is_some();
    let (definition_enabled, definition_include, definition_exclude) = match &def_skills {
        Some(cfg) => (cfg.enabled, cfg.include.clone(), cfg.exclude.clone()),
        None => (None, Vec::new(), Vec::new()),
    };

    let skills = runtime.resolved.skills.clone();
    let effective_per_turn_disabled = skills.disabled.clone();
    let effective_include_filter = if skills.include.is_empty() {
        None
    } else {
        Some(skills.include.clone())
    };
    let session_org_id = crate::session::persistence::get_session(&session_id)
        .ok()
        .flatten()
        .and_then(|record| record.org_id);
    let effective_skill_listing = build_effective_skill_listing(
        &runtime,
        &effective_per_turn_disabled,
        effective_include_filter.as_deref(),
        session_org_id.as_deref(),
    );

    Ok(SessionSkillsSnapshot {
        session_id: session_id.clone(),
        agent_id,

        definition_present,
        definition_enabled,
        definition_include,
        definition_exclude,

        resolved_skills_enabled: skills.enabled,
        resolved_skills_include: skills.include,
        resolved_skills_disabled: skills.disabled,

        effective_per_turn_disabled,
        effective_include_filter,
        effective_skill_listing,
    })
}

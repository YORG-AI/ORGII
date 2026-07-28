//! Resolve the built-in SDE agent's skills config for CLI rule-sync.

/// Resolve the built-in SDE agent definition and return just its skills
/// config — the CLI runner's only consumer of `ResolvedAgent` (see §11.4
/// row 17). Failures fall back to the default skills shape (enabled,
/// nothing excluded) because the CLI session is already running; we do
/// not want a missing definitions file to break rule-sync.
pub(super) fn resolve_sde_skills() -> agent_core::core::definitions::SkillsParams {
    use agent_core::core::definitions::{ResolvedAgent, SkillsParams};
    use agent_core::core::session::overrides::SessionOverrides;
    let definitions = agent_core::definitions::definitions_store();
    let Some(def) = definitions.get(agent_core::definitions::builtin::SDE_AGENT_ID) else {
        tracing::warn!(
            "[code_session] builtin:sde definition not found; using default skills config"
        );
        return SkillsParams::default();
    };
    match ResolvedAgent::resolve(&def, Some(&definitions), &SessionOverrides::default()) {
        Ok(resolved) => resolved.skills.clone(),
        Err(err) => {
            tracing::warn!(
                "[code_session] resolve builtin:sde failed ({}); using default skills config",
                err
            );
            SkillsParams::default()
        }
    }
}

//! Exec-mode resolution for an inbound turn.
//!
//! One turn's mode is decided from the wire value the caller sent, plus the
//! Plan-mode entry/exit bookkeeping that lets a session remember what it was
//! doing before it entered Plan. Background Agent Org wakes resolve their mode
//! from durable inbox control rows instead — see [`super::org_wake`].

pub(super) fn restore_mode_before_plan_entry(
    last_non_plan_mode: Option<crate::session::AgentExecMode>,
) -> crate::session::AgentExecMode {
    last_non_plan_mode.unwrap_or(crate::session::AgentExecMode::Plan)
}

/// Resolve the requested exec mode for an inbound `agent_send_message` call.
///
/// Wire contract:
///   * `None` or empty string → `AgentExecMode::Build` (historical wire default).
///   * `Some("plan" | "build" | …)` → parsed via `AgentExecMode::parse`.
///   * `Some(<unknown>)` → `Err(...)` so a typo cannot silently downgrade a
///     read-only mode (`Plan` / `Ask` / `Review`) into `Build` (full
///     write access).
///
/// Background Agent Org wakes override this fallback only from a durable
/// `TaskAssigned` row whose task still belongs to that member.
/// `Build` remains the compatibility default for direct calls with no task
/// mode signal.
/// `#[doc(hidden)]` — the only external caller is the
/// `app::api::agent::test::workspace` debug route, reached through
/// `agent_core::debug::resolve_agent_mode`. Internal callers in
/// `agent_send_message` use the same function.
#[doc(hidden)]
pub fn resolve_agent_mode(mode: Option<&str>) -> Result<crate::session::AgentExecMode, String> {
    match mode.map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(crate::session::AgentExecMode::Build),
        Some(value) => crate::session::AgentExecMode::parse(value)
            .ok_or_else(|| format!("Unknown agent exec mode: {value:?}")),
    }
}
